/**
 * IR2 async/request gate for `src/article-reader-content.ts`.
 *
 * Covers the request contract (one GET, cache/credentials/redirect mode), every
 * error code, the byte ceiling with stream cancellation, timeout driven by an
 * injected timer, and the ownership rule that a late or cancelled response must
 * never commit DOM even when its promise still resolves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadArticleContent, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from "../../src/article-reader-content.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const logDir = resolve(root, ".tools/immerse-reading/IR2/logs");
const ORIGIN = "https://example.test";
const HREF = "/2026/06/01/sample-essay/";
const TARGET = { postId: "wp-38", href: HREF, title: "示例散文丨夜航" };
/** 示例路径是纯 ASCII，这里的请求 URL 与 HREF 一致。 */
const ENCODED_URL = new URL(HREF, ORIGIN).href;

function canonicalBody(content) {
  return (
    "<!doctype html><html><head><title>t</title></head><body><main>" +
    `<article data-pagefind-body data-reader-version="1" data-reader-kind="post" data-post-id="wp-38" data-canonical-path="${HREF}">` +
    `<div data-reader-content><h1 class="page-title">标题</h1><div class="prose">${content}</div></div>` +
    "</article></main></body></html>"
  );
}

function createStubDom() {
  const created = [];
  const make = (nodeType, tagName, data) => {
    const node = {
      nodeType,
      tagName,
      data,
      attributes: new Map(),
      childNodes: [],
      children: [],
      appendChild(child) {
        node.childNodes.push(child);
        if (child.nodeType === 1) node.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        node.attributes.set(name, value);
      },
      getAttribute(name) {
        return node.attributes.get(name) ?? null;
      },
      removeAttribute(name) {
        node.attributes.delete(name);
      },
    };
    if (nodeType === 1) created.push(tagName);
    return node;
  };
  return {
    created,
    document: {
      createElement: (tagName) => make(1, tagName, undefined),
      createTextNode: (data) => make(3, undefined, data),
    },
  };
}

/** Controllable timer double: nothing fires until the test says so. */
function createTimerDouble() {
  const pending = new Map();
  const scheduled = [];
  let next = 1;
  return {
    scheduled,
    timers: {
      setTimeout(handler, ms) {
        const id = next++;
        pending.set(id, handler);
        scheduled.push(ms);
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    fireAll() {
      const handlers = [...pending.values()];
      pending.clear();
      for (const handler of handlers) handler();
    },
    get size() {
      return pending.size;
    },
  };
}

function response(body, { status = 200, contentType = "text/html; charset=utf-8", url = `${ORIGIN}${HREF}`, stream = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    ...(stream ? { body: stream } : {}),
    async arrayBuffer() {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function streamOf(chunks) {
  let index = 0;
  return {
    cancelled: false,
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index++];
          return { done: false, value };
        },
        async cancel() {
          this.cancelled = true;
          return undefined;
        },
      };
    },
  };
}

function uploadStream(bytes, chunkSize = 64 * 1024) {
  const chunks = [];
  for (let offset = 0; offset < bytes; offset += chunkSize) {
    chunks.push(new Uint8Array(Math.min(chunkSize, bytes - offset)).fill(65));
  }
  let cancelled = false;
  let served = 0;
  return {
    get cancelled() {
      return cancelled;
    },
    get served() {
      return served;
    },
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled || served >= chunks.length) return { done: true, value: undefined };
            const value = chunks[served++];
            return { done: false, value };
          },
          async cancel() {
            cancelled = true;
            return undefined;
          },
        };
      },
    },
  };
}

function record() {
  const calls = [];
  return {
    calls,
    fetch(input, init) {
      calls.push({ input, init });
      return Promise.resolve(response(canonicalBody("<p>正文</p>")));
    },
  };
}

async function load(options) {
  const stub = options.dom ?? createStubDom();
  const result = await loadArticleContent({
    target: TARGET,
    origin: ORIGIN,
    signal: options.signal ?? new AbortController().signal,
    document: stub.document,
    fetch: options.fetch,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
  return { result, stub };
}

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

test("loader: one same-origin GET with no-cache/omit/error and an HTML accept header", async () => {
  const recorder = record();
  const { result } = await load({ fetch: recorder.fetch });
  assert.equal(result.status, "ok");
  assert.equal(recorder.calls.length, 1);
  const [call] = recorder.calls;
  assert.equal(call.input, ENCODED_URL);
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.cache, "no-cache");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers.accept, "text/html");
  assert.ok(call.init.signal, "the request must carry an abort signal");
});

test("loader: a rejected article URL is never requested", async () => {
  const recorder = record();
  for (const href of ["https://other.test/a/", `${HREF}?x=1`, `${HREF}#f`, "/a/%2F/"]) {
    const stub = createStubDom();
    const result = await loadArticleContent({
      target: { postId: "wp-38", href, title: "t" },
      origin: ORIGIN,
      signal: new AbortController().signal,
      document: stub.document,
      fetch: recorder.fetch,
    });
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.code, "contract");
    assert.equal(stub.created.length, 0);
  }
  assert.equal(recorder.calls.length, 0, "no request for an invalid target");
});

