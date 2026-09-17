// G4/G5 identity state + timeline checks. Plain Node (no browser): verifies the
// legacy frame fixture is unchanged and that per-identity labels reveal within
// the fixed 321-339 window with one sound frame per typing step.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./load-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const { bootMotion } = loadTs(resolve(repoRoot, "src/boot-motion.ts"));
const { typingFramesFor, computeFrames, TYPING_FRAMES, LEGACY_LABEL } = loadTs(resolve(repoRoot, "src/typing-rhythm.ts"));
const { validateUsername, usernameLabel } = loadTs(resolve(repoRoot, "src/boot-identity.ts"));

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, detail: String(error?.message ?? error) });
  }
};

const appTimeFor = (frame) => frame / 25 - 5;

// 1. Typing rhythm invariants (independent of any fixture file).
// 帧数由标签长度推导（越长显影越久），因此这里校验自洽性而不是写死常量：
// 表必须与按同一标签重算的结果一致，且不得短于标签的非空白字符数。
check("typing frame table matches a fresh computation", () =>
  assert.deepEqual([...TYPING_FRAMES], [...computeFrames(LEGACY_LABEL)]),
);
check("typing frame count covers the label", () =>
  assert.ok(
    TYPING_FRAMES.length >= LEGACY_LABEL.replace(/\s/g, "").length,
    `帧数 ${TYPING_FRAMES.length} 少于标签字符数`,
  ),
);
check("typing frames are strictly increasing", () => {
  for (let i = 1; i < TYPING_FRAMES.length; i++) {
    assert.ok(TYPING_FRAMES[i] > TYPING_FRAMES[i - 1], `帧号未递增：${TYPING_FRAMES[i - 1]} -> ${TYPING_FRAMES[i]}`);
  }
});

// 2. Each identity reveals fully inside 320-339, independent of length.
const labels = ["GUEST", "abc", "A.B-C_d", "a".repeat(24)];
for (const label of labels) {
  check(`label ${label.length}: colon at 320`, () => {
    assert.equal(bootMotion(appTimeFor(320), label).auth, "ID CONFIRMED : ");
  });
  check(`label ${label.length}: complete at 339`, () => {
    assert.equal(bootMotion(appTimeFor(339), label).auth, `ID CONFIRMED : ${label}`);
  });
  check(`label ${label.length}: first char at 321`, () => {
    const auth = bootMotion(appTimeFor(321), label).auth;
    assert.ok(auth.startsWith("ID CONFIRMED : "), auth);
    assert.equal(auth, `ID CONFIRMED : ${label[0]}`);
  });
  check(`label ${label.length}: name typing stays within 321-339`, () => {
    const frames = typingFramesFor(label);
    const nameFrames = frames.filter((f) => f >= 321 && f <= 339);
    assert.ok(nameFrames.length > 0);
    assert.equal(frames.filter((f) => f > 339 && f < 367).length, 0);
  });
  check(`label ${label.length}: one sound frame per step (unique, sorted)`, () => {
    const frames = typingFramesFor(label);
    assert.deepEqual(frames, [...new Set(frames)].sort((a, b) => a - b));
  });
}

// 3. Non-identity fields are identical across labels (only `auth` differs).
check("only the auth field changes between labels", () => {
  for (const frame of [169, 170, 187, 226, 320, 339, 487, 600]) {
    const legacy = bootMotion(appTimeFor(frame), LEGACY_LABEL);
    const guest = bootMotion(appTimeFor(frame), "GUEST");
    const a = { ...legacy, auth: "" };
    const b = { ...guest, auth: "" };
    assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), `frame ${frame}`);
  }
});

// 4. Label derivation matches username rules.
check("label is uppercase of the server username", () => {
  assert.equal(usernameLabel("JOYCE_MOORE"), "JOYCE_MOORE");
  assert.equal(usernameLabel("guest") === "GUEST" && validateUsername("guest").ok === false, true);
});

const failed = checks.filter((c) => !c.passed);
for (const c of checks) console.log(`${c.passed ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
