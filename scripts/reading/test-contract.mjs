/**
 * IR2 unit gate: srcset parsing, URL/canonical policy, AST allow rules,
 * id/fragment mapping, fingerprinting and DOM-creation safety.
 *
 * Every case uses a fixed input and asserts an independent expectation; no test
 * derives its expectation from the code under test. The DOM stub records the
 * exact call sequence so "no DOM node for rejected content" is checkable and
 * not merely asserted in prose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSrcset, rewriteSrcset, serializeSrcset, encodeSrcsetUrl } from "../../shared/reading/srcset.ts";
import {
  canonicalSegments,
  checkArticleUrl,
  decodeFragment,
  encodeFragment,
  isSafeContentUrl,
  resolveContentUrl,
  sameCanonicalPath,
} from "../../shared/reading/url-policy.ts";
import {
  countProjectionNodes,
  fingerprintContentAsync,
  fingerprintPayload,
  normalizeContentTree,
  projectionText,
  readArticleContract,
  serializeProjection,
} from "../../shared/reading/contract.ts";
import { fingerprintContentNode } from "../../shared/reading/fingerprint-node.ts";
import { convertArticleHtml, isAllowedElementName } from "../../shared/reading/content.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const logDir = resolve(root, ".tools/immerse-reading/IR2/logs");

// ---------------------------------------------------------------------------
// Recording DOM stub: the converter may only create allow-listed elements.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} StubNode
 * @property {1|3} nodeType
 * @property {string} [tagName]
 * @property {string} [data]
 * @property {Map<string, string>} attributes
 * @property {StubNode[]} children
 * @property {StubNode|null} parentNode
 */

/** @type {(record: { created: string[], textNodes: number }) => { document: { createElement(tagName: string): HTMLElement, createTextNode(data: string): Text }, makeNode: (nodeType: 1|3, tagName?: string, data?: string) => StubNode }} */
function createStubDocument(record) {
  const makeNode = (nodeType, tagName, data) => {
    const node = {
      nodeType,
      ...(tagName ? { tagName } : {}),
      ...(data !== undefined ? { data } : {}),
      attributes: new Map(),
      children: [],
      parentNode: null,
      appendChild(child) {
        child.parentNode = node;
        node.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        node.attributes.set(name, value);
      },
      getAttribute(name) {
        return node.attributes.get(name) ?? null;
      },
      removeAttribute(name) {
        node.attributes.delete(name);
      },
    };
    if (nodeType === 1) record.created.push(tagName);
    return node;
  };
  return {
    document: {
      createElement(tagName) {
        return makeNode(1, tagName);
      },
      createTextNode(data) {
        record.textNodes += 1;
        return makeNode(3, undefined, data);
      },
    },
    makeNode,
  };
}

function innerText(node) {
  if (node.nodeType === 3) return node.data ?? "";
  return node.children.map(innerText).join("");
}

function findTag(content, tagName) {
  if (!content) return [];
  const found = [];
  if (tagName === undefined || content.tagName === tagName) found.push(content);
  for (const child of content.children) found.push(...findTag(child, tagName));
  return found;
}

function findByClass(root, className) {
  return findTag(root, undefined).filter((candidate) => (candidate.attributes.get("class") ?? "").split(/\s+/).includes(className));
}

/** First direct child of the converted `.prose` wrapper (the fixture itself). */
function firstFixtureChild(content) {
  return content.children.find((child) => child.nodeType === 1);
}

const voidStub = /** @type {never} */ (undefined);
void voidStub;

async function convert(content, options = {}) {
  const record = options.record ?? { created: [], textNodes: 0 };
  const stub = createStubDocument(record);
  const href = options.href ?? "/2026/06/01/sample-essay/";
  const postId = options.postId ?? "wp-38";
  const responseUrl = options.responseUrl ?? `https://example.test${href}`;
  const html = options.raw ? content : article(content, `data-post-id="${postId}" data-canonical-path="${href}"`);
  const result = await convertArticleHtml(html, {
    target: { postId, href, title: "标题" },
    responseUrl,
    document: options.document ?? stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(result.activate, true, `conversion failed: ${result.activate ? "" : JSON.stringify(result.diagnostics)}`);
  if (!result.activate) throw new Error("unreachable");
  // `prose` is the converted `.prose` subtree: exactly the fixture content.
  const prose = findByClass(result.node, "prose")[0];
  assert.ok(prose, "converted tree must contain the .prose container");
  return { node: result.node, content: prose, created: record.created, result };
}

function article(contentHtml, attrs = 'data-post-id="wp-38" data-canonical-path="/2026/06/01/sample-essay/"') {
  return `<!doctype html><html><head><title>t</title></head><body><main><article data-pagefind-body data-reader-version="1" data-reader-kind="post" ${attrs}><div data-reader-content><h1 class="page-title">标题</h1><div class="prose">${contentHtml}</div></div></article></main></body></html>`;
}

// ---------------------------------------------------------------------------
// 1. srcset (WHATWG candidate parsing)
// ---------------------------------------------------------------------------

test("srcset: w/x descriptors, mixed order and reassembly", () => {
  const parsed = parseSrcset("a.png 1x, b.png 2x, c.png 320w, d.png 640w");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    parsed.candidates.map((candidate) => [candidate.url, candidate.descriptor?.kind, candidate.descriptor?.value]),
    [
      ["a.png", "density", 1],
      ["b.png", "density", 2],
      ["c.png", "width", 320],
      ["d.png", "width", 640],
    ],
  );
  assert.equal(serializeSrcset(parsed.candidates), "a.png 1x, b.png 2x, c.png 320w, d.png 640w");
});

test("srcset: a comma inside a URL splits the candidate (spec behaviour)", () => {
  const parsed = parseSrcset("a,b.png 1x");
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.url), ["a"]);
  assert.equal(parsed.errors.length, 1);
});

