/**
 * IR5 `compat` suite: the same core reading flow on another engine.
 *
 * Only the core switches are judged here (open, read, scroll, directory,
 * error/fallback, focus, backdrop blur). The per-engine results are recorded for
 * IR6b; IR5 does not convert a missing engine into a pass.
 */
import { closeReaderByEscape, contextSnapshot, labScene, openArticleDetail, openReader, openReaderExpect, pathMatcher, poll, readerSnapshot, sleep } from "./harness.mjs";

export async function runCompatSuite(runtime, { lab }) {
  const injected = [];
  const record = (options, run) => labScene(runtime, { ...options, suite: "compat" }, run);

  await record({ name: "core-flow", ignoreConsole: () => injected }, async (scene) => {
    const { page, check, equal, near, record: put, shot } = scene;
    const href = await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
    // The injected 500 below is on purpose; the browser logs it for every engine.
    injected.push(encodeURI(href), href);
    const beforeOpen = await page.evaluate(contextSnapshot);
    const reader = await openReader(page);
    put("engine", await page.evaluate(() => navigator.userAgent));
    put("reader", { load: reader.load, nodes: reader.contentNodes, textLength: reader.textLength });
    await shot("ready");
    equal(reader.load, "ready", "核心流程：文章就绪");
    check(reader.contentNodes > 0, "核心流程：有正文节点");
    equal(reader.linkHref, href, "核心流程：独立文章页链接正确");

    // The panel is still travelling when the content becomes ready; geometry is
    // only meaningful once the entry animation has settled.
    await poll(
      page,
      readerSnapshot,
      (state) => state.progress === null || state.progress >= 0.999,
      15_000,
      "panel settled",
    );

    const layout = await page.evaluate(() => {
      const sheet = document.querySelector(".reader-sheet");
      const toolbar = document.querySelector(".reader-toolbar");
      const close = document.querySelector(".reader-close");
      const backdropElement = document.querySelector(".reader-backdrop");
      const backdrop = getComputedStyle(backdropElement);
      const rect = sheet.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return {
        sheet: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        toolbarHeight: Math.round(toolbar.getBoundingClientRect().height),
        close: { width: Math.round(closeRect.width), height: Math.round(closeRect.height) },
        backdropFilter: backdrop.backdropFilter || backdrop.webkitBackdropFilter || "none",
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    put("layout", layout);
    check(layout.sheet.height > 300, "核心流程：面板高度合理", layout.sheet.height);
    check(layout.sheet.y + layout.sheet.height <= layout.viewport.height + 1, "核心流程：面板贴底不越界", layout.sheet);
    check(/blur/.test(layout.backdropFilter), "核心流程：背景模糊生效", layout.backdropFilter);

    const scrolled = await page.evaluate(() => {
      const scroll = document.querySelector(".reader-scroll");
      scroll.scrollTop = scroll.scrollHeight;
      return { top: scroll.scrollTop, height: scroll.scrollHeight, client: scroll.clientHeight };
    });
    await page.waitForTimeout(300);
    put("scrolled", scrolled);
    equal(scrolled.top + scrolled.client, scrolled.height, "核心流程：面板内可滚到文末");
    equal(await page.evaluate(() => window.scrollY), 0, "核心流程：页面本身不滚动");

    // --- table of contents: in-panel anchor navigation ---
    await page.evaluate(() => {
      document.querySelector(".reader-scroll").scrollTop = 0;
    });
    const toc = await page.evaluate(async () => {
      const link = document.querySelector('.reader-content nav a[href^="#"]');
      if (!link) return null;
      const scroll = document.querySelector(".reader-scroll");
      const before = scroll.scrollTop;
      link.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      const ids = new Set([...document.querySelectorAll(".reader-content [id]")].map((element) => element.id));
      const fragment = decodeURIComponent(link.getAttribute("href").slice(1));
      return { before, after: scroll.scrollTop, target: fragment, resolved: ids.has(fragment), text: link.textContent.trim() };
    });
    put("toc", toc);
    check(toc !== null, "核心流程：目录链接存在", toc);
    if (toc) {
      check(toc.resolved, "核心流程：目录锚点在面板内可解析", toc);
      check(toc.after > toc.before, "核心流程：点击目录在面板内定位", toc);
    }

    // --- focus order stays inside the dialog ---
    await page.evaluate(() => document.querySelector(".reader-close")?.focus());
    const tabTrace = [];
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press("Tab");
      tabTrace.push(await page.evaluate(() => document.querySelector("dialog.article-reader")?.contains(document.activeElement) ?? false));
    }
    put("tabTrace", tabTrace);
    check(tabTrace.every(Boolean), "核心流程：Tab 不逃出 dialog", tabTrace);

    const context = await page.evaluate(contextSnapshot);
    put("context", context);
    equal(context.mode, "detail", "核心流程：阅读期间 mode 未变");
    equal(context.inputSuspended, true, "核心流程：阅读期间输入已锁定");
    near(context.rotation, beforeOpen.rotation, 0.001, "核心流程：阅读期间旋转未变");

    await closeReaderByEscape(page);
    await sleep(400);
    const after = await page.evaluate(contextSnapshot);
    const focus = await page.evaluate(() => document.activeElement === document.querySelector('[data-action="read-immersive"]'));
    put("after", after);
    put("focusRestored", focus);
    equal(after.mode, "detail", "核心流程：收起后仍在详情");
    equal(after.inputSuspended, false, "核心流程：收起后释放输入锁");
    check(focus, "核心流程：收起后焦点回到入口");

    // Error path on this engine too.
    const route = pathMatcher(href);
    await page.route(route, (handler) => handler.fulfill({ status: 500, contentType: "text/html", body: "<!doctype html>err" }));
    const errored = await openReaderExpect(page, "error");
    put("error", { load: errored.load, code: errored.errorCode, retry: errored.retryVisible, inline: errored.inlineLinkHref });
    equal(errored.load, "error", "核心流程：错误面板可用");
    check(errored.retryVisible && errored.inlineLinkHref === href, "核心流程：错误面板提供重试与独立页");
    await page.unroute(route);
    await closeReaderByEscape(page);
    const recovered = await poll(page, readerSnapshot, (state) => state.open === false, 10_000, "closed after error");
    equal(recovered.open, false, "核心流程：错误面板可收起");
  });
}
