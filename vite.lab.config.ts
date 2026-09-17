import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

// The three-dimensional archive builds separately from the blog so that a
// second build step never clears the Astro output at the repository root.
export default defineConfig({
  root: resolve(root, "lab"),
  base: "/lab/",
  publicDir: resolve(root, ".generated/lab-public"),
  // 本站未取得 MyFonts webfont 授权：恒为 false，开场始终使用描边图形。
  // 取得授权并把授权包放进 public/fonts/novecento/ 后可改为按本地文件探测。
  define: { __RHINE_NOVECENTO__: JSON.stringify(false) },
  build: {
    outDir: resolve(root, "dist/lab"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      // src/ 与 .generated/ 位于 Vite root（lab/）之外，需要显式允许。
      allow: [root],
    },
  },
  // lab/index.html imports ../src/main.ts; in dev this arrives as the URL path
  // /src/main.ts (outside root), so map it back to the repository src/.
  resolve: {
    alias: [
      { find: /^\/src\//, replacement: `${normalizePath(resolve(root, "src"))}/` },
      // Shared prose styles are imported by both the blog stylesheet and the
      // reader stylesheet; the alias keeps the import independent of the
      // postcss-import root, which differs per build.
      { find: "@reading/prose.css", replacement: normalizePath(resolve(root, "shared/reading/prose.css")) },
    ],
  },
});
