// Generate cross-language identity cases so the Go service and the TypeScript
// contract cannot drift. Writes scripts/auth/fixtures/identity-cases.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./load-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const id = loadTs(resolve(repoRoot, "src/boot-identity.ts"));

const usernames = [
  "ab", "abc", "JOYCE_01", "a".repeat(24), "a".repeat(25),
  "guest", "Guest", "GUEST", "guest1", "a b", "中文名", "a@b", "a/b",
  ".", "-", "..", "a.b-c_d", "Joyce Lee",
];
const passwords = [
  "a".repeat(14), "a".repeat(15), "a".repeat(128), "a".repeat(129),
  `${" ".repeat(3)}${"a".repeat(12)}${" ".repeat(3)}`,
  "\u{1F600}".repeat(14), "\u{1F600}".repeat(15),
  "correct horse battery staple", " pass word \u00e9\u00e9 ",
];

const fixture = {
  generatedBy: "scripts/auth/gen-identity-fixtures.mjs",
  contract: "src/boot-identity.ts",
  username: usernames.map((value) => {
    const result = id.validateUsername(value);
    return result.ok
      ? { value, ok: true, key: result.key, label: result.label }
      : { value, ok: false, error: result.error };
  }),
  password: passwords.map((value) => {
    const result = id.validatePassword(value);
    return result.ok
      ? { value, ok: true, codePoints: id.passwordCodePoints(value) }
      : { value, ok: false, error: result.error, codePoints: id.passwordCodePoints(value) };
  }),
};

mkdirSync(resolve(here, "fixtures"), { recursive: true });
const out = resolve(here, "fixtures/identity-cases.json");
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out} (${fixture.username.length} usernames, ${fixture.password.length} passwords)`);
