import { bootMotion } from "./boot-motion";

// The original 25 fps text reveal, including the first character of each field.
// Glitch restoration at frames 479/485/486 is not new typing.
export const LEGACY_LABEL = "JOYCE MOORE";

const SEGMENTS: ReadonlyArray<readonly [number, number]> = [
  [170, 187],
  [282, 295],
  [320, 339],
  [367, 389],
  [423, 440],
  [449, 457],
];

/** 计算给定标签的逐字显影帧号。导出以便测试直接校验，而不是写死一个帧数常量。 */
export function computeFrames(label: string): readonly number[] {
  return SEGMENTS.flatMap(([start, end]) => {
    const frames: number[] = [];
    let previous = 0;
    for (let frame = start; frame <= end; frame++) {
      const motion = bootMotion(frame / 25 - 5, label);
      const text = frame < 200 ? motion.access : motion.auth;
      const count = text.replace(/\s/g, "").length;
      if (count > previous) frames.push(frame);
      previous = count;
    }
    return frames;
  });
}

const cache = new Map<string, readonly number[]>();

// Per-identity typing frame table. Cached so no RAF pays for recomputation;
// the label is passed explicitly, never read from a hidden global.
export function typingFramesFor(label: string): readonly number[] {
  let frames = cache.get(label);
  if (!frames) {
    frames = computeFrames(label);
    cache.set(label, frames);
  }
  return frames;
}

export const TYPING_FRAMES: readonly number[] = typingFramesFor(LEGACY_LABEL);

export function hasTypingBetween(
  previousVideoTime: number,
  videoTime: number,
  label: string = LEGACY_LABEL,
) {
  return typingFramesFor(label).some(
    (frame) =>
      frame / 25 > previousVideoTime + 1e-6 && frame / 25 <= videoTime + 1e-6,
  );
}
