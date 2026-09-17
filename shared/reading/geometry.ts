/**
 * Reader window metrics.
 *
 * The immersive reader reuses the archive's modal surface: the same centred
 * window box as the three system dialogs (ARCHIVE INDEX / SAVED / SYSTEM), the
 * same enter/exit transition and the same compact/portrait rules. The window is
 * therefore measured in the *stage* coordinate system (1260 × 836 at 1920 × 1080)
 * and scaled by the live `--stage-scale`, exactly like `.terminal-modal`, instead
 * of being a bottom-attached sheet of its own.
 *
 * Typography stays in CSS pixels on purpose: the window footprint matches the
 * dialogs, but a 0.71× scaled 18px prose would be unreadable, so only the box and
 * its padding scale with the stage.
 *
 * No DOM access here so the formulas can be asserted in Node tests.
 */
export type ReaderWindowLayout = "desktop" | "compact" | "portrait";

/** `.terminal-modal` box in stage coordinates (style.css). */
export const MODAL_WINDOW_WIDTH = 1260;
export const MODAL_WINDOW_HEIGHT = 836;
/** `.terminal-modal` padding in stage coordinates (35px 53px). */
export const MODAL_PADDING_Y = 35;
export const MODAL_PADDING_X = 53;
/** Desktop keeps at least 100 stage-px of breathing room (`.terminal-modal` max-width). */
export const MODAL_WINDOW_MARGIN = 100;
/** Compact/portrait overrides (responsive.css). */
export const COMPACT_WINDOW_MAX_WIDTH = 760;
export const COMPACT_WINDOW_MAX_HEIGHT = 850;
export const COMPACT_EDGE = 20;
export const COMPACT_TOP_EDGE = 16;
export const COMPACT_BOTTOM_EDGE = 12;

export const NARROW_BREAKPOINT = 900;
export const PROSE_FONT_DESKTOP = 18;
export const PROSE_FONT_NARROW = 16;
export const PROSE_PADDING_DESKTOP = 32;
export const PROSE_PADDING_NARROW = 20;
export const PROSE_BOTTOM_MIN = 24;

export type ReaderWindowInput = {
  viewportWidth: number;
  viewportHeight: number;
  /** Live `--stage-scale` from `#stage`; 1 in compact/portrait layouts. */
  stageScale?: number;
  layout?: ReaderWindowLayout;
  /** Safe-area insets used by the compact/portrait layout. */
  insets?: { top?: number; right?: number; bottom?: number; left?: number };
};

export type ReaderWindow = {
  width: number;
  height: number;
  left: number;
  top: number;
  layout: ReaderWindowLayout;
  stageScale: number;
  narrow: boolean;
  fontSize: number;
  horizontalPadding: number;
  bottomPadding: number;
  /** `.terminal-modal` padding for this window, already scaled. */
  windowPaddingX: number;
  windowPaddingY: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function readerWindow({
  viewportWidth,
  viewportHeight,
  stageScale = 1,
  layout = "desktop",
  insets = {},
}: ReaderWindowInput): ReaderWindow {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const narrow = width <= NARROW_BREAKPOINT;
  const compactLayout = layout !== "desktop";
  const scale = compactLayout ? 1 : Math.max(0.1, stageScale);

  let windowWidth: number;
  let windowHeight: number;
  let windowPaddingX: number;
  let windowPaddingY: number;
  let left: number;
  let top: number;

  if (compactLayout) {
    const edge = Math.max(COMPACT_EDGE, insets.left ?? 0, insets.right ?? 0);
    const topEdge = Math.max(COMPACT_TOP_EDGE, insets.top ?? 0);
    const bottomEdge = Math.max(COMPACT_BOTTOM_EDGE, insets.bottom ?? 0);
    const available = Math.max(0, width - edge * 2);
    const availableHeight = Math.max(0, height - topEdge - bottomEdge);
    windowWidth = Math.min(COMPACT_WINDOW_MAX_WIDTH, available);
    windowHeight = Math.min(COMPACT_WINDOW_MAX_HEIGHT, availableHeight);
    windowPaddingX = 20;
    windowPaddingY = 16;
    left = edge + Math.max(0, (available - windowWidth) / 2);
    top = topEdge + Math.max(0, (availableHeight - windowHeight) / 2);
  } else {
    const margin = MODAL_WINDOW_MARGIN * scale;
    windowWidth = clamp(MODAL_WINDOW_WIDTH * scale, 0, Math.max(0, width - margin));
    windowHeight = clamp(MODAL_WINDOW_HEIGHT * scale, 0, height);
    windowPaddingX = MODAL_PADDING_X * scale;
    windowPaddingY = MODAL_PADDING_Y * scale;
    left = Math.max(0, (width - windowWidth) / 2);
    top = Math.max(0, (height - windowHeight) / 2);
  }

  return {
    width: Math.round(windowWidth),
    height: Math.round(windowHeight),
    left: Math.round(left),
    top: Math.round(top),
    layout,
    stageScale: scale,
    narrow,
    fontSize: narrow ? PROSE_FONT_NARROW : PROSE_FONT_DESKTOP,
    horizontalPadding: narrow ? PROSE_PADDING_NARROW : PROSE_PADDING_DESKTOP,
    bottomPadding: PROSE_BOTTOM_MIN,
    windowPaddingX: Math.round(windowPaddingX),
    windowPaddingY: Math.round(windowPaddingY),
  };
}

/**
 * Visible offset correction for `visualViewport`: only used while the user is
 * not pinch-zoomed in, so a magnified page is never shrunk back.
 */
export function readerViewportOffset(
  visualViewport: { offsetTop?: number; offsetLeft?: number; scale?: number } | null | undefined,
): { top: number; left: number } {
  if (!visualViewport) return { top: 0, left: 0 };
  const scale = visualViewport.scale ?? 1;
  if (Math.abs(scale - 1) > 0.01) return { top: 0, left: 0 };
  return { top: Math.max(0, visualViewport.offsetTop ?? 0), left: Math.max(0, visualViewport.offsetLeft ?? 0) };
}
