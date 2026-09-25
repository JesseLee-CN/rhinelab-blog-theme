#!/usr/bin/env node
// 部署后 smoke test：按 fixture 检查状态码、正文与关键产物。
// 用法：node ops/smoke-test.mjs [baseUrl] [fixture.json]
// fixture 默认 ops/smoke-fixtures.json。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8088").replace(/\/$/, "");
const fixturePath = resolve(process.argv[3] ?? resolve(here, "smoke-fixtures.json"));

const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
const failures = [];

// --- 夹具与本地构建对账 ---
// fixture 的期望值是手写的，过期后过去只能在部署之后才暴露（甚至可能静默变成空检查）。
// 只要仓库里有 dist/，就先拿本地产物核对一遍：夹具漂移在本机被拦住，不必等到线上。
// 需要在与本机构建不一致的站点上跑（例如核对一个更旧的 release）时设
// SMOKE_SKIP_DIST_CHECK=1。
const distRoot = resolve(here, "../dist");

function distFileFor(requestPath) {
  // 线上路径可能带百分号编码（中文 slug），本地产物用的是解码后的目录名，所以先
  // 解码再映射；解码失败（非法编码）就按原样处理，交给对账去报「本地不存在」。
  let clean = requestPath.split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // 保持原样
  }
  clean = clean.replace(/^\/+|\/+$/g, "");
  if (clean === "") return join(distRoot, "index.html");
  if (/\.[a-z0-9]+$/i.test(clean)) return join(distRoot, clean);
  return join(distRoot, clean, "index.html");
}

async function reconcileWithDist() {
  if (process.env.SMOKE_SKIP_DIST_CHECK === "1") return [];
  if (!existsSync(distRoot)) {
    console.warn("提示：未找到 dist/，跳过夹具与本地构建的对账，只按夹具访问目标站点。");
    return [];
  }
  const problems = [];
  for (const test of fixtures.tests) {
    const file = distFileFor(test.path);
    let body = null;
    try {
      body = await readFile(file, "utf8");
    } catch {
      // 本地没有这个产物：对 404 期望是正常的，其余情况在下面对账里报出。
    }
    if ((test.status ?? 200) === 404) {
      if (body !== null) problems.push(`${test.path} 期望 404，但本地产物存在（${file}）`);
      continue;
    }
    if (body === null) {
      problems.push(`${test.path} 在本地 dist/ 中不存在（${file}）`);
      continue;
    }
    for (const needle of test.contains ?? []) {
      if (!body.includes(needle)) problems.push(`${test.path} 缺少「${needle}」`);
    }
    for (const needle of test.notContains ?? []) {
      if (body.includes(needle)) problems.push(`${test.path} 不应包含「${needle}」`);
    }
  }
  return problems;
}

const drift = await reconcileWithDist();
if (drift.length) {
  console.error(
    `smoke 夹具与本地 dist/ 不一致（${drift.length} 项）：\n- ${drift.join("\n- ")}\n` +
      "请更新 ops/smoke-fixtures.json，或先重新构建 dist/（如需跳过对账：SMOKE_SKIP_DIST_CHECK=1）。",
  );
  process.exit(1);
}

for (const test of fixtures.tests) {
  const url = `${baseUrl}${test.path}`;
  let response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch (error) {
    failures.push(`${test.path} 请求失败：${error.message}`);
    continue;
  }
  if (test.status && response.status !== test.status) {
    failures.push(`${test.path} 期望 ${test.status}，实际 ${response.status}`);
    continue;
  }
  if (test.location && !String(response.headers.get("location") ?? "").includes(test.location)) {
    failures.push(`${test.path} Location 期望包含「${test.location}」，实际「${response.headers.get("location")}」`);
  }
  if (test.contains) {
    const body = await response.text();
    for (const needle of test.contains) {
      if (!body.includes(needle)) failures.push(`${test.path} 正文缺少「${needle}」`);
    }
  }
  if (test.notContains) {
    const body = await response.text();
    for (const needle of test.notContains) {
      if (body.includes(needle)) failures.push(`${test.path} 正文不应包含「${needle}」`);
    }
  }
  console.log(`✓ ${response.status} ${test.path}`);
}

if (failures.length) {
  console.error(`smoke test 失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`smoke test 通过：${fixtures.tests.length} 项`);
