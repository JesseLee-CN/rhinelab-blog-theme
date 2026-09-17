/**
 * IR5 `failure` suite: every documented load failure and race, judged in the
 * real reader inside the real `/lab/` (plan §11.3).
 *
 * Responses are injected with Playwright routes so the published articles are
 * never modified, and every case ends by removing its route and reading the real
 * article again — a failure path that leaves the reader broken is a failure.
 */
import {
  contractBrokenArticle,
  duplicateIdArticle,
  oversizedArticle,
  unsupportedArticle,
  validArticle,
} from "../fixtures/article-fixtures.mjs";
import { closeReaderByEscape, contextSnapshot, labScene, openArticleDetail, openReader, openReaderExpect, pathMatcher, poll, readerSnapshot, sleep, clickSelector } from "./harness.mjs";

/** Install one route handler for a canonical article path; returns a remover. */
async function intercept(page, articlePath, handler) {
  const matcher = pathMatcher(articlePath);
  await page.route(matcher, handler);
  return async () => {
    await page.unroute(matcher);
  };
}

/**
 * Console filter for injected failures: the browser logs every non-2xx response
 * it was handed on purpose, and those entries say nothing about the reader.
 */
const injectedArticleNoise = (href) => [encodeURI(href), href];

const fulfillHtml = (body, status = 200) => (route) => route.fulfill({ status, contentType: "text/html; charset=utf-8", body });

