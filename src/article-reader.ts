/**
 * Immersive reader surface: one native `<dialog>` under `body` holding the very
 * same modal surface the three system dialogs use (`.modal-backdrop` +
 * `.terminal-modal`), a fixed toolbar, an internally scrolling content area,
 * three load states, bounded scroll memory and a narrow interface for the main
 * application.
 *
 * The window is a centred modal window and the enter/exit motion is the shared
 * `SurfaceTransition`; the reader deliberately owns no geometry or animation of
 * its own any more (plan IR3 revision, 2026-09-12).
 *
 * The module owns only the reader layer. It never calls `setMode()`/`select()`,
 * never reads `records[selected]`, and only reports `inputSuspended` changes so
 * the 3D application can pause its own input handling (CONTRACT.md §3, §13).
 */
import type { FetchLike, LoadResult, TimerApi } from "./article-reader-content.ts";
import { createReaderToc } from "./article-reader-toc.ts";
import { SurfaceTransition } from "./ui-transitions.ts";
import { viewportLayout } from "./viewport-layout.ts";
import {
  createMemoryScrollStorage,
  createReaderScrollStore,
  findAnchorId,
  restoreScrollTop,
  type ReaderScrollStorage,
  type ReaderScrollStore,
} from "../shared/reading/scroll-store.ts";
import { readerWindow, type ReaderWindow, type ReaderWindowLayout } from "../shared/reading/geometry.ts";
import type { ConvertResult } from "../shared/reading/content.ts";

export type ReaderTarget = Readonly<{
  postId: string;
  href: string;
  title: string;
}>;

export type SurfaceState = "closed" | "opening" | "open" | "closing";
export type LoadState = "idle" | "loading" | "ready" | "error";
export type CloseReason = "button" | "escape" | "context-change" | "dispose";

export type ReaderSnapshot = {
  state: SurfaceState;
  loadState: LoadState;
  postId: string | null;
  title: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ReaderDependencies = {
  document: Document;
  /** Page origin the article URL must stay inside. */
  origin: string;
  /**
   * Content loader. Required so that this module (and with it `parse5`) carries
   * no static dependency on the content stack: the application imports it on
   * demand from `./article-reader-content.ts`.
   */
  load: (options: import("./article-reader-content.ts").LoadOptions) => Promise<LoadResult>;
  fetch?: FetchLike;
  timers?: TimerApi;
  motionTimers?: { setTimeout: (handler: () => void, ms: number) => number; clearTimeout: (handle: number) => void };
  storage?: ReaderScrollStorage | null;
  reducedMotion?: () => boolean;
  /** Settles once the first layout pass used for scroll restore is available. */
  fontsReady?: () => Promise<void>;
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  createResizeObserver?: (callback: () => void) => { observe(target: Element): void; disconnect(): void };
  restoreDelayMs?: number;
  correctionWindowMs?: number;
  instanceId?: number;
  onInputSuspended?: (suspended: boolean) => void;
  onChange?: (snapshot: ReaderSnapshot) => void;
};

export interface ImmersiveReader {
  readonly isActive: boolean;
  readonly state: SurfaceState;
  readonly loadState: LoadState;
  readonly snapshot: ReaderSnapshot;
  readonly scrollStore: ReaderScrollStore;
  readonly dialog: HTMLDialogElement;
  open(target: ReaderTarget, opener?: HTMLElement | null): boolean;
  close(reason: CloseReason, options?: { restoreFocus?: boolean }): Promise<void>;
  retry(): boolean;
  setReducedMotion(value: boolean): void;
  dispose(): void;
}

export const DEFAULT_RESTORE_DELAY_MS = 500;
export const SCROLL_CORRECTION_WINDOW_MS = 2000;
export const ANCHOR_MARGIN = 16;
export const READY_REVEAL_DELAY_MS = 48;

/** Fallback edges when the reader is used outside the lab stage (tests/fixtures). */
const STAGE_FALLBACK = { layout: "desktop" as ReaderWindowLayout, edge: 59, topEdge: 16, bottomEdge: 12 };

function defaultMotionTimers(): { setTimeout: (handler: () => void, ms: number) => number; clearTimeout: (handle: number) => void } {
  return {
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
    clearTimeout: (handle) => globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
  };
}

function isRestorable(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element && typeof element.focus === "function" && element.isConnected !== false);
}

