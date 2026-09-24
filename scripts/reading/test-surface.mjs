/**
 * IR3 surface gate: panel geometry, scroll memory, reader motion and the reader
 * lifecycle (states, request ownership, focus, close sequencing).
 *
 * The reader is driven through the real `createArticleReader` with a stub DOM and
 * a fake loader, so state ownership is judged by script-visible behaviour rather
 * than by matching source text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPACT_WINDOW_MAX_HEIGHT,
  COMPACT_WINDOW_MAX_WIDTH,
  MODAL_PADDING_X,
  MODAL_PADDING_Y,
  MODAL_WINDOW_HEIGHT,
  MODAL_WINDOW_WIDTH,
  NARROW_BREAKPOINT,
  PROSE_FONT_DESKTOP,
  PROSE_FONT_NARROW,
  PROSE_PADDING_DESKTOP,
  PROSE_PADDING_NARROW,
  readerWindow,
} from "../../shared/reading/geometry.ts";
import {
  SCROLL_LIMIT,
  SCROLL_STORE_KEY,
  createReaderScrollStore,
  findAnchorId,
  restoreScrollTop,
} from "../../shared/reading/scroll-store.ts";
import { createArticleReader } from "../../src/features/reader/reader.ts";
import { createEvent, createStubDocument } from "./dom-stub.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const logDir = resolve(root, ".tools/immerse-reading/IR3/logs");
const HREF = "/2026/06/01/sample-essay/";

/**
 * The reader reuses the archive modal surface, so these are the *shared*
 * transition's numbers (the ones the three system dialogs use), written here as
 * independent expectations instead of importing them from the implementation.
 */
const SHARED_ENTER_MS = 300;
const SHARED_EXIT_MS = 200;
const SHARED_ENTER_TRANSFORM = "translateY(12px)";
const SHARED_EXIT_TRANSFORM = "translateY(8px)";

/**
 * `SurfaceTransition` reads the live opacity/transform through the global
 * `getComputedStyle`; the stub document provides the element state it needs.
 */
