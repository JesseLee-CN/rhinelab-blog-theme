/**
 * Synthetic tokens that identify IR5 test fixtures.
 *
 * They exist so the "no fixture leaks into a release" rule is testable in both
 * directions (plan §11.3):
 *   - the isolated fixture build under `.tools/` MUST contain them (positive
 *     control: the scanner is actually looking at fixture output), and
 *   - the real `dist/` and the Pagefind index MUST NOT contain them.
 *
 * The same list is imported by `scripts/blog/check-reader.mjs`, so `check:site`
 * enforces it on every build without a second implementation.
 */
export const FIXTURE_SENTINELS = Object.freeze([
  "ir5-fixture-sentinel-4b1f",
  "IR5-FIXTURE-DRAFT-9c27",
  "ir5-fixture-future-7d3a",
]);

/** File extensions the sentinel scanner reads as text. */
export const SENTINEL_TEXT_EXTENSIONS = Object.freeze([".html", ".js", ".mjs", ".json", ".css", ".xml", ".txt", ".svg"]);

/** First sentinel found in `text`, or null. */
export function findSentinel(text) {
  return FIXTURE_SENTINELS.find((sentinel) => text.includes(sentinel)) ?? null;
}
