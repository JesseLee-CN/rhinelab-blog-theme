/**
 * Shared harness for the IR5 Playwright suites (plan §11.1).
 *
 * Everything here is deliberately product-agnostic: it boots the real `/lab/`
 * through the user-visible GUEST path, polls `window.rhine.stats()` instead of
 * guessing at WebGL timing, and records evidence per scene. Suites only add
 * assertions.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Archive display ids for the real posts, from the generated lab content. */
export async function loadLabContent() {
  const raw = await readFile(resolve(root, ".generated/lab-content.json"), "utf8");
  const parsed = JSON.parse(raw);
  const displayIdFor = (postId) => parsed.records.find((record) => record.postId === postId)?.id ?? null;
  const slotsFor = (postId) => parsed.records.filter((record) => record.postId === postId).map((record) => record.id);
  return { records: parsed.records, columns: parsed.columns, displayIdFor, slotsFor };
}

/** The publications the runner judges; every expected value is read from content. */
export async function loadPublished() {
  const { loadEntries } = await import("../../blog/check-reader.mjs");
  const { posts, pages, published, hidden } = await loadEntries();
  const publishedSet = new Set(published);
  return {
    posts: posts.filter((entry) => publishedSet.has(entry)),
    pages: pages.filter((entry) => publishedSet.has(entry)),
    hidden,
  };
}

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Poll a page-side reader until the predicate accepts its value. */
export async function poll(page, read, predicate, timeout, label) {
  const started = Date.now();
  let last;
  let error = null;
  while (Date.now() - started < timeout) {
    try {
      last = await page.evaluate(read);
      error = null;
    } catch (caught) {
      error = caught;
    }
    if (error === null && predicate(last)) return last;
    await page.waitForTimeout(50);
  }
  throw new Error(`轮询超时（${label}）：${JSON.stringify(last)}${error ? ` 错误=${error}` : ""}`);
}

export const clickSelector = (page, selector) => page.evaluate((s) => document.querySelector(s)?.click(), selector);

/**
 * Match a request against a canonical article path.
 *
 * The canonical paths in the lab content are decoded (`/2026/08/16/学习…/`) while
 * a request URL is always percent-encoded, so the comparison has to decode — a
 * raw string comparison silently matches nothing and the suite would then judge
 * the real article instead of the injected fixture.
 */
export const pathMatcher = (canonicalPath) => (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname) === canonicalPath;
  } catch {
    return false;
  }
};

/** Reader state, including the live sheet transform used for motion evidence. */
export const readerSnapshot = () => {
  const dialog = document.querySelector("dialog.article-reader");
  const sheet = document.querySelector(".reader-sheet");
  const scroll = document.querySelector(".reader-scroll");
  const error = document.querySelector(".reader-error");
  // The shared modal transition fades the backdrop and rises the window by 12px,
  // so the transition progress is read from the backdrop opacity.
  const backdrop = document.querySelector(".reader-backdrop");
  const transform = sheet ? getComputedStyle(sheet).transform : "none";
  const opacity = backdrop ? Number.parseFloat(getComputedStyle(backdrop).opacity) : null;
  return {
    exists: Boolean(dialog),
    open: dialog?.open ?? false,
    state: dialog?.getAttribute("data-state") ?? null,
    load: dialog?.getAttribute("data-load") ?? null,
    errorCode: dialog?.getAttribute("data-error-code") ?? null,
    contentNodes: document.querySelector(".reader-content")?.childElementCount ?? 0,
    scrollTop: scroll?.scrollTop ?? null,
    scrollHeight: scroll?.scrollHeight ?? null,
    clientHeight: scroll?.clientHeight ?? null,
    active: dialog?.contains(document.activeElement) ?? false,
    activeLabel: (document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.className ?? document.activeElement?.tagName ?? "")
      .toString()
      .slice(0, 40),
    textLength: (document.querySelector(".reader-content")?.textContent ?? "").length,
    text: (document.querySelector(".reader-content")?.textContent ?? "").slice(0, 120),
    linkHref: document.querySelector(".article-reader .reader-article-link")?.getAttribute("href") ?? null,
    errorVisible: error ? !error.hidden : false,
    errorText: (error?.textContent ?? "").slice(0, 120),
    retryVisible: document.querySelector(".reader-retry")?.hidden === false,
    inlineLinkHref: document.querySelector(".reader-article-link-inline")?.getAttribute("href") ?? null,
    progress: Number.isFinite(opacity) ? Math.round((backdrop.hidden ? 0 : opacity) * 1000) / 1000 : null,
    transform,
    backdropHidden: backdrop?.hidden ?? null,
    animations: sheet ? sheet.getAnimations().map((animation) => animation.playState) : [],
  };
};