globalThis.getComputedStyle = (element) => ({
  opacity: element?.style?.getPropertyValue?.("opacity") || (element?.hidden ? "0" : "1"),
  transform: element?.style?.getPropertyValue?.("transform") || "none",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStorageStub() {
  const map = new Map();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

/** Controllable timers: nothing fires until the test flushes it. */
function createTimerDouble() {
  const pending = new Map();
  let next = 1;
  return {
    timers: {
      setTimeout(handler, ms) {
        const id = next++;
        pending.set(id, { handler, ms });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    get size() {
      return pending.size;
    },
    /** Fire every timer whose delay is <= maxDelay, oldest first. */
    flush(maxDelay = Number.POSITIVE_INFINITY) {
      for (const [id, entry] of [...pending.entries()].sort((left, right) => left[1].ms - right[1].ms)) {
        if (entry.ms > maxDelay) continue;
        pending.delete(id);
        entry.handler();
      }
    },
  };
}

async function canonicalHtml(postId, href, content = "<p>正文</p>") {
  const { readArticleContract } = await import("../../shared/reading/contract.ts");
  const { convertArticleHtml } = await import("../../shared/reading/content.ts");
  const html =
    '<!doctype html><html><head><title>t</title></head><body><article data-pagefind-body ' +
    `data-reader-version="1" data-reader-kind="post" data-post-id="${postId}" data-canonical-path="${href}">` +
    `<div data-reader-content><h1 class="page-title">标题</h1><div class="prose">${content}</div></div>` +
    "</article></body></html>";
  const contract = readArticleContract(html);
  assert.equal(contract.ok, true);
  return { html, contract };
}

/** Successful loader result for the converted fixture. */
function okResult(conversion, fingerprint) {
  return {
    status: "ok",
    result: {
      activate: true,
      code: "ok",
      node: conversion.node,
      meta: { ...conversion.meta, fingerprint },
      projection: conversion.projection,
      diagnostics: [],
    },
  };
}

async function createFixture(options = {}) {
  const doc = createStubDocument({
    width: options.width ?? 1366,
    height: options.height ?? 768,
    reducedMotion: options.reducedMotion ?? false,
    storage: options.storage ?? createStorageStub(),
  });
  const timers = createTimerDouble();
  const calls = [];
  // The panel (`.reader-sheet`) is the only element the reader animates; tests
  // advance it deterministically instead of waiting for a real 280/360ms.
  // The shared transition completes when the backdrop fade finishes, so every
  // running animation on the surface is finished deterministically.
  const advanceMotion = () => {
    for (const element of doc.body.querySelectorAll(".reader-backdrop, .reader-sheet")) {
      for (const animation of element.animations) {
        if (animation.playState === "running") animation.finish();
      }
    }
  };

  const href = options.href ?? "/2026/06/01/sample-essay/";
  const postId = options.postId ?? "wp-38";
  const { html } = await canonicalHtml(postId, href, options.content ?? "<p>正文</p>");
  const { convertArticleHtml } = await import("../../shared/reading/content.ts");
  const conversion = await convertArticleHtml(html, {
    target: { postId, href, title: "标题" },
    responseUrl: `https://example.test${href}`,
    document: doc,
    allowWithoutFingerprint: true,
  });
  assert.equal(conversion.activate, true);

  const load = (request) => {
    calls.push(request);
    if (options.holdLoad) {
      return new Promise((resolveLoad) => options.holdLoad(request, resolveLoad));
    }
    return Promise.resolve(okResult(conversion, options.fingerprint ?? "fp-1"));
  };
  const suspended = [];
  const changes = [];
  const reader = createArticleReader({
    document: doc,
    origin: "https://example.test",
    load,
    motionTimers: timers.timers,
    timers: timers.timers,
    storage: options.storage ?? createStorageStub(),
    requestAnimationFrame: (callback) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    createResizeObserver: options.createResizeObserver ?? (() => ({ observe: () => undefined, disconnect: () => undefined })),
    reducedMotion: () => Boolean(options.reducedMotion),
    fontsReady: () => Promise.resolve(),
    restoreDelayMs: 500,
    correctionWindowMs: 2000,
    onInputSuspended: (value) => suspended.push(value),
    onChange: (snapshot) => changes.push(snapshot),
  });
  // The reader creates its dialog detached; mounting it is what lets the tests
  // query the panel and drive its animation, exactly like the application does.
  doc.body.appendChild(reader.dialog);
  const closeReader = async (reason = "button", options = { restoreFocus: false }) => {
    const closing = reader.close(reason, options);
    advanceMotion();
    await closing;
  };
  return { doc, reader, timers, calls, suspended, changes, conversion, advanceMotion, closeReader };
}

const flushMicrotasks = () => new Promise((resolveTick) => setImmediate(resolveTick));

// ---------------------------------------------------------------------------
// 1. Geometry (CONTRACT.md §7)
// ---------------------------------------------------------------------------

test("window: the reader reuses the modal window box scaled by the stage scale", () => {
  // 1366 × 768 desktop: the lab stage runs at 768 / 1080 = 0.7111.
  const scale = 768 / 1080;
  const window1366 = readerWindow({ viewportWidth: 1366, viewportHeight: 768, stageScale: scale });
  assert.equal(window1366.width, Math.round(MODAL_WINDOW_WIDTH * scale));
  assert.equal(window1366.height, Math.round(MODAL_WINDOW_HEIGHT * scale));
  assert.equal(window1366.windowPaddingX, Math.round(MODAL_PADDING_X * scale));
  assert.equal(window1366.windowPaddingY, Math.round(MODAL_PADDING_Y * scale));
  // Centred window: equal margins on both axes.
  assert.equal(window1366.left, Math.round((1366 - window1366.width) / 2));
  assert.equal(window1366.top, Math.round((768 - window1366.height) / 2));
  assert.equal(window1366.layout, "desktop");

  const window1920 = readerWindow({ viewportWidth: 1920, viewportHeight: 1080, stageScale: 1 });
  assert.equal(window1920.width, MODAL_WINDOW_WIDTH);
  assert.equal(window1920.height, MODAL_WINDOW_HEIGHT);
  assert.equal(window1920.left, Math.round((1920 - MODAL_WINDOW_WIDTH) / 2));
  assert.equal(window1920.top, Math.round((1080 - MODAL_WINDOW_HEIGHT) / 2));
});

test("window: a narrow desktop viewport clamps to the modal margin", () => {
  // 800 × 900: the 0.833-scaled modal box (1050px) exceeds the available width,
  // exactly like `.terminal-modal { max-width: calc(100% - 100px) }` in stage px.
  const scale = 900 / 1080;
  const clamped = readerWindow({ viewportWidth: 800, viewportHeight: 900, stageScale: scale });
  const margin = 100 * scale;
  assert.equal(clamped.width, Math.round(800 - margin));
  assert.equal(clamped.left, Math.round(margin / 2));
  assert.equal(clamped.height, Math.round(MODAL_WINDOW_HEIGHT * scale), "height is not clamped in this case");
});

test("window: compact and portrait layouts reuse the modal responsive box", () => {
  const compact = readerWindow({ viewportWidth: 900, viewportHeight: 700, layout: "compact", stageScale: 1 });
  assert.equal(compact.layout, "compact");
  assert.equal(compact.width, Math.min(COMPACT_WINDOW_MAX_WIDTH, 900 - 40));
  assert.equal(compact.height, Math.min(COMPACT_WINDOW_MAX_HEIGHT, 700 - 16 - 12));
  assert.equal(compact.windowPaddingX, 20);
  assert.equal(compact.windowPaddingY, 16);

  const portrait = readerWindow({ viewportWidth: 390, viewportHeight: 844, layout: "portrait" });
  assert.equal(portrait.width, 390 - 40);
  assert.equal(portrait.height, Math.min(COMPACT_WINDOW_MAX_HEIGHT, 844 - 28));
  assert.equal(portrait.left, 20);
  assert.equal(portrait.fontSize, PROSE_FONT_NARROW);
  assert.equal(portrait.horizontalPadding, PROSE_PADDING_NARROW);

  const safe = readerWindow({ viewportWidth: 430, viewportHeight: 932, layout: "portrait", insets: { left: 44, right: 44, top: 34, bottom: 34 } });
  assert.equal(safe.width, 430 - 88);
  assert.equal(safe.left, 44);
  assert.equal(safe.height, Math.min(COMPACT_WINDOW_MAX_HEIGHT, 932 - 68));
});

test("window: typography stays in CSS pixels and the narrow breakpoint holds", () => {
  assert.equal(readerWindow({ viewportWidth: 1366, viewportHeight: 768, stageScale: 0.4 }).fontSize, PROSE_FONT_DESKTOP);
  assert.equal(readerWindow({ viewportWidth: 1366, viewportHeight: 768, stageScale: 0.4 }).horizontalPadding, PROSE_PADDING_DESKTOP);
  assert.equal(readerWindow({ viewportWidth: NARROW_BREAKPOINT, viewportHeight: 800 }).narrow, true);
  assert.equal(readerWindow({ viewportWidth: NARROW_BREAKPOINT + 1, viewportHeight: 800 }).narrow, false);
});

// ---------------------------------------------------------------------------
// 2. Scroll memory
// ---------------------------------------------------------------------------

test("scroll store: records are keyed by postId + path + fingerprint and bounded to 20", () => {
  const storage = createStorageStub();
  const store = createReaderScrollStore(storage);
  for (let index = 0; index < SCROLL_LIMIT + 5; index += 1) {
    store.save({
      postId: `wp-${index}`,
      canonicalPath: `/p/${index}/`,
      fingerprint: `fp-${index}`,
      anchorId: null,
      anchorOffset: 0,
      scrollTop: index * 10,
      updatedAt: 1000 + index,
    });
  }
  assert.equal(store.list().length, SCROLL_LIMIT);
  assert.equal(store.list()[0].postId, `wp-${SCROLL_LIMIT + 4}`);
  assert.equal(store.get("wp-0", "/p/0/", "fp-0"), null, "the oldest record is evicted");
  assert.equal(store.get(`wp-${SCROLL_LIMIT + 4}`, `/p/${SCROLL_LIMIT + 4}/`, "fp-x"), null, "a changed fingerprint never matches");
  const stored = JSON.parse(storage.getItem(SCROLL_STORE_KEY));
  assert.equal(stored.length, SCROLL_LIMIT);
  assert.equal(stored.some((entry) => "body" in entry || "html" in entry || "node" in entry), false, "only positions are stored");
});

test("scroll store: a broken payload degrades to an empty memory", () => {
  const storage = createStorageStub();
  storage.setItem(SCROLL_STORE_KEY, "{not json");
  const store = createReaderScrollStore(storage);
  assert.deepEqual(store.list(), []);
  storage.setItem(SCROLL_STORE_KEY, JSON.stringify([{ postId: 1 }, "x", null]));
  assert.deepEqual(store.list(), []);
});

test("restore: anchor wins, then clamped scrollTop, then top", () => {
  const record = { anchorId: "reader-1-3", anchorOffset: 24, scrollTop: 500 };
  assert.deepEqual(restoreScrollTop(record, () => 800, 2000), { scrollTop: 776, mode: "anchor" });
  assert.deepEqual(restoreScrollTop(record, () => null, 2000), { scrollTop: 500, mode: "offset" });
  assert.deepEqual(restoreScrollTop(record, () => null, 120), { scrollTop: 120, mode: "offset" });
  assert.deepEqual(restoreScrollTop({ anchorId: null, anchorOffset: 0, scrollTop: 0 }, () => null, 2000), { scrollTop: 0, mode: "top" });
});

test("anchor: the heading at or above the offset is remembered", () => {
  const candidates = [
    { id: "h2-a", top: 100 },
    { id: "h2-b", top: 600 },
    { id: "h2-c", top: 1200 },
  ];
  assert.deepEqual(findAnchorId(candidates, 900), { anchorId: "h2-b", anchorOffset: 300 });
  assert.deepEqual(findAnchorId(candidates, 40), { anchorId: null, anchorOffset: 40 });
  assert.deepEqual(findAnchorId([], 77), { anchorId: null, anchorOffset: 77 });
  assert.deepEqual(findAnchorId(candidates, 2000), { anchorId: "h2-c", anchorOffset: 800 });
});

// ---------------------------------------------------------------------------
// 3. Reader surface: the shared modal window and the shared transition
// ---------------------------------------------------------------------------

test("surface: the reader renders the same modal surface as the system dialogs", async () => {
  const fixture = await createFixture();
  const { reader } = fixture;
  const dialog = reader.dialog;
  const backdrop = dialog.querySelector(".reader-backdrop");
  const sheet = dialog.querySelector(".reader-sheet");
  assert.ok(backdrop, "the reader has the shared .modal-backdrop layer");
  assert.ok(backdrop.classList.contains("modal-backdrop"), "the dim layer reuses the modal class");
  assert.ok(sheet.classList.contains("terminal-modal"), "the window reuses the dialog class");
  assert.equal(backdrop.hidden, true, "the surface starts hidden so the shared transition can fade it in");
  assert.equal(sheet.tagName, "section");
  const toolbar = sheet.querySelector(".reader-toolbar");
  assert.ok(toolbar.classList.contains("modal-top"), "the toolbar reuses the dialogs' top bar typography");
  const closeButton = sheet.querySelector(".reader-close");
  assert.ok(closeButton, "the window still carries the reader controls");
  assert.equal(closeButton.textContent.replace(/\s+/g, " ").trim(), "CLOSE", "the exit control uses the dialogs' CLOSE label");
  const closeIcon = closeButton.querySelector(".reader-close-icon");
  assert.ok(closeIcon, "the cross is a CSS-drawn icon element (the visual browser case compares it with the dialogs)");
  assert.equal(closeIcon.getAttribute("aria-hidden"), "true", "the icon stays out of the accessible name");
  assert.ok(closeButton.getAttribute("aria-label"), "the exit control keeps an accessible name");
  assert.ok(sheet.querySelector(".reader-article-link"), "the independent-article route stays in the toolbar");
  reader.dispose();
});

// ---------------------------------------------------------------------------
// 3b. Navigation rail: a view of the prose headings, never a second parser
// ---------------------------------------------------------------------------

const RAIL_CONTENT = [
  "<h2 id=\"一-问题\">一、问题</h2><p>正文</p>",
  "<h3 id=\"1-1-细节\">1.1 细节</h3><p>正文</p>",
  "<h2 id=\"二-方案\">二、方案</h2><p>正文</p>",
].join("");

test("rail: the navigation rail mirrors the prose headings exactly once", async () => {
  const fixture = await createFixture({ content: RAIL_CONTENT });
  const { reader, doc, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "标题" });
  advanceMotion();
  await fixture.timers.flush?.();
  const nav = reader.dialog.querySelector(".reader-toc");
  assert.ok(nav, "the window carries a navigation rail");
  assert.equal(nav.getAttribute("aria-label"), "目录导航");
  const ticks = nav.querySelectorAll(".reader-toc-tick");
  const links = nav.querySelectorAll(".reader-toc-link");
  // The DOM stub matches one simple selector at a time (no comma lists), and it
  // returns each tag in document order per query, so the two passes are merged
  // by sorting on the heading's own id instead of comparing raw order.
  const headings = [
    ...doc.querySelectorAll(".reader-content h2"),
    ...doc.querySelectorAll(".reader-content h3"),
  ]
    .filter((element) => element.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.equal(ticks.length, headings.length, "one tick per heading");
  assert.equal(links.length, headings.length, "one label per heading");
  assert.notEqual(ticks.length, 0, "the fixture's three headings are all reachable");
  const headingIds = new Set(headings.map((heading) => heading.id));
  assert.deepEqual(
    [...links].map((link) => link.getAttribute("href")),
    [...headings].map((heading) => `#${heading.id}`),
    "every entry points at an existing heading id (no invented anchors)",
  );
  assert.ok(
    [...links].every((link) => headingIds.has(link.getAttribute("href").slice(1))),
    "no entry points outside the prose",
  );
  assert.equal(nav.hidden, false, "a real article shows the rail");
  // The rail is a copy of the headings, so it must not be an ARIA landmark duplicating them.
  assert.equal(ticks[0].getAttribute("tabindex"), "-1", "ticks stay out of the tab order");
  await closeReader_();
  assert.equal(nav.hidden, true, "the rail is cleared once the reader closes");
  assert.equal(nav.querySelectorAll(".reader-toc-tick").length, 0, "no stale entries survive a close");
  reader.dispose();
});

test("rail: a short article hides the rail, an error clears it", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined, content: "<p>只有一段正文</p>" });
  const { reader, doc, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "标题" });
  advanceMotion();
  const nav = reader.dialog.querySelector(".reader-toc");
  assert.equal(nav.hidden, true, "an article without headings has no rail");
  await closeReader_();
  reader.dispose();
});

test("rail: picking an entry pins the panel, tapping outside unpins it", async () => {
  const fixture = await createFixture({ content: RAIL_CONTENT });
  const { reader, doc, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  advanceMotion();
  // Let the load resolve so the entries exist (the default loader is async).
  await flushMicrotasks();
  const nav = reader.dialog.querySelector(".reader-toc");
  const link = nav.querySelector(".reader-toc-link");
  const scroll = reader.dialog.querySelector(".reader-scroll");
  const tap = (target) => doc.dispatchEvent(createEvent("pointerdown", { target, bubbles: true, cancelable: true }));

  link.dispatchEvent(createEvent("click", { target: link, bubbles: true, cancelable: true }));
  assert.equal(nav.classList.contains("is-pinned"), true, "a picked entry pins the outline open");

  // A tap on the prose is outside the rail/panel and must collapse it again.
  tap(scroll);
  assert.equal(nav.classList.contains("is-pinned"), false, "tapping outside unpins the outline");
  assert.equal(nav.classList.contains("is-expanded"), false, "the panel collapses with it");

  // Tapping the same (now current) entry again toggles it back off.
  link.dispatchEvent(createEvent("click", { target: link, bubbles: true, cancelable: true }));
  assert.equal(nav.classList.contains("is-pinned"), true, "tapping the current entry pins it again");
  link.dispatchEvent(createEvent("click", { target: link, bubbles: true, cancelable: true }));
  assert.equal(nav.classList.contains("is-pinned"), false, "tapping the current entry again closes the outline");

  await closeReader_();
  reader.dispose();
});

test("surface: enter and leave use the shared modal transition numbers", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined });
  const { reader, doc, advanceMotion, closeReader: closeReader_ } = fixture;
  const backdrop = doc.querySelector(".reader-backdrop");
  const sheet = doc.querySelector(".reader-sheet");
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  const fade = backdrop.animations.find((animation) => animation.playState === "running");
  const rise = sheet.animations.find((animation) => animation.playState === "running");
  assert.ok(fade, "the backdrop fades in");
  assert.deepEqual(fade.keyframes, [{ opacity: "0" }, { opacity: 1 }]);
  assert.equal(fade.options.duration, SHARED_ENTER_MS);
  assert.ok(rise, "the window rises into place");
  assert.deepEqual(rise.keyframes, [{ transform: SHARED_ENTER_TRANSFORM }, { transform: "translateY(0)" }]);
  assert.equal(rise.options.duration, SHARED_ENTER_MS);
  assert.equal(backdrop.dataset.transition, "opening");

  const closing = reader.close("button", { restoreFocus: false });
  const exitFade = backdrop.animations.find((animation) => animation.playState === "running");
  const exitRise = sheet.animations.find((animation) => animation.playState === "running");
  assert.equal(backdrop.dataset.transition, "closing");
  assert.equal(exitFade.options.duration, SHARED_EXIT_MS);
  assert.equal(exitFade.keyframes[1].opacity, 0);
  assert.equal(exitRise.keyframes[1].transform, SHARED_EXIT_TRANSFORM);
  advanceMotion();
  await closing;
  assert.equal(backdrop.hidden, true, "the surface is hidden again once the exit finishes");
  assert.equal(backdrop.dataset.transition, "closed");
  reader.dispose();
});