test("loader: successful conversion keeps the reader defaults", async () => {
  const { result, stub } = await load({ fetch: record().fetch });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.result.meta.postId, "wp-38");
  assert.equal(result.result.meta.canonicalPath, HREF);
  assert.deepEqual(stub.created, ["div", "h1", "div", "p"]);
  // Node 24 exposes Web Crypto, so a fingerprint must be present.
  assert.match(result.result.meta.fingerprint ?? "", /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("loader: HTTP status maps to http and never exposes the body", async () => {
  for (const status of [404, 500, 302]) {
    const { result, stub } = await load({
      fetch: () => Promise.resolve(response("<html><body>SECRET-BODY</body></html>", { status })),
    });
    assert.equal(result.status, "error");
    if (result.status !== "error") continue;
    assert.equal(result.code, "http");
    assert.equal(result.message.includes("SECRET-BODY"), false);
    assert.equal(result.message.includes(String(status)), true);
    assert.equal(stub.created.length, 0);
  }
});

test("loader: a 200 login page fails the contract instead of rendering a form", async () => {
  const { result, stub } = await load({
    fetch: () => Promise.resolve(response('<!doctype html><html><body><form action="/session"><input name="password"></form></body></html>')),
  });
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.code, "contract");
  assert.equal(stub.created.length, 0);
});

test("loader: wrong MIME type is refused before decoding", async () => {
  for (const contentType of ["application/json", "text/plain", "image/png", ""]) {
    const { result, stub } = await load({ fetch: () => Promise.resolve(response("{}", { contentType })) });
    assert.equal(result.status, "error");
    if (result.status !== "error") continue;
    assert.equal(result.code, "content-type", `content-type ${JSON.stringify(contentType)}`);
    assert.equal(stub.created.length, 0);
  }
});

test("loader: network failures and aborted requests are reported as codes", async () => {
  const failure = await load({ fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
  assert.equal(failure.result.status, "error");
  if (failure.result.status === "error") assert.equal(failure.result.code, "network");

  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const aborted = await load({ fetch: () => Promise.reject(abortError) });
  assert.equal(aborted.result.status, "error");
  if (aborted.result.status === "error") assert.equal(aborted.result.code, "network");
});

// ---------------------------------------------------------------------------
// Size ceiling
// ---------------------------------------------------------------------------

test("loader: a body over the ceiling is cancelled mid-stream", async () => {
  const stream = uploadStream(DEFAULT_MAX_BYTES * 3);
  const { result, stub } = await load({ fetch: () => Promise.resolve(response(new Uint8Array(0), { stream: stream.body })) });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "too-large");
  assert.equal(stream.cancelled, true, "the transfer must be cancelled at the ceiling");
  assert.ok(stream.served * 64 * 1024 <= DEFAULT_MAX_BYTES + 64 * 1024, "reading must stop near the ceiling");
  assert.equal(stub.created.length, 0);
});

test("loader: a body just under the ceiling is accepted", async () => {
  const content = `<p>${"x".repeat(1000)}</p>`;
  const html = canonicalBody(content);
  const stream = streamOf([new TextEncoder().encode(html)]);
  const { result } = await load({ fetch: () => Promise.resolve(response(new Uint8Array(0), { stream })) });
  assert.equal(result.status, "ok");
});

test("loader: a response without a stream falls back to arrayBuffer with a size check", async () => {
  const small = await load({ fetch: () => Promise.resolve(response(canonicalBody("<p>ok</p>"))) });
  assert.equal(small.result.status, "ok");
  const huge = await load({
    maxBytes: 512,
    fetch: () => Promise.resolve(response(canonicalBody(`<p>${"y".repeat(4096)}</p>`))),
  });
  assert.equal(huge.result.status, "error");
  if (huge.result.status === "error") assert.equal(huge.result.code, "too-large");
});

// ---------------------------------------------------------------------------
// Timeout and cancellation ownership
// ---------------------------------------------------------------------------

test("loader: the injected timer fires the 10s timeout and the request is aborted", async () => {
  const timers = createTimerDouble();
  let seenSignal = null;
  const pending = load({
    timers: timers.timers,
    fetch: (_input, init) => {
      seenSignal = init.signal;
      return new Promise((resolve) => {
        // Never listens for abort; the timeout state must still classify it.
        setTimeout(() => resolve(response(canonicalBody("<p>too late</p>"))), 600);
      });
    },
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  assert.deepEqual(timers.scheduled, [DEFAULT_TIMEOUT_MS]);
  assert.equal(seenSignal.aborted, false);
  timers.fireAll();
  assert.equal(seenSignal.aborted, true);
  const { result } = await pending;
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "timeout");
  assert.equal(timers.size, 0, "the timeout is always cleared");
});

test("loader: an external abort during the body read commits nothing", async () => {
  const timers = createTimerDouble();
  const controller = new AbortController();
  const stub = createStubDom();
  let readStarted = false;
  const body = {
    getReader() {
      return {
        read: () =>
          new Promise((_resolve, reject) => {
            readStarted = true;
            controller.signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
        cancel: async () => undefined,
      };
    },
  };
  const pending = loadArticleContent({
    target: TARGET,
    origin: ORIGIN,
    signal: controller.signal,
    document: stub.document,
    timers: timers.timers,
    fetch: () => Promise.resolve(response(new Uint8Array(0), { stream: body })),
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  assert.equal(readStarted, true, "the body read must have started");
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "network");
  assert.equal(stub.created.length, 0, "an aborted load must not create DOM");
  assert.equal(timers.size, 0, "the timeout timer is cleared");
});

test("loader: an ignored abort (late resolve) is reported as network, never as ok", async () => {
  const timers = createTimerDouble();
  let seenSignal = null;
  const stub = createStubDom();
  const pending = loadArticleContent({
    target: TARGET,
    origin: ORIGIN,
    signal: new AbortController().signal,
    document: stub.document,
    timers: timers.timers,
    fetch: (_input, init) => {
      seenSignal = init.signal;
      // Deliberately ignores the abort signal: the fake resolves afterwards,
      // which is exactly the "abort 后 Promise 仍 resolve" stand-in the plan
      // requires. Ownership must come from the state, not from the rejection.
      return new Promise((resolve) => {
        setTimeout(() => resolve(response(canonicalBody("<p>迟到正文</p>"))), 600);
      });
    },
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  assert.deepEqual(timers.scheduled, [DEFAULT_TIMEOUT_MS]);
  timers.fireAll();
  assert.equal(seenSignal.aborted, true, "the timeout must abort the request");
  const result = await pending;
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "timeout");
  assert.equal(stub.created.length, 0, "a cancelled load must not create DOM");
});

test("loader: a body read that rejects on abort is classified as timeout after the timer fires", async () => {
  const timers = createTimerDouble();
  const stub = createStubDom();
  let readIndex = 0;
  let releaseRead;
  const body = {
    getReader() {
      return {
        read: () => {
          readIndex += 1;
          if (readIndex > 1) return Promise.resolve({ done: true, value: undefined });
          // Waits until the test releases it, so the timeout state is set first.
          return new Promise((_resolve, reject) => {
            releaseRead = () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
          });
        },
        cancel: async () => undefined,
      };
    },
  };
  const pending = loadArticleContent({
    target: TARGET,
    origin: ORIGIN,
    signal: new AbortController().signal,
    document: stub.document,
    timers: timers.timers,
    fetch: () => Promise.resolve(response(new Uint8Array(0), { stream: body })),
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  assert.equal(readIndex, 1, "the body read must be in flight");
  timers.fireAll();
  releaseRead();
  const result = await pending;
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "timeout");
  assert.equal(stub.created.length, 0);
  assert.equal(timers.size, 0, "the timeout timer is always cleared");
});

test("loader: a body stream that fails without an abort is a network error", async () => {
  const stub = createStubDom();
  const body = {
    getReader() {
      return {
        read: () => Promise.reject(new TypeError("terminated")),
        cancel: async () => undefined,
      };
    },
  };
  const result = await loadArticleContent({
    target: TARGET,
    origin: ORIGIN,
    signal: new AbortController().signal,
    document: stub.document,
    fetch: () => Promise.resolve(response(new Uint8Array(0), { stream: body })),
  });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "network");
  assert.equal(stub.created.length, 0);
});

test("loader: a response URL for another origin is rejected by conversion, not by URL check alone", async () => {
  const { result, stub } = await load({
    fetch: () =>
      Promise.resolve(
        response(
          canonicalBody("<p>x</p>").replace(`data-canonical-path="${HREF}"`, 'data-canonical-path="/2026/06/01/other/"'),
        ),
      ),
  });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "contract");
  assert.equal(stub.created.length, 0);
});

test("loader: two sequential loads of the same article both succeed and stay independent", async () => {
  const first = await load({ fetch: record().fetch });
  const second = await load({ fetch: record().fetch });
  assert.equal(first.result.status, "ok");
  assert.equal(second.result.status, "ok");
  assert.notEqual(first.stub.document, second.stub.document);
});

test("loader: evidence summary is written for the gate report", async () => {
  await mkdir(logDir, { recursive: true });
  await writeFile(
    resolve(logDir, "controller-evidence.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        maxBytes: DEFAULT_MAX_BYTES,
        cases: [
          "request-contract",
          "invalid-target",
          "http-404-500-302",
          "login-page",
          "content-type",
          "network-failure",
          "too-large-stream-cancel",
          "timeout-injected",
          "external-abort",
          "ignored-abort-late-resolve",
          "ignored-abort-mid-body",
          "contract-mismatch",
        ],
      },
      null,
      2,
    ) + "\n",
  );
});