test("srcset: whitespace forms, empty candidates and a trailing comma", () => {
  const parsed = parseSrcset("  a.png\t1x ,\n b.png   640w ,");
  assert.deepEqual(parsed.candidates.map((candidate) => [candidate.url, candidate.descriptorRaw]), [
    ["a.png", "1x"],
    ["b.png", "640w"],
  ]);
  assert.deepEqual(parseSrcset("  ,  , ").candidates, []);
  assert.deepEqual(parseSrcset("").candidates, []);
});

test("srcset: invalid and duplicate descriptors are reported", () => {
  assert.equal(parseSrcset("a.png 0w").errors.length, 1);
  assert.equal(parseSrcset("a.png 0x").errors.length, 1);
  assert.equal(parseSrcset("a.png 100").errors.length, 1);
  assert.equal(parseSrcset("a.png 2x, b.png 2x").errors.length, 1);
  assert.equal(parseSrcset("a.png 1x 2x").errors.length, 1);
  assert.deepEqual(parseSrcset("a.png 1.5x").errors, []);
});

test("srcset: rewriting preserves descriptors and serialises deterministically", () => {
  const rewritten = rewriteSrcset("a.png 1x, b.png 2x, https://cdn.test/d.png 320w", (url) => ({ url: `https://example.test/x/${url}` }));
  assert.deepEqual(rewritten.dropped, []);
  assert.equal(rewritten.value, "https://example.test/x/a.png 1x, https://example.test/x/b.png 2x, https://example.test/x/https://cdn.test/d.png 320w");
  assert.deepEqual(parseSrcset(rewritten.value ?? "").candidates.map((candidate) => candidate.url), [
    "https://example.test/x/a.png",
    "https://example.test/x/b.png",
    "https://example.test/x/https://cdn.test/d.png",
  ]);
});

test("srcset: encodeSrcsetUrl keeps a rewritten URL parseable in place", () => {
  // A comma inside a URL would split the candidate on the next parse, so the
  // serialiser escapes it; the escaped form parses back to the same URL.
  const rewritten = rewriteSrcset("a.png 1x", () => ({ url: "https://example.test/x/b,c.png" }));
  assert.equal(rewritten.value, "https://example.test/x/b%2Cc.png 1x");
  assert.deepEqual(parseSrcset(rewritten.value ?? "").candidates, [
    { url: "https://example.test/x/b%2Cc.png", descriptor: { kind: "density", value: 1, raw: "1x" }, descriptorRaw: "1x" },
  ]);
});

test("srcset: rejected candidates are dropped and reported; empty result removes the attribute", () => {
  const rewritten = rewriteSrcset("javascript:alert(1) 1x, ok.png 2x", (url) => (url.startsWith("javascript:") ? { error: "unsafe" } : { url: `https://example.test/${url}` }));
  assert.deepEqual(rewritten.dropped, [{ url: "javascript:alert(1)", reason: "unsafe" }]);
  assert.equal(rewritten.value, "https://example.test/ok.png 2x");
  assert.equal(rewriteSrcset("javascript:alert(1) 1x", () => ({ error: "unsafe" })).value, null);
});

test("srcset: URL encoding escapes whitespace, commas and parentheses", () => {
  assert.equal(encodeSrcsetUrl("a b.png"), "a%20b.png");
  assert.equal(encodeSrcsetUrl("a,b.png"), "a%2Cb.png");
  assert.equal(encodeSrcsetUrl("a(b).png"), "a%28b%29.png");
  assert.equal(encodeSrcsetUrl("中文.png"), "中文.png");
});

// ---------------------------------------------------------------------------
// 2. URL and canonical path policy
// ---------------------------------------------------------------------------

