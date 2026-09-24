/**
 * Article content loading: request, bounds, decoding and conversion hand-off.
 *
 * Responsibilities (CONTRACT.md §10, plan §5.4): one GET for one article with
 * `cache: 'no-cache'`, `credentials: 'omit'`, `redirect: 'error'`, a 10s total
 * timeout, a 2 MiB decoded ceiling and a hard failure on a non-HTML response.
 * Errors are reported as codes only - response bodies never reach the reader,
 * the console or a log.
 */
import { convertArticleHtml, type ConvertResult, type ReaderDom } from "../../../shared/reading/content.ts";
import { checkArticleUrl, describeUrlProblem } from "../../../shared/reading/url-policy.ts";

export type LoadErrorCode = "network" | "timeout" | "http" | "content-type" | "too-large" | "contract" | "unsupported";

export type LoadResult =
  | { status: "ok"; result: Extract<ConvertResult, { activate: true }> }
  | { status: "error"; code: LoadErrorCode; message: string };

export type LoadTarget = { postId: string; href: string; title: string };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type LoadOptions = {
  target: LoadTarget;
  /** Page origin the article URL must stay inside. */
  origin: string;
  signal: AbortSignal;
  document: ReaderDom;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  instanceId?: number;
  timers?: TimerApi;
};

/** Timeout primitives; injectable so tests never wait for real wall time. */
export type TimerApi = {
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
};

const defaultTimers: TimerApi = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const HTML_CONTENT_TYPE = /^text\/html\s*(?:;|$)/i;

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError";
}

function errorMessage(code: LoadErrorCode, detail: string): string {
  switch (code) {
    case "network":
      return "网络请求失败，请稍后重试或打开独立文章页";
    case "timeout":
      return "全文加载超时（10 秒），请重试或打开独立文章页";
    case "http":
      return `文章响应异常（${detail}），请打开独立文章页`;
    case "content-type":
      return `响应不是 HTML（${detail}），无法沉浸阅读`;
    case "too-large":
      return "文章内容超出体积限制，请打开独立文章页";
    case "contract":
      return `文章不满足阅读契约：${detail}`;
    case "unsupported":
      return `文章包含不支持的嵌入内容：${detail}`;
  }
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  isTimedOut: () => boolean,
): Promise<{ bytes: Uint8Array } | { tooLarge: true } | { timedOut: true } | { aborted: true }> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  const guard = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
        return;
      }
      const onAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });

  if (!body || typeof body.getReader !== "function") {
    const buffer = await guard(response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return { tooLarge: true };
    return { bytes: new Uint8Array(buffer) };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (isTimedOut()) {
      await reader.cancel().catch(() => undefined);
      return { timedOut: true };
    }
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await guard(reader.read());
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return isTimedOut() ? { timedOut: true } : { aborted: true };
      throw error;
    }
    if (step.done) break;
    const value = step.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop the transfer as soon as the ceiling is crossed.
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/**
 * Load and convert one article. Resolves with a status instead of throwing so a
 * late response can never be mistaken for an error path: the caller decides
 * ownership with its own request token, and this function only owns resources.
 */
export async function loadArticleContent(options: LoadOptions): Promise<LoadResult> {
  const { target, origin, signal, document: dom } = options;
  const fetchImpl: FetchLike | undefined = options.fetch ?? (typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as FetchLike) : undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timers = options.timers ?? defaultTimers;

  if (!fetchImpl) return { status: "error", code: "network", message: errorMessage("network", "fetch 不可用") };

  const checked = checkArticleUrl(target.href, origin);
  if (!checked.ok) {
    return { status: "error", code: "contract", message: errorMessage("contract", `文章地址不合法（${describeUrlProblem(checked.problem)}）`) };
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(checked.url, {
        method: "GET",
        cache: "no-cache",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "text/html" },
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        return timedOut
          ? { status: "error", code: "timeout", message: errorMessage("timeout", "") }
          : { status: "error", code: "network", message: errorMessage("network", "已取消") };
      }
      return { status: "error", code: "network", message: errorMessage("network", "请求异常") };
    }

    // The timeout is state, not only a rejection: a fake or a proxy may resolve
    // after the abort, and that late response must never become reader content.
    if (timedOut) {
      return { status: "error", code: "timeout", message: errorMessage("timeout", "") };
    }
    if (signal.aborted) {
      return { status: "error", code: "network", message: errorMessage("network", "已取消") };
    }

    if (!response.ok) {
      return { status: "error", code: "http", message: errorMessage("http", `HTTP ${response.status}`) };
    }
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!HTML_CONTENT_TYPE.test(contentType.trim())) {
      return { status: "error", code: "content-type", message: errorMessage("content-type", contentType.trim() || "缺少 Content-Type") };
    }

    let bounded: { bytes: Uint8Array } | { tooLarge: true } | { timedOut: true } | { aborted: true };
    try {
      bounded = await readBounded(response, maxBytes, controller.signal, () => timedOut);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        return timedOut
          ? { status: "error", code: "timeout", message: errorMessage("timeout", "") }
          : { status: "error", code: "network", message: errorMessage("network", "读取中断") };
      }
      return { status: "error", code: "network", message: errorMessage("network", "读取中断") };
    }
    if ("tooLarge" in bounded) {
      return { status: "error", code: "too-large", message: errorMessage("too-large", "") };
    }
    if ("timedOut" in bounded) {
      return { status: "error", code: "timeout", message: errorMessage("timeout", "") };
    }
    if ("aborted" in bounded) {
      return { status: "error", code: "network", message: errorMessage("network", "读取中断") };
    }

    const html = new TextDecoder("utf-8", { fatal: false }).decode(bounded.bytes);
    const responseUrl = response.url || checked.url;
    const converted = await convertArticleHtml(html, {
      target,
      responseUrl,
      document: dom,
      ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
    });
    if (!converted.activate) {
      const summary = converted.diagnostics.slice(0, 2).map((diagnostic) => diagnostic.message).join("；");
      return {
        status: "error",
        code: converted.code === "contract" ? "contract" : "unsupported",
        message: errorMessage(converted.code === "contract" ? "contract" : "unsupported", summary || "内容校验失败"),
      };
    }
    return { status: "ok", result: converted };
  } finally {
    timers.clearTimeout(timer);
    signal.removeEventListener("abort", forwardAbort);
  }
}
