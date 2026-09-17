/**
 * IR5 `content` suite: public content, real HTTP routes, the search index and
 * the "no fixture / no reader runtime in the release" rules (plan §11.3).
 *
 * Static invariants that `check:site` already owns are not duplicated here; this
 * suite judges the things only a running server and browser can show (status
 * codes, real 404, Pagefind query results, reading without JavaScript, and the
 * complex-Markdown fixture rendered by the real reader).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { FIXTURE_SENTINELS } from "../fixtures/sentinel.mjs";
import {
  FIXTURE_DISALLOWED_PATH,
  FIXTURE_DISALLOWED_POST_ID,
  FIXTURE_POST_ID,
  FIXTURE_POST_PATH,
  fixtureRoot,
  readFixtureArticleHtml,
} from "../fixtures/build-fixture-site.mjs";
import { contractBrokenArticle } from "../fixtures/article-fixtures.mjs";
import { contextSnapshot, labScene, openArticleDetail, openReader, openReaderExpect, closeReaderByEscape, pathMatcher, runScene, root } from "./harness.mjs";

/** Serve one HTML body for one canonical article path; returns the matcher. */
async function serveArticle(page, { articlePath, body }) {
  const matcher = pathMatcher(articlePath);
  await page.route(matcher, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }));
  return matcher;
}

/** Re-point a fixture article at a real archive record. */
function retarget(html, { fromPostId, fromPath, to }) {
  return html
    .replaceAll(`data-post-id="${fromPostId}"`, `data-post-id="${to.postId}"`)
    .replaceAll(`data-canonical-path="${fromPath}"`, `data-canonical-path="${to.href}"`);
}

async function listFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const next = resolve(dir, entry.name);
    if (entry.isDirectory()) await listFiles(next, out);
    else out.push(next);
  }
  return out;
}

