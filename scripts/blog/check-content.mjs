import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import {
  isPublished,
  isReservedPath,
  labCollectionsSchema,
  pageSchema,
  postSchema,
} from "../../apps/blog/src/content/schema.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const postsDir = resolve(root, "content/posts");
const pagesDir = resolve(root, "content/pages");
const collectionsFile = resolve(root, "content/lab-collections.json");
const blogPublic = resolve(root, "apps/blog/public");

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);

async function markdownFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => resolve(dir, name));
}

function frontmatter(raw, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) {
    fail(`${file}：缺少 frontmatter（文件必须以 --- 开头）`);
    return null;
  }
  try {
    return parseYaml(match[1]) ?? {};
  } catch (error) {
    fail(`${file}：frontmatter YAML 解析失败：${error.message}`);
    return null;
  }
}

async function loadCollection(dir, schema, kind) {
  const entries = [];
  for (const file of await markdownFiles(dir)) {
    const raw = await readFile(file, "utf8");
    const data = frontmatter(raw, file);
    if (!data) continue;
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        fail(`${file}：${issue.path.join(".") || "(root)"} ${issue.message}`);
      }
      continue;
    }
    entries.push({ file, kind, data: parsed.data });
  }
  return entries;
}

const posts = await loadCollection(postsDir, postSchema, "post");
const pages = await loadCollection(pagesDir, pageSchema, "page");
const all = [...posts, ...pages];

const now = process.env.BUILD_NOW ? new Date(process.env.BUILD_NOW) : new Date();
if (Number.isNaN(now.getTime())) fail(`BUILD_NOW 不是有效日期：${process.env.BUILD_NOW}`);

// Identity and routing must be unique and must not shadow system routes.
const byId = new Map();
const byPath = new Map();
for (const entry of all) {
  const { id, path, title } = entry.data;
  if (byId.has(id)) fail(`重复 id「${id}」：${byId.get(id)} 与 ${entry.file}`);
  else byId.set(id, entry.file);

  if (path === "/") fail(`${entry.file}：path 不能是站点根路径`);
  if (isReservedPath(path)) fail(`${entry.file}：path「${path}」与系统保留路由冲突`);
  const key = path.replace(/\/+$/, "");
  if (byPath.has(key)) fail(`重复 path「${path}」：${byPath.get(key)} 与 ${entry.file}`);
  else byPath.set(key, entry.file);

  if (entry.data.updatedAt && entry.data.updatedAt < entry.data.publishedAt) {
    warnings.push(`${entry.file}：updatedAt 早于 publishedAt（${title}）`);
  }
  const cover = entry.data.cover;
  if (cover && cover.startsWith("/") && !cover.startsWith("//")) {
    const local = resolve(blogPublic, cover.replace(/^\//, ""));
    try {
      await stat(local);
    } catch {
      fail(`${entry.file}：cover「${cover}」在 apps/blog/public 中不存在`);
    }
  }
}

// The lab collection may only reference existing, currently public posts.
let collections = null;
try {
  collections = labCollectionsSchema.parse(
    JSON.parse(await readFile(collectionsFile, "utf8")),
  );
} catch (error) {
  fail(`content/lab-collections.json：${error.message}`);
}
if (collections) {
  const publishedIds = new Set(
    posts.filter((post) => isPublished(post.data, now)).map((post) => post.data.id),
  );
  const knownIds = new Set(posts.map((post) => post.data.id));
  for (const theme of collections.themes) {
    const seen = new Set();
    for (const postId of theme.postIds) {
      if (seen.has(postId)) fail(`lab 主题「${theme.name}」重复引用 ${postId}`);
      seen.add(postId);
      if (!knownIds.has(postId)) {
        fail(`lab 主题「${theme.name}」引用了不存在的文章 ${postId}`);
      } else if (!publishedIds.has(postId)) {
        fail(`lab 主题「${theme.name}」引用了未公开文章 ${postId}`);
      }
    }
  }
}

const published = posts.filter((post) => isPublished(post.data, now));
const drafts = posts.filter((post) => post.data.draft === true);
const future = posts.filter(
  (post) => post.data.draft !== true && post.data.publishedAt.getTime() > now.getTime(),
);

console.log(
  `内容检查：文章 ${posts.length}（公开 ${published.length} / 草稿 ${drafts.length} / 未来 ${future.length}）、` +
    `页面 ${pages.length}、主题 ${collections?.themes.length ?? 0}。构建时间 ${now.toISOString()}`,
);
if (warnings.length) {
  console.log(`警告 ${warnings.length} 条：\n- ${warnings.join("\n- ")}`);
}
if (errors.length) {
  console.error(`内容检查失败 ${errors.length} 项：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
