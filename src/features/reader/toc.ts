/**
 * Reader navigation rail (CONTRACT §7/§8 — 2026-09-12 追加).
 *
 * A hover/focus-expanded table of contents that lives on the right edge of the
 * reader window, next to the scrollbar (the position the user pointed at). It is
 * a *view* of the headings already present in the converted prose — it never
 * re-parses Markdown and never invents anchors: every tick points at an existing
 * `id` inside `.reader-content`, so the anchor targets stay the ones Astro
 * generated for the canonical article page.
 *
 * Interaction notes:
 * - Hover or keyboard focus expands the labels; the rail itself is only ~44px wide
 *   and overhangs the scroll region, so the reading column never reflows.
 * - The first control pins the panel open for touch, where there is no hover.
 * - Activating a target scrolls *inside the panel* (never the page, never
 *   `location.hash`) and moves focus to the heading, keeping the reader's Esc and
 *   Tab isolation intact.
 */

export type ReaderTocOptions = {
  doc: Document;
  /** Scroll container that owns the reading position. */
  scrollHost: HTMLElement;
  /** Root of the converted prose (headings are read from here). */
  contentHost: HTMLElement;
  /** Reports whether reduced motion is currently requested. */
  prefersReducedMotion: () => boolean;
};

export type ReaderTocHandle = {
  /** The rail element to mount inside the reader window. */
  nav: HTMLElement;
  /** Rebuild the entries after new content was inserted. */
  refresh(): void;
  /** Drop listeners; the DOM is removed by the reader's own cleanup. */
  dispose(): void;
  /** Forget the current article's headings (loading/error/closed states). */
  clear(): void;
  /** Present the panel without hover (keyboard shortcut / touch). */
  reveal(): boolean;
  /** Close a pinned panel; true when it consumed the key. */
  handleEscape(): boolean;
  /** Currently highlighted heading id, or null. */
  activeId(): string | null;
  /** Number of navigation entries. */
  count(): number;
};

type TocEntry = {
  id: string;
  label: string;
  level: number;
  target: HTMLElement;
  tick: HTMLAnchorElement;
  link: HTMLAnchorElement;
  item: HTMLLIElement;
};

const HEADING_SELECTOR = "h1[id], h2[id], h3[id], h4[id]";
/** Shortest label worth showing; anything longer is ellipsised by CSS. */
const MAX_LABEL = 60;

const slugLabel = (value: string): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
};