test("canonical: only a trailing slash is normalised", () => {
  assert.equal(sameCanonicalPath("/a/b/", "/a/b"), true);
  assert.equal(sameCanonicalPath("/a/b", "/a/b/"), true);
  assert.equal(sameCanonicalPath("/a/b/", "/a/B/"), false);
  assert.equal(sameCanonicalPath("/学习/", "/学习"), true);
  assert.equal(sameCanonicalPath("/学习/", "/%E5%AD%A6%E4%B9%A0/"), true);
  assert.equal(sameCanonicalPath("/a/b/", "/a/b/c/"), false);
});

test("canonical: encoded separators, dot segments and bad escapes are rejected", () => {
  assert.deepEqual(canonicalSegments("/%2Fetc/"), { problem: "encoded-separator" });
  assert.deepEqual(canonicalSegments("/a/%5Cb/"), { problem: "encoded-separator" });
  assert.deepEqual(canonicalSegments("/a/../b/"), { problem: "dot-segment" });
  assert.deepEqual(canonicalSegments("/a/%2e%2e/"), { problem: "dot-segment" });
  assert.deepEqual(canonicalSegments("/a/%zz/"), { problem: "invalid-encoding" });
  assert.equal(sameCanonicalPath("/a/%2F/", "/a/%2F/"), false);
});

test("article URL: same-origin, no credentials, query or fragment", () => {
  const origin = "https://example.test";
  assert.equal(checkArticleUrl("/a/b/", origin).ok, true);
  assert.deepEqual(checkArticleUrl("https://other.test/a/", origin), { ok: false, problem: "cross-origin" });
  assert.deepEqual(checkArticleUrl("/a/?x=1", origin), { ok: false, problem: "query" });
  assert.deepEqual(checkArticleUrl("/a/#f", origin), { ok: false, problem: "fragment" });
  assert.deepEqual(checkArticleUrl("https://u:p@example.test/a/", origin), { ok: false, problem: "credentials" });
  assert.deepEqual(checkArticleUrl("/a/%2F/", origin), { ok: false, problem: "encoded-separator" });
  assert.equal(checkArticleUrl("/a/b/", origin).ok && checkArticleUrl("/a/b/", origin).url, "https://example.test/a/b/");
});

test("content URLs: scheme allowlist keeps http/https/mailto/tel, rejects the rest", () => {
  assert.equal(isSafeContentUrl("/relative/x.png"), true);
  assert.equal(isSafeContentUrl("https://cdn.test/x.png"), true);
  assert.equal(isSafeContentUrl("mailto:a@b.test"), true);
  assert.equal(isSafeContentUrl("tel:+8610000000000"), true);
  assert.equal(isSafeContentUrl("javascript:alert(1)"), false);
  assert.equal(isSafeContentUrl("JavaScript:alert(1)"), false);
  assert.equal(isSafeContentUrl("data:text/html;base64,AAAA"), false);
  assert.equal(isSafeContentUrl("blob:https://x/y"), false);
  assert.equal(isSafeContentUrl("vbscript:msgbox"), false);
  assert.equal(isSafeContentUrl("//evil.test/x.png"), false);
  assert.equal(isSafeContentUrl(" /x.png"), false);
  assert.equal(isSafeContentUrl(""), false);
});

test("content URLs: relative paths resolve against the article response URL", () => {
  const base = "https://example.test/2026/06/01/sample-essay/";
  // 示例文章路径是纯 ASCII，因此 base 与解析结果一致。
  const encoded = base;
  assert.deepEqual(resolveContentUrl("img/a.png", base), { url: `${encoded}img/a.png` });
  assert.deepEqual(resolveContentUrl("/wp-content/uploads/2026/01/a.png", base), { url: "https://example.test/wp-content/uploads/2026/01/a.png" });
  assert.deepEqual(resolveContentUrl("/lab/a.png", base), { url: "https://example.test/lab/a.png" });
  assert.deepEqual(resolveContentUrl("javascript:alert(1)", base), { problem: "unsafe-scheme" });
  assert.deepEqual(resolveContentUrl("data:image/png;base64,AA", base), { problem: "unsafe-scheme" });
  assert.deepEqual(resolveContentUrl("//evil.test/a.png", base), { problem: "protocol-relative" });
  assert.deepEqual(resolveContentUrl("", base), { problem: "empty" });
});

test("fragments: decoded once, re-encoded for attributes", () => {
  assert.deepEqual(decodeFragment("#%E5%AD%A6%E4%B9%A0"), { value: "学习" });
  assert.deepEqual(decodeFragment("#学习"), { value: "学习" });
  assert.deepEqual(decodeFragment("#a%2Fb"), { value: "a/b" });
  assert.deepEqual(decodeFragment("#%zz"), { problem: "invalid-encoding" });
  assert.equal(encodeFragment("学习"), "%E5%AD%A6%E4%B9%A0");
  assert.equal(encodeFragment("a b"), "a%20b");
  assert.equal(encodeFragment("4.1-使用前提"), "4.1-%E4%BD%BF%E7%94%A8%E5%89%8D%E6%8F%90");
});

