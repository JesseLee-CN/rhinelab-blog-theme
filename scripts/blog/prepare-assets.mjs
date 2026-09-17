import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Only the files the lab feature actually needs are exposed as its public
// directory. The full upstream public/ tree is never copied into the release.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(root, "public");
const target = resolve(root, ".generated/lab-public");

/** Self-hosted webfont trees: every shard is whitelisted by directory walk. */
async function fontFiles(relativeDir) {
  const dir = resolve(source, relativeDir);
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".woff2")) continue;
    found.push(`${relativeDir}/${entry.parentPath ? entry.parentPath.replace(dir, "").replace(/^[\\/]/, "") + "/" : ""}${entry.name}`.replace(/\/+/g, "/"));
  }
  return found.sort();
}

const WHITELIST = [
  "favicon.svg",
  // Text/UI font: MiSans, self-hosted woff2 sharded by unicode-range.
  ...(await fontFiles("fonts/misans")),
  "fonts/MiSans-license.pdf",
  "fonts/misans-source.json",
  // Code font: JetBrains Maple Mono, subset woff2 (Latin + symbols + site glyphs).
  "fonts/jetbrains-maple-mono/regular.woff2",
  "fonts/jetbrains-maple-mono/bold.woff2",
  "fonts/JetBrains-Maple-Mono-OFL.txt",
  "fonts/jetbrains-maple-mono-source.json",
  "fonts/NOTICE.txt",
  "assets/archive-cassette.glb",
  "assets/archive-assembly.glb",
  // 开场固定短语的 Novecento 字形来源与许可声明（字体文件本身不随发布）。
  "assets/boot-lettering-notice.txt",
  "audio/atmosphere.ogg",
  "audio/motif.ogg",
  "audio/pulse.ogg",
  "licenses/rolling-number.txt",
];

const errors = [];
for (const file of WHITELIST) {
  try {
    const info = await stat(resolve(source, file));
    if (!info.isFile() || info.size === 0) {
      errors.push(`${file}：不是非空文件`);
    }
  } catch {
    errors.push(`${file}：源文件不存在`);
  }
}
if (errors.length) {
  console.error(`prepare:assets 白名单校验失败：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

/**
 * Copy a whitelist into a destination directory only when it is stale.
 * `build:blog` and `build:lab` each prepare assets, and re-copying ~760 woff2
 * shards twice per build is pure waste.
 *
 * The signature is a content address over the *whitelisted* paths — size plus
 * modification time, which is cheap for 760 files and changes whenever the font
 * build regenerates a shard. It deliberately ignores anything else in the
 * destination, so obsolete trees left behind by an earlier font choice are not
 * mistaken for freshness; the sync removes the whole managed subtree instead.
 *
 * `destinationRoot` is removed before copying, so it must be a directory this
 * script owns. The blog's publicDir is *not* owned by this script — only its
 * `fonts/` subdirectory is — hence the separate `base` (the managed subtree) and
 * `target` (the directory that contains it).
 */
async function syncIfStale({ base, target: destinationRoot, files, label }) {
  const signature = async (directory) => {
    const parts = [];
    for (const file of [...files].sort()) {
      try {
        const info = await stat(resolve(directory, file));
        parts.push(`${file}:${info.size}:${Math.round(info.mtimeMs)}`);
      } catch {
        return null;
      }
    }
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  };
  if ((await signature(resolve(destinationRoot, base))) === (await signature(resolve(source, base)))) {
    console.log(`prepare:assets ${label} 已是最新，跳过（${files.length} 个文件）`);
    return;
  }
  // 目标 publicDir 在全新克隆里可能根本不存在：`apps/blog/public/fonts/` 被 Git 忽略，
  // 且该目录下只有这一棵托管子树，因此复制前必须先确保它存在（否则 rm/cp 会因路径缺失失败）。
  await mkdir(destinationRoot, { recursive: true });
  await rm(resolve(destinationRoot, base), { recursive: true, force: true });
  for (const file of files) {
    const destination = resolve(destinationRoot, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(source, file), destination);
  }
  console.log(`prepare:assets ${label} 同步 ${files.length} 个文件`);
}

/**
 * Remove anything inside a managed subtree that the whitelist does not name.
 *
 * The freshness signature is a content address over the whitelisted paths, which is
 * what makes a rebuild cheap — but it cannot see *extra* files, so a directory left
 * over from an earlier font choice would survive forever. This prune is what makes
 * the managed subtree actually equal the whitelist, and it is deliberately narrow:
 * only font payloads (`.woff2`, `.ttf`, `.otf`, `.woff`) are candidates, so a stray
 * note or licence added by hand is never deleted.
 */
const FONT_PAYLOAD = /\.(woff2?|ttf|otf)$/i;

async function pruneExtras({ base, target: destinationRoot, files, label }) {
  const managedRoot = resolve(destinationRoot, base);
  const keep = new Set(files.map((file) => resolve(destinationRoot, file)));
  // 全新克隆里托管子树可能尚不存在（该目录被 Git 忽略、由本脚本生成），此时没有可清理的东西。
  if (!existsSync(managedRoot)) return;
  let removed = 0;
  for (const entry of await readdir(managedRoot, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!FONT_PAYLOAD.test(entry.name)) continue;
    const full = resolve(entry.parentPath ?? managedRoot, entry.name);
    if (keep.has(full)) continue;
    await rm(full, { force: true });
    removed += 1;
  }
  // Drop directories that are now empty so the tree matches the whitelist exactly.
  for (const entry of (await readdir(managedRoot, { withFileTypes: true, recursive: true })).reverse()) {
    if (!entry.isDirectory()) continue;
    const full = resolve(entry.parentPath ?? managedRoot, entry.name);
    if ((await readdir(full)).length === 0) await rm(full, { recursive: true, force: true });
  }
  if (removed) console.log(`prepare:assets ${label} 清理不在白名单中的旧字体文件 ${removed} 个`);
}

await syncIfStale({ base: "", target, files: WHITELIST, label: "lab-public/" });

// The blog is an Astro sub-app with its own publicDir, so the shared webfonts have
// to be staged there too; both surfaces reference the same absolute /fonts/ URLs.
// Only `fonts/` is managed here — the rest of the Astro publicDir (favicon,
// wp-content uploads, cover art) is versioned source and must survive.
const stagedFonts = WHITELIST.filter((entry) => entry.startsWith("fonts/"));
const blogPublic = resolve(root, "apps/blog/public");
// Prune first: it may remove a subtree that a previous font choice left behind, and
// only then is the freshness signature a faithful picture of the destination.
await pruneExtras({ base: "fonts", target: blogPublic, files: stagedFonts, label: "apps/blog/public/fonts/" });
// Always re-stage here. The lab's publicDir is regenerated by Vite on every build,
// but the Astro publicDir is versioned source, so this subtree is compared against a
// signature that cannot see removed files; a full re-copy of ~760 shards is cheap
// (well under a second) and is the only thing that makes the staged tree provably
// equal to the whitelist.
await rm(resolve(blogPublic, "fonts"), { recursive: true, force: true });
for (const file of stagedFonts) {
  const destination = resolve(blogPublic, file);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(source, file), destination);
}
console.log(`prepare:assets apps/blog/public/fonts/ 同步 ${stagedFonts.length} 个文件`);
