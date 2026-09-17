import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";
import {
  isPublished,
  pageSchema,
  postSchema,
} from "../../apps/blog/src/content/schema.mjs";
import {
  hasReaderMarker,
  normalizeContentTree,
  readArticleContract,
  textContent,
} from "../../shared/reading/contract.ts";
import { SENTINEL_TEXT_EXTENSIONS, findSentinel } from "../reading/fixtures/sentinel.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distDir = resolve(root, "dist");
const contentDir = resolve(root, "content");

async function exists(path) {
  try {
    const info = await stat(path);
    return info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}

function distHtmlPath(entry) {
  return resolve(root, "dist", entry.path.replace(/^\/+|\/+$/g, ""), "index.html");
}

/** Load public/hidden entries the same way check-site does. */
export async function loadEntries() {
  const posts = [];
  const pages = [];
  for (const [dir, schema, bucket] of [
    ["posts", postSchema, posts],
    ["pages", pageSchema, pages],
  ]) {
    const base = resolve(contentDir, dir);
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
  return {
    posts,
    pages,
    published: [...posts, ...pages].filter((entry) => isPublished(entry, now)),
    hidden: [...posts, ...pages].filter((entry) => !isPublished(entry, now)),
  };
}

/**
 * Reader v1 contract gate over the built dist. Returns a machine-readable
 * summary and any errors; the caller decides how to report them.
 */
export async function checkReader({ dist = distDir, posts, pages, published, hidden } = {}) {
  if (!posts) {
    const loaded = await loadEntries();
    ({ posts, pages, published, hidden } = loaded);
  }
  const errors = [];
  const summaries = [];
  const publishedSet = new Set(published ?? [...posts, ...pages]);

  for (const post of posts.filter((entry) => publishedSet.has(entry))) {
    const file = resolve(dist, post.path.replace(/^\/+|\/+$/g, ""), "index.html");
    if (!(await exists(file))) {
      errors.push(`reader：公开文章缺少页面 ${post.path}`);
      continue;
    }
    const html = await readFile(file, "utf8");
    const result = readArticleContract(html);
    if (!result.ok) {
      errors.push(`reader：${post.id} 契约失败（${result.issues.join("；")}）`);
      continue;
    }
    const { contract } = result;
    if (contract.postId !== post.id) {
      errors.push(`reader：${post.path} 的 data-post-id 为 ${contract.postId}，应为 ${post.id}`);
    }
    if (contract.canonicalPath !== post.path) {
      errors.push(`reader：${post.path} 的 data-canonical-path 为 ${contract.canonicalPath}`);
    }
    if (!contract.prose) {
      errors.push(`reader：${post.id} 缺少 .prose 容器`);
      continue;
    }
    const projection = normalizeContentTree(contract.prose);
    const countNodes = (nodes) => nodes.reduce((total, node) => total + 1 + (node.children ? countNodes(node.children) : 0), 0);
    summaries.push({
      postId: contract.postId,
      canonicalPath: contract.canonicalPath,
      title: contract.title,
      projectionNodes: countNodes(projection),
      proseChars: textContent(contract.prose).trim().length,
      projection,
    });
  }

  for (const page of pages.filter((entry) => publishedSet.has(entry))) {
    const file = resolve(dist, page.path.replace(/^\/+|\/+$/g, ""), "index.html");
    if (!(await exists(file))) {
      errors.push(`reader：公开页面缺少页面 ${page.path}`);
      continue;
    }
    if (hasReaderMarker(await readFile(file, "utf8"))) {
      errors.push(`reader：页面 ${page.path} 不应带 data-reader-version 标记`);
    }
  }

  for (const entry of hidden) {
    if (await exists(distHtmlPath(entry))) {
      errors.push(`reader：未公开内容生成了页面 ${entry.path}`);
    }
  }

  // No hidden postId may surface as a consumable marker anywhere in dist.
  const hiddenIds = hidden.map((entry) => entry.id);
  if (hiddenIds.length) {
    const stack = [dist];
    while (stack.length) {
      const dir = stack.pop();
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const next = resolve(dir, item.name);
        if (item.isDirectory()) {
          stack.push(next);
        } else if (item.name.endsWith(".html")) {
          const text = await readFile(next, "utf8");
          for (const id of hiddenIds) {
            if (text.includes(`data-post-id="${id}"`)) {
              errors.push(`reader：隐藏内容 ${id} 出现在 ${next.replace(root, ".")}`);
            }
          }
        }
      }
    }
  }

  // IR5 test fixtures must never reach a release (plan §11.3). The same scan is
  // asserted in the opposite direction on the isolated fixture build, so a
  // broken scanner cannot pass silently.
  const sentinelStack = [dist];
  while (sentinelStack.length) {
    const dir = sentinelStack.pop();
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const next = resolve(dir, item.name);
      if (item.isDirectory()) {
        sentinelStack.push(next);
        continue;
      }
      const extension = item.name.slice(item.name.lastIndexOf("."));
      if (!SENTINEL_TEXT_EXTENSIONS.includes(extension)) continue;
      const sentinel = findSentinel(await readFile(next, "utf8"));
      if (sentinel) errors.push(`reader：发布产物含有测试夹具标记 ${sentinel}（${next.replace(root, ".")}）`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    buildNow: process.env.BUILD_NOW ?? null,
    version: "1",
    posts: summaries,
    errors,
  };
  try {
    await mkdir(resolve(root, ".generated"), { recursive: true });
    await writeFile(resolve(root, ".generated/reader-contract.json"), JSON.stringify(summary, null, 2) + "\n");
  } catch {
    // The summary file is evidence only; a read-only tree must not fail the gate.
  }
  return summary;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const summary = await checkReader();
  if (summary.errors.length) {
    console.error(`reader 检查失败 ${summary.errors.length} 项：\n- ${summary.errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`reader 检查通过：公开文章 ${summary.posts.length} 篇契约完整，页面/草稿无泄露。`);
}
