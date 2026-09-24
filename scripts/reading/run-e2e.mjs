#!/usr/bin/env node
/**
 * IR5 end-to-end gate (plan §11.1).
 *
 *   node scripts/reading/run-e2e.mjs [--browser chromium] [--suite all]
 *     [--base-url http://127.0.0.1:4173] [--out-dir .tools/immerse-reading/IR5/chromium]
 *
 * Contract:
 *   - `--base-url` reuses an existing target after checking it is reachable and
 *     really carries this build; without it a local preview of `dist/` is
 *     started and only that process is stopped again.
 *   - nothing is built automatically and no production host is ever contacted.
 *   - `all` = content + interaction + failure. `compat` and `performance` must be
 *     named explicitly: their numbers are judged in IR6, not here.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadLabContent, loadPublished, root, startPreviewServer, verifyBaseUrl } from "./e2e/harness.mjs";
import { runContentSuite } from "./e2e/content.mjs";
import { runInteractionSuite } from "./e2e/interaction.mjs";
import { runFailureSuite } from "./e2e/failure.mjs";
import { runCompatSuite } from "./e2e/compat.mjs";
import { runPerformanceSuite } from "./e2e/performance.mjs";
import { runVisualSuite } from "./e2e/visual.mjs";
import { buildFixtureSite } from "./fixtures/build-fixture-site.mjs";
import { FIXTURE_SENTINELS } from "./fixtures/sentinel.mjs";

const SUITES = ["all", "content", "interaction", "failure", "compat", "performance", "visual"];
const BROWSERS = ["chromium", "firefox", "webkit"];
const GATE_SUITES = ["content", "interaction", "failure"];

function usage() {
  return [
    "用法：node scripts/reading/run-e2e.mjs [选项]",
    "",
    "  --base-url <url>     复用已有站点（默认自建本机 dist 预览）",
    "  --browser <name>     chromium | firefox | webkit（默认 chromium）",
    "  --suite <name>       all | content | interaction | failure | compat | performance | visual",
    "                       all = content + interaction + failure（IR5 判定范围）",
    "                       visual / performance / compat = IR6 设备、性能与跨引擎证据",
    "  --out-dir <dir>      证据输出目录（默认 .tools/immerse-reading/IR5/<browser>）",
    "  --headed             有头运行",
    "  --no-trace           不为失败场景保存 trace",
    "  --skip-fixture-build 复用已构建的复杂 Markdown 夹具",
    "  --help               显示本说明",
  ].join("\n");
}

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    browser: { type: "string", default: "chromium" },
    suite: { type: "string", default: "all" },
    "out-dir": { type: "string" },
    headed: { type: "boolean", default: false },
    trace: { type: "boolean", default: true },
    "skip-fixture-build": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowNegative: true,
});

if (values.help) {
  console.log(usage());
  process.exit(0);
}
const browserName = values.browser;
const suiteName = values.suite;
if (!BROWSERS.includes(browserName)) {
  console.error(`未知浏览器：${browserName}\n${usage()}`);
  process.exit(2);
}
if (!SUITES.includes(suiteName)) {
  console.error(`未知套件：${suiteName}\n${usage()}`);
  process.exit(2);
}
const suites = suiteName === "all" ? GATE_SUITES : [suiteName];
const outDir = resolve(root, values["out-dir"] ?? `.tools/immerse-reading/IR5/${browserName}`);

await mkdir(resolve(outDir, "screenshots"), { recursive: true });
await mkdir(resolve(outDir, "traces"), { recursive: true });

// ---------------------------------------------------------------------------
// Target: reuse or start, but never touch a foreign process
// ---------------------------------------------------------------------------
let target;
if (values["base-url"]) {
  const marker = await verifyBaseUrl(values["base-url"]);
  target = { baseUrl: values["base-url"], stop: () => {}, owned: false, marker };
} else {
  target = await startPreviewServer();
}
const baseUrl = target.baseUrl;

// ---------------------------------------------------------------------------
// Evidence inputs
// ---------------------------------------------------------------------------
const lab = await loadLabContent();
const published = await loadPublished();
/**
 * A search term that really exists in the post the pagefind case asserts on.
 *
 * Derived from the built article instead of hardcoded: the sample articles are
 * meant to be replaced, and a stale term turns the whole search case red without
 * anything being wrong with the index. Latin tokens are preferred because the
 * previous positive control ("Multisim") proved they are indexed verbatim.
 */