/** Main-application context that must survive an immersive reading session. */
export const contextSnapshot = () => {
  const stats = window.rhine?.stats();
  const detail = document.querySelector("#detail-content");
  const panel = document.querySelector("#tab-panel");
  return {
    mode: stats?.mode,
    postId: stats?.selected,
    selectedSlot: stats?.selectedSlot,
    selectedLane: stats?.selectedLane,
    activeTab: document.querySelector("[data-tab].active")?.getAttribute("data-tab") ?? null,
    detailScrollTop: detail?.scrollTop ?? null,
    tabPanelScrollTop: panel?.scrollTop ?? null,
    rotation: stats?.rotation ?? null,
    clearance: stats?.clearance ?? null,
    canInspect: stats?.canInspect ?? null,
    inputSuspended: stats?.inputSuspended ?? null,
    stageInert: document.querySelector("#stage")?.inert ?? null,
    detailInert: document.querySelector("#detail-ui")?.inert ?? null,
    readerDialogs: document.querySelectorAll("dialog.article-reader").length,
    reader: stats?.reader ?? null,
    activeElement: document.activeElement?.className || document.activeElement?.id || document.activeElement?.tagName || "",
    saved: stats?.saved?.length ?? null,
    accessLogRows: document.querySelectorAll("#tab-panel .log-row").length,
    scrollY: window.scrollY,
    detailScroll: document.querySelector("#detail-content")?.scrollTop ?? null,
  };
};

