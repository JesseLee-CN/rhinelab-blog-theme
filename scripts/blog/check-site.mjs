import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import {
  isPublished,
  pageSchema,
  postSchema,
} from "../../apps/blog/src/content/schema.mjs";
import { checkReader } from "./check-reader.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dist = resolve(root, "dist");
const content = resolve(root, "content");

const errors = [];
const fail = (message) => errors.push(message);

async function exists(path) {
  try {
    const info = await stat(path);
    return info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}

async function read(path) {
  return readFile(path, "utf8");
}

// Build the expected public paths straight from the content source.
const posts = [];
const pages = [];
for (const [dir, schema, bucket] of [
  ["posts", postSchema, posts],
  ["pages", pageSchema, pages],
]) {
  const { readdir } = await import("node:fs/promises");
  const base = resolve(content, dir);
  let names = [];
  try {
    names = await readdir(base);
  } catch {
    continue;
  }
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    const raw = await readFile(resolve(base, name), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!match) continue;
    const parsed = schema.safeParse(parseYaml(match[1]) ?? {});
    if (parsed.success) bucket.push(parsed.data);
  }
}

const now = process.env.BUILD_NOW ? new Date(process.env.BUILD_NOW) : new Date();
const published = [...posts, ...pages].filter((entry) => isPublished(entry, now));
const hidden = [...posts, ...pages].filter((entry) => !isPublished(entry, now));

const requiredFiles = [
  "index.html",
  "404.html",
  "rss.xml",
  "robots.txt",
  "sitemap-index.xml",
  "search/index.html",
  "pagefind/pagefind.js",
  "lab/index.html",
];
for (const file of requiredFiles) {
  if (!(await exists(resolve(dist, file)))) fail(`缺少构建产物 dist/${file}`);
}

// Release hygiene: no repository, secrets, database dumps or private exports.
const { readdir } = await import("node:fs/promises");
async function walk(dir, relative = "") {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const next = relative ? `${relative}/${name.name}` : name.name;
    if (name.isDirectory()) await walk(resolve(dir, name.name), next);
    if (/^(\.git|\.env|\.migration-private|node_modules|wp-config\.php)$/.test(name.name)) {
      fail(`构建产物包含禁止内容：dist/${next}`);
    }
    if (/\.(sql|blend1)$/i.test(name.name)) fail(`构建产物包含禁止文件：dist/${next}`);
  }
}
await walk(dist);

// Every public entry must have a real HTML file; every hidden entry must not.
for (const entry of published) {
  const file = resolve(dist, entry.path.replace(/^\/+|\/+$/g, ""), "index.html");
  if (!(await exists(file))) fail(`公开内容缺少页面：${entry.path}`);
}
for (const entry of hidden) {
  const file = resolve(dist, entry.path.replace(/^\/+|\/+$/g, ""), "index.html");
  if (await exists(file)) fail(`未公开内容生成了页面：${entry.path}`);
}

// Hidden markers must not appear in any public HTML or the RSS feed.
if (hidden.length > 0) {
  const publicHtml = [resolve(dist, "index.html"), resolve(dist, "rss.xml")];
  for (const file of publicHtml) {
    if (!(await exists(file))) continue;
    const text = await read(file);
    for (const entry of hidden) {
      if (text.includes(entry.title)) {
        fail(`${file.replace(root, ".")} 泄露了未公开标题：${entry.title}`);
      }
    }
  }
}

// Blog reading must not pull in the 3D/audio stack, and production pages must
// not be accidentally noindex.
const forbiddenRefs = [".glb", "atmosphere.ogg", "three.module", "/lab/assets/"];
const blogPages = ["index.html", ...published.map((entry) => `${entry.path.replace(/^\/+|\/+$/g, "")}/index.html`)];
for (const relative of blogPages) {
  const file = resolve(dist, relative);
  if (!(await exists(file))) continue;
  const html = await read(file);
  for (const forbidden of forbiddenRefs) {
    if (html.includes(forbidden)) fail(`${relative} 引用了三维/音频资源：${forbidden}`);
  }
  if (/<meta name="robots" content="noindex/.test(html)) {
    fail(`${relative} 含意外 noindex`);
  }
}

// The lab must stay under /lab/ and must not ship a Service Worker or manifest.
if (await exists(resolve(dist, "lab/index.html"))) {
  const labHtml = await read(resolve(dist, "lab/index.html"));
  if (!labHtml.includes('src="/lab/assets/') && !labHtml.includes('href="/lab/assets/')) {
    fail("lab/index.html 未使用 /lab/ base 解析资源");
  }
  for (const forbidden of ["sw.js", "manifest.webmanifest"]) {
    if (labHtml.includes(forbidden)) fail(`lab/index.html 仍引用 ${forbidden}`);
  }
  for (const file of ["sw.js", "manifest.webmanifest", "pwa-build.json"]) {
    if (await exists(resolve(dist, "lab", file))) fail(`dist/lab/${file} 不应存在（MVP 关闭 PWA）`);
  }
  if (await exists(resolve(dist, "lab/archives"))) {
    fail("dist/lab/archives 不应存在（演示档案已退役）");
  }
}

// RSS and sitemap must only reference public canonical URLs.
if (await exists(resolve(dist, "rss.xml"))) {
  const rss = await read(resolve(dist, "rss.xml"));
  const rssPaths = new Set(
    [...rss.matchAll(/<link>([^<]+)<\/link>/g)]
      .map((match) => {
        try {
          return decodeURIComponent(new URL(match[1]).pathname);
        } catch {
          return match[1];
        }
      })
      .map((path) => path.replace(/\/$/, "")),
  );
  for (const entry of published) {
    // RSS is a feed of posts only; pages are intentionally absent.
    if (posts.includes(entry) && !rssPaths.has(entry.path.replace(/\/$/, ""))) {
      fail(`RSS 缺少文章：${entry.path}`);
    }
  }
  for (const entry of hidden) {
    if (rss.includes(entry.title)) fail(`RSS 泄露未公开文章：${entry.title}`);
  }
}

// Reader v1 contract over the built HTML (same public set and BUILD_NOW).
const reader = await checkReader({ dist, posts, pages, published, hidden });
errors.push(...reader.errors);

if (errors.length) {
  console.error(`站点检查失败 ${errors.length} 项：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `站点检查通过：公开 ${published.length} 条、隐藏 ${hidden.length} 条；` +
    `HTML/404/RSS/sitemap/搜索/lab 产物齐全，无未公开泄露。`,
);
