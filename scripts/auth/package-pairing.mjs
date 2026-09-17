// LOGIN-IMPROVE L4a pairing manifest: binds one static site release to one auth
// release, the reviewed config hashes and the gate reports that justify the
// pairing. An auth artifact without the register-v1 feature, or a pairing
// missing this round's L3a/L3b gate reports, is refused.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const argv = process.argv.slice(2);
const opts = { config: [], "gate-report": [] };
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const key = argv[i].slice(2);
  const value = argv[++i];
  if (key === "config") opts.config.push(value);
  else if (key === "gate-report") opts["gate-report"].push(value);
  else opts[key] = value;
}
if (!opts.site || !opts.auth || opts["gate-report"].length === 0) {
  console.error(
    "usage: package-pairing.mjs --site <releaseDir> --auth <authReleaseDir> --gate-report <path> [--gate-report <path> ...] [--config <file> ...] [--backup <id>] [--previous <pairing.json>] [--out <file>]",
  );
  process.exit(2);
}

const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const siteDir = resolve(opts.site);
const authDir = resolve(opts.auth);
const site = JSON.parse(readFileSync(resolve(siteDir, "release-manifest.json"), "utf8"));
const auth = JSON.parse(readFileSync(resolve(authDir, "manifest.json"), "utf8"));

if (!Array.isArray(auth.features) || !auth.features.includes("register-v1")) {
  console.error(`auth ${auth.id} does not declare the register-v1 feature; refusing pairing`);
  process.exit(1);
}

const gateReports = opts["gate-report"].map((file) => {
  const abs = resolve(file);
  if (!existsSync(abs)) {
    console.error(`gate report not found: ${file}`);
    process.exit(1);
  }
  const gate = basename(file).replace(/\.md$/i, "");
  return { gate, path: file, sha256: sha256File(abs) };
});
for (const required of ["l3a", "l3b"]) {
  if (!gateReports.some((report) => report.gate.toLowerCase() === required)) {
    console.error(`pairing requires the ${required.toUpperCase()} gate report`);
    process.exit(1);
  }
}

const configHashes = opts.config.map((file) => ({ file: basename(file), sha256: sha256File(resolve(file)) }));
const previous = opts.previous ? JSON.parse(readFileSync(resolve(opts.previous), "utf8")) : null;

const pairing = {
  pairingId: `${site.releaseId}__${auth.id}`,
  createdAt: new Date().toISOString(),
  site: { releaseId: site.releaseId, gitSha: site.gitSha, archiveSha256: site.archiveSha256 },
  auth: {
    releaseId: auth.id,
    version: auth.version,
    binarySha256: auth.binary.sha256,
    apiMajor: auth.api.major,
    schemaVersion: auth.schema.version,
    schemaCompatibleFrom: auth.schema.compatibleFrom,
    features: auth.features,
    worktreeSha256: auth.source?.worktreeSha256 ?? null,
    goModSha256: auth.go.modSha256,
    goSumSha256: auth.go.goSumSha256,
  },
  configHashes,
  backupId: opts.backup ?? null,
  previousPairingId: previous?.pairingId ?? null,
  gateReports,
};
const out = resolve(opts.out ?? `release/pairing/${pairing.pairingId}.json`);
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(pairing, null, 2)}\n`);
console.log(JSON.stringify({ out, pairingId: pairing.pairingId, gateReports: gateReports.map((g) => g.gate) }, null, 2));