function positiveSearchTerm(entry) {
  const file = resolve(root, "dist", entry.path.replace(/^\//, ""), "index.html");
  const html = readFileSync(file, "utf8");
  const article = /<div class="prose"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/.exec(html)?.[1] ?? html;
  const text = article.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ");
  const counts = new Map();
  for (const token of text.match(/[A-Za-z][A-Za-z0-9-]{4,}/g) ?? []) counts.set(token, (counts.get(token) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
  if (ranked.length) return ranked[0][0];
  const cjk = /[\u4e00-\u9fff]{4,}/.exec(text);
  return cjk ? cjk[0].slice(0, 6) : null;
}

const pagefindPost = published.posts.find((entry) => entry.id === "wp-55") ?? published.posts[0];
const pagefindPositive = pagefindPost ? positiveSearchTerm(pagefindPost) : null;
if (!pagefindPositive) {
  console.error("无法从已构建的文章中取得 Pagefind 正向检索词；请先 npm run build 生成 dist/。");
  process.exit(2);
}
const pagefindTerms = {
  positive: pagefindPositive,
  negative: [...FIXTURE_SENTINELS, ...published.hidden.map((entry) => entry.id)],
};
let fixture = { built: false };
if (suites.includes("content") && !values["skip-fixture-build"]) {
  const started = Date.now();
  const html = await buildFixtureSite();
  fixture = { built: true, bytes: Buffer.byteLength(html), ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
const playwright = await import("playwright");
const engine = playwright[browserName];
if (!engine) {
  console.error(`Playwright 不支持 ${browserName}`);
  process.exit(2);
}
let browser;
try {
  browser = await engine.launch({
    headless: !values.headed,
    ...(browserName === "chromium"
      ? { args: ["--use-angle=default", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-precise-memory-info"] }
      : {}),
  });
} catch (error) {
  target.stop();
  console.error(`无法启动 ${browserName}：${String(error).split("\n")[0]}`);
  console.error("  提示：npx playwright install " + browserName);
  process.exit(3);
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  baseUrlOwned: target.owned,
  baseUrlMarker: target.marker ?? null,
  browser: browserName,
  browserVersion: browser.version(),
  suites,
  suiteArgument: suiteName,
  fixture,
  cases: [],
  note: "all = content + interaction + failure；compat/performance 的结果只作 IR6 输入。",
};

const runtime = { browser, browserName, outDir, report, baseUrl };
const context = { baseUrl, lab, published, pagefind: pagefindTerms };

try {
  if (suites.includes("content")) await runContentSuite(runtime, context);
  if (suites.includes("interaction")) await runInteractionSuite(runtime, context);
  if (suites.includes("failure")) await runFailureSuite(runtime, context);
  if (suites.includes("compat")) await runCompatSuite(runtime, context);
  if (suites.includes("performance")) await runPerformanceSuite(runtime, context);
  if (suites.includes("visual")) await runVisualSuite(runtime, context);
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const counts = report.cases.reduce(
  (total, entry) => {
    total[entry.status] = (total[entry.status] ?? 0) + 1;
    total.checks += entry.checks.length;
    total.failedChecks += entry.checks.filter((check) => !check.ok).length;
    return total;
  },
  { pass: 0, fail: 0, checks: 0, failedChecks: 0 },
);
report.counts = counts;
report.passed = counts.fail === 0;
const failures = report.cases
  .filter((entry) => entry.status === "fail")
  .map((entry) => ({
    name: entry.name,
    error: entry.error ?? null,
    checks: entry.checks.filter((check) => !check.ok).map((check) => `${check.message}${check.detail ? ` :: ${JSON.stringify(check.detail)}` : ""}`),
  }));
report.failures = failures;

await writeFile(resolve(outDir, "test-results.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(
  resolve(outDir, "test-summary.json"),
  `${JSON.stringify(
    {
      generatedAt: report.generatedAt,
      baseUrl,
      baseUrlOwned: target.owned,
      browser: browserName,
      browserVersion: report.browserVersion,
      suites,
      counts,
      passed: report.passed,
      caseNames: report.cases.map((entry) => `${entry.suite}/${entry.name}:${entry.status}`),
      failures,
      screenshots: report.cases.flatMap((entry) => entry.screenshots ?? []),
      traces: report.cases.filter((entry) => entry.trace).map((entry) => entry.trace),
    },
    null,
    2,
  )}\n`,
);

target.stop();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));

for (const entry of report.cases) {
  const failed = entry.checks.filter((check) => !check.ok);
  console.log(`${entry.status === "pass" ? "✔" : "✖"} [${entry.suite}] ${entry.name} — ${entry.checks.length} 项检查，${Math.round(entry.durationMs / 100) / 10}s`);
  for (const check of failed) console.log(`    ✖ ${check.message}${check.detail ? ` ${JSON.stringify(check.detail)}` : ""}`);
  if (entry.error) console.log(`    ! ${entry.error.split("\n")[0]}`);
}
console.log(`\n套件：${suites.join(", ")}；浏览器：${browserName} ${report.browserVersion}；目标：${baseUrl}（${target.owned ? "本进程启动" : "外部"}）`);
console.log(`用例：${counts.pass} 通过 / ${counts.fail} 失败；检查：${counts.checks - counts.failedChecks}/${counts.checks} 通过`);
console.log(`证据：${outDir.replace(root, ".")}/test-results.json`);
if (!report.passed) {
  console.error(`IR5 e2e 失败 ${counts.fail} 个场景：\n- ${failures.map((entry) => `${entry.name}: ${entry.error ?? entry.checks.join("；")}`).join("\n- ")}`);
  process.exit(1);
}
console.log("IR5 e2e 通过。");