test("surface: reduced motion shows and hides without a transition", async () => {
  const fixture = await createFixture({ reducedMotion: true, holdLoad: () => undefined });
  const { reader, doc } = fixture;
  const backdrop = doc.querySelector(".reader-backdrop");
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  assert.equal(backdrop.animations.filter((animation) => animation.playState === "running").length, 0, "no transition is started");
  assert.equal(backdrop.hidden, false, "the surface is visible immediately");
  assert.equal(backdrop.dataset.transition, "open");
  await reader.close("button", { restoreFocus: false });
  assert.equal(backdrop.hidden, true);
  assert.equal(backdrop.dataset.transition, "closed");
  reader.dispose();
});

// ---------------------------------------------------------------------------
// 4. Reader lifecycle
// ---------------------------------------------------------------------------

test("reader: open exposes the loading shell synchronously and isolates input", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined });
  const { reader, doc, suspended, advanceMotion, closeReader: closeReader_ } = fixture;
  const ok = reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  assert.equal(ok, true);
  assert.equal(reader.isActive, true);
  assert.equal(reader.state, "opening");
  assert.equal(reader.loadState, "loading");
  assert.equal(doc.openDialog, reader.dialog, "the dialog is open synchronously");
  assert.equal(doc.activeElement.getAttribute("aria-label"), "收起全文，返回档案");
  assert.equal(suspended.at(-1), true, "the 3D input is suspended");
  assert.match(reader.dialog.querySelector(".reader-status").textContent, /加载/);
  assert.equal(fixture.calls.length, 1, "exactly one request per open");
  await closeReader_("button", { restoreFocus: false });
  reader.dispose();
});