/** Reach the archive through the visible GUEST entry; never a review shortcut. */
export async function bootGuest(page, baseUrl, timeout = 90_000) {
  await page.goto(`${baseUrl}/lab/?scene=archive`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#boot-entry[data-phase="login"]', { timeout });
  await page.waitForFunction(() => window.rhine?.stats()?.introPhase === "ready", null, { timeout });
  await clickSelector(page, '[data-entry="guest"]');
  await poll(page, () => window.rhine?.stats()?.mode, (mode) => mode === "archive", timeout, "archive mode");
  await page.waitForTimeout(2000);
}

/**
 * Open the detail view of a record that maps to a real article, using the
 * visible archive search (the shortcut a user actually has) rather than the 3D
 * array's navigation state.
 */
export async function openArticleDetail(page, displayId, wantedPostId, timeout = 30_000) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press("/");
  await poll(page, () => Boolean(document.querySelector("#archive-search")), (found) => found === true, 20_000, "search overlay");
  await page.fill("#archive-search", displayId);
  // `fill` does not emit the input event the search field listens to.
  await page.evaluate(() => {
    document.querySelector("#archive-search")?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const results = await page.evaluate(() => document.querySelectorAll(".result-row").length);
  if (results === 0) throw new Error(`检索 ${displayId} 没有结果`);
  await page.evaluate(() => document.querySelector(".result-row")?.click());
  await poll(page, () => window.rhine?.stats()?.mode, (mode) => mode === "detail", timeout, "detail mode");
  await page.waitForTimeout(900);
  const current = await page.evaluate(() => window.rhine?.stats()?.selected);
  if (wantedPostId && current !== wantedPostId) throw new Error(`打开了 ${current}，期望 ${wantedPostId}`);
  return page.evaluate(() => document.querySelector('[data-action="read-immersive"]')?.getAttribute("href") ?? null);
}

/** Open the reader from the dedicated link and wait until it is ready. */
export async function openReader(page, timeout = 30_000) {
  return openReaderExpect(page, "ready", timeout);
}

/** Open the reader and wait for a specific load state (`ready` or `error`). */
export async function openReaderExpect(page, expected, timeout = 30_000) {
  await clickSelector(page, '[data-action="read-immersive"]');
  try {
    return await poll(page, readerSnapshot, (state) => state.load === expected, timeout, `reader ${expected}`);
  } catch (error) {
    // The decline reason is the only place the application says why a click was
    // not honoured, so a timing failure must carry it.
    const diagnostics = await page
      .evaluate(() => ({
        reader: window.rhine?.stats()?.reader ?? null,
        mode: window.rhine?.stats()?.mode ?? null,
        introPhase: window.rhine?.stats()?.introPhase ?? null,
        inputSuspended: window.rhine?.stats()?.inputSuspended ?? null,
        entry: (() => {
          const link = document.querySelector('[data-action="read-immersive"]');
          return link ? { href: link.getAttribute("href"), connected: link.isConnected, rects: link.getClientRects().length } : null;
        })(),
      }))
      .catch(() => null);
    throw new Error(`${error.message}\n  reader 诊断=${JSON.stringify(diagnostics)}`);
  }
}

export async function closeReaderByEscape(page, timeout = 20_000) {
  await page.keyboard.press("Escape");
  return poll(page, readerSnapshot, (state) => state.open === false, timeout, "reader closed");
}

/** Start the local static preview of the built `dist/` on a free port. */
export async function startPreviewServer(basePort = 5300) {
  for (let port = basePort; port < basePort + 40; port += 1) {
    const child = spawn(process.execPath, ["scripts/blog/preview.mjs", String(port)], { cwd: root, stdio: "ignore" });
    const ok = await new Promise((resolvePromise) => {
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolvePromise(value);
        }
      };
      child.on("error", () => done(false));
      child.on("exit", () => done(false));
      const probe = async (attempt) => {
        if (attempt > 60) return done(false);
        // A responder on this port is only ours while the child is still alive:
        // otherwise an orphaned preview from an earlier run would be adopted and
        // never stopped again.
        if (child.exitCode !== null || child.signalCode !== null) return done(false);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/lab/`);
          if (response.ok) return done(true);
        } catch {
          // Not listening yet.
        }
        setTimeout(() => void probe(attempt + 1), 150);
      };
      setTimeout(() => void probe(0), 150);
    });
    if (ok) return { baseUrl: `http://127.0.0.1:${port}`, stop: () => child.kill(), owned: true };
    child.kill();
    await sleep(120);
  }
  throw new Error("无法启动本地预览服务器");
}

/** Verify an externally supplied target is reachable and is really this site. */
export async function verifyBaseUrl(baseUrl) {
  const lab = await fetch(`${baseUrl}/lab/`);
  if (!lab.ok) throw new Error(`--base-url 不可达：${baseUrl}/lab/ 返回 ${lab.status}`);
  const html = await lab.text();
  if (!html.includes("/lab/assets/")) throw new Error(`--base-url 产物标记缺失：/lab/ 未引用 /lab/assets/`);
  return { labStatus: lab.status, bytes: Buffer.byteLength(html) };
}

/**
 * Collect console errors and page errors that the reader must not add.
 *
 * `ignored` may be a list of URL fragments or a function returning one; the
 * function form lets a scene register the requests it injects on purpose after
 * the scene has started.
 */
export function watchConsole(page, ignored = []) {
  const errors = [];
  const tokens = () => (typeof ignored === "function" ? ignored() : ignored) ?? [];
  const ignorable = (message) => {
    if (!/Failed to load resource/.test(message.text())) return false;
    const url = message.location()?.url ?? "";
    // The static preview has no auth service, so `/session` 404s by design.
    if (url.includes("/lab/api/auth/session") || url.endsWith("/favicon.ico") || url.endsWith("/favicon.svg")) return true;
    return tokens().some((token) => token && (url.includes(token) || decodeURIComponent(url).includes(token)));
  };
  page.on("console", (message) => {
    if (message.type() === "error" && !ignorable(message)) {
      errors.push(`${message.text()} @ ${message.location()?.url ?? "?"}`);
    }
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/**
 * One scene: its own browser context, console watch, screenshots and checks.
 * A failing check records a failure instead of aborting the whole run, so a
 * single report shows every problem.
 */
export async function runScene(runtime, options, run) {  const { browser, browserName, outDir, report } = runtime;
  const name = options.name;
  const started = Date.now();
  const checks = [];
  const evidence = {};
  const record = { name, suite: options.suite, status: "pass", checks, evidence, durationMs: 0 };
  report.cases.push(record);
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1366, height: 768 },
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
    ...(options.javaScriptEnabled === false ? { javaScriptEnabled: false } : {}),
    ...(options.deviceScaleFactor ? { deviceScaleFactor: options.deviceScaleFactor } : {}),
    ...(options.hasTouch ? { hasTouch: true } : {}),
    ...(options.isMobile ? { isMobile: true } : {}),
    ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  const page = await context.newPage();
  const consoleErrors = watchConsole(page, options.ignoreConsole ?? []);
  const shots = [];
  const client = options.screenshot === false ? null : await context.newCDPSession(page).catch(() => null);
  const shot = async (label) => {
    if (options.screenshot === false) return null;
    const file = resolve(outDir, "screenshots", `${browserName}-${name}-${label}.png`);
    await mkdir(dirname(file), { recursive: true });
    if (client) {
      const result = await client.send("Page.captureScreenshot", { format: "png" });
      await writeFile(file, Buffer.from(result.data, "base64"));
    } else {
      // Firefox/WebKit have no CDP session; the Playwright screenshot API works
      // on every engine and is only used as the fallback path.
      try {
        await page.screenshot({ path: file, timeout: 20_000 });
      } catch (error) {
        checks.push({ ok: true, message: `截图 ${label} 在该引擎上不可用：${String(error).slice(0, 80)}` });
        return null;
      }
    }
    shots.push(file.replace(root, "."));
    return file;
  };
  const check = (condition, message, detail) => {
    if (condition) {
      checks.push({ ok: true, message });
      return true;
    }
    checks.push({ ok: false, message, ...(detail === undefined ? {} : { detail }) });
    record.status = "fail";
    return false;
  };
  const equal = (actual, expected, message) =>
    check(actual === expected, message, { actual, expected });
  const near = (actual, expected, tolerance, message) =>
    check(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, message, { actual, expected, tolerance });
  const scene = { page, context, shot, check, equal, near, record: (key, value) => { evidence[key] = value; }, evidence, browserName };

  if (options.tracing !== false) {
    await context.tracing.start({ screenshots: false, snapshots: false, sources: true }).catch(() => undefined);
  }
  try {
    await run(scene);
  } catch (error) {
    record.status = "fail";
    record.error = String(error?.stack ?? error).slice(0, 2000);
  } finally {
    for (const error of consoleErrors) {
      record.status = "fail";
      checks.push({ ok: false, message: `控制台错误：${error}` });
    }
    if (record.status === "fail" && options.tracing !== false) {
      const file = resolve(outDir, "traces", `${browserName}-${name}.zip`);
      await mkdir(dirname(file), { recursive: true });
      await context.tracing.stop({ path: file }).catch(() => undefined);
      record.trace = file.replace(root, ".");
    } else if (options.tracing !== false) {
      await context.tracing.stop().catch(() => undefined);
    }
    record.screenshots = shots;
    record.durationMs = Date.now() - started;
    await context.close();
  }
  return record;
}

/**
 * A scene that needs the real archive: the context is booted through the
 * user-visible GUEST path before the scene body runs.
 */
export function labScene(runtime, options, run) {
  return runScene(runtime, options, async (scene) => {
    await bootGuest(scene.page, runtime.baseUrl);
    await run(scene);
  });
}
