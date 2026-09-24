// Pure trajectory, layout and clock contract for the boot intro
// (LOGIN-IMPROVE L1a).
//
// This module deliberately has no DOM, network, audio or global clock access.
// Every sample is a pure function of its arguments, so a long frame, a
// background tab or a repeated tick can never change the result at a given
// elapsed time. BootIntro/BootEntry own the DOM and pass measured sizes in.

export const FPS = 25;
export const FRAME_MS = 1000 / FPS;

export const DOCKING_MS = 720;
export const FORM_ENTER_START_MS = 360;
export const FORM_ROW_STAGGER_MS = 80;
export const EXIT_MS = 320;

export const HANDOFF_TARGET_FRAME = 169;
export const HANDOFF_APP_TIME = 1.76;

export const FORM_TRANSLATE_Y = 24;
export const STACK_GAP = 56;

export const REFERENCE_LOGO_WIDTH = 256;
export const REFERENCE_FORM_WIDTH = 423;
export const LOGO_CENTER_X_RATIO = 0.384;
export const FORM_CENTER_X_RATIO = 0.601;
export const VERTICAL_CENTER_RATIO = 0.5;
export const SIDE_MIN_WIDTH = 1720;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function smooth(p: number): number {
  const v = clamp01(p);
  return v * v * (3 - 2 * v);
}

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

export interface IntroLayoutInput extends Size {
  readonly logo: Size;
  readonly form: Size;
}

export interface IntroLayout {
  readonly mode: "side" | "stack";
  readonly logo: Rect;
  readonly form: Rect;
  readonly center: { readonly x: number; readonly y: number };
  readonly exitLogoDx: number;
  readonly exitFormDx: number;
  readonly contentHeight: number;
}

function safeSize(size: Size): Size {
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 1;
  const height =
    Number.isFinite(size.height) && size.height > 0 ? size.height : 1;
  return { width, height };
}

export function introLayout(input: IntroLayoutInput): IntroLayout {
  const viewport = safeSize(input);
  const logo = safeSize(input.logo);
  const form = safeSize(input.form);
  const formWidth = Math.min(form.width, Math.max(1, viewport.width - 32));
  const center = {
    x: viewport.width / 2,
    y: viewport.height * VERTICAL_CENTER_RATIO,
  };

  if (viewport.width >= SIDE_MIN_WIDTH) {
    const logoRect: Rect = {
      x: viewport.width * LOGO_CENTER_X_RATIO - logo.width / 2,
      y: viewport.height * VERTICAL_CENTER_RATIO - logo.height / 2,
      width: logo.width,
      height: logo.height,
    };
    const formRect: Rect = {
      x: viewport.width * FORM_CENTER_X_RATIO - formWidth / 2,
      y: viewport.height * VERTICAL_CENTER_RATIO - form.height / 2,
      width: formWidth,
      height: form.height,
    };
    return {
      mode: "side",
      logo: logoRect,
      form: formRect,
      center,
      exitLogoDx: -(logoRect.x + logoRect.width),
      exitFormDx: viewport.width - formRect.x,
      contentHeight: viewport.height,
    };
  }

  // Small screens stack the Logo above the panel. Keep the stack clear of the
  // corner brand and let it extend below the fold as a scrollable curtain
  // instead of overlapping the decorations.
  const safeTop = Math.min(150, Math.max(96, viewport.height * 0.22));
  const totalHeight = logo.height + STACK_GAP + form.height;
  const top = Math.max(
    safeTop,
    viewport.height * VERTICAL_CENTER_RATIO - totalHeight / 2,
  );
  const logoRect: Rect = {
    x: center.x - logo.width / 2,
    y: top,
    width: logo.width,
    height: logo.height,
  };
  const formRect: Rect = {
    x: center.x - formWidth / 2,
    y: top + logo.height + STACK_GAP,
    width: formWidth,
    height: form.height,
  };
  return {
    mode: "stack",
    logo: logoRect,
    form: formRect,
    center,
    exitLogoDx: -(logoRect.x + logoRect.width),
    exitFormDx: viewport.width - formRect.x,
    contentHeight: top + totalHeight + 72,
  };
}

export function dockProgress(elapsedMs: number): number {
  return smooth(clamp01(elapsedMs / DOCKING_MS));
}

export interface LogoState {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
}

/**
 * Docked Logo sample. `connecting` is the measured size of the loading mark;
 * the docked size is `layout.logo`. The DOM applies translate + scale on one
 * recycled node (never per-frame width/height writes).
 */
export function logoStateAt(
  elapsedMs: number,
  layout: IntroLayout,
  connecting: Size,
): LogoState {
  const from = safeSize(connecting);
  const p = dockProgress(elapsedMs);
  const width = lerp(from.width, layout.logo.width, p);
  return {
    x: lerp(layout.center.x - from.width / 2, layout.logo.x, p),
    y: lerp(layout.center.y - from.height / 2, layout.logo.y, p),
    scale: width / layout.logo.width,
    opacity: 1,
  };
}

export interface FormRowState {
  readonly visible: boolean;
  readonly translateY: number;
}

/**
 * Form reveal sample. Rows start at FORM_ENTER_START_MS and are staggered by
 * FORM_ROW_STAGGER_MS; every row settles by DOCKING_MS. Visibility is a
 * frame-point decision (25 fps reference), position is continuous time.
 */
export function formRowStateAt(elapsedMs: number, index: number): FormRowState {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const start = FORM_ENTER_START_MS + safeIndex * FORM_ROW_STAGGER_MS;
  const duration = Math.max(1, DOCKING_MS - start);
  const p = smooth(clamp01((elapsedMs - start) / duration));
  return {
    visible: elapsedMs >= start,
    translateY: FORM_TRANSLATE_Y * (1 - p),
  };
}

export interface ExitState {
  readonly progress: number;
  readonly logoDx: number;
  readonly formDx: number;
  readonly visible: boolean;
}

/**
 * Exit sample: the Logo moves left and the form moves right past the clip.
 * The end frame hides the layer directly; there is no full-page opacity tween.
 */
export function exitStateAt(elapsedMs: number, layout: IntroLayout): ExitState {
  const p = smooth(clamp01(elapsedMs / EXIT_MS));
  return {
    progress: p,
    logoDx: layout.exitLogoDx * p,
    formDx: layout.exitFormDx * p,
    visible: elapsedMs < EXIT_MS,
  };
}

/** Stable terminal state used directly when reduced motion is requested. */
export function reducedMotionState(layout: IntroLayout): {
  readonly logo: Rect;
  readonly form: Rect;
} {
  return { logo: layout.logo, form: layout.form };
}

/** Original boot clock origin for the single handoff commit. */
export function handoffBootStart(rafMs: number): number {
  return rafMs / 1000 - HANDOFF_APP_TIME;
}

/** Original footage frame index for an app time in seconds. */
export function frameIndexAt(appTimeSeconds: number): number {
  return Math.floor((appTimeSeconds + 5) * FPS + 0.00001);
}

/**
 * Monotonic revision token. A visual revision and an auth attempt generation
 * are separate instances; a late response can only write when its token is
 * still current.
 */
export class Revision {
  private value = 0;

  current(): number {
    return this.value;
  }

  next(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(token: number): boolean {
    return token === this.value;
  }
}