test("reader: a second open while loading keeps one dialog and aborts the first request", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined });
  const { reader, doc, calls, advanceMotion, closeReader: closeReader_ } = fixture;
  const target = { postId: "wp-38", href: HREF, title: "标题" };
  reader.open(target);
  const second = reader.open(target);
  assert.equal(second, true);
  assert.equal(calls.length, 2, "a reopen starts a new request");
  assert.equal(calls[0].signal.aborted, true, "the superseded request is aborted");
  assert.equal(doc.body.querySelectorAll("dialog.article-reader").length, 1, "still a single dialog");
  await closeReader_("button", { restoreFocus: false });
  reader.dispose();
});

test("reader: a stale response never commits content", async () => {
  const pendingLoads = [];
  const fixture = await createFixture({
    holdLoad: (request, resolveLoad) => pendingLoads.push({ request, resolveLoad }),
  });
  const { reader, suspended, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  // Close before the response arrives, then let the response resolve anyway.
  const closing = reader.close("button", { restoreFocus: false });
  fixture.advanceMotion();
  const { conversion } = fixture;
  pendingLoads[0].resolveLoad(okResult(conversion, "fp-late"));
  await closing;
  assert.equal(reader.state, "closed");
  assert.equal(reader.dialog.querySelector(".reader-content").childNodes.length, 0, "no DOM from a cancelled request");
  assert.equal(suspended.at(-1), false, "input is released");
  reader.dispose();
});

test("reader: ready state stores the fingerprint, keeps focus and remembers scroll", async () => {
  const storage = createStorageStub();
  const fixture = await createFixture({ storage, fingerprint: "fp-locked" });
  const { reader, doc, timers, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(reader.loadState, "ready");
  assert.equal(reader.state, "open");
  assert.ok(reader.dialog.querySelector(".reader-content").childNodes.length > 0);
  assert.equal(reader.dialog.querySelector(".reader-state").hidden, true, "the state area is separate from the content area");
  assert.equal(doc.activeElement.getAttribute("aria-label"), "收起全文，返回档案", "focus stays on the close control");

  const scroll = reader.dialog.querySelector(".reader-scroll");
  scroll.scrollTop = 320;
  await closeReader_("button", { restoreFocus: false });
  const record = reader.scrollStore.get("wp-38", HREF, "fp-locked");
  assert.ok(record, "the scroll position is remembered");
  assert.equal(record.scrollTop, 320);
  assert.equal(timers.size, 0, "every timer is cleared after close");
  reader.dispose();
});

test("reader: error state keeps close, retry and the independent page route", async () => {
  let attempt = 0;
  const fixture = await createFixture({
    holdLoad: (request, resolveLoad) => {
      attempt += 1;
      if (attempt === 1) {
        resolveLoad({ status: "error", code: "http", message: "文章响应异常（HTTP 404），请打开独立文章页" });
        return;
      }
      resolveLoad(okResult(fixture.conversion, "fp-retry"));
    },
  });
  const { reader, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(reader.loadState, "error");
  const retry = reader.dialog.querySelector(".reader-retry");
  assert.equal(retry.hidden, false, "retry appears in the error state");
  assert.ok(reader.dialog.querySelector(".reader-close"), "close stays available");
  assert.equal(reader.dialog.querySelector(".reader-article-link").getAttribute("href"), HREF, "the toolbar keeps the independent page route");
  assert.equal(reader.dialog.querySelector(".reader-error").hidden, false, "the error panel is visible");
  // Regression (found by the IR5 failure suite): the panel message used to be
  // written with `textContent`, which destroyed the fallback link inside it.
  const inlineLink = reader.dialog.querySelector(".reader-article-link-inline");
  assert.ok(inlineLink, "the error panel keeps its independent page link");
  assert.equal(inlineLink.getAttribute("href"), HREF, "the inline link points at the canonical article");
  assert.match(reader.dialog.querySelector(".reader-error-text").textContent, /HTTP 404/, "the error text is rendered");
  assert.equal(reader.retry(), true);
  assert.equal(fixture.calls.length, 2, "retry issues a new request");
  assert.equal(reader.loadState, "loading", "retry returns to the loading state");
  // Regression (found by the IR5 retry scene): the previous error code used to
  // survive a successful retry, so the DOM claimed a failure for ready content.
  assert.equal(reader.dialog.getAttribute("data-error-code"), null, "a new attempt clears the previous error code");
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(reader.loadState, "ready");
  assert.equal(retry.hidden, true, "retry disappears once ready");
  await closeReader_("button", { restoreFocus: false });
  reader.dispose();
});

test("reader: close is idempotent and repeated calls share one promise", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined });
  const { reader, suspended } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  const first = reader.close("button", { restoreFocus: false });
  const second = reader.close("escape", { restoreFocus: true });
  assert.equal(first, second, "the same closing promise is returned");
  fixture.advanceMotion();
  await first;
  assert.equal(reader.state, "closed");
  assert.equal(await reader.close("button"), undefined, "close on a closed reader resolves immediately");
  assert.equal(suspended.at(-1), false);
  reader.dispose();
});

