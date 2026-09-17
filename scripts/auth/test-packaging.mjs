// LOGIN-IMPROVE L4a packaging tests: immutable auth artifacts and pairings
// that carry the required gate reports.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = (script, argv) =>
  spawnSync(process.execPath, [join("scripts", "auth", script), ...argv], { cwd: repoRoot, encoding: "utf8", timeout: 120000 });

test("package-auth refuses to overwrite an existing artifact and records register-v1", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-auth-package-"));
  const outRoot = join(root, "auth");
  mkdirSync(outRoot);
  const id = `0.4.0-test-${Math.random().toString(36).slice(2, 8)}`;
  const argv = ["--version", "0.4.0", "--id", id, "--out-root", outRoot];

  const first = run("package-auth.mjs", argv);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const manifestPath = join(outRoot, id, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json must exist");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.features.includes("register-v1"), "manifest must declare register-v1");
  assert.ok(manifest.source.files.length >= 10, `expected a full source list, got ${manifest.source.files.length}`);
  assert.equal(manifest.source.worktreeSha256.length, 64);
  const binaryBefore = manifest.binary.sha256;

  const second = run("package-auth.mjs", argv);
  assert.notEqual(second.status, 0, "second package run must fail");
  assert.match(second.stderr, /refusing to overwrite/);
  const after = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(after.binary.sha256, binaryBefore, "existing artifact must stay untouched");
});

test("package-auth refuses an out-root that is not a directory named auth", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-auth-badroot-"));
  const outRoot = join(root, "elsewhere");
  mkdirSync(outRoot);
  const result = run("package-auth.mjs", ["--version", "0.4.0", "--id", "0.4.0-test-badroot", "--out-root", outRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /named "auth"/);
});

function writePairingFixture(base, { features = ["register-v1"] } = {}) {
  const authDir = join(base, "auth-release");
  const siteDir = join(base, "site-release");
  mkdirSync(authDir);
  mkdirSync(siteDir);
  writeFileSync(
    join(authDir, "manifest.json"),
    `${JSON.stringify(
      {
        id: "0.4.0-fixture",
        version: "0.4.0",
        binary: { sha256: "b".repeat(64) },
        api: { major: 1 },
        schema: { version: 1, compatibleFrom: 1 },
        features,
        source: { worktreeSha256: "c".repeat(64) },
        go: { modSha256: "d".repeat(64), goSumSha256: "e".repeat(64) },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(siteDir, "release-manifest.json"),
    `${JSON.stringify({ releaseId: "20260911T000000Z-fixture", gitSha: "f".repeat(40), archiveSha256: "a".repeat(64) }, null, 2)}\n`,
  );
  const gateA = join(base, "L3a.md");
  const gateB = join(base, "L3b.md");
  writeFileSync(gateA, "# L3a\n");
  writeFileSync(gateB, "# L3b\n");
  return { authDir, siteDir, gateA, gateB };
}

test("package-pairing requires register-v1 and this round's gate reports", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-pairing-"));
  const { authDir, siteDir, gateA, gateB } = writePairingFixture(root);
  const out = join(root, "pairing.json");
  const base = ["--site", siteDir, "--auth", authDir, "--out", out];

  const noGates = run("package-pairing.mjs", base);
  assert.notEqual(noGates.status, 0);
  assert.match(noGates.stderr, /gate-report/);

  const onlyA = run("package-pairing.mjs", [...base, "--gate-report", gateA]);
  assert.notEqual(onlyA.status, 0);
  assert.match(onlyA.stderr, /L3B/);

  const noFeatureRoot = mkdtempSync(join(tmpdir(), "lab-pairing-nofeature-"));
  const fixture2 = writePairingFixture(noFeatureRoot, { features: [] });
  const noFeature = run("package-pairing.mjs", [
    "--site", fixture2.siteDir, "--auth", fixture2.authDir,
    "--gate-report", fixture2.gateA, "--gate-report", fixture2.gateB,
    "--out", join(noFeatureRoot, "pairing.json"),
  ]);
  assert.notEqual(noFeature.status, 0);
  assert.match(noFeature.stderr, /register-v1/);

  const ok = run("package-pairing.mjs", [...base, "--gate-report", gateA, "--gate-report", gateB]);
  assert.equal(ok.status, 0, ok.stderr);
  const pairing = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(pairing.gateReports.map((report) => report.gate), ["L3a", "L3b"]);
  assert.equal(pairing.gateReports[0].sha256.length, 64);
  assert.deepEqual(pairing.auth.features, ["register-v1"]);
});
