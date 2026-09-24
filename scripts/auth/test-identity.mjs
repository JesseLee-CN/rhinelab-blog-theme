// G1 contract tests for the pure identity rules in src/features/auth/identity.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./load-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const id = loadTs(resolve(here, "../../src/features/auth/identity.ts"));

test("usernameKey lowercases and usernameLabel uppercases", () => {
  assert.equal(id.usernameKey("Joyce-Moore"), "joyce-moore");
  assert.equal(id.usernameLabel("joyce-moore"), "JOYCE-MOORE");
});

test("valid username returns key, stored value and label", () => {
  const result = id.validateUsername("JOYCE_01");
  assert.deepEqual(result, {
    ok: true,
    key: "joyce_01",
    username: "JOYCE_01",
    label: "JOYCE_01",
  });
});

test("username length is measured in code points and bounded 3-24", () => {
  assert.equal(id.validateUsername("ab").error, "too-short");
  assert.equal(id.validateUsername("abc").ok, true);
  assert.equal(id.validateUsername("a".repeat(24)).ok, true);
  assert.equal(id.validateUsername("a".repeat(25)).error, "too-long");
});

test("username charset rejects spaces, CJK and punctuation", () => {
  for (const value of ["a b", "中文名", "a@b", "a/b"]) {
    assert.equal(id.validateUsername(value).error, "charset", value);
  }
});

test("guest is a reserved username regardless of case", () => {
  assert.equal(id.validateUsername("guest").error, "reserved");
  assert.equal(id.validateUsername("Guest").error, "reserved");
  assert.equal(id.validateUsername("GUEST").error, "reserved");
  assert.equal(id.validateUsername("guest1").ok, true);
});

test("password length uses code points without trimming or normalisation", () => {
  assert.equal(id.validatePassword("a".repeat(14)).error, "too-short");
  assert.equal(id.validatePassword("a".repeat(15)).ok, true);
  assert.equal(id.validatePassword("a".repeat(128)).ok, true);
  assert.equal(id.validatePassword("a".repeat(129)).error, "too-long");
  assert.equal(id.validatePassword("   " + "a".repeat(12) + "   ").ok, true);
  assert.equal(id.validatePassword("\u{1F600}".repeat(15)).ok, true);
});

test("password keeps its exact code points", () => {
  const value = " Pass Word \u00e9\u00e9 ";
  assert.equal(id.passwordCodePoints(value), 14);
  // A surrogate pair counts as one code point but two UTF-16 units.
  assert.equal(id.passwordCodePoints("\u{1F600}".repeat(15)), 15);
  assert.equal("\u{1F600}".repeat(15).length, 30);
});

test("guest and registered identity labels are frozen", () => {
  assert.deepEqual(id.guestIdentity(), { kind: "guest", label: "GUEST" });
  assert.deepEqual(id.registeredIdentity("u1", "Joyce"), {
    kind: "registered",
    userId: "u1",
    username: "Joyce",
    label: "JOYCE",
  });
});

test("sameIdentity compares registered users by id", () => {
  assert.equal(id.sameIdentity(id.guestIdentity(), id.guestIdentity()), true);
  assert.equal(id.sameIdentity(id.guestIdentity(), id.NO_IDENTITY), false);
  const a = id.registeredIdentity("u1", "A");
  assert.equal(id.sameIdentity(a, id.registeredIdentity("u1", "B")), true);
  assert.equal(id.sameIdentity(a, id.registeredIdentity("u2", "A")), false);
});

test("intro transitions follow the frozen table", () => {
  assert.equal(id.canIntroTransition("connecting", "docking"), true);
  assert.equal(id.canIntroTransition("connecting", "ready"), true);
  assert.equal(id.canIntroTransition("connecting", "playing"), false);
  assert.equal(id.canIntroTransition("docking", "ready"), true);
  assert.equal(id.canIntroTransition("ready", "exiting"), true);
  assert.equal(id.canIntroTransition("ready", "handoff"), true);
  assert.equal(id.canIntroTransition("exiting", "handoff"), true);
  assert.equal(id.canIntroTransition("handoff", "entered"), true);
  assert.equal(id.canIntroTransition("playing", "ready"), true);
  assert.equal(id.canIntroTransition("playing", "playing"), true);
  assert.equal(id.canIntroTransition("entered", "playing"), true);
  assert.equal(id.canIntroTransition("entered", "connecting"), false);
  assert.equal(id.canIntroTransition("resource-error", "connecting"), true);
  assert.equal(id.canIntroTransition("playing", "disposed"), true);
  assert.equal(id.canIntroTransition("disposed", "connecting"), false);
});

test("entry panel transitions are login/register only", () => {
  assert.equal(id.canEntryPanelTransition("login", "register"), true);
  assert.equal(id.canEntryPanelTransition("register", "login"), true);
  assert.equal(id.canEntryPanelTransition("login", "login"), false);
});

test("auth transitions include registering back to idle", () => {
  assert.equal(id.canAuthTransition("idle", "verifying"), true);
  assert.equal(id.canAuthTransition("idle", "registering"), true);
  assert.equal(id.canAuthTransition("registering", "idle"), true);
  assert.equal(id.canAuthTransition("registering", "confirming"), false);
  assert.equal(id.canAuthTransition("verifying", "confirming"), true);
  assert.equal(id.canAuthTransition("confirming", "cancelling"), true);
  assert.equal(id.canAuthTransition("cancelling", "idle"), true);
  assert.equal(id.canAuthTransition("idle", "confirming"), false);
});
