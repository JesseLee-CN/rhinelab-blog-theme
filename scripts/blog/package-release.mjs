import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Local release packaging. Runs on the developer machine (or CI), never on the
// production server. Produces an immutable, checksummed archive that the
// upload scripts transfer over SSH.
//
// 用法：
//   npm run release -- --id 20260909T120000Z-<gitsha>
//   npm run release -- --id <release-id> --out release --dry-run

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dist = resolve(root, "dist");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const dryRun = process.argv.includes("--dry-run");
const outDir = resolve(root, arg("out", "release"));

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

let gitSha = "unknown";
let shortSha = "nogit";
try {
  gitSha = git("rev-parse", "HEAD");
  shortSha = git("rev-parse", "--short", "HEAD");
} catch (error) {
  console.warn(`警告：无法读取 git 信息（${error.message}），release ID 需显式提供且无法追溯提交。`);
}

const releaseId =
  arg("id", "") || `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-${shortSha}`;
if (!/^\d{8}T\d{6}Z-[0-9a-f]{7,40}$/.test(releaseId)) {
  console.error(`release ID 格式应为 YYYYMMDDTHHMMSSZ-<gitsha>，收到：${releaseId}`);
  process.exit(1);
}

const required = [
  "index.html",
  "404.html",
  "rss.xml",
  "robots.txt",
  "sitemap-index.xml",
  "search/index.html",
  "pagefind/pagefind.js",
  "lab/index.html",
];
for (const file of required) {
  try {
    const info = await stat(resolve(dist, file));
    if (!info.isFile() && !info.isDirectory()) throw new Error();
  } catch {
    console.error(`dist 缺少必需产物：${file}。先运行 npm run build。`);
    process.exit(1);
  }
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const files = await walk(dist);
const siteBytes = (await Promise.all(files.map((file) => stat(file)))).reduce(
  (sum, info) => sum + info.size,
  0,
);

const releaseDir = resolve(outDir, releaseId);
const archive = resolve(releaseDir, "site.tar.gz");
const manifestPath = resolve(releaseDir, "release-manifest.json");
const checksumPath = resolve(releaseDir, "checksums.sha256");

console.log(`release ID：${releaseId}`);
console.log(`git：${gitSha}`);
console.log(`dist：${files.length} 个文件，${(siteBytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`输出：${releaseDir}`);

if (dryRun) {
  console.log("[dry-run] 校验通过，未写入归档。");
  process.exit(0);
}

try {
  await stat(releaseDir);
  console.error(`release 目录已存在，不覆盖：${releaseDir}`);
  process.exit(1);
} catch {
  // 目标不存在，可以继续。
}

await mkdir(releaseDir, { recursive: true });
execFileSync("tar", ["-czf", archive, "-C", dist, "."], { stdio: "inherit" });

// 重定向 map 随 release 一起发布；由 activate 切换 active 指针后生效。
const redirectsDir = resolve(root, ".generated/redirects");
const mapFiles = [];
try {
  for (const name of (await readdir(redirectsDir)).filter((n) => n.endsWith(".map")).sort()) {
    await mkdir(resolve(releaseDir, "nginx"), { recursive: true });
    await cp(resolve(redirectsDir, name), resolve(releaseDir, "nginx", name));
    mapFiles.push(name);
  }
} catch {
  console.warn("警告：未找到 .generated/redirects/*.map，先运行 npm run redirects。");
}

const archiveBuffer = await readFile(archive);
const archiveSha256 = createHash("sha256").update(archiveBuffer).digest("hex");

const manifest = {
  releaseId,
  gitSha,
  shortSha,
  builtAt: new Date().toISOString(),
  node: process.version,
  fileCount: files.length,
  siteBytes,
  archive: "site.tar.gz",
  archiveSha256,
  archiveBytes: archiveBuffer.length,
  redirectMaps: mapFiles,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const checksumLines = [`${archiveSha256}  site.tar.gz`];
for (const name of mapFiles) {
  const buffer = await readFile(resolve(releaseDir, "nginx", name));
  checksumLines.push(`${createHash("sha256").update(buffer).digest("hex")}  nginx/${name}`);
}
await writeFile(checksumPath, `${checksumLines.join("\n")}\n`, "utf8");

console.log(
  `已打包：${(archiveBuffer.length / 1024 / 1024).toFixed(1)} MiB，sha256=${archiveSha256.slice(0, 12)}…`,
);
console.log("下一步：ops/upload-release.sh（Linux/macOS）或 ops/upload-release.ps1（Windows）");
