import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const now = process.env.BUILD_NOW ?? new Date().toISOString();
const env = { ...process.env, BUILD_NOW: now };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const steps = [
  "check:content",
  "check:features",
  "build:blog",
  "build:lab",
  "search:index",
  "check:site",
];

console.log(`统一构建开始，BUILD_NOW=${now}`);
for (const step of steps) {
  console.log(`\n=== npm run ${step} ===`);
  const result = spawnSync(npm, ["run", step], { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`构建在 ${step} 失败（exit ${result.status}）。`);
    process.exit(result.status ?? 1);
  }
}
console.log("\n统一构建完成：dist/ 包含博客、lab、搜索索引。");