// ---------------------------------------------------------------------------
// 3. AST allow rules and DOM-creation safety
// ---------------------------------------------------------------------------

test("convert: a plain article produces only allow-listed elements", async () => {
  const { content, created, result } = await convert("<h2>小标题</h2><p>正文 <strong>加粗</strong></p><ul><li>一</li></ul>");
  assert.deepEqual(created, ["div", "h1", "div", "h2", "p", "strong", "ul", "li"]);
  assert.equal(innerText(findTag(content, "h2")[0]), "小标题");
  assert.equal(result.diagnostics.filter((d) => d.kind === "active-element" || d.kind === "unknown-element").length, 0);
});

test("convert: <script> inside prose is never executed and never created", async () => {
  const record = { created: [], textNodes: 0 };
  const stub = createStubDocument(record);
  const outcome = await convertArticleHtml(article('<p>ok</p><script>window.pwned=1</script>'), {
    target: { postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "t" },
    responseUrl: "https://example.test/2026/06/01/sample-essay/",
    document: stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(outcome.activate, false);
  if (outcome.activate) throw new Error("unreachable");
  assert.equal(outcome.code, "unsupported");
  assert.equal(record.created.includes("script"), false);
  assert.equal(globalThis.pwned, undefined, "the fixture must never execute in Node either");
});

test("convert: an escaped <script> example stays visible code text", async () => {
  const { content, created } = await convert("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>");
  assert.deepEqual(created, ["div", "h1", "div", "pre", "code"]);
  assert.equal(innerText(findTag(content, "code")[0]), "<script>alert(1)</script>");
});

test("convert: active elements (iframe/video/form/svg/custom element) reject the whole response", async () => {
  for (const hostile of ["<iframe src=\"https://evil.test/x\"></iframe>", "<video src=\"/a.mp4\"></video>", "<form action=\"/x\"><input name=\"q\"></form>", "<svg><circle r=\"1\"></circle></svg>", "<my-widget></my-widget>", "<canvas></canvas>"]) {
    const record = { created: [], textNodes: 0 };
    const stub = createStubDocument(record);
    const outcome = await convertArticleHtml(article(`<p>before</p>${hostile}`), {
      target: { postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "t" },
      responseUrl: "https://example.test/2026/06/01/sample-essay/",
      document: stub.document,
      allowWithoutFingerprint: true,
    });
    assert.equal(outcome.activate, false, `expected rejection for ${hostile}`);
    if (outcome.activate) throw new Error("unreachable");
    assert.equal(outcome.code, "unsupported");
    assert.equal(record.created.some((tag) => !isAllowedElementName(tag)), false);
  }
});

test("convert: event handlers and dangerous protocols are dropped, not created", async () => {
  const { content, result } = await convert(
    '<p><a href="javascript:alert(1)" onclick="alert(2)">坏链接</a></p>' +
      '<p><img src="data:image/png;base64,AAAA" onerror="alert(3)" alt="坏图"></p>' +
      '<p><a href="https://ok.test/x" onmouseover="alert(4)">好链接</a></p>',
  );
  const anchors = findTag(content, "a");
  assert.deepEqual(anchors.map((anchor) => anchor.getAttribute("href")), ["https://ok.test/x"]);
  const images = findTag(content, "img");
  assert.deepEqual(images.map((image) => image.getAttribute("src")), [null]);
  assert.equal(images[0].getAttribute("alt"), "坏图");
  const attributeNames = [...anchors[0].attributes.keys(), ...images[0].attributes.keys()];
  assert.equal(attributeNames.some((name) => name.startsWith("on")), false);
  assert.equal(result.diagnostics.some((d) => d.kind === "bad-url"), true);
  // The rejected link degrades to a span so no active handler survives.
  assert.equal(findTag(content, "span").length >= 1, true);
  assert.equal(innerText(content).includes("坏链接"), true, "link text survives as plain text");
});

test("convert: application data-* attributes never reach the reader DOM", async () => {
  const { content, result } = await convert(
    '<p data-action="select" data-pref="tab" data-tab="notes" data-select="1" data-result="x">正文</p>' +
      '<pre data-language="plaintext" data-line-numbers="1"><code>echo hi</code></pre>',
  );
  const paragraph = findTag(content, "p")[0];
  assert.equal([...paragraph.attributes.keys()].filter((name) => name.startsWith("data-")).length, 0);
  const pre = findTag(content, "pre")[0];
  assert.equal(pre.getAttribute("data-language"), "plaintext");
  assert.equal(pre.getAttribute("data-line-numbers"), null);
  assert.equal(result.diagnostics.filter((d) => d.kind === "dropped-data-attribute").length, 6);
});

test("convert: inline styles keep only allow-listed declarations", async () => {
  const { content, result } = await convert(
    '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8; overflow-x: auto; position:fixed; background-image:url(https://evil.test/x.png)" tabindex="0"><code>ls</code></pre>',
  );
  const pre = findTag(content, "pre")[0];
  assert.equal(pre.getAttribute("style"), "background-color: #24292e; color: #e1e4e8; overflow-x: auto");
  assert.equal(pre.getAttribute("class"), "astro-code github-dark");
  assert.equal(pre.getAttribute("tabindex"), "0");
  assert.equal(result.diagnostics.filter((d) => d.kind === "dropped-style").length, 2);
});

test("convert: style values with var()/url()/expression are rejected", async () => {
  const { content } = await convert(
    '<span style="color:var(--x); background-color:url(/x.png); font-weight:expression(alert(1)); text-decoration:underline">x</span>',
  );
  const span = findTag(content, "span")[0];
  assert.equal(span.getAttribute("style"), "text-decoration: underline");
});

test("convert: ids are remapped and fragment/ARIA references follow", async () => {
  const { content, result } = await convert(
    '<h2 id="参考资料">参考资料</h2><p><a href="#参考资料">跳转</a></p>' +
      '<nav><a href="#不存在">坏锚点</a></nav>' +
      '<p id="fn1">脚注</p><p><a href="#fn1" role="doc-noteref" aria-describedby="fn1 extra">引用</a></p>' +
      '<p><a href="https://example.test/x#other">外链</a></p>',
    { responseUrl: "https://example.test/2026/06/01/sample-essay/" },
  );
  const heading = findTag(content, "h2")[0];
  const headingId = heading.getAttribute("id");
  assert.equal(headingId, "reader-1-1");
  // A dangling anchor loses only its href; its text stays and its target is
  // reported. The other two links keep working reader-internal targets.
  const anchors = findTag(content, "a");
  assert.deepEqual(anchors.map((anchor) => anchor.getAttribute("href")), ["#reader-1-1", "#reader-1-2", "https://example.test/x#other"]);
  assert.equal(result.diagnostics.some((d) => d.kind === "dangling-reference"), true);
  assert.equal(result.diagnostics.some((d) => d.kind === "bad-url"), true);
  const note = findTag(content, "p").find((paragraph) => paragraph.getAttribute("id") === "reader-1-2");
  assert.ok(note, "second id maps to reader-1-2");
  const noterefAnchor = findTag(content, "a").find((anchor) => anchor.getAttribute("role") === "doc-noteref");
  assert.ok(noterefAnchor, "the footnote reference link survives as a link");
  assert.equal(noterefAnchor.getAttribute("href"), `#${note.getAttribute("id")}`);
  assert.equal(noterefAnchor.getAttribute("aria-describedby"), note.getAttribute("id"));
  assert.equal(innerText(content).includes("坏锚点"), true, "dangling anchor text survives");
  assert.equal(findTag(findTag(content, "nav")[0], "a").length, 0, "the dangling anchor is no longer a link");
});

test("convert: duplicate ids reject the response instead of producing two equal ids", async () => {
  const record = { created: [], textNodes: 0 };
  const stub = createStubDocument(record);
  const outcome = await convertArticleHtml(article('<h2 id="dup">A</h2><h2 id="dup">B</h2><p><a href="#dup">go</a></p>'), {
    target: { postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "t" },
    responseUrl: "https://example.test/2026/06/01/sample-essay/",
    document: stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(outcome.activate, false);
  if (outcome.activate) throw new Error("unreachable");
  assert.equal(outcome.code, "contract");
  assert.equal(outcome.diagnostics.filter((d) => d.kind === "duplicate-id").length, 1);
  assert.equal(record.created.length, 0, "no DOM node for a rejected id map");
});

test("convert: external links keep absolute URLs, _blank gets noopener", async () => {
  const { content } = await convert('<a href="/wp-content/uploads/a b.png">图</a><a href="https://x.test/y" target="_blank">外</a><a href="mailto:a@b.test">邮</a>');
  const anchors = findTag(content, "a");
  assert.equal(anchors[0].getAttribute("href"), "https://example.test/wp-content/uploads/a%20b.png");
  assert.equal(anchors[1].getAttribute("rel"), "noopener noreferrer");
  assert.equal(anchors[2].getAttribute("href"), "mailto:a@b.test");
});

test("convert: images and srcset resolve against the article URL", async () => {
  const { content, result } = await convert(
    '<img src="/wp-content/uploads/2026/01/a.png" srcset="/wp-content/uploads/2026/01/a.png 320w, /wp-content/uploads/2026/01/b.png 640w" sizes="(max-width: 600px) 100vw, 640px" alt="示例" width="640" height="360" loading="eager">' +
      '<picture><source media="(min-width: 600px)" srcset="/wp-content/uploads/2026/01/c.png 1x, /wp-content/uploads/2026/01/d.png 2x" type="image/png"><img src="/wp-content/uploads/2026/01/c.png" alt="p"></picture>' +
      '<img src="/wp-content/uploads/2026/01/e.png" srcset="javascript:alert(1) 1x, /wp-content/uploads/2026/01/f.png 2x" alt="s">',
  );
  assert.deepEqual(result.diagnostics.filter((d) => d.kind === "bad-url").length >= 1, true);
  const images = findTag(content, "img");
  assert.equal(images[0].getAttribute("src"), "https://example.test/wp-content/uploads/2026/01/a.png");
  assert.equal(images[0].getAttribute("srcset"), "https://example.test/wp-content/uploads/2026/01/a.png 320w, https://example.test/wp-content/uploads/2026/01/b.png 640w");
  assert.equal(images[0].getAttribute("sizes"), "(max-width: 600px) 100vw, 640px");
  assert.equal(images[0].getAttribute("loading"), "lazy", "reader forces lazy loading");
  assert.equal(images[0].getAttribute("width"), "640");
  assert.equal(images[2].getAttribute("srcset"), "https://example.test/wp-content/uploads/2026/01/f.png 2x");
  const source = findTag(content, "source")[0];
  assert.equal(source.getAttribute("media"), "(min-width: 600px)");
  assert.equal(source.getAttribute("srcset"), "https://example.test/wp-content/uploads/2026/01/c.png 1x, https://example.test/wp-content/uploads/2026/01/d.png 2x");
});

test("convert: an allowed img alt is applied and never reported as unhandled", async () => {
  // Regression (found by the IR5 fixture article, the first input with images):
  // `alt` was correctly set on the reader `img` but also fell through to the
  // generic "unhandled attribute" diagnostic, which contradicted the DOM.
  const { content, result } = await convert('<img src="/icons/a.png" alt="夹具图片" title="夹具标题">');
  assert.equal(findTag(content, "img")[0].getAttribute("alt"), "夹具图片");
  assert.equal(findTag(content, "img")[0].getAttribute("title"), "夹具标题");
  assert.deepEqual(result.diagnostics.filter((d) => /alt/.test(d.message)), []);
});

test("convert: tables, lists, details and task checkboxes keep semantics", async () => {
  const { content } = await convert(
    '<table><caption>表</caption><thead><tr><th scope="col" colspan="2">头</th></tr></thead><tbody><tr><td rowspan="2">a</td><td>b</td></tr></tbody></table>' +
      '<ol start="3" reversed><li value="7">项</li></ol>' +
      '<details open><summary>摘要</summary><p>隐藏文本</p></details>' +
      '<ul><li><input type="checkbox" checked disabled>完成</li></ul>' +
      '<ul><li><input type="text" name="q"></li></ul>',
  );
  assert.equal(findTag(content, "th")[0].getAttribute("scope"), "col");
  assert.equal(findTag(content, "th")[0].getAttribute("colspan"), "2");
  assert.equal(findTag(content, "td")[0].getAttribute("rowspan"), "2");
  const list = findTag(content, "ol")[0];
  assert.equal(list.getAttribute("start"), "3");
  assert.equal(list.getAttribute("reversed"), "");
  assert.equal(findTag(content, "li")[0].getAttribute("value"), "7");
  assert.equal(findTag(content, "details")[0].getAttribute("open"), "");
  const checkbox = findTag(content, "input")[0];
  assert.equal(checkbox.getAttribute("type"), "checkbox");
  assert.equal(checkbox.getAttribute("checked"), "");
  assert.equal(checkbox.getAttribute("disabled"), "");
  assert.equal(findTag(content, "input").length, 1, "a text input is never created");
});

test("convert: disallowed classes are dropped with a diagnostic", async () => {
  const { content, result } = await convert('<div class="toc-sub unknown-thing">x</div>');
  assert.equal(findByClass(content, "toc-sub").length, 1);
  assert.equal(findByClass(content, "unknown-thing").length, 0);
  assert.equal(result.diagnostics.filter((d) => d.kind === "dropped-class").length, 1);
});

test("convert: wrong postId or canonical path is a contract failure and creates no DOM", async () => {
  const record = { created: [], textNodes: 0 };
  const stub = createStubDocument(record);
  const wrongId = await convertArticleHtml(article("<p>x</p>"), {
    target: { postId: "wp-19", href: "/2026/06/01/sample-essay/", title: "t" },
    responseUrl: "https://example.test/2026/06/01/sample-essay/",
    document: stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(wrongId.activate, false);
  if (wrongId.activate) throw new Error("unreachable");
  assert.equal(wrongId.code, "contract");

  const wrongPath = await convertArticleHtml(article("<p>x</p>"), {
    target: { postId: "wp-38", href: "/2026/06/01/别的文章/", title: "t" },
    responseUrl: "https://example.test/2026/06/01/sample-essay/",
    document: stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(wrongPath.activate, false);
  assert.equal(record.created.length, 0, "no DOM node may exist for a rejected contract");
});

test("convert: a login page or duplicate container never activates", async () => {
  const record = { created: [], textNodes: 0 };
  const stub = createStubDocument(record);
  const login = await convertArticleHtml("<!doctype html><html><body><form action=\"/session\"><input name=\"password\"></form></body></html>", {
    target: { postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "t" },
    responseUrl: "https://example.test/2026/06/01/sample-essay/",
    document: stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(login.activate, false);
  const duplicate = article(`<p>x</p></div><div data-reader-content><p>y</p>`);
  const doubled = await convertArticleHtml(duplicate, {
    target: { postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "t" },
    responseUrl: "https://example.test/2026/06/01/sample-essay/",
    document: stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(doubled.activate, false);
  assert.equal(record.created.length, 0);
});

test("convert: depth over 128 levels is rejected", async () => {
  const deep = "<div>".repeat(130) + "x" + "</div>".repeat(130);
  const record = { created: [], textNodes: 0 };
  const stub = createStubDocument(record);
  const outcome = await convertArticleHtml(article(deep), {
    target: { postId: "wp-38", href: "/2026/06/01/sample-essay/", title: "t" },
    responseUrl: "https://example.test/2026/06/01/sample-essay/",
    document: stub.document,
    allowWithoutFingerprint: true,
  });
  assert.equal(outcome.activate, false);
  assert.equal(record.created.length, 0);
});

test("convert: heading ids from the Astro contract are preserved as reader ids", async () => {
  const { content } = await convert('<h2 id="一问题为什么会出现">一</h2><nav class="toc"><a href="#一问题为什么会出现">目录</a></nav>');
  const headingId = findTag(content, "h2")[0].getAttribute("id");
  assert.match(headingId ?? "", /^reader-1-\d+$/);
  assert.equal(findTag(content, "a")[0].getAttribute("href"), `#${headingId}`);
});

// ---------------------------------------------------------------------------
// 4. Projection and content fingerprint
// ---------------------------------------------------------------------------

test("projection: node path, text order and image alt are comparable", async () => {
  const { content, result } = await convert('<h2>B</h2><p>text <em>em</em></p><img src="/a.png" alt="图">');
  // Fixture subtree only: the contract chrome (h1/meta/toc) is not part of it.
  assert.equal(countProjectionNodes(normalizeContentTree(contractContent(article('<h2>B</h2><p>text <em>em</em></p><img src="/a.png" alt="图">')))), 12);
  assert.equal(countProjectionNodes(result.projection), 12);
  assert.equal(projectionText(result.projection).replace(/\s+/g, " ").trim(), "标题Btextem图");
  const serialized = serializeProjection(result.projection);
  assert.equal(serialized.split("\n")[0], "div");
  assert.equal(serialized.split("\n")[1], "  h1");
  assert.match(serialized, /^ {4}text "标题"$/m);
  assert.equal(findTag(content, "h2").length, 1);
});

function contractContent(html) {
  const parsed = readArticleContract(html);
  assert.equal(parsed.ok, true, "fixture must satisfy the reader v1 contract");
  return parsed.contract.content;
}

test("fingerprint: Node crypto and Web Crypto agree, and content changes the digest", async () => {
  const projection = normalizeContentTree(contractContent(article("<h2>标题</h2><p>正文</p>")));
  const input = { canonicalPath: "/a/b/", postId: "wp-1", projection };
  const nodeDigest = await fingerprintContentNode(input);
  const webDigest = await fingerprintContentAsync(input);
  assert.match(nodeDigest, /^[0-9a-f]{64}$/);
  if (webDigest === null) {
    assert.equal(typeof globalThis.crypto?.subtle, "undefined");
  } else {
    assert.equal(webDigest, nodeDigest, "Web Crypto and Node crypto must agree");
  }
  assert.equal(nodeDigest, createHash("sha256").update(fingerprintPayload(input)).digest("hex"));
  const other = await fingerprintContentNode({ ...input, projection: [...projection, { tag: "p", children: [{ tag: "#text", text: "extra" }] }] });
  assert.notEqual(other, nodeDigest);
  const otherPath = await fingerprintContentNode({ ...input, canonicalPath: "/a/c/" });
  assert.notEqual(otherPath, nodeDigest);
  const otherId = await fingerprintContentNode({ ...input, postId: "wp-2" });
  assert.notEqual(otherId, nodeDigest);
});

test("fingerprint: payload is stable across instances and line endings", () => {
  const projection = normalizeContentTree(contractContent(article("<p>a\r\nb</p>")));
  const payload = fingerprintPayload({ canonicalPath: "/a/", postId: "wp-1", projection });
  assert.equal(payload.split("\n")[0], "reader-v1");
  assert.equal(payload.includes("\r"), false);
});

// ---------------------------------------------------------------------------
// 5. Real article evidence (independent expectations locked at IR2)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LockedExpectation
 * @property {string} postId
 * @property {string} canonicalPath
 * @property {Record<string, number>} elements
 * @property {number} textNodes
 * @property {number} proseChars
 * @property {number} contentChars
 * @property {string} contentTextSha256
 * @property {number} projectionNodes
 * @property {string} projectionSha256
 * @property {number} images
 * @property {number} links
 * @property {string[]} codeBlocks
 * @property {{tag: string, text: string, id: string}[]} headings
 * @property {string} firstParagraphText
 * @property {string} lastHeadingText
 * @property {string} referenceTailText
 */

/** All `id` attribute values in a converted stub tree. */
function collectIds_(node, out = []) {
  if (node.nodeType === 1) {
    const id = node.getAttribute("id");
    if (id) out.push(id);
  }
  for (const child of node.children) collectIds_(child, out);
  return out;
}

test("real articles: conversion preserves the locked projection of all 4 posts", async (t) => {
  const lockFile = resolve(logDir, "content-expectations.json");
  /** @type {{ posts: LockedExpectation[] }} */
  let locked;
  try {
    locked = JSON.parse(await readFile(lockFile, "utf8"));
  } catch {
    t.skip(`锁定期望缺失：${lockFile}（先运行 node --experimental-strip-types scripts/reading/verify-content.mjs --write-expectations）`);
    return;
  }
  const distDir = resolve(root, "dist");
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const expected of locked.posts) {
    const file = resolve(distDir, expected.canonicalPath.replace(/^\/+|\/+$/g, ""), "index.html");
    const html = await readFile(file, "utf8");
    const record = { created: [], textNodes: 0 };
    const stub = createStubDocument(record);
    const outcome = await convertArticleHtml(html, {
      target: { postId: expected.postId, href: expected.canonicalPath, title: "" },
      responseUrl: `https://example.test${expected.canonicalPath}`,
      document: stub.document,
      allowWithoutFingerprint: true,
    });
    assert.equal(outcome.activate, true, `${expected.postId} 转换失败`);
    if (!outcome.activate) continue;

    const serialized = serializeProjection(outcome.projection);
    const digest = createHash("sha256").update(serialized).digest("hex");
    const rawText = innerText(outcome.node);
    const convertedText = rawText.replace(/\s+/g, " ").trim();
    const convertedTextSha256 = createHash("sha256").update(convertedText).digest("hex");
    const blocking = outcome.diagnostics.filter((diagnostic) =>
      ["active-element", "unknown-element", "bad-url", "bad-attribute-value", "duplicate-id"].includes(diagnostic.kind),
    );
    const entry = {
      postId: expected.postId,
      projectionNodes: countProjectionNodes(outcome.projection),
      projectionSha256: digest,
      contentChars: convertedText.length,
      contentTextSha256: convertedTextSha256,
      blockingDiagnostics: blocking.length,
    };
    results.push(entry);

    // Independent expectations come from the built canonical HTML, so a
    // regression in the converter cannot agree with itself here.
    assert.equal(entry.projectionNodes, expected.projectionNodes, `${expected.postId} 节点数变化`);
    assert.equal(entry.projectionSha256, expected.projectionSha256, `${expected.postId} 投影哈希变化`);
    assert.equal(entry.contentChars, expected.contentChars, `${expected.postId} 正文字符数变化`);
    assert.equal(entry.contentTextSha256, expected.contentTextSha256, `${expected.postId} 正文文本哈希变化`);
    assert.equal(entry.blockingDiagnostics, 0, `${expected.postId} 出现元素/URL 级诊断`);

    // Explicit, human-readable facts: the long article's locked code blocks,
    // headings and reference section must all be reachable in the reader text.
    for (const code of expected.codeBlocks) {
      assert.equal(rawText.includes(code), true, `${expected.postId} 代码块文本丢失：${code.slice(0, 40)}`);
    }
    for (const heading of expected.headings) {
      assert.equal(convertedText.includes(heading.text), true, `${expected.postId} 标题文本丢失：${heading.text}`);
    }
    assert.equal(convertedText.includes(expected.firstParagraphText.slice(0, 12)), true, `${expected.postId} 首段丢失`);
    if (expected.referenceTailText) {
      assert.equal(convertedText.includes(expected.referenceTailText), true, `${expected.postId} 参考资料一节丢失`);
    }
    const convertedIds = collectIds_(outcome.node);
    assert.equal(convertedIds.length, new Set(convertedIds).size, `${expected.postId} reader 树中不能出现重复 id`);
  }
  await mkdir(logDir, { recursive: true });
  await writeFile(resolve(logDir, "unit-real-articles.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n");
});