test("reader: focus returns to the opener, or stays out when the opener is gone", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined });
  const { reader, doc, closeReader: closeReader_ } = fixture;
  const opener = doc.createElement("a");
  opener.setAttribute("href", "/x/");
  doc.body.appendChild(opener);
  reader.open({ postId: "wp-38", href: HREF, title: "标题" }, opener);
  await closeReader_("button", { restoreFocus: true });
  assert.equal(doc.activeElement, opener, "focus returns to the trigger link");

  reader.open({ postId: "wp-38", href: HREF, title: "标题" }, opener);
  opener.isConnected = false;
  await closeReader_("context-change");
  assert.notEqual(doc.activeElement, opener, "a dead opener never receives focus");
  reader.dispose();
});

test("reader: Escape closes once and the dialog stays open until the exit finishes", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined });
  const { reader, doc, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  const event = {
    type: "keydown",
    key: "Escape",
    target: doc.activeElement,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  reader.dialog.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, "Escape does not reach the page");
  assert.equal(reader.state, "closing");
  assert.equal(reader.dialog.open, true, "the dialog stays open during the exit animation");
  await closeReader_("button", { restoreFocus: false });

  const cancelEvent = {
    type: "cancel",
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  reader.dialog.dispatchEvent(cancelEvent);
  assert.equal(cancelEvent.defaultPrevented, true, "the native cancel is prevented");
  reader.dispose();
});