/**
 * Create the reader for one document. Every browser capability is injectable, so
 * the state machine, request ownership and scroll memory are unit testable.
 */
export function createArticleReader(dependencies: ReaderDependencies): ImmersiveReader {
  const doc = dependencies.document;
  const timers = dependencies.motionTimers ?? defaultMotionTimers();
  const instanceId = dependencies.instanceId ?? 1;
  const raf =
    dependencies.requestAnimationFrame ?? ((callback: () => void) => globalThis.requestAnimationFrame(callback) as unknown as number);
  const cancelRaf = dependencies.cancelAnimationFrame ?? ((handle: number) => globalThis.cancelAnimationFrame(handle));

  const readReducedMotion = (): boolean => {
    if (dependencies.reducedMotion) return dependencies.reducedMotion();
    try {
      return doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    } catch {
      return false;
    }
  };
  let reducedMotionOverride: boolean | null = null;
  const prefersReducedMotion = (): boolean => reducedMotionOverride ?? readReducedMotion();

  const storage =
    dependencies.storage !== undefined
      ? dependencies.storage
      : (() => {
          try {
            return doc.defaultView?.sessionStorage ?? null;
          } catch {
            return null;
          }
        })() ?? createMemoryScrollStorage();
  const scrollStore = createReaderScrollStore(storage);

  // ---- DOM scaffold ---------------------------------------------------------
  // The reader surface is literally the archive modal surface: `.modal-backdrop`
  // dims/blurs and centres, `.terminal-modal` is the window box, and the shared
  // `SurfaceTransition` animates them exactly like ARCHIVE INDEX / SAVED / SYSTEM.
  const dialog = doc.createElement("dialog");
  dialog.className = "article-reader";
  dialog.setAttribute("data-reader-instance", String(instanceId));

  const backdrop = doc.createElement("div");
  backdrop.className = "modal-backdrop reader-backdrop";
  backdrop.hidden = true;
  dialog.appendChild(backdrop);

  const sheet = doc.createElement("section");
  sheet.className = "terminal-modal reader-sheet";
  backdrop.appendChild(sheet);
  const transition = new SurfaceTransition(backdrop, sheet);

  const toolbar = doc.createElement("div");
  toolbar.className = "reader-toolbar modal-top";
  sheet.appendChild(toolbar);

  const heading = doc.createElement("p");
  heading.className = "reader-title";
  heading.id = `reader-title-${instanceId}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  toolbar.appendChild(heading);

  const status = doc.createElement("p");
  status.className = "reader-status";
  status.setAttribute("role", "status");
  toolbar.appendChild(status);

  const actions = doc.createElement("div");
  actions.className = "reader-actions";
  toolbar.appendChild(actions);

  const retryButton = doc.createElement("button");
  retryButton.type = "button";
  retryButton.className = "reader-retry";
  retryButton.textContent = "重试";
  retryButton.hidden = true;
  actions.appendChild(retryButton);

  const articleLink = doc.createElement("a");
  articleLink.className = "reader-article-link";
  articleLink.textContent = "独立文章页 ↗";
  actions.appendChild(articleLink);

  // Exit control reuses the visual treatment of the three system dialogs' "CLOSE ×"
  // (`src/style.css` .modal-top button): label + letter-spaced text and a CSS-drawn
  // cross, no frame of its own. Only the destination differs — it collapses the
  // reader and returns to the archive context.
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "reader-close";
  closeButton.setAttribute("aria-label", "收起全文，返回档案");
  closeButton.setAttribute("title", "收起全文，返回档案");
  closeButton.appendChild(doc.createTextNode("CLOSE\u00a0"));
  const closeIcon = doc.createElement("span");
  closeIcon.className = "reader-close-icon";
  closeIcon.setAttribute("aria-hidden", "true");
  closeButton.appendChild(closeIcon);
  actions.appendChild(closeButton);

  const scrollHost = doc.createElement("div");
  scrollHost.className = "reader-scroll";
  scrollHost.tabIndex = 0;
  sheet.appendChild(scrollHost);

  const contentHost = doc.createElement("div");
  contentHost.className = "reader-content";
  scrollHost.appendChild(contentHost);

  const stateHost = doc.createElement("div");
  stateHost.className = "reader-state";
  scrollHost.appendChild(stateHost);

  const toc = createReaderToc({
    doc,
    scrollHost,
    contentHost,
    prefersReducedMotion,
  });
  sheet.appendChild(toc.nav);

  const errorPanel = doc.createElement("div");
  errorPanel.className = "reader-error";
  errorPanel.hidden = true;
  stateHost.appendChild(errorPanel);

  const errorText = doc.createElement("p");
  errorText.className = "reader-error-text";
  errorPanel.appendChild(errorText);

  const openInArticle = doc.createElement("a");
  openInArticle.className = "reader-article-link reader-article-link-inline";
  openInArticle.textContent = "打开独立文章页";
  errorPanel.appendChild(openInArticle);

  // ---- State ---------------------------------------------------------------
  let state: SurfaceState = "closed";
  let loadState: LoadState = "idle";
  let currentTarget: ReaderTarget | null = null;
  let currentOpener: HTMLElement | null = null;
  let currentFingerprint: string | null = null;
  let requestToken = 0;
  let abortController: AbortController | null = null;
  let closingPromise: Promise<void> | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let suspended = false;
  let disposed = false;
  let restoreTimer: number | null = null;
  let correctionTimer: number | null = null;
  let resizeObserver: { observe(target: Element): void; disconnect(): void } | null = null;
  let userInteracted = false;
  let revealRaf: number | null = null;

  const readerActive = (): boolean => state === "opening" || state === "open" || state === "closing";

  const snapshot = (): ReaderSnapshot => ({
    state,
    loadState,
    postId: currentTarget?.postId ?? null,
    title: currentTarget?.title ?? null,
    errorCode,
    errorMessage,
  });

  const setState = (next: SurfaceState, nextLoad?: LoadState) => {
    const changed = next !== state || (nextLoad !== undefined && nextLoad !== loadState);
    state = next;
    if (nextLoad !== undefined) loadState = nextLoad;
    dialog.setAttribute("data-state", state);
    dialog.setAttribute("data-load", loadState);
    if (changed) dependencies.onChange?.(snapshot());
  };

  const setInputSuspended = (value: boolean) => {
    if (suspended === value) return;
    suspended = value;
    dependencies.onInputSuspended?.(value);
  };

  // ---- Layout --------------------------------------------------------------
  /**
   * The window box and the compact/portrait rules live in the shared modal CSS,
   * which is driven by `#stage`'s layout state. The dialog sits outside the stage
   * (top layer), so the live values are mirrored onto it here; nothing about the
   * window is re-derived by the reader itself.
   */
  const stageMetrics = (): { layout: ReaderWindowLayout; stageScale: number; modalTop: number; modalHeight: number | null; edge: number; topEdge: number; bottomEdge: number } => {
    const stage = doc.getElementById("stage");
    if (!stage || typeof doc.defaultView?.getComputedStyle !== "function") {
      // Standalone use (tests, fixtures, an embed without the lab shell): mirror
      // `viewportLayout()` so the window still fits the viewport the same way the
      // app's modal surface does.
      const view = doc.defaultView;
      let coarse = false;
      try {
        coarse = view?.matchMedia?.("(pointer: coarse)")?.matches ?? false;
      } catch {
        coarse = false;
      }
      const layoutInfo = viewportLayout(view?.innerWidth ?? 1366, view?.innerHeight ?? 768, coarse);
      const layout: ReaderWindowLayout = layoutInfo.kind === "portrait" || layoutInfo.kind === "compact" ? layoutInfo.kind : "desktop";
      // Compact/portrait use the responsive edges (`#stage:is([data-layout=...])`
      // in responsive.css); desktop keeps the 59px stage edge.
      const compactEdges = layout !== "desktop";
      return {
        layout,
        stageScale: layoutInfo.scale,
        modalTop: 0,
        modalHeight: null,
        edge: compactEdges ? 20 : STAGE_FALLBACK.edge,
        topEdge: compactEdges ? 16 : STAGE_FALLBACK.topEdge,
        bottomEdge: compactEdges ? 12 : STAGE_FALLBACK.bottomEdge,
      };
    }
    const computed = doc.defaultView.getComputedStyle(stage);
    const readNumber = (name: string, fallback: number): number => {
      const raw = Number.parseFloat(computed.getPropertyValue(name));
      return Number.isFinite(raw) ? raw : fallback;
    };
    const rawLayout = (stage.dataset?.layout ?? "desktop") as ReaderWindowLayout;
    const layout: ReaderWindowLayout = rawLayout === "compact" || rawLayout === "portrait" ? rawLayout : "desktop";
    const modalHeightRaw = Number.parseFloat(computed.getPropertyValue("--modal-height"));
    return {
      layout,
      stageScale: readNumber("--stage-scale", 1),
      modalTop: readNumber("--modal-top", 0),
      modalHeight: Number.isFinite(modalHeightRaw) ? modalHeightRaw : null,
      edge: readNumber("--edge", STAGE_FALLBACK.edge),
      topEdge: readNumber("--top-edge", STAGE_FALLBACK.topEdge),
      bottomEdge: readNumber("--bottom-edge", STAGE_FALLBACK.bottomEdge),
    };
  };

  const applyGeometry = () => {
    const view = doc.defaultView;
    const metrics = stageMetrics();
    const viewportHeight = view?.innerHeight ?? 0;
    const visualHeight = view?.visualViewport?.height ?? viewportHeight;
    const geometry: ReaderWindow = readerWindow({
      viewportWidth: view?.innerWidth ?? 0,
      viewportHeight: metrics.layout === "desktop" ? viewportHeight : Math.min(viewportHeight, visualHeight),
      stageScale: metrics.stageScale,
      layout: metrics.layout,
      insets: { top: metrics.topEdge, right: metrics.edge, bottom: metrics.bottomEdge, left: metrics.edge },
    });
    // Layout state the shared modal CSS keys off, mirrored from the live stage.
    dialog.dataset.layout = metrics.layout;
    // Motion preference is a JS concern here (the app also overrides it), so the
    // stylesheet reads it from the dialog instead of guessing with a media query.
    dialog.dataset.reducedMotion = String(prefersReducedMotion());
    if (metrics.layout === "desktop") {
      // Desktop edges are plain numbers on `#stage`; the compact/portrait edges
      // resolve `env(safe-area-inset-*)` in CSS (custom properties are not
      // resolved by `getPropertyValue`), so the reader stylesheet declares them
      // for the dialog itself instead of copying them here.
      dialog.style.setProperty("--edge", `${metrics.edge}px`);
      dialog.style.setProperty("--top-edge", `${metrics.topEdge}px`);
      dialog.style.setProperty("--bottom-edge", `${metrics.bottomEdge}px`);
    } else {
      dialog.style.removeProperty("--edge");
      dialog.style.removeProperty("--top-edge");
      dialog.style.removeProperty("--bottom-edge");
    }
    dialog.style.setProperty("--modal-top", `${metrics.modalTop}px`);
    dialog.style.setProperty("--modal-height", `${metrics.modalHeight ?? geometry.height + metrics.topEdge + metrics.bottomEdge}px`);
    dialog.style.setProperty("--reader-stage-scale", String(geometry.stageScale));
    sheet.style.setProperty("--reader-width", `${geometry.width}px`);
    sheet.style.setProperty("--reader-height", `${geometry.height}px`);
    sheet.style.setProperty("--reader-window-padding-x", `${geometry.windowPaddingX}px`);
    sheet.style.setProperty("--reader-window-padding-y", `${geometry.windowPaddingY}px`);
    sheet.style.setProperty("--reader-font-size", `${geometry.fontSize}px`);
    sheet.style.setProperty("--reader-padding-x", `${geometry.horizontalPadding}px`);
    sheet.style.setProperty("--reader-padding-bottom", `${geometry.bottomPadding}px`);
  };

  // ---- Scroll memory -------------------------------------------------------
  const stopCorrection = () => {
    if (correctionTimer !== null) {
      timers.clearTimeout(correctionTimer);
      correctionTimer = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
  };

  const markUserInteraction = () => {
    userInteracted = true;
    stopCorrection();
  };

  const captureScrollRecord = () => {
    if (!currentTarget || !currentFingerprint) return;
    const candidates = Array.from(contentHost.querySelectorAll("[id]")).map((element) => ({
      id: element.id,
      top: (element as HTMLElement).offsetTop ?? 0,
    }));
    const anchor = findAnchorId(candidates, scrollHost.scrollTop, ANCHOR_MARGIN);
    scrollStore.save({
      postId: currentTarget.postId,
      canonicalPath: currentTarget.href,
      fingerprint: currentFingerprint,
      anchorId: anchor.anchorId,
      anchorOffset: anchor.anchorOffset,
      scrollTop: scrollHost.scrollTop,
    });
  };

  const resolveAnchorTop = (anchorId: string): number | null => {
    const element = contentHost.querySelector(`[id="${anchorId.replace(/["\\]/g, "\\$&")}"]`);
    if (!element) return null;
    return (element as HTMLElement).offsetTop ?? null;
  };

  const applyRestore = () => {
    if (!currentTarget || !currentFingerprint || userInteracted) return;
    const record = scrollStore.get(currentTarget.postId, currentTarget.href, currentFingerprint);
    if (!record) {
      scrollHost.scrollTop = 0;
      return;
    }
    const maxScrollTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
    scrollHost.scrollTop = restoreScrollTop(record, resolveAnchorTop, maxScrollTop).scrollTop;
  };

  const onCreateResizeObserver =
    dependencies.createResizeObserver ??
    ((callback: () => void) => {
      const Observer = (
        doc.defaultView as unknown as {
          ResizeObserver?: new (cb: () => void) => { observe(target: Element): void; disconnect(): void };
        }
      )?.ResizeObserver;
      if (!Observer) return { observe: () => undefined, disconnect: () => undefined };
      return new Observer(callback);
    });

  const scheduleCorrection = () => {
    if (userInteracted || !currentTarget || !currentFingerprint) return;
    stopCorrection();
    resizeObserver = onCreateResizeObserver(() => {
      if (userInteracted || !readerActive() || !currentTarget || !currentFingerprint) return;
      const record = scrollStore.get(currentTarget.postId, currentTarget.href, currentFingerprint);
      if (!record) return;
      const maxScrollTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
      const next = restoreScrollTop(record, resolveAnchorTop, maxScrollTop).scrollTop;
      if (Math.abs(next - scrollHost.scrollTop) < 2) return;
      scrollHost.scrollTop = next;
    });
    resizeObserver.observe(contentHost);
    correctionTimer = timers.setTimeout(stopCorrection, dependencies.correctionWindowMs ?? SCROLL_CORRECTION_WINDOW_MS);
  };

  const scheduleRestore = () => {
    if (restoreTimer !== null) {
      timers.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      if (restoreTimer !== null) {
        timers.clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      applyRestore();
      scheduleCorrection();
    };
    // Prefer "after fonts are ready", but never later than the hard bound.
    const fonts = dependencies.fontsReady ?? (() => Promise.resolve());
    Promise.resolve()
      .then(() => fonts())
      .catch(() => undefined)
      .then(() => {
        if (disposed || done) return;
        run();
      });
    restoreTimer = timers.setTimeout(run, dependencies.restoreDelayMs ?? DEFAULT_RESTORE_DELAY_MS);
  };

  scrollHost.addEventListener("wheel", markUserInteraction, { passive: true });
  scrollHost.addEventListener("touchstart", markUserInteraction, { passive: true });
  scrollHost.addEventListener("keydown", markUserInteraction);
  scrollHost.addEventListener("pointerdown", markUserInteraction);

  // ---- Background isolation -------------------------------------------------
  const contains = (node: EventTarget | null): boolean => Boolean(node && dialog.contains(node as Node));
  const isolateOutside = (event: Event) => {
    if (!readerActive()) return;
    if (!contains(event.target)) event.preventDefault();
  };
  dialog.addEventListener("pointerdown", isolateOutside, true);
  dialog.addEventListener("wheel", isolateOutside, { capture: true, passive: false });
  dialog.addEventListener("click", (event) => {
    // A click on the backdrop (the dialog element itself) stops here: the sheet
    // keeps its actions and the background never receives the activation.
    if (!readerActive()) return;
    if (event.target === dialog) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  // ---- Focus -----------------------------------------------------------------
  const onKeydown = (event: KeyboardEvent) => {
    if (!readerActive()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // An open navigation panel is the innermost layer: Esc closes it first.
      if (toc.handleEscape()) return;
      void close("escape", { restoreFocus: true });
      return;
    }
    if (event.key === "t" || event.key === "T") {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable='true']"))) return;
      if (toc.reveal()) event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement | null;
    const inToolbar = Boolean(target && toolbar.contains(target) && !scrollHost.contains(target));
    if (inToolbar && ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const page = Math.max(80, scrollHost.clientHeight - 80);
      if (event.key === "PageDown") scrollHost.scrollTop += page;
      else if (event.key === "PageUp") scrollHost.scrollTop -= page;
      else if (event.key === "Home") scrollHost.scrollTop = 0;
      else if (event.key === "End") scrollHost.scrollTop = scrollHost.scrollHeight;
      else if (event.key === "ArrowDown") scrollHost.scrollTop += 40;
      else scrollHost.scrollTop -= 40;
      markUserInteraction();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"),
    )
      .filter((element) => !element.hidden)
      .filter((element) => element.offsetParent !== null || element === doc.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  dialog.addEventListener("keydown", onKeydown);

  dialog.addEventListener("cancel", (event) => {
    // The native cancel must not close the dialog immediately: the exit animation
    // still has to run, so it is prevented and routed through close().
    event.preventDefault();
    void close("escape", { restoreFocus: true });
  });
  dialog.addEventListener("close", () => {
    if (state !== "closed") void close("context-change", { restoreFocus: false });
  });
  closeButton.addEventListener("click", () => void close("button", { restoreFocus: true }));
  retryButton.addEventListener("click", () => retry());

  const onWindowResize = () => {
    if (!readerActive()) return;
    applyGeometry();
    if (loadState === "ready" && !userInteracted) scheduleCorrection();
  };
  doc.defaultView?.addEventListener?.("resize", onWindowResize);
  doc.defaultView?.visualViewport?.addEventListener?.("resize", onWindowResize);

  let reducedMotionQuery: { matches: boolean; addEventListener?: (type: string, handler: () => void) => void; removeEventListener?: (type: string, handler: () => void) => void } | null = null;
  let reducedMotionHandler: (() => void) | null = null;
  try {
    reducedMotionQuery = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    if (reducedMotionQuery && !dependencies.reducedMotion) {
      // The shared transition reads the preference per call; a live change only
      // has to re-apply the window metrics.
      reducedMotionHandler = () => {
        applyGeometry();
        // The rail decides between smooth and instant jumps per call, so nothing
        // else has to be re-read here.
      };
      reducedMotionQuery.addEventListener?.("change", reducedMotionHandler);
    }
  } catch {
    reducedMotionQuery = null;
  }

  // ---- Content states -------------------------------------------------------
  const renderLoading = (target: ReaderTarget) => {
    heading.textContent = target.title;
    status.textContent = "正在加载全文…";
    status.hidden = false;
    stateHost.hidden = false;
    errorPanel.hidden = true;
    // A new attempt supersedes the previous outcome: the stale code must not
    // survive into a successful render.
    errorCode = null;
    errorMessage = null;
    dialog.removeAttribute("data-error-code");
    contentHost.replaceChildren();
    toc.clear();
    articleLink.setAttribute("href", target.href);
    openInArticle.setAttribute("href", target.href);
    retryButton.hidden = true;
  };

  const renderReady = (result: Extract<ConvertResult, { activate: true }>) => {
    contentHost.replaceChildren();
    contentHost.appendChild(result.node);
    toc.refresh();
    stateHost.hidden = true;
    status.hidden = false;
    status.textContent = "全文已加载";
    heading.textContent = result.meta.title;
    articleLink.setAttribute("href", result.meta.canonicalPath);
    openInArticle.setAttribute("href", result.meta.canonicalPath);
    retryButton.hidden = true;
  };

  const renderError = (code: string, message: string) => {
    contentHost.replaceChildren();
    toc.clear();
    stateHost.hidden = false;
    errorPanel.hidden = false;
    // Only the message text is replaced: the panel also carries the
    // independent-article fallback link, which must survive every error.
    errorText.textContent = message;
    status.hidden = false;
    status.textContent = "加载失败";
    retryButton.hidden = false;
    const href = currentTarget?.href ?? "";
    articleLink.setAttribute("href", href);
    openInArticle.setAttribute("href", href);
    dialog.setAttribute("data-error-code", code);
  };

  function cleanupShell() {
    contentHost.replaceChildren();
    toc.clear();
    stateHost.hidden = false;
    errorPanel.hidden = true;
    heading.textContent = "";
    status.textContent = "";
    status.hidden = false;
    scrollHost.scrollTop = 0;
    retryButton.hidden = true;
    dialog.removeAttribute("data-error-code");
  }

  function startRequest(target: ReaderTarget): void {
    requestToken += 1;
    const token = requestToken;
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    setState(state === "opening" ? "opening" : "open", "loading");
    renderLoading(target);
    void dependencies
      .load({
        target: { postId: target.postId, href: target.href, title: target.title },
        origin: dependencies.origin,
        signal: controller.signal,
        document: doc,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.timers ? { timers: dependencies.timers } : {}),
        instanceId,
      })
      .then((result) => {
        // Ownership: a superseded or closed request must never touch the DOM.
        if (token !== requestToken || !readerActive() || abortController !== controller) return;
        if (result.status !== "ok") {
          errorCode = result.code;
          errorMessage = result.message;
          setState("open", "error");
          renderError(result.code, result.message);
          return;
        }
        const converted = result.result;
        revealRaf = raf(() => {
          revealRaf = null;
          if (token !== requestToken || !readerActive()) return;
          currentFingerprint = converted.meta.fingerprint;
          errorCode = null;
          errorMessage = null;
          renderReady(converted);
          setState("open", "ready");
          scheduleRestore();
        });
      })
      .catch(() => {
        if (token !== requestToken || !readerActive() || abortController !== controller) return;
        errorCode = "network";
        errorMessage = "加载中断，请重试或打开独立文章页";
        setState("open", "error");
        renderError(errorCode, errorMessage);
      });
  }

  // ---- Public API -----------------------------------------------------------
  function open(target: ReaderTarget, opener: HTMLElement | null = null): boolean {
    if (disposed || state === "closing") return false;
    currentTarget = { postId: target.postId, href: target.href, title: target.title };
    if (opener) currentOpener = opener;
    currentFingerprint = null;
    errorCode = null;
    errorMessage = null;
    userInteracted = false;
    stopCorrection();
    if (restoreTimer !== null) {
      timers.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    setState("opening", "loading");
    applyGeometry();
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        setState("closed", "idle");
        setInputSuspended(false);
        return false;
      }
    }
    setInputSuspended(true);
    // The surface must be visible before focusing: a control inside the still
    // `hidden` backdrop cannot take focus, and the dialog would keep it instead.
    transition.show(prefersReducedMotion());
    closeButton.focus?.();
    startRequest(target);
    return true;
  }

  function close(reason: CloseReason, options: { restoreFocus?: boolean } = {}): Promise<void> {
    if (state === "closed") return Promise.resolve();
    if (state === "closing" && closingPromise) return closingPromise;
    const restoreFocus = options.restoreFocus ?? reason !== "context-change";

    setState("closing");
    requestToken += 1;
    abortController?.abort();
    abortController = null;
    if (revealRaf !== null) {
      cancelRaf(revealRaf);
      revealRaf = null;
    }
    stopCorrection();
    if (restoreTimer !== null) {
      timers.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    captureScrollRecord();

    closingPromise = (async () => {
      try {
        // The shared transition hides the surface with the modal exit motion and
        // reports completion through its callback; a close that interrupts an
        // opening continues from the current opacity/transform.
        await new Promise<void>((resolve) => {
          transition.hide(prefersReducedMotion(), resolve);
        });
        setInputSuspended(false);
        cleanupShell();
        if (dialog.open) {
          try {
            dialog.close();
          } catch {
            // The engine already closed it.
          }
        }
        if (restoreFocus && isRestorable(currentOpener)) {
          const opener = currentOpener;
          try {
            opener.focus();
          } catch {
            // Focus restoration is best effort.
          }
          // WebKit may hand focus back to the document while the top-layer dialog
          // is being torn down, which would silently drop the focus the user had
          // before opening the panel. Re-assert it once the close has settled.
          const reassert = () => {
            if (!isRestorable(opener) || doc.activeElement === opener) return;
            try {
              opener.focus();
            } catch {
              // Ignore: the element may have been re-rendered in the meantime.
            }
          };
          // Two attempts: engines differ in when they hand focus back after a
          // top-layer dialog closes (WebKit restores it asynchronously).
          timers.setTimeout(reassert, 0);
          timers.setTimeout(reassert, 60);
        }
      } finally {
        currentOpener = null;
        currentTarget = null;
        currentFingerprint = null;
        errorCode = null;
        errorMessage = null;
        state = "closed";
        loadState = "idle";
        dialog.setAttribute("data-state", state);
        dialog.setAttribute("data-load", loadState);
        closingPromise = null;
        dependencies.onChange?.(snapshot());
      }
    })();
    return closingPromise;
  }

  function retry(): boolean {
    if (!currentTarget || state !== "open") return false;
    startRequest(currentTarget);
    return true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    requestToken += 1;
    abortController?.abort();
    abortController = null;
    stopCorrection();
    if (restoreTimer !== null) {
      timers.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    if (revealRaf !== null) {
      cancelRaf(revealRaf);
      revealRaf = null;
    }
    if (reducedMotionQuery && reducedMotionHandler) reducedMotionQuery.removeEventListener?.("change", reducedMotionHandler);
    toc.dispose();
    doc.defaultView?.removeEventListener?.("resize", onWindowResize);
    doc.defaultView?.visualViewport?.removeEventListener?.("resize", onWindowResize);
    transition.dispose();
    if (dialog.open) {
      try {
        dialog.close();
      } catch {
        // ignore
      }
    }
    setInputSuspended(false);
    dialog.remove();
    state = "closed";
    loadState = "idle";
    dependencies.onChange?.(snapshot());
  }

  dialog.setAttribute("data-state", state);
  dialog.setAttribute("data-load", loadState);

  return {
    get isActive() {
      return readerActive();
    },
    get state() {
      return state;
    },
    get loadState() {
      return loadState;
    },
    get snapshot() {
      return snapshot();
    },
    get scrollStore() {
      return scrollStore;
    },
    dialog,
    open,
    close,
    retry,
    setReducedMotion(value: boolean) {
      // The shared transition reads the preference on every show/hide call; the
      // reader only re-applies its window metrics.
      reducedMotionOverride = value;
      applyGeometry();
    },
    dispose,
  };
}

/**
 * Mount the reader on a document: creates the single dialog using the reader
 * stylesheet the caller already loaded, appends it to the mount point and
 * returns the reader. The caller supplies the content loader so that importing
 * this module never pulls in the HTML parsing stack.
 */
export function installArticleReader(
  dependencies: Omit<ReaderDependencies, "document"> & {
    document?: Document;
    mount?: HTMLElement;
    stylesheetHref?: string | null;
  },
): { reader: ImmersiveReader; dispose(): void } {
  const doc = dependencies.document ?? globalThis.document;
  const reader = createArticleReader({ ...dependencies, document: doc });
  const mount = dependencies.mount ?? doc.body;
  const href = dependencies.stylesheetHref;
  if (href && !doc.querySelector(`link[data-reader-style="${href}"]`)) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-reader-style", href);
    doc.head?.appendChild(link);
  }
  mount.appendChild(reader.dialog);
  return {
    reader,
    dispose() {
      reader.dispose();
    },
  };
}
