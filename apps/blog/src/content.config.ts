import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pageSchema, postSchema } from "./content/schema.mjs";

// Normal builds read the repository `content/` trees. The IR5 fixture build
// points the same collections at synthetic content under `.tools/` so complex
// Markdown can be rendered by this exact configuration without touching the
// published content set. The loader resolves its base as a URL, so both forms
// are file URLs: a Windows drive path is not a valid URL base.
const contentRoot = process.env.BLOG_CONTENT_ROOT || resolve("../../content");
const postsBase = pathToFileURL(resolve(contentRoot, "posts")).href;
const pagesBase = pathToFileURL(resolve(contentRoot, "pages")).href;

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: postsBase }),
  schema: postSchema,
});

const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: pagesBase }),
  schema: pageSchema,
});

export const collections = { posts, pages };
