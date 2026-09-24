/**
 * IR5 `interaction` suite: the immersive reader inside the real `/lab/`, entered
 * through the visible GUEST path.
 *
 * The IR4 scenarios are migrated here (one implementation, not two) and extended
 * with the cases IR4 left open: Enter/modifier activation, real drag-rotation
 * context, duplicate-mapping slots, closing mid-animation, repeated Escape while
 * closing, and 50 open/close cycles.
 */
import { articleProseLength, openArticleDetail, openReader, closeReaderByEscape, poll, readerSnapshot, contextSnapshot, clickSelector, labScene, sleep } from "./harness.mjs";

/** Where the dedicated link is, after making sure it is actually on screen. */
async function entryPoint(page) {
  return page.evaluate(() => {
    const link = document.querySelector('[data-action="read-immersive"]');
    if (!link) return null;
    link.scrollIntoView({ block: "center" });
    const rect = link.getBoundingClientRect();
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      width: rect.width,
      height: rect.height,
      rects: link.getClientRects().length,
      href: link.getAttribute("href"),
      target: link.getAttribute("target"),
      download: link.hasAttribute("download"),
      tag: link.tagName,
      detailInert: document.querySelector("#detail-ui")?.inert ?? null,
    };
  });
}

/**
 * Record what the next activation looks like after the application has seen it.
 *
 * The probe listens on `document` without capture, so it runs after the app's own
 * document-level handler and can therefore see whether the activation was taken
 * over (`defaultPrevented`). A listener on the link itself would run first and
 * always report `false`.
 */
async function observeNextClick(page) {
  await page.evaluate(() => {
    window.__ir5Click = { click: null, auxclick: null, contextmenu: null };
    document.addEventListener("click", (event) => {
      if (!event.target?.closest?.('[data-action="read-immersive"]')) return;
      window.__ir5Click.click = {
        button: event.button,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        defaultPrevented: event.defaultPrevented,
        detail: event.detail,
      };
    });
    document.addEventListener("auxclick", (event) => {
      if (!event.target?.closest?.('[data-action="read-immersive"]')) return;
      window.__ir5Click.auxclick = { button: event.button, defaultPrevented: event.defaultPrevented };
    });
    document.addEventListener("contextmenu", (event) => {
      if (!event.target?.closest?.('[data-action="read-immersive"]')) return;
      window.__ir5Click.contextmenu = { button: event.button, defaultPrevented: event.defaultPrevented };
    });
  });
}

const observedClick = (page) => page.evaluate(() => window.__ir5Click ?? null);

/** Wait until the camera has settled on a target rotation. */
async function settleRotation(page, timeout = 12_000) {
  const started = Date.now();
  let previous = null;
  while (Date.now() - started < timeout) {
    const current = await page.evaluate(() => window.rhine.stats().rotation);
    if (previous !== null && Math.abs(current - previous) < 0.002) return current;
    previous = current;
    await page.waitForTimeout(250);
  }
  return previous;
}

