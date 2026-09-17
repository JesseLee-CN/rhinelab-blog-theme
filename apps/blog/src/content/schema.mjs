import { z } from "astro/zod";

// Shared content contract. Both the Astro content collection (build time) and
// scripts/blog/check-content.mjs (pre-build gate) import this module so the two
// layers cannot drift apart.

export const POST_ID_PATTERN = /^(wp-\d+|post-[0-9a-f-]{8,})$/;

export const RESERVED_PATH_PREFIXES = [
  "/lab",
  "/tags",
  "/categories",
  "/search",
  "/archive",
  "/pagefind",
  "/_astro",
  "/assets",
  "/fonts",
  "/audio",
  "/icons",
  "/licenses",
  "/wp-admin",
  "/wp-content/plugins",
  "/wp-includes",
  "/wp-login.php",
  "/xmlrpc.php",
  "/feed",
  "/rss.xml",
  "/sitemap",
  "/404",
  "/robots.txt",
  "/manifest.webmanifest",
  "/sw.js",
];

const sitePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "path 必须以 / 开头")
  .refine((value) => !value.startsWith("//"), "path 不能是协议相对 URL")
  .refine((value) => !value.includes(".."), "path 不能包含 ..")
  .refine((value) => !value.includes("\\"), "path 不能包含反斜杠")
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "path 不能包含控制字符",
  )
  .refine((value) => !value.includes("://"), "path 不能包含站外协议");

const legacyUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith("/") && !value.startsWith("//"),
    "legacyUrls 必须是站内路径或查询串",
  )
  .refine((value) => !value.includes(".."), "legacyUrls 不能包含 ..");

const baseFields = {
  id: z
    .string()
    .regex(POST_ID_PATTERN, "id 必须为 wp-<数字> 或 post-<稳定 UUID>"),
  title: z.string().trim().min(1, "title 不能为空"),
  description: z
    .string()
    .trim()
    .min(1, "description 不能为空")
    .max(300, "description 不能超过 300 字"),
  path: sitePath,
  publishedAt: z.coerce.date(),
  updatedAt: z.coerce.date().optional(),
  draft: z.boolean().default(false),
  categories: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
  author: z.string().trim().min(1).default("Joyce"),
  cover: z.string().optional(),
  legacyUrls: z.array(legacyUrl).default([]),
};

export const postSchema = z.object(baseFields).strict();

export const pageSchema = z
  .object({
    ...baseFields,
    description: z.string().trim().max(300, "description 不能超过 300 字"),
  })
  .strict();

export const labCollectionsSchema = z
  .object({
    themes: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            description: z.string().trim().min(1),
            postIds: z.array(z.string()).max(8, "每个主题最多 8 个槽位"),
          })
          .strict(),
      )
      .length(5, "必须保留五个策展主题"),
  })
  .strict();

export function isReservedPath(path) {
  return RESERVED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export function isPublished(data, now) {
  return (
    data.draft !== true &&
    data.publishedAt instanceof Date &&
    !Number.isNaN(data.publishedAt.getTime()) &&
    data.publishedAt.getTime() <= now.getTime()
  );
}