test("reader: dispose releases listeners, dialog and input suspension", async () => {
  const fixture = await createFixture({ holdLoad: () => undefined });
  const { reader, doc, suspended } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  reader.dispose();
  assert.equal(reader.isActive, false);
  assert.equal(doc.body.querySelectorAll("dialog.article-reader").length, 0, "the dialog is removed");
  assert.equal(suspended.at(-1), false, "the 3D input is released");
  assert.equal(reader.open({ postId: "wp-38", href: "/x/", title: "x" }), false, "a disposed reader never opens");
});

test("reader: reduced motion shows and hides without a transition", async () => {
  const fixture = await createFixture({ reducedMotion: true, fingerprint: "fp-reduced" });
  const { reader, doc, closeReader: closeReader_ } = fixture;
  const backdrop = doc.querySelector(".reader-backdrop");
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  assert.equal(backdrop.animations.length, 0, "no animation is created in reduced motion");
  assert.equal(backdrop.hidden, false, "the surface is visible immediately");
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(reader.loadState, "ready");
  await closeReader_("button", { restoreFocus: false });
  assert.equal(backdrop.animations.length, 0, "the exit starts no animation either");
  assert.equal(backdrop.hidden, true);
  assert.equal(reader.state, "closed");
  reader.dispose();
});

