import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import remarkCjkFriendly from "remark-cjk-friendly";

const site = process.env.BLOG_SITE_ORIGIN || "https://example.com";
// IR5 fixture builds run the same configuration against synthetic content and
// write somewhere outside `dist/`; both variables are unset for a normal build.
const outDir = process.env.BLOG_OUT_DIR || "../../dist";

export default defineConfig({
  site,
  outDir,
  publicDir: "./public",
  markdown: {
    // CommonMark 默认不把中文标点当作 punctuation，导致 `**…：**后接文字`
    // 这类强调不渲染。该插件让中文标点参与 flanking 判定。
    remarkPlugins: [remarkCjkFriendly],
  },
  build: {
    format: "directory",
    inlineStylesheets: "auto",
  },
  trailingSlash: "ignore",
  integrations: [
    sitemap({
      filter: (page) => !page.includes("/lab/") && !page.includes("/search/") && !page.includes("/account/"),
    }),
  ],
  devToolbar: { enabled: false },
});