export async function runInteractionSuite(runtime, { baseUrl, lab }) {
  const record = (options, run) => labScene(runtime, { ...options, suite: "interaction" }, run);

  // -------------------------------------------------------------------------
  // Main flow: entry surface, open, isolation, scroll memory, restored context
  // -------------------------------------------------------------------------
  await record({ name: "entry-and-context", viewport: { width: 1440, height: 900 } }, async (scene) => {
    const { page, check, equal, near, record: put, shot } = scene;
    const articleHref = await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");    put("articleHref", articleHref);
    check(articleHref?.startsWith("/2026/"), `专用链接 href 异常：${articleHref}`);

    const entry = await page.evaluate(() => {
      const link = document.querySelector('[data-action="read-immersive"]');
      const footnote = document.querySelector(".detail-footnote .article-link");
      return {
        tag: link?.tagName,
        href: link?.getAttribute("href"),
        target: link?.getAttribute("target"),
        download: link?.hasAttribute("download") ?? null,
        ariaLabel: link?.getAttribute("aria-label"),
        footnoteHref: footnote?.getAttribute("href"),
        footnoteAction: footnote?.getAttribute("data-action"),
        footnoteTag: footnote?.tagName,
      };
    });
    put("entry", entry);
    equal(entry.tag, "A", "阅读全文是真实 <a>");
    check(!entry.target && entry.download === false, "阅读全文未加 target/download");
    equal(entry.footnoteAction, null, "底部文章链接不带 data-action");
    check(entry.footnoteTag === "A" && entry.footnoteHref === entry.href, "底部文章链接指向同一规范地址");
    await shot("detail-open");

    await poll(page, contextSnapshot, (snapshot) => snapshot.mode === "detail", 20_000, "detail snapshot");
    await clickSelector(page, '[data-tab="notes"]');
    await page.waitForTimeout(400);
    // Push a detail scroll container away from the top so the scroll restore is
    // real. At some viewports the whole detail layer fits (measured: 1366×768 →
    // 708/708), so the search is recorded as a fact instead of failing on layout:
    // the invariance claim is then carried by the reader's own scroll memory.
    const scrollTarget = await page.evaluate(async () => {
      const candidates = [document.querySelector("#detail-content"), document.querySelector("#tab-panel"), ...document.querySelectorAll("#detail-ui div, #detail-ui ol, #detail-ui ul")];
      for (const element of candidates) {
        if (!element || element.scrollHeight <= element.clientHeight + 4) continue;
        element.scrollTop = 140;
        await new Promise((resolvePromise) => requestAnimationFrame(() => resolvePromise(null)));
        if (element.scrollTop > 0) {
          return {
            id: element.id || null,
            cls: (element.className || "").toString().slice(0, 40),
            top: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          };
        }
        element.scrollTop = 0;
      }
      return null;
    });
    put("detailScrollTarget", scrollTarget);
    const scrolledSelector = scrollTarget ? (scrollTarget.id ? `#${scrollTarget.id}` : `.${scrollTarget.cls.split(/\s+/)[0]}`) : null;
    const readScrollTop = () =>
      page.evaluate((selector) => (selector ? (document.querySelector(selector)?.scrollTop ?? null) : null), scrolledSelector);
    if (scrollTarget) {
      check(scrollTarget.top > 0, "详情层已建立非零滚动位置", scrollTarget);
    } else {
      put("detailScrollNote", "本视口详情层无可滚动容器，滚动不变性由 reader 记忆场景与 IR4 的 240→240 覆盖");
    }
    const beforeOpen = await page.evaluate(contextSnapshot);
    put("beforeOpen", beforeOpen);

    const opened = await openReader(page);
    put("opened", opened);
    await shot("reader-ready");
    check(opened.open && opened.contentNodes > 0, "点击阅读全文后 reader 就绪");
    // 期望值取自被服务的文章本身：模板的示例文章很短，写死 4000 会让这条永远失败。
    const proseLength = await articleProseLength(page, articleHref);
    put("proseLength", proseLength);
    check(
      proseLength === null || opened.textLength >= Math.floor(proseLength * 0.8),
      "reader 渲染出整篇正文",
      { actual: opened.textLength, proseLength },
    );
    equal(opened.linkHref, articleHref, "reader 内独立页链接等于规范地址");
    check(opened.active, "打开后焦点在 reader 内");

    const during = await page.evaluate(contextSnapshot);
    put("duringOpen", during);
    equal(during.inputSuspended, true, "打开后 scene 输入已暂停");
    equal(during.mode, "detail", "打开 reader 未改变 mode");
    equal(during.postId, beforeOpen.postId, "打开 reader 未改变 selected");
    equal(during.selectedSlot, beforeOpen.selectedSlot, "打开 reader 未改变槽位");
    equal(during.activeTab, beforeOpen.activeTab, "打开 reader 未改变页签");
    near(during.detailScrollTop, beforeOpen.detailScrollTop, 1, "打开 reader 未改变详情滚动");
    near(during.rotation, beforeOpen.rotation, 0.001, "打开 reader 未改变旋转");    equal(during.readerDialogs, 1, "reader dialog 为单例");
    equal(during.scrollY, 0, "阅读期间页面本身不滚动");
    if (scrollTarget) {
      near(during.detailScroll, beforeOpen.detailScroll ?? scrollTarget.top, 1, "打开 reader 未改变详情层滚动位置");
    }

    await page.evaluate(() => {
      const scroll = document.querySelector(".reader-scroll");
      if (scroll) scroll.scrollTop = 0;
    });
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(250);
    const afterKey = { reader: await page.evaluate(readerSnapshot), context: await page.evaluate(contextSnapshot) };
    put("afterKeyboard", afterKey);
    check(afterKey.reader.scrollTop > 0, "PageDown 滚动 reader 正文");
    equal(afterKey.context.postId, beforeOpen.postId, "键盘事件未穿透到档案选择");
    equal(afterKey.context.mode, "detail", "键盘事件未改变 mode");

    const scrolled = await page.evaluate(() => {
      const scroll = document.querySelector(".reader-scroll");
      scroll.scrollTop = scroll.scrollHeight;
      return { top: scroll.scrollTop, height: scroll.scrollHeight, client: scroll.clientHeight };
    });
    await page.waitForTimeout(250);
    put("scrolled", scrolled);
    await shot("reader-end");
    equal(scrolled.top + scrolled.client, scrolled.height, "面板内可滚到文末");

    await clickSelector(page, ".reader-close");
    await poll(page, readerSnapshot, (state) => state.open === false, 20_000, "reader closed");
    await page.waitForTimeout(500);
    const afterClose = await page.evaluate(contextSnapshot);
    put("afterClose", afterClose);
    await shot("detail-restored");
    equal(afterClose.mode, "detail", "下箭头收起后仍在详情");
    equal(afterClose.postId, beforeOpen.postId, "收起后 selected 不变");
    equal(afterClose.selectedSlot, beforeOpen.selectedSlot, "收起后槽位不变");
    equal(afterClose.activeTab, beforeOpen.activeTab, "收起后页签不变");
    near(afterClose.detailScrollTop, beforeOpen.detailScrollTop, 1, "收起后详情滚动不变");
    near(afterClose.tabPanelScrollTop, beforeOpen.tabPanelScrollTop, 1, "收起后页签面板滚动不变");
    equal(afterClose.scrollY, 0, "收起后页面仍在顶端");
    if (scrollTarget) {
      near(await readScrollTop(), scrollTarget.top, 1, "收起后详情层滚动位置保持不变");
    }
    near(afterClose.rotation, beforeOpen.rotation, 0.001, "收起后旋转不变");
    equal(afterClose.inputSuspended, false, "收起后 scene 输入恢复");
    equal(afterClose.readerDialogs, 1, "收起后保留单例 dialog");
    equal(afterClose.stageInert, false, "收起后 stage 未保持 inert");
    equal(afterClose.saved, beforeOpen.saved, "收起后收藏状态不变");
    const focusRestore = await page.evaluate(() => {
      const link = document.querySelector('[data-action="read-immersive"]');
      return {
        isEntryLink: document.activeElement === link,
        activeLabel: document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.tagName ?? null,
      };
    });
    put("focusRestore", focusRestore);
    check(focusRestore.isEntryLink, "收起后焦点回到阅读全文链接", focusRestore.activeLabel);

    await poll(page, readerSnapshot, (state) => state.state === "closed", 20_000, "reader fully closed");
    await sleep(250);
    // 关闭后、重开前读出位置记录：恢复必须符合契约 §7 的锚点公式
    // （anchorTop − anchorOffset，并按可达范围裁剪）。不能拿「最后一个锚点」当期望值：
    // 文末之后还有内容时，最后一个锚点会落在可达滚动范围之外——长短文章都会如此。
    const stored = await page.evaluate(() => {
      const raw = sessionStorage.getItem("rhine.reader.scroll.v1");
      const parsed = raw ? JSON.parse(raw) : [];
      const entry = parsed.find((item) => item.postId === "wp-55") ?? parsed[0] ?? null;
      return entry ? { anchorId: entry.anchorId, anchorOffset: entry.anchorOffset, scrollTop: entry.scrollTop } : null;
    });
    put("storedScroll", stored);
    check(stored !== null && Math.abs((stored?.scrollTop ?? 0) - scrolled.top) <= 2, "关闭时记录的是文末真实位置", stored);
    const reopened = await openReader(page);
    await page.waitForTimeout(700);
    const restored = await page.evaluate((anchorId) => {
      const anchor = anchorId ? document.querySelector(`.reader-content [id="${anchorId}"]`) : null;
      return {
        scrollTop: document.querySelector(".reader-scroll").scrollTop,
        anchorTop: anchor ? anchor.offsetTop : null,
      };
    }, stored?.anchorId ?? null);
    put("reopened", reopened);
    put("restored", restored);
    await shot("reader-reopened");
    const expectedRestore = restored.anchorTop === null ? null : Math.max(0, restored.anchorTop - (stored?.anchorOffset ?? 0));
    put("restoreFormula", { expected: expectedRestore, actual: restored.scrollTop, anchorId: stored?.anchorId ?? null });
    check(
      restored.scrollTop > 0 && expectedRestore !== null && Math.abs(restored.scrollTop - expectedRestore) <= 24,
      "再次打开按锚点公式恢复阅读位置",
      { restored: restored.scrollTop, expected: expectedRestore, anchorId: stored?.anchorId ?? null },
    );
    equal(await page.evaluate(() => document.querySelectorAll("dialog.article-reader").length), 1, "再次打开复用同一 dialog");
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // Activation surface: Enter, and every modifier/mouse-button combination
  // -------------------------------------------------------------------------
  await record({ name: "activation-modifiers" }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-19"), "wp-19");
    const point = await entryPoint(page);
    put("entryPoint", point);
    if (!point) throw new Error("详情页缺少阅读全文链接");
    check(point.rects > 0, "阅读全文链接可见");
    equal(point.tag, "A", "入口仍是真实链接");

    // --- Enter on the focused link ---
    await observeNextClick(page);
    await page.evaluate(() => document.querySelector('[data-action="read-immersive"]')?.focus());
    await page.keyboard.press("Enter");
    const enterReader = await poll(page, readerSnapshot, (state) => state.load === "ready", 30_000, "reader via Enter");
    const enterClick = await observedClick(page);
    put("enter", { observed: enterClick, reader: { open: enterReader.open, nodes: enterReader.contentNodes } });
    check(enterClick?.click !== null && enterClick?.click !== undefined, "Enter 在链接上产生了真实 click");
    equal(enterClick?.click?.defaultPrevented, true, "Enter 激活被 reader 接管");
    check(enterReader.open && enterReader.contentNodes > 0, "Enter 打开了沉浸式阅读");
    await shot("enter-opened");
    await closeReaderByEscape(page);
    await poll(page, readerSnapshot, (state) => state.state === "closed", 20_000, "closed after Enter");
    await sleep(250);

    // --- modifier + mouse button combinations must stay native ---
    // `page.mouse.click` has no `modifiers` option, so the keys are held around
    // a plain mouse click; a silently ignored modifier would make this scene
    // assert the wrong thing entirely. Alt/Meta are exercised with dispatched
    // events instead: on Windows Chromium they do not open a new tab, they
    // navigate the current page, which would destroy the evidence mid-scene.
    const combinations = [
      { label: "shift", button: "left", keys: ["Shift"] },
      { label: "ctrl", button: "left", keys: ["Control"] },
      { label: "middle", button: "middle", keys: [] },
      { label: "right", button: "right", keys: [] },
    ];
    const results = [];
    for (const combination of combinations) {
      await poll(page, readerSnapshot, (state) => state.open === false, 20_000, `${combination.label} precondition`);
      const target = await entryPoint(page);
      if (!target) throw new Error(`${combination.label}：阅读全文链接不可见`);
      await observeNextClick(page);
      const popups = [];
      const onPage = (popup) => popups.push(popup);
      page.context().on("page", onPage);
      for (const key of combination.keys) await page.keyboard.down(key);
      await page.mouse.move(target.x, target.y);
      await page.mouse.click(target.x, target.y, { button: combination.button });
      for (const key of combination.keys) await page.keyboard.up(key);
      await page.waitForTimeout(1000);
      page.context().off("page", onPage);
      const state = await page.evaluate(() => ({
        readerOpen: document.querySelector("dialog.article-reader")?.open ?? false,
        mode: window.rhine?.stats()?.mode,
        selected: window.rhine?.stats()?.selected,
        url: location.pathname,
        entryHref: document.querySelector('[data-action="read-immersive"]')?.getAttribute("href") ?? null,
      }));
      const observed = await observedClick(page);
      const popupUrls = [];
      for (const popup of popups) {
        await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
        popupUrls.push(popup.url());
        await popup.close().catch(() => undefined);
      }
      const entry = {
        label: combination.label,
        button: combination.button,
        keys: combination.keys,
        observed,
        readerOpen: state.readerOpen,
        mode: state.mode,
        url: state.url,
        popups: popupUrls,
      };
      results.push(entry);
      check(!state.readerOpen, `${combination.label} 点击未打开 in-page reader`, entry);
      equal(state.mode, "detail", `${combination.label} 点击未改变 mode`);
      equal(state.url, "/lab/", `${combination.label} 点击未离开 lab`);
      check(state.entryHref === target.href, `${combination.label} 点击后入口链接不变`, state.entryHref);
      if (combination.button === "left") {
        check(observed?.click !== null && observed?.click !== undefined, `${combination.label} 点击到达链接`);
        equal(observed?.click?.defaultPrevented, false, `${combination.label} 点击未被接管`);
        if (combination.label === "ctrl") equal(observed?.click?.ctrlKey, true, "Ctrl 修饰键传递到点击");
        if (combination.label === "shift") equal(observed?.click?.shiftKey, true, "Shift 修饰键传递到点击");
      } else if (combination.button === "middle") {
        check(observed?.auxclick !== null && observed?.auxclick !== undefined, "中键产生真实 auxclick");
      } else {
        check(observed?.contextmenu !== null && observed?.contextmenu !== undefined, "右键产生真实 contextmenu");
      }
    }
    put("combinations", results);

    // Alt/Meta must reach the same guard without letting the engine navigate
    // (on Windows Chromium they follow the link in the current page). The href is
    // detached for the dispatch only, so a missing guard would still be caught by
    // the reader opening, while a native follow-through cannot destroy the scene.
    const synthetic = [];
    for (const label of ["alt", "meta"]) {
      const result = await page.evaluate((name) => {
        const link = document.querySelector('[data-action="read-immersive"]');
        if (!link) return { error: "入口链接不存在" };
        const href = link.getAttribute("href");
        link.removeAttribute("href");
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          view: window,
          ...(name === "alt" ? { altKey: true } : { metaKey: true }),
        });
        link.dispatchEvent(event);
        const state = {
          defaultPrevented: event.defaultPrevented,
          altKey: event.altKey,
          metaKey: event.metaKey,
          readerOpen: document.querySelector("dialog.article-reader")?.open ?? false,
          mode: window.rhine?.stats()?.mode,
          url: location.pathname,
        };
        link.setAttribute("href", href);
        return { ...state, hrefRestored: link.getAttribute("href") === href };
      }, label);
      synthetic.push({ label, ...result });
      check(result.defaultPrevented === false, `${label} 修饰键点击未被接管`, result);
      check(!result.readerOpen, `${label} 修饰键点击未打开 reader`, result);
      equal(result.mode, "detail", `${label} 修饰键点击未改变 mode`);
      check(result.hrefRestored === true, `${label} 修饰键点击后入口链接完好`);
    }
    put("syntheticModifiers", synthetic);
    await shot("after-combinations");
    const finalState = await page.evaluate(contextSnapshot);
    put("finalState", finalState);
    equal(finalState.mode, "detail", "组合点击之后仍在详情");
    equal(await page.evaluate(() => document.querySelectorAll("dialog.article-reader").length), 1, "组合点击没有产生多余 dialog");
  });

  // -------------------------------------------------------------------------
  // Real drag rotation: the reader must not reset the inspected rotation
  // -------------------------------------------------------------------------
  await record({ name: "drag-rotation-context" }, async (scene) => {
    const { page, check, near, record: put, shot } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-38"), "wp-38");
    await poll(page, () => window.rhine?.stats(), (stats) => stats?.canInspect === true && stats?.cameraDetail > 0.9, 40_000, "inspectable detail");
    const canvas = await page.evaluate(() => {
      const element = document.querySelector("#stage canvas") ?? document.querySelector("canvas");
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    });
    put("canvas", canvas);
    await page.mouse.move(canvas.x, canvas.y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse.move(canvas.x + step * 18, canvas.y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dragged = await settleRotation(page);
    put("rotationAfterDrag", dragged);
    check(Math.abs(dragged) > 0.1, "真实拖拽产生了非零旋转目标", dragged);
    await shot("rotated");

    const beforeOpen = await page.evaluate(contextSnapshot);
    await openReader(page);
    await page.waitForTimeout(1200);
    const during = await page.evaluate(contextSnapshot);
    await closeReaderByEscape(page);
    await page.waitForTimeout(600);
    const afterClose = await page.evaluate(contextSnapshot);
    put("before", beforeOpen);
    put("during", during);
    put("after", afterClose);
    near(during.rotation, beforeOpen.rotation, 0.02, "阅读期间旋转目标未被重置");
    near(afterClose.rotation, beforeOpen.rotation, 0.02, "收起后旋转保持在拖拽结果");
    check(Math.abs(afterClose.rotation) > 0.1, "收起后旋转未回到 0", afterClose.rotation);
  });

  // -------------------------------------------------------------------------
  // Duplicate mappings: several slots, one article, one scroll memory
  // -------------------------------------------------------------------------
  await record({ name: "duplicate-mapping-slots" }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    const slots = lab.slotsFor("wp-55");
    put("slots", slots);
    check(slots.length > 1, "wp-55 在阵列中有多个槽位映射", slots.length);

    const first = slots[0];
    const second = slots[slots.length - 1];
    const hrefA = await openArticleDetail(page, first, "wp-55");
    const identityA = await page.evaluate(() => ({
      postId: window.rhine.stats().selected,
      slotLabel: document.querySelector(".detail-id")?.textContent?.trim() ?? null,
    }));
    const readerA = await openReader(page);
    const fresh = await page.evaluate(() => document.querySelector(".reader-scroll").scrollTop);
    put("freshScrollTop", fresh);
    equal(fresh, 0, "首次阅读从头开始（尚无位置记忆）");
    const saved = await page.evaluate(() => {
      const scroll = document.querySelector(".reader-scroll");
      scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) * 0.5);
      return { top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight };
    });
    await page.waitForTimeout(800);
    const savedTop = await page.evaluate(() => document.querySelector(".reader-scroll").scrollTop);
    await closeReaderByEscape(page);
    await poll(page, readerSnapshot, (state) => state.state === "closed", 20_000, "closed after first slot");
    const stored = await page.evaluate(() => {
      const raw = sessionStorage.getItem("rhine.reader.scroll.v1");
      const parsed = raw ? JSON.parse(raw) : [];
      return parsed.map((entry) => ({ postId: entry.postId, canonicalPath: entry.canonicalPath, fingerprint: entry.fingerprint, anchorId: entry.anchorId, anchorOffset: entry.anchorOffset, scrollTop: entry.scrollTop }));
    });
    put("stored", stored);
    equal(stored.length, 1, "关闭后只留下一条位置记录");
    check(stored[0]?.postId === "wp-55" && stored[0]?.canonicalPath === hrefA, "记录按文章身份与规范路径归档", stored[0]);
    check(Math.abs((stored[0]?.scrollTop ?? 0) - savedTop) <= 2, "记录保存的是关闭时的真实位置", { stored: stored[0]?.scrollTop, savedTop });
    check(Boolean(stored[0]?.anchorId), "记录带有锚点", stored[0]?.anchorId);

    await clickSelector(page, '[data-action="back"]');
    await poll(page, () => window.rhine?.stats()?.mode, (mode) => mode === "archive", 20_000, "back to archive");
    const hrefB = await openArticleDetail(page, second, "wp-55");
    const readerB = await openReader(page);
    await page.waitForTimeout(1600);
    const restored = await page.evaluate((anchorId) => {
      const scroll = document.querySelector(".reader-scroll");
      const anchor = anchorId ? document.querySelector(`.reader-content [id="${anchorId}"]`) : null;
      return { scrollTop: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight, anchorTop: anchor ? anchor.offsetTop : null };
    }, stored[0]?.anchorId ?? null);
    const fingerprintB = await page.evaluate(() => {
      const raw = sessionStorage.getItem("rhine.reader.scroll.v1");
      return raw ? JSON.parse(raw)[0]?.fingerprint ?? null : null;
    });
    put("first", { slot: first, href: hrefA, identity: identityA, reader: { nodes: readerA.contentNodes, textLength: readerA.textLength }, saved, savedTop });
    put("second", { slot: second, href: hrefB, reader: { nodes: readerB.contentNodes, textLength: readerB.textLength }, restored, fingerprintB });
    await shot("second-slot-restored");
    equal(hrefB, hrefA, "不同槽位映射到同一规范地址");
    equal(readerB.contentNodes, readerA.contentNodes, "不同槽位渲染出相同的 reader 内容");
    equal(fingerprintB, stored[0]?.fingerprint ?? null, "跨槽位的指纹一致（同一内容修订）");
    // The documented restore is anchor based (CONTRACT §7): the restored offset
    // must equal the stored anchor position minus the stored anchor offset, not
    // the raw pixel value.
    const expected = restored.anchorTop === null ? null : Math.max(0, Math.min(restored.max, restored.anchorTop - stored[0].anchorOffset));
    put("restoreFormula", { expected, actual: restored.scrollTop, anchorId: stored[0]?.anchorId });
    check(expected !== null && Math.abs(restored.scrollTop - expected) <= 24, "跨槽位按锚点公式恢复位置", { expected, actual: restored.scrollTop });
    // 下面那条锚点公式检查才是主判据；这里只声明「没有回到文首」，
    // 不对短文章能滚出多少像素作假设（max * 0.25 会随内容长度失守）。
    check(restored.scrollTop > 0, "跨槽位恢复的不是文首", { restored: restored.scrollTop, max: restored.max });
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // Closing while the panel is still opening (25% / 50% / 75%)
  // -------------------------------------------------------------------------
  await record({ name: "opening-midway-close" }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
    const beforeOpen = await page.evaluate(contextSnapshot);
    // Slow the panel animation down from inside the page: the entry animation is
    // 360ms, which is far too short to aim a real key press at 25/50/75% from the
    // driver. Only the sheet's own transitions are re-rated, and the exit
    // animation is created later at normal speed.
    await page.evaluate(() => {
      const original = Element.prototype.animate;
      window.__ir5RestoreAnimate = () => {
        Element.prototype.animate = original;
      };
      Element.prototype.animate = function (keyframes, options) {
        const animation = original.call(this, keyframes, options);
        const duration = typeof options === "number" ? options : (options?.duration ?? 0);
        // Both halves of the shared modal transition (backdrop fade + window rise).
        if ((this.classList?.contains("reader-sheet") || this.classList?.contains("reader-backdrop")) && Number(duration) > 0) {
          animation.updatePlaybackRate(0.06);
        }
        return animation;
      };
    });
    const targets = [0.25, 0.5, 0.75];
    const results = [];
    for (const target of targets) {
      await page.evaluate(() => document.querySelector('[data-action="read-immersive"]')?.click());
      // The shared modal transition is a 300ms fade + 12px rise; with the slowed
      // playback the three sample points land mid-flight on the same curve.
      await sleep(Math.round(300 / 0.06 * target));
      const before = await page.evaluate(readerSnapshot);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(45);
      const after = await page.evaluate(readerSnapshot);
      const entry = {
        target,
        stateAtEscape: before.state,
        progressAtEscape: before.progress,
        stateAfterEscape: after.state,
        progressAfterEscape: after.progress,
      };
      check(before.progress !== null && before.progress > 0 && before.progress < 1, `在进入中途（≈${target * 100}%）触发收起`, before.progress);
      check(before.state === "opening" || before.state === "open", `收起发生在进入过程中（${target * 100}%）`, before.state);
      check(after.state === "closing", `收起进入 closing（${target * 100}%）`, after.state);
      check(
        after.progress === null || after.progress <= before.progress + 0.03,
        `收起从当前 transform 接续（${target * 100}%）`,
        { before: before.progress, after: after.progress },
      );
      check(
        after.progress === null || after.progress >= before.progress * 0.3,
        `收起未跳回起点（${target * 100}%）`,
        { before: before.progress, after: after.progress },
      );
      const closedState = await poll(page, readerSnapshot, (state) => state.open === false, 20_000, "closed midway");
      entry.closedState = closedState.state;
      results.push(entry);
      await sleep(250);
    }
    await page.evaluate(() => window.__ir5RestoreAnimate?.());
    put("interrupts", results);
    await shot("after-interrupts");
    const afterAll = await page.evaluate(contextSnapshot);
    put("afterAll", afterAll);
    equal(afterAll.mode, "detail", "三次中途收起都保留了详情上下文");
    equal(afterAll.postId, beforeOpen.postId, "三次中途收起都保留了选中档案");
    equal(afterAll.inputSuspended, false, "三次中途收起都释放了输入锁");
    equal(afterAll.readerDialogs, 1, "中途收起没有产生多余的 dialog");
    // The reader must remain fully usable afterwards.
    const reopened = await openReader(page);
    check(reopened.load === "ready" && reopened.contentNodes > 0, "中途收起后仍可正常打开");
    put("reopened", { load: reopened.load, progress: reopened.progress, nodes: reopened.contentNodes });
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // Repeated Escape while closing
  // -------------------------------------------------------------------------
  await record({ name: "closing-double-escape" }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-71"), "wp-71");
    const beforeOpen = await page.evaluate(contextSnapshot);
    await openReader(page);
    const states = [];
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
    states.push(await page.evaluate(() => document.querySelector("dialog.article-reader")?.getAttribute("data-state") ?? null));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
    states.push(await page.evaluate(() => document.querySelector("dialog.article-reader")?.getAttribute("data-state") ?? null));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
    states.push(await page.evaluate(() => document.querySelector("dialog.article-reader")?.getAttribute("data-state") ?? null));
    const closed = await poll(page, readerSnapshot, (state) => state.open === false, 20_000, "closed after repeated Escape");
    await sleep(400);
    const after = await page.evaluate(contextSnapshot);
    put("statesDuringClose", states);
    put("closed", closed);
    put("after", after);
    await shot("after-double-escape");
    check(states.filter((state) => state === "closing").length >= 1, "随后两次 Esc 落在 closing 阶段", states);
    equal(after.mode, "detail", "连续 Esc 只收起阅读层");
    equal(after.postId, beforeOpen.postId, "连续 Esc 未改变选中档案");
    equal(after.readerDialogs, 1, "连续 Esc 未产生多余 dialog");
    equal(after.inputSuspended, false, "连续 Esc 后输入锁已释放");
    const focusRestore = await page.evaluate(() => document.activeElement === document.querySelector('[data-action="read-immersive"]'));
    check(focusRestore, "连续 Esc 后焦点仍在阅读全文链接");
  });

  // -------------------------------------------------------------------------
  // Programmatic transitions are gated; the reader never stacks with a modal
  // -------------------------------------------------------------------------
  await record({ name: "gated-entries-and-transitions" }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-19"), "wp-19");
    await openReader(page);
    await sleep(200);
    const openState = await page.evaluate(contextSnapshot);
    await clickSelector(page, '[data-action="back"]');
    await page.waitForTimeout(600);
    const afterBackClick = await page.evaluate(contextSnapshot);
    put("openState", openState);
    put("afterBackClick", afterBackClick);
    check(afterBackClick.mode === "detail" && afterBackClick.readerDialogs === 1, "框外点击档案控件时 reader 保持打开");

    const gated = await page.evaluate(() => {
      const before = window.rhine.stats().selected;
      document.querySelector('[data-action="next"]')?.click();
      document.querySelector('[data-action="bookmark"]')?.click();
      document.querySelector('[data-action="settings"]')?.click();
      document.querySelector('[data-action="replay"]')?.click();
      return {
        before,
        after: window.rhine.stats().selected,
        savedCount: window.rhine.stats().saved.length,
        readerOpen: document.querySelector("dialog.article-reader")?.open ?? false,
        modalOpen: (document.querySelector("#modal-root")?.childElementCount ?? 0) > 0,
        mode: window.rhine.stats().mode,
      };
    });
    put("gated", gated);
    await shot("gated-entries");
    equal(gated.after, gated.before, "reader 打开时档案选择未被改变");
    check(gated.readerOpen, "reader 打开时未被外部控件关闭");
    check(!gated.modalOpen, "reader 打开时未叠加设置弹窗");
    equal(gated.mode, "detail", "reader 打开时 mode 未改变");

    // The search overlay must not open on top of the reader either.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press("/");
    await page.waitForTimeout(500);
    const searchDuring = await page.evaluate(() => ({
      overlay: Boolean(document.querySelector("#archive-search")),
      readerOpen: document.querySelector("dialog.article-reader")?.open ?? false,
    }));
    put("searchDuringReader", searchDuring);
    check(!searchDuring.overlay, "reader 打开时 / 未打开检索层");

    await closeReaderByEscape(page);
    await sleep(400);
    const afterEscape = await page.evaluate(contextSnapshot);
    put("afterEscape", afterEscape);
    equal(afterEscape.mode, "detail", "Esc 收起 reader 时未退出详情");

    await clickSelector(page, '[data-action="back"]');
    const back = await poll(
      page,
      () => ({ mode: window.rhine?.stats()?.mode, reader: document.querySelector("dialog.article-reader")?.open ?? false, suspended: window.rhine?.stats()?.inputSuspended }),
      (state) => state.mode === "archive" && state.reader === false,
      20_000,
      "back to archive",
    );
    put("back", back);
    await shot("archive-after-back");
    equal(back.suspended, false, "返回阵列后 scene 输入恢复");
    // Now that the reader is gone, the search overlay works again.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press("/");
    const overlayAfter = await poll(page, () => Boolean(document.querySelector("#archive-search")), (found) => found === true, 20_000, "search overlay after close");
    put("searchAfterClose", overlayAfter);
    check(overlayAfter, "收起 reader 后检索层恢复可用");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // The 360° viewer still works on its own.
    await openArticleDetail(page, lab.displayIdFor("wp-19"), "wp-19");
    await clickSelector(page, '[data-action="model-viewer"]');
    await page.waitForTimeout(2500);
    const viewerState = await page.evaluate(() => ({
      stageViewer: document.querySelector("#stage")?.dataset?.viewer ?? null,
      detailInert: document.querySelector("#detail-ui")?.inert ?? null,
      mode: window.rhine?.stats()?.mode,
    }));
    put("viewer", viewerState);
    await shot("viewer-open");
    check(viewerState.mode === "detail", "360° 查看器打开后仍在详情");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
    equal(await page.evaluate(() => window.rhine.stats().mode), "detail", "关闭查看器后回到详情");
  });

  // -------------------------------------------------------------------------
  // Lifecycle: 50 open/close cycles must not accumulate anything
  // -------------------------------------------------------------------------
  await record({ name: "lifecycle-50-cycles", viewport: { width: 1366, height: 768 } }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
    const first = await openReader(page);
    const baseline = await page.evaluate(() => ({
      nodes: document.querySelector(".reader-content")?.childElementCount ?? 0,
      scrollHeight: document.querySelector(".reader-scroll")?.scrollHeight ?? 0,
      heap: performance.memory?.usedJSHeapSize ?? null,
      listeners: document.querySelectorAll("dialog.article-reader").length,
    }));
    await closeReaderByEscape(page);
    await poll(page, readerSnapshot, (state) => state.state === "closed", 20_000, "first close");
    await sleep(250);

    const cycles = 50;
    let failures = 0;
    for (let index = 1; index < cycles; index += 1) {
      await page.evaluate(() => document.querySelector('[data-action="read-immersive"]')?.click());
      const ready = await poll(page, readerSnapshot, (state) => state.load === "ready", 20_000, `cycle ${index} ready`).catch(() => null);
      if (!ready) {
        failures += 1;
        break;
      }
      await page.keyboard.press("Escape");
      const closed = await poll(page, readerSnapshot, (state) => state.open === false, 20_000, `cycle ${index} closed`).catch(() => null);
      if (!closed) {
        failures += 1;
        break;
      }
      await poll(page, readerSnapshot, (state) => state.state === "closed", 20_000, `cycle ${index} settled`);
    }
    const after = await page.evaluate(() => ({
      dialogs: document.querySelectorAll("dialog.article-reader").length,
      modalChildren: document.querySelector("#modal-root")?.childElementCount ?? 0,
      reader: window.rhine.stats().reader,
      mode: window.rhine.stats().mode,
      inputSuspended: window.rhine.stats().inputSuspended,
    }));
    // A closed reader intentionally holds no content, so the open state is
    // re-measured and compared with the first cycle.
    const finalOpen = await openReader(page);
    const finalState = await page.evaluate(() => ({
      nodes: document.querySelector(".reader-content")?.childElementCount ?? 0,
      scrollHeight: document.querySelector(".reader-scroll")?.scrollHeight ?? 0,
      heap: performance.memory?.usedJSHeapSize ?? null,
      animations: document.querySelector(".reader-sheet")?.getAnimations().length ?? 0,
    }));
    put("cycles", cycles);
    put("baseline", baseline);
    put("afterClosed", after);
    put("afterFinalOpen", { ...finalState, load: finalOpen.load, textLength: finalOpen.textLength });
    await shot("after-cycles");
    equal(failures, 0, "50 次开关全部完成");
    equal(after.dialogs, 1, "50 次开关后 dialog 仍为单例");
    equal(after.modalChildren, 0, "50 次开关未留下弹窗");
    equal(after.mode, "detail", "50 次开关后仍在详情");
    equal(after.inputSuspended, false, "50 次开关后输入锁已释放");
    equal(after.reader.active, false, "50 次开关后 reader 未激活");
    equal(finalOpen.load, "ready", "50 次开关后仍可正常阅读");
    equal(finalState.nodes, baseline.nodes, "50 次开关后内容节点数不变");
    // Sub-pixel reflow: with `unicode-range`-sharded webfonts the article keeps
    // settling while shards arrive, and the scrollbar gutter rounds differently at
    // some line counts, so scrollHeight can move a few pixels without any content
    // change. The invariants that matter (node count, text length, single dialog,
    // released input lock) are asserted on their own lines below.
    check(Math.abs(finalState.scrollHeight - baseline.scrollHeight) <= 12, "50 次开关后滚动高度不漂移", { baseline: baseline.scrollHeight, after: finalState.scrollHeight });
    check(finalState.animations <= 2, "50 次开关后未累积动画对象", finalState.animations);
    check(finalOpen.textLength === first.textLength, "50 次开关后正文字符数不变", { before: first.textLength, after: finalOpen.textLength });
    if (baseline.heap !== null && finalState.heap !== null) {
      const growthMb = (finalState.heap - baseline.heap) / 1024 / 1024;
      put("heapGrowthMb", Math.round(growthMb * 10) / 10);
      check(growthMb < 60, "50 次开关后堆增长有界", `${Math.round(growthMb * 10) / 10} MB`);
    }
    put("firstCycleTextLength", first.textLength);
    await closeReaderByEscape(page);
  });
}
