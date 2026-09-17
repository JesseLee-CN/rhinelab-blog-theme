// 参考页开发服务器（`npm run dev:reference`）的根级配置。
//
// 背景：三维入口的正式配置是 vite.lab.config.ts（root = lab/、base = /lab/），
// 但 reference/*.html 这些对照页位于仓库根、并以 iframe 内嵌根路径的应用
// （`/?time=13&freeze=1&review=1`）。没有这份配置时，根路径的 Vite 解析不了
// article-reader.css 里的 `@reading/prose.css` 别名（500），应用无法启动，
// 13 个对照页都会失效。
//
// 只服务开发与本机验证：正式构建始终走 vite.lab.config.ts（lab/）与 Astro，
// 不受本文件影响。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 应用资源（GLB、字体、许可）由白名单暂存在 .generated/lab-public。
  publicDir: resolve(root, ".generated/lab-public"),
  // 本站没有 MyFonts webfont 授权：开场固定短语始终使用描边图形。
  define: { __RHINE_NOVECENTO__: JSON.stringify(false) },
  resolve: {
    alias: [
      {
        find: "@reading/prose.css",
        replacement: normalizePath(resolve(root, "shared/reading/prose.css")),
      },
    ],
  },
});
