// LOGIN-IMPROVE L4a artifact scan. Fails (non-zero) if the production dist/
// leaks server code, databases, secrets, DEV mock or test credentials, or if
// normal blog pages load the 3D/boot/login bundles. Scans every lab JS chunk,
// not just the first one. Writes .tools/boot-identity/g7/artifacts.json.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const dist = resolve("dist");
const outDir = resolve(".tools/boot-identity/g7");
mkdirSync(outDir, { recursive: true });

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);
const labRoot = join(dist, "lab");
const labFiles = files.filter((file) => file.startsWith(labRoot));
const labBundles = labFiles.filter((file) => file.endsWith(".js"));

const textExtensions = new Set([".js", ".mjs", ".css", ".html", ".json", ".xml", ".txt", ".svg", ".webmanifest"]);
const findings = [];
const fail = (rule, file, detail) => findings.push({ rule, file: relative(dist, file), detail });

// 1. No test credentials, DEV mock, seek bypass or server-side markers in any
//    artifact. `freeze`/`review`/`entryMock` may only exist behind DEV gates,
//    which are stripped from production chunks.
const forbiddenText = [
  { rule: "test-user", needle: "E2eUser" },
  { rule: "test-user", needle: "DisabledUser" },
  { rule: "test-password", needle: "a very long e2e password" },
  { rule: "test-password", needle: "local bench password" },
  { rule: "dev-mock", needle: "createDevIdentityPort" },
  { rule: "dev-mock", needle: "entryMock" },
  { rule: "dev-mock", needle: "auth-dev" },
  { rule: "dev-bypass", needle: "reviewParams" },
  { rule: "dev-bypass", needle: "freeze" },
  { rule: "server-code", needle: "modernc.org/sqlite" },
  { rule: "server-code", needle: "argon2.IDKey" },
  { rule: "server-code", needle: "LAB_AUTH_" },
  { rule: "secret", needle: "BEGIN PRIVATE KEY" },
];
for (const file of files) {
  if (!textExtensions.has(extname(file))) continue;
  const isLab = file.startsWith(labRoot);
  const body = readFileSync(file, "utf8");
  for (const { rule, needle } of forbiddenText) {
    if (!isLab && (rule === "dev-mock" || rule === "dev-bypass")) continue;
    if (body.includes(needle)) fail(rule, file, needle);
  }
}

// 2. No databases, env files, Go sources, keys or DEV-only chunk filenames.
for (const file of files) {
  const name = file.toLowerCase();
  if (name.endsWith(".db") || name.endsWith(".db-wal") || name.endsWith(".db-shm")) fail("database", file, extname(file));
  if (name.endsWith(".env") || name.includes(".env.")) fail("env-file", file, extname(file));
  if (name.endsWith(".go")) fail("go-source", file, extname(file));
  if (name.endsWith(".pem") || name.endsWith(".key")) fail("key", file, extname(file));
  if (file.startsWith(labRoot) && /(auth-dev|dev-identity|entry-mock)/.test(name)) fail("dev-chunk", file, name);
}

// 3. Normal blog pages must not load the 3D/boot/login bundles. /lab/ is a
// separate entry and may be linked, but article HTML must stay static.
// 功能相关的 chunk 名来自 features.manifest.json：重命名功能产物不会悄悄削弱这条规则。
const manifest = JSON.parse(readFileSync(resolve("features.manifest.json"), "utf8"));
const featureMarkers = [...new Set((manifest.features ?? []).flatMap((feature) => feature.runtimeMarkers ?? []))];
const labAssetPattern = new RegExp(["(^|/)(lab)/", "three", "main-", ...featureMarkers].join("|"));
const scriptOrLink = /<(script|link)\b[^>]*(src|href)="([^"]+)"/gi;
for (const file of files) {
  if (!file.endsWith(".html")) continue;
  if (file.includes(labRoot)) continue;
  const body = readFileSync(file, "utf8");
  for (const match of body.matchAll(scriptOrLink)) {
    const url = match[3];
    if (labAssetPattern.test(url)) {
      fail("blog-loads-lab-asset", file, url);
    }
  }
  for (const marker of ["ACCESS PERMISSION", "boot-entry", "ID CONFIRMED"]) {
    if (body.includes(marker)) fail("blog-has-boot-markup", file, marker);
  }
}

// 4. Every lab chunk is scanned; at least one must carry the real client and
//    none may carry the DEV mock.
const bundleReads = labBundles.map((file) => ({ file, body: readFileSync(file, "utf8") }));
const report = {
  dist,
  fileCount: files.length,
  labBundleCount: labBundles.length,
  labBundles: labBundles.map((file) => relative(dist, file)),
  labHasIdentityClient: bundleReads.some(({ body }) => body.includes("csrfToken") && body.includes("X-CSRF-Token")),
  labHasMock: bundleReads.some(({ body }) => body.includes("createDevIdentityPort") || body.includes("entryMock")),
  findings,
  passed: findings.length === 0,
};
writeFileSync(resolve(outDir, "artifacts.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`artifact scan: ${files.length} files, ${labBundles.length} lab chunk(s), ${findings.length} finding(s)`);
for (const finding of findings.slice(0, 20)) console.error(`  ${finding.rule}: ${finding.file} (${finding.detail})`);
process.exit(findings.length === 0 ? 0 : 1);
