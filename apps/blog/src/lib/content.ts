import { getCollection, type CollectionEntry } from "astro:content";
import { isPublished } from "../content/schema.mjs";

export type PostEntry = CollectionEntry<"posts">;
export type PageEntry = CollectionEntry<"pages">;
export type AnyEntry = PostEntry | PageEntry;

// One build time for every public artefact so that "future" filtering cannot
// disagree between HTML, RSS, sitemap and the search index.
export const BUILD_NOW = (() => {
  const raw = process.env.BUILD_NOW;
  const parsed = raw ? new Date(raw) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`BUILD_NOW 不是有效日期：${raw}`);
  }
  return parsed;
})();

const byDateDesc = (a: AnyEntry, b: AnyEntry) =>
  b.data.publishedAt.getTime() - a.data.publishedAt.getTime();

export async function getPublishedPosts(now = BUILD_NOW): Promise<PostEntry[]> {
  const entries = await getCollection("posts");
  return entries.filter((entry) => isPublished(entry.data, now)).sort(byDateDesc);
}

export async function getPublishedPages(
  now = BUILD_NOW,
): Promise<PageEntry[]> {
  const entries = await getCollection("pages");
  return entries.filter((entry) => isPublished(entry.data, now)).sort(byDateDesc);
}

export async function getPublishedContent(
  now = BUILD_NOW,
): Promise<AnyEntry[]> {
  const [posts, pages] = await Promise.all([
    getPublishedPosts(now),
    getPublishedPages(now),
  ]);
  return [...posts, ...pages].sort(byDateDesc);
}

export function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

export function entryUrl(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(date);
}
