// 上游 65fc700 的对照页交互检查，**按本站接口改写**：
// 上游用 `getStats().cameraDetail` 与 Edge 通道；本站用暂停前后
// `renderedFrames + reusedFrames` 是否停止增长来判定暂停生效。
//
// 用法：先 `npm run dev:reference`，再
//   PREVIEW_URL=http://127.0.0.1:5173 node scripts/check-model-precision-review.mjs
// 产物：.tools/performance/model-precision-review.json
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";
const checks = [];
const errors = [];
const browser = await chromium.launch({
  args: ["--use-angle=default", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--mute-audio"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /THREE|shader|WebGL/.test(message.text())) errors.push(message.text());
  });
  await page.goto(`${base}/reference/model-precision.html`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector("#note")?.textContent?.includes("正在准备"), null, { timeout: 120000 });
  const note = () => page.locator("#note").innerText();
  for (const [tier, arrayCount] of [["high", "4,200"], ["medium", "2,072"], ["low", "1,554"]]) {
    await page.selectOption("#tier", tier);
    await page.waitForFunction((count) => document.querySelector("#note")?.textContent?.includes(count), arrayCount, { timeout: 120000 });
    checks.push({ tier, note: await note() });
  }
  // 暗色与暂停
  await page.check("#dark");
  await page.waitForFunction(() => document.querySelector("#note")?.textContent?.includes("1,554"), null, { timeout: 120000 });
  checks.push({ dark: true, note: await note() });
  const frames = () =>
    page.evaluate(() => {
      const stats = document.querySelector("#view")?.contentWindow?.bench?.scene.getStats();
      return stats ? stats.renderedFrames + stats.reusedFrames : null;
    });
  await page.waitForTimeout(1200);
  await page.click("#pause");
  const before = await frames();
  await page.waitForTimeout(600);
  const after = await frames();
  assert.equal(before, after, "Pause must stop stepping");
  await page.click("#pause");
  await page.waitForFunction((baseline) => {
    const stats = document.querySelector("#view")?.contentWindow?.bench?.scene.getStats();
    return stats ? stats.renderedFrames + stats.reusedFrames > baseline : false;
  }, before, { timeout: 120000 });
  checks.push({ pause: true, resume: true });
  assert.deepEqual(errors, []);
  await mkdir(".tools/performance", { recursive: true });
  await writeFile(".tools/performance/model-precision-review.json", `${JSON.stringify({ base, checks, errors }, null, 2)}\n`);
  console.log(JSON.stringify({ base, checks, errors }));
} finally {
  await browser.close();
}
