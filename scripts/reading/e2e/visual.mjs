/**
 * IR6 `visual` suite: device matrix, visual states, accessibility traversal and
 * zoom behaviour (plan §12.1–§12.2).
 *
 * Each environment captures the six documented states (before / entering 50% /
 * open / end / exiting 50% / after) plus a code-overflow shot on narrow screens,
 * and judges the panel against an independent implementation of the CONTRACT §7
 * formulas — the expectations here are written from the contract, not imported
 * from `shared/reading/geometry.ts`.
 */
import { closeReaderByEscape, contextSnapshot, labScene, openArticleDetail, pathMatcher, poll, readerSnapshot, sleep, clickSelector } from "./harness.mjs";
import { FIXTURE_POST_ID, FIXTURE_POST_PATH, readFixtureArticleHtml } from "../fixtures/build-fixture-site.mjs";

/** Modal window expectations, derived from CONTRACT §7 (independent of the code). */
function expectedWindow(width, height) {
  const portrait = width / height < 1.05;
  const compact = portrait || width < 1100;
  if (compact) {
    const edge = 20;
    const topEdge = 16;
    const bottomEdge = 12;
    const available = Math.max(0, width - edge * 2);
    const availableHeight = Math.max(0, height - topEdge - bottomEdge);
    const windowWidth = Math.min(760, available);
    const windowHeight = Math.min(850, availableHeight);
    return {
      layout: portrait ? "portrait" : "compact",
      width: windowWidth,
      height: windowHeight,
      left: edge + Math.max(0, (available - windowWidth) / 2),
      top: topEdge + Math.max(0, (availableHeight - windowHeight) / 2),
      narrow: width <= 900,
      fontSize: width <= 900 ? 16 : 18,
      windowPaddingX: 20,
    };
  }
  const scale = height / 1080;
  const margin = 100 * scale;
  const windowWidth = Math.min(1260 * scale, Math.max(0, width - margin));
  const windowHeight = Math.min(836 * scale, height);
  return {
    layout: "desktop",
    width: windowWidth,
    height: windowHeight,
    left: Math.max(0, (width - windowWidth) / 2),
    top: Math.max(0, (height - windowHeight) / 2),
    narrow: width <= 900,
    fontSize: 18,
    windowPaddingX: 53 * scale,
  };
}
const DESKTOP_ENVIRONMENTS = [
  { name: "desktop-1366-768-dark", viewport: { width: 1366, height: 768 }, colorScheme: "dark" },
  { name: "desktop-1920-1080-dark", viewport: { width: 1920, height: 1080 }, colorScheme: "dark" },
  { name: "desktop-2560-1440-dark", viewport: { width: 2560, height: 1440 }, colorScheme: "dark" },
  { name: "desktop-1366-768-light", viewport: { width: 1366, height: 768 }, colorScheme: "light" },
  { name: "desktop-1366-768-reduced", viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "reduce" },
  // Browser zoom 200% halves the CSS viewport while doubling the device pixel
  // ratio; this is the same layout box a 1366×768 window gets at 200% zoom.
  { name: "desktop-1366-768-zoom200", viewport: { width: 683, height: 384 }, deviceScaleFactor: 2, colorScheme: "dark" },
];

const MOBILE_ENVIRONMENTS = [
  { name: "mobile-390-844", viewport: { width: 390, height: 844 } },
  { name: "mobile-430-932", viewport: { width: 430, height: 932 } },
  { name: "mobile-844-390-landscape", viewport: { width: 844, height: 390 } },
];

/**
 * Slow the panel animation so a 360ms/280ms transition can be sampled exactly.
 *
 * The reader also arms a `duration + 60` safety timer; without stretching it the
 * state machine would settle long before the slowed animation ends, so that
 * fallback timer is stretched by the same factor. Only the sheet's own
 * transitions are re-rated.
 */
const INSTALL_MOTION_PROBE = () => {
  const originalAnimate = Element.prototype.animate;
  const originalSetTimeout = window.setTimeout;
  const FACTOR = 0.06;
  window.__ir6RestoreMotion = () => {
    Element.prototype.animate = originalAnimate;
    window.setTimeout = originalSetTimeout;
  };
  Element.prototype.animate = function (keyframes, options) {
    const animation = originalAnimate.call(this, keyframes, options);
    const duration = typeof options === "number" ? options : (options?.duration ?? 0);
    if (this.classList?.contains("reader-sheet") && Number(duration) > 0) animation.updatePlaybackRate(FACTOR);
    return animation;
  };
  window.setTimeout = function (handler, delay, ...rest) {
    // READER_ENTER_MS + 60 and READER_LEAVE_MS + 60 are the motion fallbacks.
    const adjusted = delay === 420 || delay === 340 ? Math.round(delay / FACTOR) : delay;
    return originalSetTimeout.call(this, handler, adjusted, ...rest);
  };
};

const HOLD_SHEET = (hold) => {
  const surface = [document.querySelector(".reader-backdrop"), document.querySelector(".reader-sheet")].filter(Boolean);
  const animations = surface.flatMap((element) => element.getAnimations());
  for (const animation of animations) {
    if (hold) animation.pause();
    else animation.play();
  }
  return animations.length;
};

/** Computed-style facts the visual judgement needs. */
const panelFacts = () => {
  const dialog = document.querySelector("dialog.article-reader");
  const sheet = document.querySelector(".reader-sheet");
  const toolbar = document.querySelector(".reader-toolbar");
  const close = document.querySelector(".reader-close");
  const content = document.querySelector(".reader-content");
  const scroll = document.querySelector(".reader-scroll");
  // The dim layer is the shared `.reader-backdrop` (the top-layer ::backdrop is clear).
  const backdropElement = dialog?.querySelector(".reader-backdrop") ?? null;
  const backdrop = backdropElement ? getComputedStyle(backdropElement) : null;
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  };
  const parseColor = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (foreground, background) => {
    const a = luminance(foreground);
    const b = luminance(background);
    const [light, dark] = a > b ? [a, b] : [b, a];
    return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
  };
  const paragraph = [...(content?.querySelectorAll("p") ?? [])].find((element) => (element.textContent ?? "").length > 60) ?? content?.querySelector("p");
  const heading = content?.querySelector("h1, h2");
  const sheetColor = parseColor(sheet ? getComputedStyle(sheet).backgroundColor : null) ?? { r: 0, g: 0, b: 0, a: 1 };
  const background = { r: sheetColor.r, g: sheetColor.g, b: sheetColor.b };
  const textColor = parseColor(paragraph ? getComputedStyle(paragraph).color : null);
  const headingStyle = heading ? getComputedStyle(heading) : null;
  const headingColor = parseColor(headingStyle?.color ?? null);
  const headingSize = heading ? Number.parseFloat(headingStyle.fontSize) : 0;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    visualViewport: window.visualViewport
      ? { width: Math.round(window.visualViewport.width), height: Math.round(window.visualViewport.height), scale: window.visualViewport.scale, offsetTop: window.visualViewport.offsetTop }
      : null,
    sheet: rect(sheet),
    toolbar: rect(toolbar),
    close: rect(close),
    scrollHost: rect(scroll),
    content: { x: rect(content)?.x ?? null, width: rect(content)?.width ?? null, scrollWidth: content?.scrollWidth ?? null, clientWidth: content?.clientWidth ?? null },
    scrollState: scroll ? { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, scrollTop: scroll.scrollTop } : null,
    sheetOverflowX: sheet ? sheet.scrollWidth - sheet.clientWidth : null,
    // `scrollWidth - clientWidth` also counts the scroll track, so overflow is
    // judged from the layout boxes: nothing *visible* (except a container that
    // scrolls its own content horizontally) may stick out of the window. The
    // collapsed navigation panel is excluded — it is `visibility: hidden` and
    // deliberately overlaps the window edge so it meets the tick bars when shown.
    outsideSheet: (() => {
      if (!sheet) return null;
      const bounds = sheet.getBoundingClientRect();
      const outside = [];
      const walk = (element) => {
        for (const child of element.children) {
          const box = child.getBoundingClientRect();
          const style = getComputedStyle(child);
          const visible = style.visibility !== "hidden" && style.display !== "none" && Number.parseFloat(style.opacity) > 0.05;
          if (visible && box.width > 0 && (box.right > bounds.right + 1 || box.left < bounds.left - 1) && !["auto", "scroll"].includes(style.overflowX)) {
            outside.push({ tag: child.tagName.toLowerCase(), className: (child.className || "").toString().slice(0, 40) });
          }
          if (["auto", "scroll"].includes(style.overflowX)) continue;
          walk(child);
        }
      };
      walk(sheet);
      return outside.slice(0, 6);
    })(),
    backdropFilter: backdrop ? backdrop.backdropFilter || backdrop.webkitBackdropFilter : null,
    backdropColor: backdrop ? backdrop.backgroundColor : null,
    sheetBackground: sheet ? getComputedStyle(sheet).backgroundColor : null,
    fontSize: content ? getComputedStyle(content).fontSize : null,
    cssVars: sheet
      ? {
          width: sheet.style.getPropertyValue("--reader-width"),
          left: sheet.style.getPropertyValue("--reader-left"),
          top: sheet.style.getPropertyValue("--reader-top"),
          height: sheet.style.getPropertyValue("--reader-height"),
          offsetTop: sheet.style.getPropertyValue("--reader-offset-top"),
        }
      : null,
    contrast: {
      text: textColor ? ratio(textColor, background) : null,
      textSample: (paragraph?.textContent ?? "").slice(0, 24),
      heading: headingColor ? ratio(headingColor, background) : null,
      headingFontSize: headingSize,
    },
    pageScrollY: window.scrollY,
    activeElementLabel: document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.className ?? null,
  };
};

