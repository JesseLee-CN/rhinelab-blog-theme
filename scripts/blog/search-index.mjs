import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pagefind from "pagefind";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const site = resolve(root, "dist");

const { index, errors } = await pagefind.createIndex({
  // Only article bodies are searchable; navigation, taxonomy pages and the lab
  // terminal never enter the index.
  rootSelector: "[data-pagefind-body]",
});
if (!index || errors?.length) {
  console.error(`Pagefind 索引创建失败：\n- ${(errors ?? ["未知错误"]).join("\n- ")}`);
  process.exit(1);
}

const result = await index.addDirectory({ path: site });
if (result.errors?.length) {
  console.error(`Pagefind 索引失败：\n- ${result.errors.join("\n- ")}`);
  await pagefind.close();
  process.exit(1);
}

await index.writeFiles({ outputPath: resolve(site, "pagefind") });
await pagefind.close();

console.log(
  `Pagefind 索引完成：${result.page_count ?? "?"} 个页面，输出 dist/pagefind/`,
);
