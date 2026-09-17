#!/usr/bin/env node
// 部署后 smoke test：按 fixture 检查状态码、正文与关键产物。
// 用法：node ops/smoke-test.mjs [baseUrl] [fixture.json]
// fixture 默认 ops/smoke-fixtures.json。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8088").replace(/\/$/, "");
const fixturePath = resolve(process.argv[3] ?? resolve(here, "smoke-fixtures.json"));

const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
const failures = [];

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