export async function runContentSuite(runtime, { baseUrl, lab, published, pagefind }) {
  const record = (options, run) =>
    options.lab === false ? runScene(runtime, { ...options, suite: "content" }, run) : labScene(runtime, { ...options, suite: "content" }, run);

  // -------------------------------------------------------------------------
  // The isolated fixture build: complex Markdown rendered by the same Astro config
  // -------------------------------------------------------------------------
  await record({ name: "fixture-site-build", lab: false, screenshot: false }, async (scene) => {
    const { check, equal, record: put } = scene;
    const articleHtmlText = await readFixtureArticleHtml();
    const disallowedHtml = await readFixtureArticleHtml(FIXTURE_DISALLOWED_PATH);
    const files = await listFiles(fixtureRoot);
    const htmlFiles = files.filter((file) => file.endsWith(".html"));
    put("fixtureRoot", fixtureRoot.replace(root, "."));
    put("htmlFiles", htmlFiles.map((file) => file.replace(root, ".")));
    check(articleHtmlText.includes(FIXTURE_SENTINELS[0]), "夹具构建包含正文哨兵（扫描灵敏度正控）");
    const draftPresent = htmlFiles.some((file) => file.includes("ir5-fixture-draft"));
    const futurePresent = htmlFiles.some((file) => file.includes("ir5-fixture-future"));
    equal(draftPresent, false, "夹具构建未生成草稿页面");
    equal(futurePresent, false, "夹具构建未生成未来日期页面");
    put("disallowedBytes", Buffer.byteLength(disallowedHtml));
    check(articleHtmlText.includes("<table>") && articleHtmlText.includes("data-footnote-ref"), "夹具文章覆盖表格与脚注");
  });

  // -------------------------------------------------------------------------
  // Complex Markdown must survive the real reader
  // -------------------------------------------------------------------------
  await record({ name: "complex-markdown-render" }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    const displayId = lab.displayIdFor("wp-55");
    const href = await openArticleDetail(page, displayId, "wp-55");
    const fixtureHtml = await readFixtureArticleHtml();
    const body = retarget(fixtureHtml, { fromPostId: FIXTURE_POST_ID, fromPath: FIXTURE_POST_PATH, to: { postId: "wp-55", href } });
    await serveArticle(page, { articlePath: href, body });
    const reader = await openReader(page);
    put("reader", { load: reader.load, nodes: reader.contentNodes, textLength: reader.textLength });
    check(reader.load === "ready", "复杂 Markdown 夹具在真实 reader 中渲染成功", reader.errorCode);
    await shot("fixture-rendered");

    const rendered = await page.evaluate(() => {
      const content = document.querySelector(".reader-content");
      const text = content?.textContent ?? "";
      return {
        text,
        headings: [...content.querySelectorAll("h1,h2,h3")].map((element) => element.textContent.trim()),
        tableRows: content.querySelectorAll("table tr").length,
        tableHeaders: content.querySelectorAll("th").length,
        checkboxInputs: content.querySelectorAll('input[type="checkbox"]').length,
        disabledCheckboxes: content.querySelectorAll("input[type=checkbox][disabled]").length,
        codeBlocks: content.querySelectorAll("pre").length,
        codeLines: content.querySelectorAll("pre .line").length,
        inlineCode: content.querySelectorAll("code").length,
        footnoteRefs: content.querySelectorAll('a[href^="#"]').length,
        footnoteItems: content.querySelectorAll("section ol li").length,
        details: content.querySelectorAll("details").length,
        summaries: content.querySelectorAll("summary").length,
        blockquotes: content.querySelectorAll("blockquote").length,
        images: [...content.querySelectorAll("img")].map((image) => ({
          src: image.getAttribute("src"),
          srcset: image.getAttribute("srcset"),
          sizes: image.getAttribute("sizes"),
          width: image.getAttribute("width"),
          height: image.getAttribute("height"),
          alt: image.getAttribute("alt"),
          title: image.getAttribute("title"),
          loading: image.getAttribute("loading"),
        })),
        abbr: [...content.querySelectorAll("abbr")].map((element) => ({ title: element.getAttribute("title"), text: element.textContent })),
        lists: content.querySelectorAll("ul,ol").length,
        nestedLists: content.querySelectorAll("li ul, li ol").length,
        ids: [...content.querySelectorAll("[id]")].map((element) => element.id),
        fragmentLinks: [...content.querySelectorAll('a[href^="#"]')].map((element) => element.getAttribute("href")),
        scriptTags: content.querySelectorAll("script").length,
        videoTags: content.querySelectorAll("video,audio,iframe,canvas").length,
      };
    });
    put("rendered", { ...rendered, text: undefined, textLength: rendered.text.length });
    const sentinelPresent = rendered.text.includes(FIXTURE_SENTINELS[0]);
    const tailPresent = rendered.text.includes("结尾标记");
    put("sentinel", { sentinelPresent, tailPresent });
    equal(rendered.scriptTags, 0, "reader 内容中没有 <script>");
    equal(rendered.videoTags, 0, "reader 内容中没有活跃媒体元素");
    check(sentinelPresent, "夹具正文文本完整进入 reader");
    check(tailPresent, "夹具正文读到最后一行");
    check(rendered.tableRows >= 3, "表格行保留", rendered.tableRows);
    equal(rendered.tableHeaders, 3, "表头单元格保留");
    equal(rendered.checkboxInputs, 2, "任务列表复选框保留");
    equal(rendered.disabledCheckboxes, 2, "复选框保持 disabled");
    equal(rendered.codeBlocks, 2, "代码块保留");
    check(rendered.codeLines >= 4, "代码行保留", rendered.codeLines);
    equal(rendered.details, 1, "details 保留");
    equal(rendered.summaries, 1, "summary 保留");
    equal(rendered.blockquotes, 1, "引用块保留");
    equal(rendered.images.length, 2, "两张图片都保留");
    equal(rendered.images[0]?.alt, "夹具图片", "Markdown 图片 alt 保留");
    equal(rendered.images[0]?.title, "本地图片标题", "Markdown 图片 title 保留");
    equal(rendered.images[0]?.loading, "lazy", "Markdown 图片强制 lazy");
    check(rendered.images[0]?.src?.endsWith("/wp-content/uploads/2026/05/1778677188-IMG_776.jpg"), "Markdown 图片解析为站点绝对地址", rendered.images[0]?.src);
    equal(rendered.images[1]?.alt, "响应式夹具图片", "srcset 图片 alt 保留");
    equal(rendered.images[1]?.width, "300", "srcset 图片 width 保留");
    check(
      rendered.images[1]?.srcset?.includes("150w") && rendered.images[1]?.srcset?.includes("300w"),
      "srcset 候选与描述符保留",
      rendered.images[1]?.srcset,
    );
    equal(rendered.images[1]?.sizes, "(max-width: 600px) 100vw, 300px", "sizes 保留");
    equal(rendered.abbr.length, 1, "abbr 保留");
    check(rendered.lists >= 4, "列表保留", rendered.lists);
    check(rendered.nestedLists >= 2, "嵌套列表保留", rendered.nestedLists);
    const idSet = new Set(rendered.ids);
    const dangling = rendered.fragmentLinks.filter((href) => !idSet.has(decodeURIComponent(href.slice(1))));
    put("anchors", { ids: rendered.ids.length, fragmentLinks: rendered.fragmentLinks.length, dangling });
    check(rendered.ids.length >= 8, "标题 id 保留为 reader 作用域 id", rendered.ids.length);
    equal(dangling.length, 0, "每个同页锚点都能在 reader 树中解析");
    check(rendered.footnoteItems >= 2, "脚注列表保留", rendered.footnoteItems);
    check(rendered.headings.length >= 7, "所有标题保留", rendered.headings.length);
    check(rendered.text.includes("中文强调后接冒号：注意：这里是重点"), "CJK 强调渲染为 strong 且文本完整");
    check(rendered.text.includes("中文注释与 <标签> 都必须原样保留"), "代码块中的中文与尖括号文本完整");

    // Same-page anchors keep working inside the panel.
    const anchorJump = await page.evaluate(async () => {
      const link = document.querySelector('.reader-content a[href^="#"]');
      if (!link) return null;
      const scroll = document.querySelector(".reader-scroll");
      const before = scroll.scrollTop;
      link.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      return { before, after: scroll.scrollTop, href: link.getAttribute("href"), text: link.textContent };
    });
    put("anchorJump", anchorJump);
    check(anchorJump !== null && anchorJump.after > anchorJump.before, "面板内锚点跳转有效", anchorJump);
    await shot("fixture-anchor");
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // An article outside the allow-list degrades to the independent page
  // -------------------------------------------------------------------------
  await record({ name: "disallowed-element-fallback" }, async (scene) => {
    const { page, check, equal, record: put, shot } = scene;
    const href = await openArticleDetail(page, lab.displayIdFor("wp-19"), "wp-19");
    const fixtureHtml = await readFixtureArticleHtml(FIXTURE_DISALLOWED_PATH);
    const body = retarget(fixtureHtml, { fromPostId: FIXTURE_DISALLOWED_POST_ID, fromPath: FIXTURE_DISALLOWED_PATH, to: { postId: "wp-19", href } });
    const disallowedMatcher = await serveArticle(page, { articlePath: href, body });
    const reader = await openReaderExpect(page, "error");
    put("reader", reader);
    await shot("fallback-error");
    equal(reader.load, "error", "未授权元素使整篇回退为错误面板");
    equal(reader.errorCode, "unsupported", "错误码为 unsupported");
    check(reader.errorVisible, "错误面板可见");
    check(reader.retryVisible, "重试按钮可用");
    equal(reader.contentNodes, 0, "回退时不插入任何正文节点");
    equal(reader.inlineLinkHref, href, "独立文章页链接指向规范地址");
    equal(reader.linkHref, href, "工具栏独立文章页链接指向规范地址");
    // The fallback must still be a working reading experience.
    const closed = await closeReaderByEscape(page);
    equal(closed.open, false, "回退面板可正常收起");
    const context = await page.evaluate(contextSnapshot);
    equal(context.mode, "detail", "回退后仍保留详情上下文");

    // A response without the contract is rejected the same way (no partial DOM).
    await page.unroute(disallowedMatcher);
    const broken = contractBrokenArticle({ postId: "wp-19", href }, "契约缺失");
    const brokenMatcher = await serveArticle(page, { articlePath: href, body: broken });
    const second = await openReaderExpect(page, "error");
    put("contractBroken", second);
    equal(second.load, "error", "缺少契约标记的响应进入错误面板");
    equal(second.errorCode, "contract", "错误码为 contract");
    equal(second.contentNodes, 0, "契约失败时不插入正文节点");
    await closeReaderByEscape(page);
    await page.unroute(brokenMatcher);
    const restored = await openReader(page);
    put("restored", { load: restored.load, textLength: restored.textLength });
    check(restored.load === "ready" && restored.textLength > 50, "撤掉注入后重新读取真实文章成功");
    await closeReaderByEscape(page);
  });

  // -------------------------------------------------------------------------
  // HTTP routes: canonical refresh, real 404, feeds, search entry
  // -------------------------------------------------------------------------
  await record({ name: "routes-and-public-filter", lab: false, screenshot: false }, async (scene) => {
    const { check, equal, record: put, page } = scene;
    const request = async (path) => {
      const response = await page.request.get(`${baseUrl}${path}`, { failOnStatusCode: false });
      return { status: response.status(), text: await response.text(), headers: response.headers() };
    };
    const canonical = [];
    for (const post of published.posts) {
      const result = await request(post.path);
      canonical.push({ path: post.path, status: result.status, contract: /data-reader-version="1"/.test(result.text), postId: /data-post-id="([^"]+)"/.exec(result.text)?.[1] ?? null });
    }
    put("canonical", canonical);
    for (const entry of canonical) {
      equal(entry.status, 200, `规范路径可直接刷新：${entry.path}`);
      check(entry.contract, `规范路径带 reader 契约：${entry.path}`);
    }
    put("publishedPosts", canonical.length);

    const missing = await request("/ir5-this-path-does-not-exist/");
    put("missing", { status: missing.status, isNotFoundPage: /404|not found|页面不存在/i.test(missing.text) });
    equal(missing.status, 404, "未知路径返回真实 404");
    check(!/id="app"|data-action="read-immersive"/.test(missing.text), "404 页面不是 SPA 回落");

    const hiddenResults = [];
    for (const entry of published.hidden) {
      const result = await request(entry.path);
      hiddenResults.push({ path: entry.path, title: entry.title, status: result.status });
    }
    put("hidden", hiddenResults);
    for (const entry of hiddenResults) {
      equal(entry.status, 404, `未公开内容不生成页面：${entry.path}`);
    }

    const rss = await request("/rss.xml");
    const sitemapIndex = await request("/sitemap-index.xml");
    const pagefindEntry = await request("/pagefind/pagefind.js");
    put("feeds", { rss: rss.status, sitemapIndex: sitemapIndex.status, pagefind: pagefindEntry.status, pagefindBytes: Buffer.byteLength(pagefindEntry.text) });
    equal(rss.status, 200, "RSS 可访问");
    equal(sitemapIndex.status, 200, "sitemap-index 可访问");
    equal(pagefindEntry.status, 200, "Pagefind 入口存在");
    for (const entry of published.hidden) {
      check(!rss.text.includes(entry.title), `RSS 未泄露未公开内容：${entry.title}`);
      check(!sitemapIndex.text.includes(entry.path), `sitemap 未包含未公开路径：${entry.path}`);
    }
    for (const post of published.posts) {
      check(rss.text.includes(encodeURI(post.path)) || rss.text.includes(post.path), `RSS 包含公开文章：${post.path}`);
    }

    // One canonical HTML per article, and no per-slot duplication.
    const htmlFiles = (await listFiles(resolve(root, "dist"))).filter((file) => file.endsWith(".html"));
    const articleCopies = new Map();
    for (const post of published.posts) {
      const matches = htmlFiles.filter((file) => file.replaceAll("\\", "/").includes(post.path.replace(/^\/|\/$/g, "")));
      articleCopies.set(post.path, matches.length);
    }
    put("articleCopies", Object.fromEntries(articleCopies));
    for (const [path, count] of articleCopies) equal(count, 1, `每篇文章只有一份规范 HTML：${path}`);
    put("slotCount", lab.records.length);
    check(lab.records.length > published.posts.length, "阵列槽位多于文章数（重复映射真实存在）", lab.records.length);
  });

  // -------------------------------------------------------------------------
  // Reading without JavaScript, and the reader runtime staying out of articles
  // -------------------------------------------------------------------------
  await record({ name: "no-js-and-asset-boundaries", lab: false, javaScriptEnabled: false, screenshot: false }, async (scene) => {
    const { check, equal, record: put, page } = scene;
    const post = published.posts.find((entry) => entry.id === "wp-55") ?? published.posts[0];
    const response = await page.goto(`${baseUrl}${post.path}`, { waitUntil: "domcontentloaded" });
    equal(response.status(), 200, "无 JS 时规范路径仍可访问");
    const body = await page.evaluate(() => document.body.innerText);
    put("noJsText", { length: body.length, head: body.slice(0, 80) });
    check(body.length > 1000, "无 JS 时正文可读", body.length);
    check(body.includes("参考资料"), "无 JS 时读到文末小节");
    const refs = await page.evaluate(() => ({
      scripts: [...document.querySelectorAll("script[src]")].map((element) => element.getAttribute("src")),
      links: [...document.querySelectorAll("link[href]")].map((element) => element.getAttribute("href")),
    }));
    put("refs", refs);
    for (const forbidden of ["/lab/", "article-reader", ".glb", "atmosphere.ogg", "three"]) {
      check(!refs.scripts.some((src) => src.includes(forbidden)), `文章 HTML 未引用 ${forbidden}`);
    }
    for (const sentinel of FIXTURE_SENTINELS) {
      check(!body.includes(sentinel), `文章正文不含夹具哨兵：${sentinel}`);
    }
    // The lab's initial bundle must not carry full article bodies.
    const labChunk = await page.request.get(`${baseUrl}/lab/`);
    const chunkPath = /src="(\/lab\/assets\/index-[^"]+\.js)"/.exec(await labChunk.text())?.[1] ?? null;
    put("labChunk", chunkPath);
    check(chunkPath !== null, "lab 首页引用初始 chunk");
    if (chunkPath) {
      const chunk = await page.request.get(`${baseUrl}${chunkPath}`);
      const code = await chunk.text();
      check(
        !/参考资料/.test(code) && !/依赖升级后的数据库报错排查/.test(code.slice(0, 200_000)),
        "初始 chunk 不含文章正文",
      );
      for (const sentinel of FIXTURE_SENTINELS) check(!code.includes(sentinel), `初始 chunk 不含夹具哨兵：${sentinel}`);
    }
  });

  // -------------------------------------------------------------------------
  // Search index: positive control plus absence of fixtures/hidden content
  // -------------------------------------------------------------------------
  await record({ name: "pagefind-query", lab: false }, async (scene) => {
    const { page, check, equal, record: put } = scene;
    await page.goto(`${baseUrl}/search/`, { waitUntil: "domcontentloaded" });
    const moduleLoaded = await page.evaluate(async () => {
      try {
        const pagefind = await import("/pagefind/pagefind.js");
        window.__ir5Pagefind = pagefind;
        return typeof pagefind.search === "function";
      } catch (error) {
        return String(error);
      }
    });
    put("pagefindModule", moduleLoaded);
    check(moduleLoaded === true, "Pagefind 查询接口可用（浏览器内动态导入）");
    const query = async (term) => {
      const result = await page.evaluate(async (value) => {
        const pagefind = window.__ir5Pagefind;
        const search = await pagefind.search(value);
        const top = await Promise.all(search.results.slice(0, 5).map((entry) => entry.data()));
        return { count: search.results.length, urls: top.map((entry) => entry.url) };
      }, term);
      return result;
    };
    // Pagefind matches loosely (any token, prefixes, numbers), so an absence
    // assertion needs the phrase form: `"token"` is matched exactly. Both the
    // loose and the phrase paths are proven present by the positive controls,
    // otherwise "no results" would be indistinguishable from a broken query.
    const positive = await query(pagefind.positive);
    const positivePhrase = await query(`"${pagefind.positive}"`);
    put("positive", positive);
    put("positivePhrase", positivePhrase);
    check(positive.count > 0, `Pagefind 能检索到公开文章（${pagefind.positive}）`, positive);
    check(positivePhrase.count > 0, `Pagefind 短语检索可用（"${pagefind.positive}"）`, positivePhrase);
    const wp55 = published.posts.find((entry) => entry.id === "wp-55");
    check(
      !wp55 || positive.urls.some((url) => decodeURIComponent(url).includes(decodeURIComponent(wp55.path))),
      "检索结果指向规范文章地址",
      positive.urls,
    );
    for (const term of pagefind.negative) {
      const result = await query(`"${term}"`);
      put(`negative:${term}`, result);
      equal(result.count, 0, `Pagefind 检不到合成标记：${term}`);
    }
    for (const entry of published.hidden) {
      const byId = await query(`"${entry.id}"`);
      const byTitle = await query(`"${entry.title.slice(0, 10)}"`);
      put(`hidden:${entry.id}`, { byId, byTitle });
      equal(byId.count, 0, `Pagefind 检不到未公开内容 id：${entry.id}`);
      equal(byTitle.count, 0, `Pagefind 检不到未公开内容标题：${entry.id}`);
    }
  });

  // -------------------------------------------------------------------------
  // Fixtures must not exist anywhere in the release
  // -------------------------------------------------------------------------
  await record({ name: "no-fixture-in-release", lab: false, screenshot: false }, async (scene) => {
    const { check, equal, record: put, page } = scene;
    const files = await listFiles(resolve(root, "dist"));
    const hits = [];
    for (const file of files) {
      if (!/\.(html|js|mjs|json|css|xml|txt|svg)$/.test(file)) continue;
      const text = await readFile(file, "utf8");
      for (const sentinel of FIXTURE_SENTINELS) {
        if (text.includes(sentinel)) hits.push({ file: file.replace(root, "."), sentinel });
      }
    }
    put("scannedFiles", files.length);
    put("sentinelHits", hits);
    equal(hits.length, 0, "发布产物中没有夹具哨兵");
    const fixturePaths = [FIXTURE_POST_PATH, FIXTURE_DISALLOWED_PATH, "/2026/09/08/ir5-fixture-draft/", "/2099/01/01/ir5-fixture-future/", "/ir5-fixture-about/"];
    for (const path of fixturePaths) {
      const response = await page.request.get(`${baseUrl}${path}`, { failOnStatusCode: false });
      equal(response.status(), 404, `发布站点没有夹具路由：${path}`);
    }
    const ids = [FIXTURE_POST_ID, FIXTURE_DISALLOWED_POST_ID];
    const labHome = await (await page.request.get(`${baseUrl}/lab/`, { failOnStatusCode: false })).text();
    for (const id of ids) {
      check(!labHome.includes(id), `lab 首页不含夹具 postId：${id}`);
    }
    const labContent = await readFile(resolve(root, ".generated/lab-content.json"), "utf8");
    for (const id of ids) check(!labContent.includes(id), `lab 摘要不含夹具 postId：${id}`);
    const distInfo = await stat(resolve(root, "dist"));
    put("dist", { files: files.length, isDirectory: distInfo.isDirectory() });
  });
}
