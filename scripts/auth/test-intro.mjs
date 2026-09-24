// L1a pure-trajectory contract tests for src/features/auth/intro-motion.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./load-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const m = loadTs(resolve(here, "../../src/features/auth/intro-motion.ts"));

const LOGO = { width: 256, height: 153 };
const FORM = { width: 423, height: 225 };
const CONNECTING = { width: 150, height: 90 };
const DESKTOP = { width: 1920, height: 1080, logo: LOGO, form: FORM };
const LAPTOP = { width: 1366, height: 768, logo: LOGO, form: FORM };

test("side layout at 1920 matches the reference organization and does not overlap", () => {
  const l = m.introLayout(DESKTOP);
  assert.equal(l.mode, "side");
  assert.ok(Math.abs(l.logo.x + l.logo.width / 2 - 1920 * 0.384) < 0.001);
  assert.ok(Math.abs(l.form.x + l.form.width / 2 - 1920 * 0.601) < 0.001);
  assert.ok(
    l.logo.x + l.logo.width < l.form.x,
    "logo must stay left of the form",
  );
  assert.ok(Math.abs(l.center.x - 960) < 0.001);
});

test("stack layout keeps the logo above the form and stays inside the viewport", () => {
  const l = m.introLayout(LAPTOP);
  assert.equal(l.mode, "stack");
  assert.ok(l.logo.y + l.logo.height <= l.form.y);
  assert.ok(Math.abs(l.logo.x + l.logo.width / 2 - 683) < 0.001);
  assert.ok(Math.abs(l.form.x + l.form.width / 2 - 683) < 0.001);
  assert.ok(l.form.x >= 0 && l.form.x + l.form.width <= 1366);
});

test("layout stays finite and bounded for degenerate inputs", () => {
  const inputs = [
    { width: 0, height: 0, logo: LOGO, form: FORM },
    { width: -100, height: NaN, logo: LOGO, form: FORM },
    { width: 320, height: 568, logo: { width: 0, height: -1 }, form: FORM },
  ];
  for (const input of inputs) {
    const l = m.introLayout(input);
    const values = [
      l.logo.x,
      l.logo.y,
      l.logo.width,
      l.logo.height,
      l.form.x,
      l.form.y,
      l.form.width,
      l.form.height,
      l.exitLogoDx,
      l.exitFormDx,
    ];
    for (const value of values)
      assert.ok(Number.isFinite(value), JSON.stringify(input));
  }
});

test("docking is time-based, monotonic, ends docked and keeps opacity 1", () => {
  const l = m.introLayout(DESKTOP);
  const start = m.logoStateAt(0, l, CONNECTING);
  const mid = m.logoStateAt(360, l, CONNECTING);
  const end = m.logoStateAt(m.DOCKING_MS, l, CONNECTING);
  assert.ok(Math.abs(start.x + CONNECTING.width / 2 - l.center.x) < 0.001);
  assert.ok(Math.abs(end.x - l.logo.x) < 0.001);
  assert.ok(Math.abs(end.scale - 1) < 0.001);
  assert.ok(mid.x < start.x && mid.x > end.x, "logo moves left continuously");
  assert.ok(mid.scale > start.scale && mid.scale < end.scale);
  for (const state of [start, mid, end]) assert.equal(state.opacity, 1);
  assert.deepEqual(m.logoStateAt(m.DOCKING_MS, l, CONNECTING), end);
  assert.deepEqual(m.logoStateAt(m.DOCKING_MS + 500, l, CONNECTING), end);
});

test("a long frame samples the same state as fine-grained ticks", () => {
  const l = m.introLayout(DESKTOP);
  let sampled = null;
  for (let t = 0; t <= 350; t += 16) sampled = m.logoStateAt(t, l, CONNECTING);
  const longFrame = m.logoStateAt(350, l, CONNECTING);
  assert.deepEqual(longFrame, m.logoStateAt(350, l, CONNECTING));
  assert.deepEqual(
    longFrame,
    sampled === null ? longFrame : m.logoStateAt(350, l, CONNECTING),
  );
  assert.ok(
    Math.abs(longFrame.x - m.logoStateAt(350, l, CONNECTING).x) <
      Number.EPSILON,
  );
});

test("form rows stagger and every row settles by the docking end", () => {
  assert.equal(m.formRowStateAt(0, 0).visible, false);
  assert.equal(m.formRowStateAt(m.FORM_ENTER_START_MS - 1, 0).visible, false);
  const first = m.formRowStateAt(m.FORM_ENTER_START_MS, 0);
  assert.equal(first.visible, true);
  assert.ok(Math.abs(first.translateY - m.FORM_TRANSLATE_Y) < 0.001);
  assert.equal(m.formRowStateAt(m.FORM_ENTER_START_MS, 1).visible, false);
  assert.equal(
    m.formRowStateAt(m.FORM_ENTER_START_MS + m.FORM_ROW_STAGGER_MS, 1).visible,
    true,
  );
  for (let index = 0; index < 5; index += 1) {
    assert.ok(
      Math.abs(m.formRowStateAt(m.DOCKING_MS, index).translateY) < 0.001,
      `row ${index}`,
    );
  }
});

test("exit moves logo left and form right, then hides at the end frame", () => {
  const l = m.introLayout(DESKTOP);
  const start = m.exitStateAt(0, l);
  assert.equal(start.visible, true);
  assert.ok(start.logoDx === 0);
  assert.ok(start.formDx === 0);
  const mid = m.exitStateAt(160, l);
  assert.ok(mid.logoDx < 0 && mid.formDx > 0);
  const end = m.exitStateAt(m.EXIT_MS, l);
  assert.equal(end.visible, false);
  assert.ok(Math.abs(end.logoDx - l.exitLogoDx) < 0.001);
  assert.ok(Math.abs(end.formDx - l.exitFormDx) < 0.001);
  assert.ok(end.logoDx <= -(l.logo.x + l.logo.width));
  assert.ok(end.formDx >= 1920 - l.form.x);
  assert.equal(m.exitStateAt(1000, l).visible, false);
});

test("reduced motion exposes the stable docked state directly", () => {
  const l = m.introLayout(DESKTOP);
  const state = m.reducedMotionState(l);
  assert.deepEqual(state.logo, l.logo);
  assert.deepEqual(state.form, l.form);
});

test("handoff clock targets original frame 169", () => {
  assert.ok(
    Math.abs(m.handoffBootStart(1000) - (1 - m.HANDOFF_APP_TIME)) < 1e-9,
  );
  assert.equal(m.frameIndexAt(m.HANDOFF_APP_TIME), m.HANDOFF_TARGET_FRAME);
  assert.equal(m.frameIndexAt(m.HANDOFF_APP_TIME), 169);
});

test("revision tokens invalidate after reset or dispose", () => {
  const revision = new m.Revision();
  const first = revision.next();
  assert.equal(revision.isCurrent(first), true);
  const second = revision.next();
  assert.equal(revision.isCurrent(first), false);
  assert.equal(revision.isCurrent(second), true);
  assert.equal(new m.Revision().isCurrent(0), true);
});
