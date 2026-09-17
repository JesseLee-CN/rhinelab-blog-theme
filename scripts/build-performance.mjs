// 上游 51ba3b0 / d9ecb6c 的性能基准构建，**按本站仓库改写**：
// 本站的 Vite 配置（vite.lab.config.ts）以 lab/ 为 root、base 为 /lab/，不适合直接复用，
// 因此这里用 configFile:false 单独构建 reference/performance.html；基线注入只替换
// src/scene.ts（本站没有上游的 archive-visibility.ts / hud-projection.ts）。
//
// 用法：
//   npm run generate:lab-content          # 基准页依赖生成后的 lab 内容
//   node scripts/build-performance.mjs baseline
//   node scripts/build-performance.mjs candidate
//   PERF_BASELINE=<本地提交> node scripts/build-performance.mjs baseline
// 产物：release/performance-<label>，用 scripts/serve-performance.mjs 起静态服务。
import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const label = process.argv[2] || 'candidate';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid benchmark label');
// 本站默认基线：移植上游渲染优化之前的提交。
const defaultBaseline = 'e6dafe8';
let baselineRef = process.env.PERF_BASELINE || defaultBaseline;
try {
  execFileSync('git', ['cat-file', '-e', `${baselineRef}^{commit}`], { stdio: 'ignore' });
} catch (error) {
  if (process.env.PERF_BASELINE) throw error;
  throw new Error('找不到基线提交；用 PERF_BASELINE=<本地提交> 指定移植前的修订。');
}
const baselineCommit = execFileSync('git', ['rev-parse', baselineRef], { encoding: 'utf8' }).trim();
console.log('Performance baseline:', baselineCommit);
await mkdir('.tools/performance', { recursive: true });
await writeFile('.tools/performance/baseline.json', JSON.stringify({ baselineCommit, label }, null, 2));

const injected = ['scene.ts'];
const baselinePlugin = label === 'baseline' ? {
  name: 'performance-baseline',
  enforce: 'pre',
  load(id) {
    const name = injected.find((name) => id.replaceAll('\\', '/').endsWith('/src/' + name));
    if (name) return execFileSync('git', ['show', `${baselineCommit}:src/${name}`], { encoding: 'utf8' });
  },
} : null;

await build({
  configFile: false,
  base: '/',
  plugins: baselinePlugin ? [baselinePlugin] : [],
  build: {
    outDir: `release/performance-${label}`,
    emptyOutDir: true,
    rollupOptions: { input: { benchmark: 'reference/performance.html' } },
  },
});
