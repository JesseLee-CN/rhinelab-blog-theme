import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPublished,
  isReservedPath,
  labCollectionsSchema,
  pageSchema,
  postSchema,
} from "../../apps/blog/src/content/schema.mjs";

const base = {
  id: "wp-123",
  title: "示例文章",
  description: "摘要",
  path: "/2026/09/09/example/",
  publishedAt: "2026-09-09T10:00:00+08:00",
  draft: false,
  categories: ["技术"],
  tags: ["Astro"],
  author: "Joyce",
  legacyUrls: ["/?p=123"],
};

test("isPublished filters drafts and future entries", () => {
  const now = new Date("2026-09-09T12:00:00+08:00");
  assert.equal(isPublished({ ...base, draft: false, publishedAt: new Date("2026-09-09T10:00:00+08:00") }, now), true);
  assert.equal(isPublished({ ...base, draft: true, publishedAt: new Date("2026-09-09T10:00:00+08:00") }, now), false);
  assert.equal(isPublished({ ...base, draft: false, publishedAt: new Date("2026-09-10T10:00:00+08:00") }, now), false);
  assert.equal(isPublished({ ...base, draft: false, publishedAt: new Date("invalid") }, now), false);
});

test("isReservedPath blocks system routes", () => {
  for (const path of ["/lab", "/lab/", "/tags/x", "/categories/x", "/search/", "/archive/", "/pagefind/x", "/wp-admin/"]) {
    assert.equal(isReservedPath(path), true, `${path} 应保留`);
  }
  for (const path of ["/2026/09/09/example/", "/about/", "/posts/foo/"]) {
    assert.equal(isReservedPath(path), false, `${path} 不应保留`);
  }
});

test("postSchema accepts a valid entry", () => {
  const parsed = postSchema.parse(base);
  assert.equal(parsed.id, "wp-123");
  assert.equal(parsed.draft, false);
});

const invalidPosts = [
  ["非法 id", { id: "123" }],
  ["空标题", { title: "  " }],
  ["空摘要", { description: "" }],
  ["超长摘要", { description: "字".repeat(301) }],
  ["相对路径", { path: "2026/09/09/example/" }],
  ["越界路径", { path: "/2026/../etc/" }],
  ["反斜杠路径", { path: "/2026\\09\\example/" }],
  ["协议相对", { path: "//evil.example/" }],
  ["控制字符", { path: "/2026/\u0000/" }],
  ["站外协议", { path: "https://evil.example/" }],
  ["未知字段", { extra: true }],
  ["非法 legacyUrl", { legacyUrls: ["//evil.example/"] }],
];
for (const [name, patch] of invalidPosts) {
  test(`postSchema rejects ${name}`, () => {
    assert.equal(postSchema.safeParse({ ...base, ...patch }).success, false);
  });
}

test("pageSchema allows an empty description", () => {
  const parsed = pageSchema.parse({ ...base, description: "" });
  assert.equal(parsed.description, "");
});

test("labCollectionsSchema requires five themes and max eight slots", () => {
  const theme = { name: "主题", description: "描述", postIds: [] };
  assert.equal(labCollectionsSchema.safeParse({ themes: [theme, theme, theme, theme, theme] }).success, true);
  assert.equal(labCollectionsSchema.safeParse({ themes: [theme, theme, theme, theme] }).success, false);
  const nine = { name: "主题", description: "描述", postIds: Array.from({ length: 9 }, (_, i) => `wp-${i}`) };
  assert.equal(labCollectionsSchema.safeParse({ themes: [nine, theme, theme, theme, theme] }).success, false);
});