export async function runFailureSuite(runtime, { lab }) {
  const record = (options, run) => labScene(runtime, { ...options, suite: "failure" }, run);

  // -------------------------------------------------------------------------
  // Error codes: each one shows the same recoverable panel
  // -------------------------------------------------------------------------
  const errorCodesNoise = [];
  await record({ name: "error-codes", ignoreConsole: () => errorCodesNoise }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    const href = await openArticleDetail(page, lab.displayIdFor("wp-55"), "wp-55");
    const target = { postId: "wp-55", href };
    errorCodesNoise.push(...injectedArticleNoise(href));

    const scenarios = [
      { code: "http", label: "404", install: () => intercept(page, href, (route) => route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>not found</title>找不到" })) },
      { code: "http", label: "500", install: () => intercept(page, href, (route) => route.fulfill({ status: 500, contentType: "text/html", body: "<!doctype html><title>error</title>服务器错误" })) },
      { code: "content-type", label: "json", install: () => intercept(page, href, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })) },
      { code: "contract", label: "no-marker", install: () => intercept(page, href, fulfillHtml(contractBrokenArticle(target, "无标记"))) },
      { code: "contract", label: "duplicate-id", install: () => intercept(page, href, fulfillHtml(duplicateIdArticle(target, "重复 id"))) },
      { code: "unsupported", label: "video", install: () => intercept(page, href, fulfillHtml(unsupportedArticle(target, "未授权元素"))) },
      { code: "too-large", label: "oversized", install: () => intercept(page, href, fulfillHtml(oversizedArticle(target))) },
      { code: "network", label: "aborted", install: () => intercept(page, href, (route) => route.abort("failed")) },
    ];

    const results = [];
    for (const scenario of scenarios) {
      const remove = await scenario.install();
      const reader = await openReaderExpect(page, "error", 40_000);
      const entry = {
        label: scenario.label,
        expected: scenario.code,
        load: reader.load,
        errorCode: reader.errorCode,
        errorVisible: reader.errorVisible,
        retryVisible: reader.retryVisible,
        contentNodes: reader.contentNodes,
        inlineLinkHref: reader.inlineLinkHref,
        errorText: reader.errorText,
        mode: (await page.evaluate(contextSnapshot)).mode,
      };
      results.push(entry);
      equal(reader.load, "error", `${scenario.label}：进入错误状态`);
      equal(reader.errorCode, scenario.code, `${scenario.label}：错误码为 ${scenario.code}`);
      check(reader.errorVisible, `${scenario.label}：错误说明可见`);
      check(reader.retryVisible, `${scenario.label}：重试可用`);
      equal(reader.contentNodes, 0, `${scenario.label}：未提交任何正文节点`);
      equal(reader.inlineLinkHref, href, `${scenario.label}：独立文章页入口指向规范地址`);
      equal(entry.mode, "detail", `${scenario.label}：仍保留详情上下文`);
      if (scenario.label === "404") await shot("error-404");
      await closeReaderByEscape(page);
      await poll(page, readerSnapshot, (state) => state.state === "closed", 20_000, `${scenario.label} closed`);
      await remove();
      await sleep(150);
    }
    put("scenarios", results);

    // Recoverability: the same entry must still read the real article.
    const recovered = await openReader(page);
    put("recovered", { load: recovered.load, textLength: recovered.textLength, errorCode: recovered.errorCode });
    check(recovered.load === "ready" && recovered.textLength > 4000, "错误轮次之后仍可正常阅读真实文章", recovered.errorCode);
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // Timeout is a state, not just a rejection
  // -------------------------------------------------------------------------
  const timeoutNoise = [];
  await record({ name: "timeout", ignoreConsole: () => timeoutNoise }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    const href = await openArticleDetail(page, lab.displayIdFor("wp-38"), "wp-38");
    timeoutNoise.push(...injectedArticleNoise(href));
    const remove = await intercept(page, href, async (route) => {
      // Answer after the reader's 10s deadline: the late response must never
      // become content.
      await sleep(11_500);
      try {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: validArticle({ postId: "wp-38", href }, "迟到响应") });
      } catch {
        // The reader already aborted the request.
      }
    });
    const started = Date.now();
    const reader = await openReaderExpect(page, "error", 60_000);
    const elapsed = Date.now() - started;
    put("reader", { load: reader.load, errorCode: reader.errorCode, errorText: reader.errorText });
    put("elapsedMs", elapsed);
    await shot("timeout-error");
    equal(reader.load, "error", "超过 10 秒后进入错误状态");
    equal(reader.errorCode, "timeout", "错误码为 timeout");
    equal(reader.contentNodes, 0, "超时未提交正文节点");
    check(elapsed < 20_000, "超时在 10 秒量级触发", elapsed);
    // Wait past the late response and re-check: still no DOM, still the error.
    await sleep(4000);
    const after = await page.evaluate(readerSnapshot);
    put("afterLateResponse", { load: after.load, errorCode: after.errorCode, contentNodes: after.contentNodes, text: after.text.slice(0, 60) });
    equal(after.load, "error", "迟到响应没有替换错误面板");
    equal(after.contentNodes, 0, "迟到响应没有提交 DOM");
    check(!after.text.includes("迟到响应"), "迟到响应文本未进入面板");
    await remove();
    await closeReaderByEscape(page);
    const recovered = await openReader(page);
    equal(recovered.load, "ready", "超时之后仍可正常阅读");
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // Races: late first request, retry, close-then-resolve
  // -------------------------------------------------------------------------
  const raceNoise = [];
  await record({ name: "races-and-cancellation", ignoreConsole: () => raceNoise }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    const href = await openArticleDetail(page, lab.displayIdFor("wp-71"), "wp-71");
    const target = { postId: "wp-71", href };
    raceNoise.push(...injectedArticleNoise(href));
    let requestCount = 0;
    const remove = await intercept(page, href, async (route) => {
      requestCount += 1;
      const index = requestCount;
      if (index === 1) {
        await sleep(2500);
        try {
          await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: validArticle(target, "第一份迟到内容") });
        } catch {
          // The first request was cancelled by the close; nothing to deliver.
        }
        return;
      }
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: validArticle(target, `第二份内容-${index}`) });
    });

    // --- close while the first request is still in flight ---
    await clickSelector(page, '[data-action="read-immersive"]');
    await poll(page, readerSnapshot, (state) => state.load === "loading", 20_000, "first request in flight");
    const loading = await page.evaluate(readerSnapshot);
    put("loading", { load: loading.load, contentNodes: loading.contentNodes, open: loading.open });
    await closeReaderByEscape(page);
    await poll(page, readerSnapshot, (state) => state.state === "closed", 20_000, "closed during load");
    // Let the cancelled request resolve late.
    await sleep(3000);
    const afterCancel = await page.evaluate(readerSnapshot);
    put("afterCancelledResolve", { load: afterCancel.load, state: afterCancel.state, open: afterCancel.open, contentNodes: afterCancel.contentNodes, text: afterCancel.text.slice(0, 60) });
    equal(afterCancel.open, false, "取消后 dialog 保持关闭");
    equal(afterCancel.contentNodes, 0, "取消后迟到响应没有提交 DOM");
    check(!afterCancel.text.includes("第一份迟到内容"), "取消后迟到内容未进入面板");

    // --- second request wins and stays ---
    const second = await openReader(page);
    await sleep(2600);
    const settled = await page.evaluate(readerSnapshot);
    put("second", { load: second.load, text: second.text.slice(0, 40), requestCount });
    put("settled", { load: settled.load, text: settled.text.slice(0, 40), contentNodes: settled.contentNodes });
    equal(second.load, "ready", "第二次请求成功渲染");
    check(second.text.includes("第二份内容-2"), "面板显示第二次请求的内容", second.text.slice(0, 40));
    check(!settled.text.includes("第一份迟到内容"), "迟到的第一次响应没有覆盖第二次内容");
    await shot("race-settled");

    // --- repeated retry: only the last answer survives ---
    await page.evaluate(() => document.querySelector(".reader-retry")?.click());
    await page.waitForTimeout(80);
    await page.evaluate(() => document.querySelector(".reader-retry")?.click());
    await page.waitForTimeout(80);
    const afterRetries = await poll(page, readerSnapshot, (state) => state.load === "ready", 20_000, "retry ready");
    put("afterRetries", { load: afterRetries.load, text: afterRetries.text.slice(0, 40), requestCount });
    equal(afterRetries.load, "ready", "重复重试后回到就绪");
    equal(afterRetries.contentNodes, settled.contentNodes, "重复重试未叠加内容");
    await remove();
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // Retry after an error, and navigation while an error panel is open
  // -------------------------------------------------------------------------
  const retryNoise = [];
  await record({ name: "retry-and-recovery", ignoreConsole: () => retryNoise }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    const href = await openArticleDetail(page, lab.displayIdFor("wp-19"), "wp-19");
    retryNoise.push(...injectedArticleNoise(href));
    let attempt = 0;
    const remove = await intercept(page, href, async (route) => {
      attempt += 1;
      if (attempt <= 2) {
        await route.fulfill({ status: 503, contentType: "text/html", body: "<!doctype html><title>unavailable</title>维护中" });
        return;
      }
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: validArticle({ postId: "wp-19", href }, "重试成功") });
    });
    const first = await openReaderExpect(page, "error");
    put("first", { load: first.load, errorCode: first.errorCode, attempts: attempt });
    equal(first.load, "error", "第一次请求失败");
    equal(first.errorCode, "http", "错误码为 http");
    await shot("retry-error");
    await page.evaluate(() => document.querySelector(".reader-retry")?.click());
    const second = await poll(page, readerSnapshot, (state) => state.load !== "loading", 20_000, "second attempt");
    put("second", { load: second.load, errorCode: second.errorCode, attempts: attempt });
    equal(second.load, "error", "第二次请求仍然失败");
    check(second.retryVisible, "错误面板仍提供重试");
    await page.evaluate(() => document.querySelector(".reader-retry")?.click());
    const third = await poll(page, readerSnapshot, (state) => state.load === "ready", 20_000, "third attempt ready");
    put("third", { load: third.load, text: third.text.slice(0, 40), attempts: attempt });
    equal(third.load, "ready", "重试成功后渲染正文");
    check(third.text.includes("重试成功"), "重试渲染的是成功响应");
    equal(await page.evaluate(() => document.querySelector("dialog.article-reader").getAttribute("data-error-code")), null, "成功后清除错误码");
    await remove();
    await closeReaderByEscape(page);

    // Closing from the retry panel keeps the archive context usable.
    const broken = await intercept(page, href, (route) => route.fulfill({ status: 500, contentType: "text/html", body: "<!doctype html>err" }));
    const errored = await openReaderExpect(page, "error");
    equal(errored.load, "error", "错误面板可再次出现");
    await closeReaderByEscape(page);
    await broken();
    const context = await page.evaluate(contextSnapshot);
    put("contextAfterErrorClose", context);
    equal(context.mode, "detail", "从错误面板收起后仍在详情");
    equal(context.inputSuspended, false, "从错误面板收起后输入锁已释放");
    const recovered = await openReader(page);
    equal(recovered.load, "ready", "错误收起后重新打开成功");
    await closeReaderByEscape(page);
  });
}