export async function runVisualSuite(runtime, { lab }) {
  const record = (options, run) => labScene(runtime, { ...options, suite: "visual" }, run);

  const environmentScene = (environment, mobile) =>
    record(
      {
        name: environment.name,
        viewport: environment.viewport,
        ...(environment.colorScheme ? { colorScheme: environment.colorScheme } : {}),
        ...(environment.reducedMotion ? { reducedMotion: environment.reducedMotion } : {}),
        ...(environment.deviceScaleFactor ? { deviceScaleFactor: environment.deviceScaleFactor } : {}),
        ...(mobile ? { hasTouch: true, isMobile: runtime.browserName !== "firefox" } : {}),
      },
      async (scene) => {
        const { page, check, equal, near, record: put } = scene;
        const reduced = environment.reducedMotion === "reduce";
        const href = await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
        put("href", href);
        const closed = await page.evaluate(readerSnapshot);
        equal(closed.open, false, "阅读前 reader 关闭");
        await scene.shot("01-before");

        // The shared modal transition is a 300ms fade + 12px rise, so the frame is
        // captured early and the measured progress is recorded with it rather than
        // asserted against a band (the modal dialogs have no such band either).
        if (!reduced) await page.evaluate(INSTALL_MOTION_PROBE);
        await clickSelector(page, '[data-action="read-immersive"]');
        await page.waitForTimeout(reduced ? 150 : 260);
        const enteringState = await page.evaluate(readerSnapshot);
        const enteringProgress = enteringState.progress;
        put("entering", { progress: enteringProgress, animations: enteringState.animations.length, reduced });
        if (reduced) check(enteringProgress === null || enteringProgress >= 0.99, "reduced 模式无进入过渡", enteringProgress);
        await scene.shot("02-entering");
        if (!reduced) await page.evaluate(HOLD_SHEET, false);

        await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "reader ready");
        // Settled means the shared transition has finished *and* cancelled its
        // fill, otherwise a leftover transform would shift the measured window.
        await poll(page, readerSnapshot, (state) => (state.progress === null || state.progress >= 0.999) && state.animations.length === 0, 30_000, "surface settled");
        await page.evaluate(() => window.__ir6RestoreMotion?.());
        const facts = await page.evaluate(panelFacts);
        put("open", facts);
        put("enteringProgress", enteringProgress);
        const expected = expectedWindow(environment.viewport.width, environment.viewport.height);
        put("expected", expected);
        near(facts.sheet.width, expected.width, 2, "窗口宽度符合弹框公式");
        near(facts.sheet.height, expected.height, 2, "窗口高度符合弹框公式");
        near(facts.sheet.x, expected.left, 2, "窗口左边距符合弹框公式");
        near(facts.sheet.y, expected.top, 2, "窗口顶部符合弹框公式");
        near(facts.sheet.y + facts.sheet.height / 2, facts.viewport.height / 2, 2, "窗口垂直居中");
        near(facts.sheet.x + facts.sheet.width / 2, facts.viewport.width / 2, 2, "窗口水平居中");
        equal(facts.fontSize, `${expected.fontSize}px`, "正文字号符合契约公式");
        check(
          typeof facts.sheetOverflowX === "number" && facts.sheetOverflowX <= 12,
          "面板不横向溢出（余量仅来自滚动条轨道）",
          facts.sheetOverflowX,
        );
        check((facts.outsideSheet ?? []).length === 0, "窗口内没有内容横向越界", facts.outsideSheet);
        check(facts.close.width >= 44 && facts.close.height >= 44, "关闭控件命中区不小于 44×44", facts.close);
        check(facts.toolbar.height >= 56, "工具栏高度不小于 56px", facts.toolbar.height);
        check(
          facts.scrollHost.y >= facts.sheet.y - 1 && facts.scrollHost.y + facts.scrollHost.height <= facts.sheet.y + facts.sheet.height + 1,
          "滚动区在面板内",
          { scrollHost: facts.scrollHost, sheet: facts.sheet },
        );
        check(facts.content.x >= facts.sheet.x && facts.content.x + facts.content.width <= facts.sheet.x + facts.sheet.width + 1, "正文宽度不越出面板", {
          content: facts.content,
          sheet: facts.sheet,
        });
        equal(facts.content.scrollWidth - facts.content.clientWidth, 0, "正文自身不产生横向滚动");
        equal(facts.pageScrollY, 0, "页面本身未滚动");
        check(/blur\((1[0-9]|2[0-9])px\)/.test(facts.backdropFilter ?? ""), "背景复用弹框遮罩的模糊", facts.backdropFilter);
        check(!/rgba\(0, 0, 0, 0\)|transparent/.test(facts.backdropColor ?? ""), "遮罩有可见底色", facts.backdropColor);
        check((facts.contrast.text ?? 0) >= 4.5, "正文对比度 ≥4.5:1", facts.contrast);
        const largeText = facts.contrast.headingFontSize >= 24;
        check((facts.contrast.heading ?? 0) >= (largeText ? 3 : 4.5), `标题对比度 ≥${largeText ? 3 : 4.5}:1`, facts.contrast);
        await scene.shot("03-open");

        const end = await page.evaluate(() => {
          const scroll = document.querySelector(".reader-scroll");
          scroll.scrollTop = scroll.scrollHeight;
          const last = document.querySelector(".reader-content p:last-of-type");
          return {
            top: scroll.scrollTop,
            height: scroll.scrollHeight,
            client: scroll.clientHeight,
            lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
            sheetBottom: Math.round(document.querySelector(".reader-sheet").getBoundingClientRect().bottom),
          };
        });
        put("end", end);
        equal(end.top + end.client, end.height, "面板内可滚到文末");
        check(end.lastBottom === null || end.lastBottom <= end.sheetBottom + 1, "文末段落不越出面板", end);
        await page.waitForTimeout(200);
        await scene.shot("04-end");

        if (expected.narrow) {
          const code = await page.evaluate(() => {
            const pre = document.querySelector(".reader-content pre");
            if (!pre) return null;
            pre.scrollIntoView({ block: "center" });
            const scroll = document.querySelector(".reader-scroll");
            scroll.scrollTop = Math.max(0, scroll.scrollTop - 40);
            return { scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, overflowX: getComputedStyle(pre).overflowX, top: Math.round(pre.getBoundingClientRect().top) };
          });
          put("codeOverflow", code);
          if (code) {
            check(code.scrollWidth >= code.clientWidth, "代码块保留自身横向滚动容器", code);
            equal(code.overflowX, "auto", "代码块 overflow-x 为 auto");
            await scene.shot("05-code-hscroll");
          }
        }

        // Exit at ~50%: with the transition stretched the frame can be held.
        if (!reduced) await page.evaluate(INSTALL_MOTION_PROBE);
        await page.keyboard.press("Escape");
        if (!reduced) {
          await poll(page, readerSnapshot, (state) => state.progress !== null && state.progress <= 0.7, 30_000, "exiting");
          await page.evaluate(HOLD_SHEET, true);
        }
        let held = false;
        if (!reduced) {
          // Hold the exit mid-flight where the engine keeps it on screen long
          // enough (WebKit can finish a 200ms exit before the first sample).
          const closing = await poll(page, readerSnapshot, (state) => state.state === "closing", 8_000, "closing").catch(() => null);
          if (closing) {
            await page.evaluate(HOLD_SHEET, true);
            held = true;
          }
        }
        const exitState = await page.evaluate(readerSnapshot);
        put("exiting", { progress: exitState.progress, state: exitState.state, held });
        if (!reduced) check(exitState.state === "closing" || exitState.open === false, "退出帧在关闭过程中捕获", exitState);
        await scene.shot("06-exiting");
        if (!reduced) {
          await page.evaluate(HOLD_SHEET, false);
          await page.evaluate(() => window.__ir6RestoreMotion?.());
        }
        await poll(page, readerSnapshot, (state) => state.open === false, 30_000, "closed");
        await sleep(400);
        const after = await page.evaluate(contextSnapshot);
        const afterFacts = await page.evaluate(panelFacts);
        put("after", { context: after, facts: afterFacts });
        equal(after.mode, "detail", "收起后仍在详情");
        equal(after.inputSuspended, false, "收起后输入锁释放");
        const focus = await page.evaluate(() => ({
          restored: document.activeElement === document.querySelector('[data-action="read-immersive"]'),
          active: document.activeElement?.tagName ?? null,
          label: document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.className ?? null,
        }));
        put("focus", focus);
        check(focus.restored, "收起后焦点回到入口", focus);
        await scene.shot("07-after");
      },
    );

  for (const environment of DESKTOP_ENVIRONMENTS) await environmentScene(environment, false);
  for (const environment of MOBILE_ENVIRONMENTS) await environmentScene(environment, true);

  // -------------------------------------------------------------------------
  // Touch scrolling must move the prose, not the page
  // -------------------------------------------------------------------------
  await record(
    { name: "touch-scrolling", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: runtime.browserName !== "firefox" },
    async (scene) => {
      const { page, check, equal, record: put } = scene;
      if (runtime.browserName !== "chromium") {
        // Playwright only exposes tap on non-Chromium engines; the drag gesture
        // needs CDP, so touch scrolling is judged on Chromium and recorded here.
        await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
        await clickSelector(page, '[data-action="read-immersive"]');
        await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
        await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.999, 20_000, "settled");
        const closePoint = await page.evaluate(() => {
          const rect = document.querySelector(".reader-close").getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        });
        await page.touchscreen.tap(closePoint.x, closePoint.y);
        const closed = await poll(page, readerSnapshot, (state) => state.open === false, 20_000, "closed by tap");
        const context = await page.evaluate(contextSnapshot);
        put("skipped", "该引擎无 CDP，触摸拖动只在 Chromium 判定；此处验证触摸点击");
        put("tap", { closed: closed.open === false, mode: context.mode });
        equal(closed.open, false, "触摸点击下箭头可收起");
        equal(context.mode, "detail", "触摸收起后仍在详情");
        return;
      }
      await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
      await clickSelector(page, '[data-action="read-immersive"]');
      const ready = await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
      check(ready.load === "ready", "移动视口下 reader 就绪");
      await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.999, 20_000, "settled");
      const before = await page.evaluate(readerSnapshot);
      const box = await page.evaluate(() => {
        const rect = document.querySelector(".reader-scroll").getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
      });
      const x = Math.round((box.left + box.right) / 2);
      const startY = Math.round(box.top + (box.bottom - box.top) * 0.65);
      const client = await page.context().newCDPSession(page);
      // A real touch drag: synthesizeScrollGesture is ignored for touch here, so
      // the gesture is dispatched as an explicit touch event sequence.
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY }] });
      for (let step = 1; step <= 14; step += 1) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: startY - step * 22 }] });
        await page.waitForTimeout(16);
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(900);
      const after = await page.evaluate(readerSnapshot);
      const context = await page.evaluate(contextSnapshot);
      put("scroll", { before: before.scrollTop, after: after.scrollTop, box, pageScrollY: context.scrollY, mode: context.mode });
      await scene.shot("touch-scrolled");
      check(after.scrollTop > before.scrollTop + 50, "触摸拖动滚动面板正文", { before: before.scrollTop, after: after.scrollTop });
      equal(context.scrollY, 0, "触摸拖动未滚动页面");
      equal(context.mode, "detail", "触摸拖动未改变 mode");
      // Wheel/touch momentum inside the panel must not leak to the stage.
      const closePoint = await page.evaluate(() => {
        const rect = document.querySelector(".reader-close").getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      });
      await page.touchscreen.tap(closePoint.x, closePoint.y);
      const closed = await poll(page, readerSnapshot, (state) => state.open === false, 20_000, "closed by tap");
      equal(closed.open, false, "触摸点击下箭头可收起");
      const afterTap = await page.evaluate(contextSnapshot);
      equal(afterTap.mode, "detail", "触摸收起后仍在详情");
    },
  );

  // -------------------------------------------------------------------------
  // Accessibility traversal and naming
  // -------------------------------------------------------------------------
  await record({ name: "accessibility-traversal", viewport: { width: 1366, height: 768 }, colorScheme: "dark" }, async (scene) => {
    const { page, check, equal, record: put } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
    await clickSelector(page, '[data-action="read-immersive"]');
    await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
    await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.999, 20_000, "settled");

    const naming = await page.evaluate(() => {
      const dialog = document.querySelector("dialog.article-reader");
      const labelledby = dialog.getAttribute("aria-labelledby");
      const label = labelledby ? document.getElementById(labelledby) : null;
      const status = dialog.querySelector(".reader-status");
      const toc = dialog.querySelector("nav");
      const close = dialog.querySelector(".reader-close");
      const inline = dialog.querySelector(".reader-article-link");
      return {
        role: dialog.getAttribute("role"),
        labelledby,
        labelText: label?.textContent?.trim() ?? null,
        statusRole: status?.getAttribute("role"),
        statusText: status?.textContent ?? null,
        statusHidden: status?.hidden ?? null,
        tocLabel: toc?.getAttribute("aria-label") ?? null,
        tocHeadings: [...dialog.querySelectorAll("nav a")].slice(0, 3).map((element) => element.textContent.trim()),
        closeLabel: close?.getAttribute("aria-label") ?? null,
        closeTitle: close?.getAttribute("title") ?? null,
        closeText: close?.textContent ?? null,
        closeIcon: Boolean(close?.querySelector(".reader-close-icon")),
        articleLinkText: inline?.textContent ?? null,
        headingCount: dialog.querySelectorAll("h1, h2, h3").length,
        firstHeading: dialog.querySelector("h1, h2, h3")?.textContent?.trim() ?? null,
      };
    });
    put("naming", naming);
    equal(naming.role, null, "dialog 使用原生角色（未覆盖 role）");
    check(Boolean(naming.labelledby) && (naming.labelText?.length ?? 0) > 3, "dialog 由标题元素命名", naming);
    equal(naming.statusRole, "status", "加载状态使用 role=status");
    check((naming.tocLabel ?? "").length > 0, "目录导航有 aria-label", naming.tocLabel);
    check((naming.tocHeadings?.length ?? 0) > 0, "目录包含可读链接", naming.tocHeadings);
    check((naming.closeLabel ?? "").length > 0, "关闭按钮有无障碍名称", naming.closeLabel);
    equal((naming.closeText ?? "").replace(/\s+/g, " ").trim(), "CLOSE", "关闭按钮复用系统弹框的 CLOSE 文案（× 由 CSS 绘制）");
    check(Boolean(naming.closeIcon), "关闭按钮含与弹框同源的 × 图标元素");
    check((naming.headingCount ?? 0) >= 7, "标题结构完整", naming.headingCount);

    // Real Tab/Shift+Tab through the browser; focus must not escape the dialog.
    await page.evaluate(() => document.querySelector(".reader-close")?.focus());
    const tabTrace = [];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      tabTrace.push(await page.evaluate(() => ({ inside: document.querySelector("dialog.article-reader")?.contains(document.activeElement) ?? false, label: document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.tagName ?? null })));
    }
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Shift+Tab");
      tabTrace.push(await page.evaluate(() => ({ inside: document.querySelector("dialog.article-reader")?.contains(document.activeElement) ?? false, label: document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.tagName ?? null })));
    }
    put("tabTrace", tabTrace);
    check(tabTrace.every((entry) => entry.inside), "真实 Tab/Shift+Tab 未逃出 dialog", tabTrace);

    // Focus ring must be visible on the close control.
    const focusRing = await page.evaluate(() => {
      const close = document.querySelector(".reader-close");
      close.focus();
      const style = getComputedStyle(close);
      return { outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, outlineColor: style.outlineColor, boxShadow: style.boxShadow };
    });
    put("focusRing", focusRing);
    check(
      Number.parseFloat(focusRing.outlineWidth) > 0 || /rgb/.test(focusRing.boxShadow ?? ""),
      "焦点在关闭按钮上可见",
      focusRing,
    );

    await page.evaluate(() => document.querySelector(".reader-close")?.focus());
    const keyboard = {};
    for (const key of ["PageDown", "PageUp", "End", "Home", "ArrowDown", "ArrowUp"]) {
      const before = await page.evaluate(() => document.querySelector(".reader-scroll").scrollTop);
      await page.keyboard.press(key);
      await page.waitForTimeout(140);
      const after = await page.evaluate(() => document.querySelector(".reader-scroll").scrollTop);
      keyboard[key] = { before, after };
    }
    put("keyboard", keyboard);
    check(keyboard.PageDown.after > keyboard.PageDown.before, "PageDown 向下滚动", keyboard.PageDown);
    check(keyboard.PageUp.after < keyboard.PageUp.before, "PageUp 向上滚动", keyboard.PageUp);
    check(keyboard.End.after > keyboard.PageUp.after, "End 跳到文末方向", keyboard.End);
    equal(keyboard.Home.after, 0, "Home 回到文首");
    check(keyboard.ArrowDown.after > keyboard.Home.after, "ArrowDown 向下滚动", keyboard.ArrowDown);
    check(keyboard.ArrowUp.after <= keyboard.ArrowDown.after, "ArrowUp 向上滚动", keyboard.ArrowUp);

    // Copy/selection must stay usable inside the panel.
    const selection = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll(".reader-content p")].find((element) => (element.textContent ?? "").length > 60);
      if (!paragraph) return { length: 0, head: "" };
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const active = document.getSelection();
      active.removeAllRanges();
      active.addRange(range);
      const text = String(active);
      active.removeAllRanges();
      return { length: text.length, head: text.slice(0, 24) };
    });
    put("selection", selection);
    check(selection.length > 40, "正文可被选中（复制路径可用）", selection);
    await scene.shot("selection");

    const closed = await closeReaderByEscape(page);
    equal(closed.open, false, "Esc 收起");
  });

  // -------------------------------------------------------------------------
  // The dialog chrome: the exit control and the independent-article entry reuse
  // the three system dialogs' "CLOSE ×" treatment (no frame, same typography).
  // -------------------------------------------------------------------------
  for (const theme of ["dark", "light"]) {
    await record({ name: `closing-controls-${theme}`, viewport: { width: 1366, height: 768 }, colorScheme: theme }, async (scene) => {
      const { page, check, equal, record: put } = scene;
      const readControls = () => {
        const facts = (element) => {
          if (!element) return null;
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          const icon = element.querySelector("span");
          const dot = icon ? getComputedStyle(icon, "::before") : null;
          return {
            text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
            fontSize: style.fontSize,
            letterSpacing: style.letterSpacing,
            gap: style.gap,
            borderTopWidth: style.borderTopWidth,
            borderTopStyle: style.borderTopStyle,
            backgroundImage: style.backgroundImage,
            backgroundColor: style.backgroundColor,
            boxShadow: style.boxShadow,
            padding: style.padding,
            width: Math.round(box.width),
            height: Math.round(box.height),
            iconWidth: icon ? Math.round(icon.getBoundingClientRect().width) : null,
            iconHeight: icon ? Math.round(icon.getBoundingClientRect().height) : null,
            barWidth: dot?.width ?? null,
            barHeight: dot?.height ?? null,
            barBackground: dot?.backgroundColor ?? null,
          };
        };
        const dialogs = [...document.querySelectorAll(".modal-top button")];
        const bar = dialogs[0]?.closest(".modal-top");
        const barStyle = bar ? getComputedStyle(bar) : null;
        // The dialogs live inside the scaled #stage, so their client rects carry the
        // stage scale; the reader sits in the top layer at CSS-pixel scale.
        const stageTransform = getComputedStyle(document.querySelector("#stage") ?? document.body).transform;
        const matrix = /matrix\(([^)]+)\)/.exec(stageTransform);
        const stageScale = matrix ? Number.parseFloat(matrix[1].split(",")[0]) : 1;
        return {
          stageScale,
          dialogs: dialogs.map(facts),
          dialogBar: barStyle ? { fontSize: barStyle.fontSize, letterSpacing: barStyle.letterSpacing } : null,
          articleLink: facts(document.querySelector("dialog.article-reader .reader-article-link")),
          close: facts(document.querySelector("dialog.article-reader .reader-close")),
        };
      };

      await page.evaluate(() => document.querySelector('[data-action="search"]')?.click());
      await page.waitForTimeout(500);
      const modal = await page.evaluate(readControls);
      put("modal", modal);
      check(modal.dialogs.length >= 1, "ARCHIVE INDEX 弹框带 CLOSE × 控件", modal.dialogs.length);
      check(
        modal.dialogs.every((entry) => /^CLOSE\s*×$/.test(entry.text)),
        "系统弹框文案为 CLOSE + ×",
        modal.dialogs.map((entry) => entry.text),
      );
      // The dialogs' authored metrics (unscaled): CONTRACT §7 reference values.
      // They live inside the scaled #stage, so their client rects carry the scale
      // and land on a device pixel — hence the sub-pixel tolerance.
      const firstScale = modal.stageScale;
      const firstUnscaled = (value) => value / firstScale;
      check(Math.abs(firstUnscaled(modal.dialogs[0].iconWidth) - 16) <= 1.5, "CLOSE 的 × 盒宽 16px", firstUnscaled(modal.dialogs[0].iconWidth));
      check(Math.abs(firstUnscaled(modal.dialogs[0].iconHeight) - 34) <= 1.5, "CLOSE 的 × 盒高 34px", firstUnscaled(modal.dialogs[0].iconHeight));
      equal(modal.dialogs[0].barWidth, "14px", "CLOSE 的两笔 14×2");
      equal(modal.dialogs[0].gap, "24px", "CLOSE 文本与 × 间距 24px");
      equal(modal.dialogs[0].fontSize, "10px", "CLOSE 字号 10px");
      check(modal.stageScale > 0, "取到舞台缩放", modal.stageScale);
      await page.evaluate(() => document.querySelector('[data-action="close-modal"]')?.click());
      await page.waitForTimeout(500);

      await openArticleDetail(page, lab.displayIdFor("wp-38"), "wp-38");
      await clickSelector(page, '[data-action="read-immersive"]');
      await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
      await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.999, 20_000, "settled");
      const reader = await page.evaluate(readControls);
      put("reader", reader);

      const reference = modal.dialogs[0];
      const scale = modal.stageScale;
      const unscaled = (value) => Math.round((value / scale) * 10) / 10;
      // "CLOSE ×": the dialogs carry the × as a text node, the reader draws it with
      // CSS pseudo-elements, so both are compared on the CLOSE label here.
      equal(reader.close.text.replace(/\u00a0/g, " ").trim(), reference.text.replace(/\s*×\s*$/, "").trim(), "退出控件与系统弹框同文案（CLOSE）");
      for (const property of ["fontSize", "letterSpacing", "gap", "borderTopWidth", "borderTopStyle", "backgroundImage", "padding"]) {
        equal(reader.close[property], reference[property], `退出控件 ${property} 与 CLOSE 一致`);
      }
      equal(reader.close.iconWidth, Math.round(unscaled(reference.iconWidth)), "退出控件的 × 与 CLOSE 同宽（折算舞台缩放）");
      equal(reader.close.iconHeight, Math.round(unscaled(reference.iconHeight)), "退出控件的 × 与 CLOSE 同高（折算舞台缩放）");
      equal(reader.close.barWidth, reference.barWidth, "× 的两笔与 CLOSE 同宽");
      equal(reader.close.barHeight, reference.barHeight, "× 的两笔与 CLOSE 同粗");
      equal(reader.close.barBackground, reference.barBackground, "× 跟随 currentColor");
      equal(reader.close.boxShadow, reference.boxShadow, "退出控件没有额外投影");
      check((reader.dialogBar?.fontSize ?? "") !== "", "工具条取到弹框顶栏排版", reader.dialogBar);
      check(
        reader.close.width >= 44 && reader.close.height >= 44,
        "退出控件命中区不小于 44×44",
        { width: reader.close.width, height: reader.close.height },
      );
      check(
        Math.abs(reader.close.width - unscaled(reference.width)) <= 10,
        "退出控件与 CLOSE 的实际宽度一致（44px 命中区带来的 ≤10px 余量）",
        { reader: reader.close.width, dialog: unscaled(reference.width) },
      );

      equal(reader.articleLink.fontSize, reference.fontSize, "独立文章页入口与 CLOSE 同字号");
      equal(reader.articleLink.letterSpacing, reference.letterSpacing, "独立文章页入口与 CLOSE 同字距");
      equal(reader.articleLink.borderTopWidth, "0px", "独立文章页入口没有可见边框");
      equal(reader.articleLink.backgroundColor, "rgba(0, 0, 0, 0)", "独立文章页入口没有底色");
      check((reader.articleLink.text ?? "").length > 0, "独立文章页入口保留可读文案", reader.articleLink.text);
      equal(reader.articleLink.height, reader.close.height, "独立文章页入口与退出控件同一行高（44px 命中区）");

      // The two toolbar actions must not read as a single run-on control: at least
      // two Chinese characters of separation at the toolbar's own font size. The
      // fit is judged from the action cluster's right edge — Firefox/WebKit report a
      // toolbar `scrollWidth` ~8px wider than `clientWidth` on this nowrap row even
      // though every child box ends inside the window.
      const separation = await page.evaluate(() => {
        const link = document.querySelector(".reader-article-link");
        const close = document.querySelector(".reader-close");
        const toolbar = document.querySelector(".reader-toolbar");
        if (!link || !close || !toolbar) return null;
        const linkBox = link.getBoundingClientRect();
        const closeBox = close.getBoundingClientRect();
        const toolbarBox = toolbar.getBoundingClientRect();
        const style = getComputedStyle(toolbar);
        const rightEdge = toolbarBox.right - Number.parseFloat(style.paddingRight || "0") - Number.parseFloat(style.borderRightWidth || "0");
        return {
          gap: Math.round((closeBox.left - linkBox.right) * 10) / 10,
          fontSize: Number.parseFloat(getComputedStyle(link).fontSize),
          actionsRight: Math.round(closeBox.right),
          contentRight: Math.round(rightEdge),
          outside: document.querySelectorAll(".reader-toolbar .reader-actions > :not([hidden])").length,
        };
      });
      put("separation", separation);
      check(
        separation !== null && separation.gap >= separation.fontSize * 2,
        "独立文章页入口与退出控件至少隔开两个中文字符",
        separation,
      );
      check(
        separation !== null && separation.actionsRight <= separation.contentRight + 1,
        "操作区右缘不越出工具栏内容盒",
        separation,
      );

      await scene.shot("closing-controls");
      await closeReaderByEscape(page);
    });
  }

  // -------------------------------------------------------------------------
  // Navigation rail, scrollbar and dark-mode prose legibility. The rail is a view
  // of the headings Astro already emitted, so the anchor targets are compared
  // against the prose itself instead of a hard-coded list.
  // -------------------------------------------------------------------------
  for (const theme of ["dark", "light"]) {
    await record({ name: `rail-and-legibility-${theme}`, viewport: { width: 1440, height: 900 }, colorScheme: theme }, async (scene) => {
      const { page, check, equal, record: put } = scene;
      await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
      await clickSelector(page, '[data-action="read-immersive"]');
      await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
      await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.999, 20_000, "settled");

      const readRail = () => {
        const rail = document.querySelector(".reader-toc");
        const panel = document.querySelector(".reader-toc-panel");
        const ticks = [...document.querySelectorAll(".reader-toc-tick")];
        const links = [...document.querySelectorAll(".reader-toc-link")];
        const scroll = document.querySelector(".reader-scroll");
        const headingIds = [...document.querySelectorAll(".reader-content .prose h2, .reader-content .prose h3, .reader-content .prose h4")].map((heading) => heading.id);
        const panelStyle = panel ? getComputedStyle(panel) : null;
        const scrollStyle = scroll ? getComputedStyle(scroll) : null;
        return {
          hidden: rail?.hidden ?? null,
          tickCount: ticks.length,
          linkCount: links.length,
          hrefs: links.map((link) => link.getAttribute("href")),
          headingIds: headingIds.map((id) => `#${id}`),
          ticksAreTabStops: ticks.filter((tick) => tick.tabIndex >= 0).length,
          panelVisibility: panelStyle?.visibility ?? null,
          panelOpacity: panelStyle?.opacity ?? null,
          scrollbarWidth: scrollStyle?.scrollbarWidth ?? null,
          scrollbarColor: scrollStyle?.scrollbarColor ?? null,
          horizontalOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
          activeTicks: ticks.filter((tick) => tick.classList.contains("is-active")).length,
          activeLabel: links.find((link) => link.classList.contains("is-active"))?.textContent ?? null,
          railRect: (() => {
            const box = document.querySelector(".reader-toc")?.getBoundingClientRect();
            return box ? { x: Math.round(box.x), right: Math.round(box.right), width: Math.round(box.width) } : null;
          })(),
          sheetRect: (() => {
            const box = document.querySelector(".reader-sheet")?.getBoundingClientRect();
            return box ? { x: Math.round(box.x), right: Math.round(box.right), width: Math.round(box.width) } : null;
          })(),
        };
      };

      const collapsed = await page.evaluate(readRail);
      put("collapsed", collapsed);
      check(collapsed.hidden === false, "目录导航在长文上可见", collapsed.hidden);
      check(collapsed.tickCount === collapsed.headingIds.length, "刻度数量等于正文标题数量", { ticks: collapsed.tickCount, headings: collapsed.headingIds.length });
      check(collapsed.tickCount >= 8, "样本长文提供了足够的目录项", collapsed.tickCount);
      check(collapsed.hrefs.every((href) => collapsed.headingIds.includes(href)), "每个目录项都指向正文里已存在的锚点", collapsed.hrefs.slice(0, 3));
      equal(collapsed.ticksAreTabStops, 0, "刻度本身不是 Tab 停靠点（面板链接才是）");
      check(collapsed.panelVisibility === "hidden", "默认收起，链接不在 Tab 顺序中", collapsed.panelVisibility);
      // Firefox reports `none` for `scrollbar-width: thin` in this environment and
      // WebKit does not implement `scrollbar-color` at all (the declaration is
      // still in the stylesheet); the stylesheet content itself is asserted by the
      // unit tests, so these two accept the engine's own reporting.
      check(["thin", "none"].includes(collapsed.scrollbarWidth ?? ""), "阅读区滚动条与弹框一致（thin 而非默认宽度）", collapsed.scrollbarWidth);
      check(
        collapsed.scrollbarColor === null || /rgba|color\(/.test(collapsed.scrollbarColor ?? ""),
        "滚动条颜色来自主题",
        collapsed.scrollbarColor,
      );      equal(collapsed.horizontalOverflow, 0, "目录栏不产生横向滚动");
      check(
        collapsed.railRect !== null &&
          collapsed.sheetRect !== null &&
          Math.abs(collapsed.railRect.right - collapsed.sheetRect.right) <= 6,
        "目录栏贴在窗口右缘（滚动条一侧，用户指出的位置）",
        { rail: collapsed.railRect, sheet: collapsed.sheetRect },
      );

      const railBox = await page.evaluate(() => {
        // Hover must land on a tick bar: the rail column itself deliberately does
        // not expand the panel.
        const tick = document.querySelectorAll(".reader-toc-tick")[0];
        const box = (tick ?? document.querySelector(".reader-toc-rail")).getBoundingClientRect();
        return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
      });
      await page.mouse.move(railBox.x, railBox.y);
      await page.waitForTimeout(450);
      const expanded = await page.evaluate(readRail);
      put("expanded", expanded);
      put("hoverPoint", railBox);
      check(expanded.panelVisibility === "visible" && expanded.panelOpacity === "1", "悬停刻度条展开目录面板", { visibility: expanded.panelVisibility, hoverPoint: railBox });
      // The panel and the bars must read as one piece: no slit between them.
      const seam = await page.evaluate(() => {
        const panel = document.querySelector(".reader-toc-panel")?.getBoundingClientRect();
        const tick = document.querySelector(".reader-toc-tick");
        const bar = tick ? getComputedStyle(tick, "::before") : null;
        const tickBox = tick?.getBoundingClientRect();
        const barRight = tickBox && bar ? tickBox.right - (tickBox.width - Number.parseFloat(bar.width)) / 2 : null;
        return { panelRight: panel ? Math.round(panel.right) : null, barRight: barRight === null ? null : Math.round(barRight) };
      });
      put("seam", seam);
      check(
        seam.panelRight !== null && seam.barRight !== null && seam.panelRight >= seam.barRight,
        "展开面板与刻度条之间没有缝隙",
        seam,
      );
      const rail = await page.evaluate(() => {
        const nav = document.querySelector(".reader-toc");
        const railElement = document.querySelector(".reader-toc-rail");
        return {
          buttons: nav ? nav.querySelectorAll("button").length : null,
          railText: railElement ? (railElement.textContent ?? "").trim() : null,
          hasToggleElement: Boolean(document.querySelector(".reader-toc-toggle")),
        };
      });
      put("rail", rail);
      equal(rail.buttons, 0, "目录栏内没有按钮");
      equal(rail.railText, "", "目录栏内没有可见文字（含“目录”）");
      equal(rail.hasToggleElement, false, "不存在“目录”按钮元素");
      await scene.shot("rail-expanded");

      const before = await page.evaluate(() => document.querySelector(".reader-scroll").scrollTop);
      await page.evaluate(() => document.querySelectorAll(".reader-toc-link")[5]?.click());
      await page.waitForTimeout(1200);
      const jumped = await page.evaluate(readRail);
      const scrolled = await page.evaluate(() => document.querySelector(".reader-scroll").scrollTop);
      put("afterJump", { ...jumped, scrollTop: scrolled, before });
      check(scrolled > before + 100, "点击目录在面板内定位", { before, after: scrolled });
      equal(jumped.activeTicks, 1, "同时只有一个激活项");
      check((jumped.activeLabel ?? "").length > 0, "激活项有可读标题", jumped.activeLabel);
      check(
        await page.evaluate(() => ["h2", "h3", "h4"].includes(document.activeElement?.tagName?.toLowerCase() ?? "")),
        "跳转后焦点落到标题上",
        await page.evaluate(() => document.activeElement?.tagName ?? null),
      );

      // A picked entry pins the outline; a click on the prose must close it again
      // (this is the reported touch dead end, and it applies to the pointer too).
      const pinned = await page.evaluate(() => document.querySelector(".reader-toc")?.classList.contains("is-pinned") ?? null);
      put("pinnedAfterPick", pinned);
      check(pinned === true, "选中目录项后面板保持展开");
      const prosePoint = await page.evaluate(() => {
        const scroll = document.querySelector(".reader-scroll");
        const panel = document.querySelector(".reader-toc-panel").getBoundingClientRect();
        const box = scroll.getBoundingClientRect();
        return { x: Math.max(box.left + 12, panel.left - 60), y: Math.round(box.top + box.height / 2) };
      });
      await page.mouse.click(prosePoint.x, prosePoint.y);
      await page.waitForTimeout(450);
      const afterOutside = await page.evaluate(readRail);
      put("afterOutsideTap", { ...afterOutside, point: prosePoint });
      check(afterOutside.panelVisibility === "hidden", "点击目录外的正文可收起目录", { visibility: afterOutside.panelVisibility, point: prosePoint });
      equal(
        await page.evaluate(() => document.querySelector("dialog.article-reader")?.open ?? null),
        true,
        "收起目录后阅读层仍在",
      );

      // Prose legibility: the shared prosestyle defaults to a light palette, which
      // used to leave quotes and inline code unreadable on the dark window.
      const legibility = await page.evaluate(() => {
        const parse = (value) => {
          const text = (value ?? "").trim();
          const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(text);
          if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
          const rgb = /rgba?\(([^)]+)\)/.exec(text);
          if (!rgb) return null;
          const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number.parseFloat);
          return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
        };
        const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
        const luminance = ({ r, g, b }) => {
          const channel = (value) => {
            const scaled = value / 255;
            return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const ratio = (foreground, background) => {
          const a = luminance(foreground);
          const b = luminance(background);
          const [light, dark] = a > b ? [a, b] : [b, a];
          return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
        };
        const sheet = document.querySelector(".reader-sheet");
        const sheetColor = parse(getComputedStyle(sheet).backgroundColor) ?? { r: 32, g: 42, b: 47, a: 1 };
        const pageColor = parse(getComputedStyle(document.documentElement).backgroundColor) ?? { r: 17, g: 24, b: 27, a: 1 };
        const background = sheetColor.a < 1 ? over(sheetColor, pageColor) : sheetColor;
        const sample = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const computed = getComputedStyle(element);
          const color = parse(computed.color) ?? { r: 255, g: 255, b: 255, a: 1 };
          const own = parse(computed.backgroundColor);
          const behind = own && own.a > 0.5 ? over(own, background) : background;
          return { selector, color: computed.color, fontSize: computed.fontSize, ratio: ratio(color.a < 1 ? over(color, behind) : color, behind) };
        };
        const tocLink = document.querySelector(".reader-content .toc a");
        return {
          structure: {
            quotes: document.querySelectorAll(".reader-content blockquote").length,
            inlineCode: document.querySelectorAll(".reader-content :not(pre) > code").length,
            pre: document.querySelectorAll(".reader-content pre").length,
            tocSections: document.querySelectorAll(".reader-content .toc").length,
          },
          tocLinkColor: tocLink ? getComputedStyle(tocLink).color : null,
          items: [
            sample(".reader-content .prose p"),
            sample(".reader-content blockquote"),
            sample(".reader-content .prose h2"),
            sample(".reader-content .toc a"),
            sample(".reader-content .toc-title"),
            sample(".reader-status"),
          ].filter(Boolean),
        };
      });
      put("legibility", legibility);
      check(legibility.structure.quotes > 0, "样本文章包含引用块", legibility.structure);
      check(
        !/rgb\(0,\s*0,\s*238\)/.test(legibility.tocLinkColor ?? ""),
        "链接不再是浏览器默认蓝（复用博客的链接配色）",
        legibility.tocLinkColor,
      );
      for (const item of legibility.items) {
        check(item.ratio >= 4.5, `对比度 ≥4.5:1 ${item.selector}`, { ratio: item.ratio, color: item.color, fontSize: item.fontSize });
      }
      // A picked entry keeps the panel pinned, so the first Esc closes the panel
      // and only the second one collapses the reader (contract §7/§8). After the
      // outside click above the panel is already closed, so only one Esc is needed.
      const pinnedNow = await page.evaluate(() => document.querySelector(".reader-toc")?.classList.contains("is-pinned") ?? null);
      if (pinnedNow === true) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(350);
        const afterFirstEsc = await page.evaluate(() => ({
          pinned: document.querySelector(".reader-toc")?.classList.contains("is-pinned") ?? null,
          readerOpen: document.querySelector("dialog.article-reader")?.open ?? null,
        }));
        put("afterFirstEsc", afterFirstEsc);
        check(afterFirstEsc.pinned === false && afterFirstEsc.readerOpen === true, "第一次 Esc 收起目录面板、阅读层仍在", afterFirstEsc);
      }
      await closeReaderByEscape(page);
    });
  }

  // -------------------------------------------------------------------------
  // Markdown presentation (IR11): the reference theme's structure — hairline
  // rules, two-tone quote, ruled tables, framed code, square corners — rendered
  // with the reader's own palette. Judged on the complex-Markdown fixture, which
  // is the only document carrying every element the reader supports.
  // -------------------------------------------------------------------------
  await record({ name: "markdown-presentation", viewport: { width: 1440, height: 900 }, colorScheme: "dark" }, async (scene) => {
    const { page, check, equal, record: put } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
    const href = await page.evaluate(() => document.querySelector('[data-action="read-immersive"]')?.getAttribute("href") ?? null);
    const fixtureHtml = await readFixtureArticleHtml();
    const body = fixtureHtml
      .replaceAll(`data-post-id="${FIXTURE_POST_ID}"`, 'data-post-id="wp-55"')
      .replaceAll(`data-canonical-path="${FIXTURE_POST_PATH}"`, `data-canonical-path="${href}"`);
    await page.route(pathMatcher(href), (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }));
    await clickSelector(page, '[data-action="read-immersive"]');
    await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
    await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.999, 20_000, "settled");

    const markdown = await page.evaluate(() => {
      const radius = (element) => getComputedStyle(element).borderTopLeftRadius;
      const describe = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const computed = getComputedStyle(element);
        return {
          color: computed.color,
          backgroundAlpha: (() => {
            // Chromium serialises `color-mix()` as `color(srgb r g b / a)` (0..1
            // floats, slash-separated) and plain colours as `rgba(r, g, b, a)`.
            const value = computed.backgroundColor ?? "";
            const slash = /^color\([^/]+\/\s*([\d.]+)\s*\)$/.exec(value.trim());
            if (slash) return Number.parseFloat(slash[1]);
            const match = /rgba?\(([^)]+)\)/.exec(value);
            if (!match) return 0;
            const parts = match[1].split(/[,\s/]+/).filter(Boolean);
            return parts.length > 3 ? Number.parseFloat(parts[3]) : 1;
          })(),
          borderLeft: `${computed.borderLeftWidth} ${computed.borderLeftStyle}`,
          borderBottom: `${computed.borderBottomWidth} ${computed.borderBottomStyle}`,
          borderTop: `${computed.borderTopWidth} ${computed.borderTopStyle}`,
          padding: computed.padding,
          fontWeight: computed.fontWeight,
          textAlign: computed.textAlign,
        };
      };
      const accent = (() => {
        const reader = document.querySelector("dialog.article-reader");
        return reader ? getComputedStyle(reader).getPropertyValue("--reader-accent").trim() : null;
      })();
      const quote = document.querySelector(".reader-content .prose blockquote");
      return {
        structure: {
          headings: document.querySelectorAll(".reader-content .prose h2").length,
          tableRows: document.querySelectorAll(".reader-content .prose table tr").length,
          quotes: document.querySelectorAll(".reader-content .prose blockquote").length,
          code: document.querySelectorAll(".reader-content .prose pre").length,
          checkboxes: document.querySelectorAll('.reader-content .prose input[type="checkbox"]').length,
          details: document.querySelectorAll(".reader-content .prose details").length,
        },
        accent,
        h2: describe(".reader-content .prose h2"),
        quote: describe(".reader-content .prose blockquote"),
        quoteBar: quote ? getComputedStyle(quote).borderLeftColor : null,
        table: describe(".reader-content .prose table"),
        th: describe(".reader-content .prose th"),
        stripedCell: describe(".reader-content .prose tbody tr:nth-child(2n) td"),
        pre: describe(".reader-content .prose pre"),
        inlineCode: describe(".reader-content .prose :not(pre) > code"),
        details: describe(".reader-content .prose details"),
        checkbox: (() => {
          const box = document.querySelector('.reader-content .prose input[type="checkbox"]');
          if (!box) return null;
          const computed = getComputedStyle(box);
          return { appearance: computed.appearance, width: computed.width, height: computed.height, radius: computed.borderTopLeftRadius, accentColor: computed.accentColor };
        })(),
        radiusViolations: [...document.querySelectorAll(".reader-content *")].filter((element) => radius(element) !== "0px").length,
      };
    });
    put("markdown", markdown);
    equal(markdown.radiusViolations, 0, "窗口内全部 markdown 元素为直角");
    check(markdown.structure.headings >= 5, "夹具覆盖多个标题", markdown.structure);
    check(markdown.structure.tableRows >= 3 && markdown.structure.quotes >= 1 && markdown.structure.code >= 2, "夹具覆盖表格/引用/代码块", markdown.structure);
    equal(markdown.h2?.borderBottom, "1px solid", "标题用 1px 细线分隔");
    equal(markdown.quote?.borderLeft, "3px solid", "引用块有 3px 强调色竖条");
    check(markdown.quoteBar === markdown.accent, "竖条颜色等于读者强调色 token", { bar: markdown.quoteBar, accent: markdown.accent });
    check((markdown.quote?.backgroundAlpha ?? 0) > 0.04 && (markdown.quote?.backgroundAlpha ?? 0) < 0.2, "引用块有强调色洗底（双层）", markdown.quote?.backgroundAlpha);
    equal(markdown.table?.borderTop, "1px solid", "表格为 1px 细线外框");
    equal(markdown.th?.borderBottom, "1px solid", "表头单元格有 1px 细线");
    check((markdown.th?.backgroundAlpha ?? 0) > 0.03 && (markdown.stripedCell?.backgroundAlpha ?? 0) > 0.02, "表头有底色且正文行有条纹", {
      th: markdown.th?.backgroundAlpha,
      stripe: markdown.stripedCell?.backgroundAlpha,
    });
    equal(markdown.th?.textAlign, "left", "表头左对齐");
    equal(markdown.pre?.borderTop, "1px solid", "代码块有 1px 直角边框");
    check((markdown.inlineCode?.backgroundAlpha ?? 0) > 0.02, "行内代码有中性底色", markdown.inlineCode?.backgroundAlpha);
    equal(markdown.checkbox?.appearance, "none", "任务列表复选框由样式绘制（平台蓝已消除）");
    equal(markdown.checkbox?.radius, "0px", "复选框为直角");
    equal(markdown.details?.borderTop, "1px solid", "details 折叠块为 1px 直角边框");
    await scene.shot("markdown-presentation");
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // The dim layer is the shared modal backdrop: without a filter it must still
  // be opaque enough to hide the stage.
  // -------------------------------------------------------------------------
  await record({ name: "backdrop-fallback", viewport: { width: 1366, height: 768 }, colorScheme: "dark" }, async (scene) => {
    const { page, check, equal, record: put } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-38"), "wp-38");
    await clickSelector(page, '[data-action="read-immersive"]');
    await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
    await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.99, 20_000, "settled");
    const styles = await page.evaluate(() => {
      const layer = document.querySelector(".reader-backdrop");
      const computed = getComputedStyle(layer);
      const before = { filter: computed.backdropFilter, color: computed.backgroundColor };
      const tag = document.createElement("style");
      tag.id = "ir6-fallback";
      tag.textContent = ".reader-backdrop{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:rgba(227, 224, 215, 0.85)!important}";
      document.head.appendChild(tag);
      const after = getComputedStyle(layer);
      return { before, after: { filter: after.backdropFilter, color: after.backgroundColor }, sharesModalClass: layer.classList.contains("modal-backdrop") };
    });
    put("backdrop", styles);
    await scene.shot("fallback-backdrop");
    check(styles.sharesModalClass, "遮罩层复用 .modal-backdrop", styles);
    check(/blur\((1[0-9]|2[0-9])px\)/.test(styles.before.filter ?? ""), "默认遮罩带模糊", styles.before);
    check(!/rgba\(0, 0, 0, 0\)|transparent/.test(styles.before.color ?? ""), "默认遮罩有可见底色", styles.before);
    equal(styles.after.filter, "none", "测试注入后滤镜被关闭");
    check(/0\.85/.test(styles.after.color), "无滤镜时遮罩保持不透明", styles.after.color);
    await page.evaluate(() => document.getElementById("ir6-fallback")?.remove());
    const restored = await page.evaluate(() => getComputedStyle(document.querySelector(".reader-backdrop")).backdropFilter);
    check(/blur\((1[0-9]|2[0-9])px\)/.test(restored), "移除注入后恢复模糊", restored);
    await closeReaderByEscape(page);
  });
  // -------------------------------------------------------------------------
  // Pinch zoom: a magnified page must never be shrunk back
  // -------------------------------------------------------------------------
  await record(
    { name: "pinch-zoom", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: runtime.browserName !== "firefox" },
    async (scene) => {
      const { page, check, equal, record: put } = scene;
      if (runtime.browserName !== "chromium") {
        put("skipped", `${runtime.browserName} 不支持 CDP 页面缩放指令`);
        return;
      }
      await openArticleDetail(page, lab.displayIdFor("wp-38"), "wp-38");
      await clickSelector(page, '[data-action="read-immersive"]');
      await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "ready");
      await poll(page, readerSnapshot, (state) => state.progress === null || state.progress >= 0.999, 20_000, "settled");
      const client = await page.context().newCDPSession(page);
      await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
      await page.waitForTimeout(400);
      const zoomed = await page.evaluate(() => {
        const sheet = document.querySelector(".reader-sheet");
        const view = window.visualViewport;
        return {
          scale: view.scale,
          layoutWidth: window.innerWidth,
          visualWidth: Math.round(view.width),
          offsetTop: sheet.style.getPropertyValue("--reader-offset-top"),
          offsetLeft: sheet.style.getPropertyValue("--reader-offset-left"),
          sheetLeft: Math.round(sheet.getBoundingClientRect().left),
          sheetWidth: Math.round(sheet.getBoundingClientRect().width),
        };
      });
      put("zoomed", zoomed);
      await scene.shot("pinched");
      check((zoomed.scale ?? 1) > 1.5, "页面确实处于放大状态", zoomed.scale);
      check(zoomed.offsetTop === "" || zoomed.offsetTop === "0px", "放大时不做视觉视口补偿（不被缩回）", zoomed.offsetTop);
      check(zoomed.offsetLeft === "" || zoomed.offsetLeft === "0px", "放大时左侧同样不补偿", zoomed.offsetLeft);
      check(zoomed.sheetLeft >= 0, "面板仍在布局视口内", zoomed.sheetLeft);
      check(zoomed.sheetWidth > 200, "放大不影响面板布局宽度", zoomed.sheetWidth);
      await page.keyboard.press("Escape");
      const closed = await poll(page, readerSnapshot, (state) => state.open === false, 20_000, "closed while zoomed");
      equal(closed.open, false, "放大状态下 Esc 仍可收起");
      await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await page.waitForTimeout(300);
      const reset = await page.evaluate(() => window.visualViewport.scale);
      check(Math.abs(reset - 1) < 0.01, "缩放已复位", reset);
    },
  );
}