export function createReaderToc(options: ReaderTocOptions): ReaderTocHandle {
  const { doc, scrollHost, contentHost, prefersReducedMotion } = options;

  const nav = doc.createElement("nav");
  nav.className = "reader-toc";
  nav.setAttribute("aria-label", "目录导航");
  nav.hidden = true;

  const panel = doc.createElement("div");
  panel.className = "reader-toc-panel";
  const list = doc.createElement("ol");
  list.className = "reader-toc-list";
  panel.appendChild(list);
  nav.appendChild(panel);

  const rail = doc.createElement("div");
  rail.className = "reader-toc-rail";
  rail.setAttribute("aria-hidden", "true");
  nav.appendChild(rail);

  let entries: TocEntry[] = [];
  let activeId: string | null = null;
  let pinned = false;
  let disposed = false;
  let rafId: number | null = null;

  const setActive = (id: string | null) => {
    if (id === activeId) return;
    activeId = id;
    for (const entry of entries) {
      const isActive = entry.id === id;
      entry.tick.classList.toggle("is-active", isActive);
      entry.tick.setAttribute("aria-current", isActive ? "true" : "false");
      entry.link.classList.toggle("is-active", isActive);
      if (isActive) entry.link.setAttribute("aria-current", "true");
      else entry.link.removeAttribute("aria-current");
    }
  };

  /** The heading whose top is closest above the reading position. */
  const readActiveId = (): string | null => {
    if (entries.length === 0) return null;
    const hostTop = scrollHost.getBoundingClientRect().top;
    // A tenth of the visible height is the "reading line": a heading counts as
    // current once it has crossed into the top band of the region.
    const line = hostTop + Math.min(120, scrollHost.clientHeight * 0.18);
    let current: string | null = entries[0].id;
    for (const entry of entries) {
      if (entry.target.getBoundingClientRect().top <= line) current = entry.id;
      else break;
    }
    return current;
  };

  /** rAF is taken from the reader's document so tests and non-window hosts work. */
  const raf = (callback: () => void): number => {
    const view = doc.defaultView;
    if (view?.requestAnimationFrame) return view.requestAnimationFrame(callback);
    return Number(setTimeout(callback, 16));
  };
  const cancelRaf = (handle: number): void => {
    if (doc.defaultView?.cancelAnimationFrame) doc.defaultView.cancelAnimationFrame(handle);
    else clearTimeout(handle);
  };
  /** `matches()` on interaction pseudo-classes: a host without them answers false. */
  const matchesSafe = (element: HTMLElement, selector: string): boolean => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  };

  const scheduleActive = () => {
    if (disposed || rafId !== null) return;
    rafId = raf(() => {
      rafId = null;
      try {
        setActive(readActiveId());
      } catch {
        setActive(null);
      }
    });
  };

  /**
   * The rail carries no button and no label: the only chrome is the tick stack, so
   * the panel is opened by hovering/focusing a tick (`T` and `Esc` are the keyboard
   * route). Nothing in the window spells out "目录".
   */
  const expand = (next: boolean) => {
    nav.classList.toggle("is-expanded", next);
  };

  const pin = (next: boolean) => {
    pinned = next;
    nav.classList.toggle("is-pinned", next);
    expand(next || matchesSafe(nav, ":hover") || matchesSafe(nav, ":focus-within"));
  };

  const scrollToHeading = (target: HTMLElement) => {
    const reduced = prefersReducedMotion();
    const hostRect = scrollHost.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = scrollHost.scrollTop + (targetRect.top - hostRect.top) - 8;
    scrollHost.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
  };

  const activate = (entry: TocEntry, moveFocus: boolean) => {
    scrollToHeading(entry.target);
    setActive(entry.id);
    if (moveFocus) {
      if (!entry.target.hasAttribute("tabindex")) entry.target.setAttribute("tabindex", "-1");
      entry.target.focus?.({ preventScroll: true });
    }
    scheduleActive();
  };

  /**
   * Hover is detected on the tick marks themselves, not on the whole rail column:
   * the rail box is taller than the tick stack, and expanding from that empty
   * area (or from the window edge beside it) was the wrong affordance.
   */
  const isPointOverNav = (event: MouseEvent): boolean => {
    const { clientX, clientY } = event;
    const overPanel = panel.getBoundingClientRect();
    if (clientX >= overPanel.left && clientX <= overPanel.right && clientY >= overPanel.top && clientY <= overPanel.bottom) return true;
    return entries.some((entry) => {
      const box = entry.tick.getBoundingClientRect();
      return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
    });
  };

  const leaveNav = (event: MouseEvent) => {
    if (disposed || pinned || matchesSafe(nav, ":focus-within")) return;
    if (isPointOverNav(event)) return;
    expand(false);
  };

  /**
   * Tapping anywhere outside the rail/panel collapses a pinned panel. Touch has no
   * hover to end, so without this the pinned panel was a dead end: the reader had
   * to find `Esc`. `pointerdown` is used rather than `click` so the collapse
   * happens as the tap lands, and the check runs on capture so a tap that also
   * activates prose (a link, a footnote) still closes the outline first.
   */
  const onPointerDown = (event: Event) => {
    if (disposed || !pinned) return;
    const target = event.target as Node | null;
    if (target && (nav.contains(target) || panel.contains(target))) return;
    const active = doc.activeElement as HTMLElement | null;
    if (active && panel.contains(active)) active.blur?.();
    pin(false);
  };
  /**
   * Keyboard route: leaving the outline region also closes it (`Tab` out). The
   * handler is named so `dispose()` can detach it again.
   */
  const onDocumentFocusIn = (event: Event) => {
    if (disposed || !pinned) return;
    const target = event.target as Node | null;
    if (target && (nav.contains(target) || panel.contains(target))) return;
    pin(false);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focusin", onDocumentFocusIn);

  panel.addEventListener("mouseleave", leaveNav);
  nav.addEventListener("focusin", () => expand(true));
  nav.addEventListener("focusout", () => {
    // Focus may move between the rail and the panel; only collapse once it left.
    raf(() => {
      if (disposed || pinned || matchesSafe(nav, ":focus-within") || matchesSafe(nav, ":hover")) return;
      expand(false);
    });
  });

  const onScroll = () => scheduleActive();
  scrollHost.addEventListener("scroll", onScroll, { passive: true });

  const buildEntry = (target: HTMLElement, index: number): TocEntry => {
    const id = target.id;
    const level = Number.parseInt(target.tagName.slice(1), 10) || 2;
    const label = slugLabel(target.textContent ?? id);

    const tick = doc.createElement("a");
    tick.className = "reader-toc-tick";
    tick.setAttribute("href", `#${id}`);
    tick.setAttribute("aria-label", label);
    tick.setAttribute("title", label);
    tick.setAttribute("aria-current", "false");
    // The rail is decorative for assistive tech: the panel links carry the names.
    tick.tabIndex = -1;
    tick.dataset.level = String(level);

    const link = doc.createElement("a");
    link.className = "reader-toc-link";
    link.setAttribute("href", `#${id}`);
    link.dataset.level = String(level);
    link.textContent = label;

    const item = doc.createElement("li");
    item.className = "reader-toc-item";
    item.appendChild(link);

    const entry: TocEntry = { id, label, level, target, tick, link, item };
    const handler = (event: Event) => {
      const mouse = event as MouseEvent;
      if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey || mouse.button > 0) return;
      event.preventDefault();
      // Tapping the entry that is already current closes the outline again, so the
      // rail works as a toggle on touch; any other tap jumps and keeps it open.
      if (pinned && activeId === id) {
        pin(false);
        return;
      }
      activate(entry, true);
      pin(true);
    };
    tick.addEventListener("click", handler);
    tick.addEventListener("mouseenter", () => {
      if (disposed || pinned) return;
      expand(true);
      scheduleActive();
    });
    tick.addEventListener("mouseleave", leaveNav);
    link.addEventListener("click", handler);
    tick.dataset.index = String(index);
    link.dataset.index = String(index);
    return entry;
  };

  const refresh = () => {
    if (disposed) return;
    const targets = [...contentHost.querySelectorAll<HTMLElement>(HEADING_SELECTOR)].filter((element) => element.id);
    entries = [];
    list.replaceChildren();
    rail.replaceChildren();
    targets.forEach((target, index) => {
      const entry = buildEntry(target, index);
      entries.push(entry);
      list.appendChild(entry.item);
      rail.appendChild(entry.tick);
    });
    nav.hidden = entries.length < 2;
    // A host without layout (unit-test stubs, or a detached document) simply has
    // no active heading yet; the rail itself still works.
    try {
      setActive(readActiveId());
    } catch {
      setActive(null);
    }
  };

  const clear = () => {
    if (disposed) return;
    entries = [];
    list.replaceChildren();
    rail.replaceChildren();
    nav.hidden = true;
    pinned = false;
    nav.classList.remove("is-pinned");
    expand(false);
    setActive(null);
  };

  const dispose = () => {
    disposed = true;
    if (rafId !== null) cancelRaf(rafId);
    rafId = null;
    scrollHost.removeEventListener("scroll", onScroll);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focusin", onDocumentFocusIn);
    entries = [];
  };

  /** Keyboard route (`T`): open the panel and put focus on its first entry. */
  const reveal = () => {
    if (nav.hidden) return false;
    pin(true);
    entries[0]?.link.focus?.();
    return true;
  };

  /** Close a pinned panel; true when it consumed the key. */
  const handleEscape = () => {
    if (nav.hidden || !pinned) return false;
    const active = doc.activeElement as HTMLElement | null;
    if (active && panel.contains(active)) active.blur?.();
    pin(false);
    return true;
  };

  refresh();

  return {
    nav,
    refresh,
    dispose,
    clear,
    reveal,
    handleEscape,
    activeId: () => activeId,
    count: () => entries.length,
  };
}