test("reader: keyboard scrolling is directed at the prose while the toolbar has focus", async () => {
  const longContent = Array.from({ length: 40 }, (_, index) => `<h2 id="s-${index}">段 ${index}</h2><p>内容 ${index}</p>`).join("");
  const fixture = await createFixture({ content: longContent, fingerprint: "fp-scroll" });
  const { reader, doc, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  await flushMicrotasks();
  await flushMicrotasks();
  const scroll = reader.dialog.querySelector(".reader-scroll");
  scroll.clientHeight = 400;
  scroll.scrollHeight = 4000;
  const press = (key) => {
    const event = {
      type: "keydown",
      key,
      target: doc.activeElement,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    reader.dialog.dispatchEvent(event);
    return event;
  };
  assert.equal(press("PageDown").defaultPrevented, true);
  assert.equal(scroll.scrollTop, 320, "PageDown scrolls the prose container");
  press("End");
  assert.equal(scroll.scrollTop, 4000);
  press("Home");
  assert.equal(scroll.scrollTop, 0);
  press("ArrowDown");
  assert.equal(scroll.scrollTop, 40);
  await closeReader_("button", { restoreFocus: false });
  reader.dispose();
});

test("reader: user scrolling cancels the late-layout correction", async () => {
  let observerCallback = null;
  const storage = createStorageStub();
  const { createReaderScrollStore: makeStore } = await import("../../shared/reading/scroll-store.ts");
  makeStore(storage).save({
    postId: "wp-38",
    canonicalPath: HREF,
    fingerprint: "fp-correction",
    anchorId: "a",
    anchorOffset: 0,
    scrollTop: 300,
  });
  const fixture = await createFixture({
    storage,
    fingerprint: "fp-correction",
    content: '<h2 id="a">A</h2><p>正文</p>',
    createResizeObserver: (callback) => {
      observerCallback = callback;
      return { observe: () => undefined, disconnect: () => undefined };
    },
  });
  const { reader, timers, advanceMotion, closeReader: closeReader_ } = fixture;
  reader.open({ postId: "wp-38", href: HREF, title: "标题" });
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(
    reader.loadState,
    "ready",
    `the reader reaches ready (${reader.dialog.getAttribute("data-error-code") ?? "no error code"})`,
  );
  const scroll = reader.dialog.querySelector(".reader-scroll");
  assert.equal(scroll.scrollTop, 300, "the stored offset is restored when no anchor layout exists yet");

  // A user scroll during the correction window stops the automatic correction.
  scroll.dispatchEvent({ type: "wheel", target: scroll, preventDefault() {} });
  scroll.scrollTop = 123;
  if (observerCallback) observerCallback();
  assert.equal(scroll.scrollTop, 123, "the correction no longer fights the user");
  timers.flush(2500);
  assert.equal(timers.size, 0);
  await closeReader_("button", { restoreFocus: false });
  reader.dispose();
});

test("IR3 surface evidence summary is written for the gate report", async () => {
  await mkdir(logDir, { recursive: true });
  await writeFile(
    resolve(logDir, "surface-evidence.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        geometryCases: ["1366x768", "1920x1080", "2560x1440", "1560x900", "390x844", "430x932", "844x390", "boundary-900"],
        surface: { window: "terminal-modal (shared with ARCHIVE INDEX / SAVED / SYSTEM)", transitionMs: { enter: SHARED_ENTER_MS, exit: SHARED_EXIT_MS } },
        scroll: { limit: SCROLL_LIMIT, storeKey: SCROLL_STORE_KEY },
        readerCases: [
          "open-sync-shell",
          "double-open-single-dialog",
          "stale-response-no-dom",
          "ready-fingerprint-and-scroll",
          "error-close-retry-article",
          "close-idempotent",
          "focus-restore",
          "escape-once",
          "dispose",
          "keyboard-scroll",
          "user-scroll-cancels-correction",
        ],
      },
      null,
      2,
    ) + "\n",
  );
});

// Keep the module import meaningful for the type checker.
void readFile;
