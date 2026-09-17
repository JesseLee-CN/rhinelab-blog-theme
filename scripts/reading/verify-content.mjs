/**
 * IR2 content gate: compare the canonical article HTML with the converted reader
 * tree for every public post, and lock the expectations used by the unit tests.
 *
 * The expectations are computed from the built `dist/` HTML (the independent
 * source of truth), never from the converter, so the unit test can catch a
 * regression in the converter instead of agreeing with itself.
 *
 *   node --experimental-strip-types scripts/reading/verify-content.mjs
 *   node --experimental-strip-types scripts/reading/verify-content.mjs --write-expectations
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "parse5";

import {
  countProjectionNodes,
  findAll,
  attribute,
  normalizeContentTree,
  projectionText,
  readArticleContract,
  serializeProjection,
} from "../../shared/reading/contract.ts";
import { convertArticleHtml } from "../../shared/reading/content.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distDir = resolve(root, "dist");
const outDir = resolve(root, ".tools/immerse-reading/IR2");
const logDir = resolve(outDir, "logs");

/** Minimal DOM stub: the comparison needs structure, not a real document. */
function createStubDom() {
  const created = [];
  const make = (nodeType, tagName, data) => {
    const node = {
      nodeType,
      tagName,
      data,
      attributes: new Map(),
      childNodes: [],
      children: [],
      appendChild(child) {
        node.childNodes.push(child);
        if (child.nodeType === 1) node.children.push(child);
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
    if (nodeType === 1) created.push(tagName);
    return node;
  };
  return {
    created,
    document: {
      createElement: (tagName) => make(1, tagName, undefined),
      createTextNode: (data) => make(3, undefined, data),
    },
  };
}

/** Serialise a stub tree into deterministic markup for byte comparison. */
function serializeStub(node) {
  const attributes = [...node.attributes]
    .map(([name, value]) => ` ${name}="${value.replaceAll('"', "&quot;")}"`)
    .join("");
  const inner = node.childNodes.map(serializeStub).join("");
  return `<${node.tagName}${attributes}>${inner}</${node.tagName}>`;
}

function nameOf(node) {
  return node.tagName + (attribute(node, "class") ? `.${attribute(node, "class").split(/\s+/)[0]}` : "");
}

function elementNameCounts(rootNode) {
  const counts = new Map();
  for (const element of findAll(rootNode, () => true)) {
    counts.set(element.tagName, (counts.get(element.tagName) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort());
}

function textNodeCount(rootNode) {
  let count = 0;
  const visit = (node) => {
    if (node.nodeName === "#text") {
      count += 1;
      return;
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(rootNode);
  return count;
}

function images(rootNode) {
  return findAll(rootNode, (element) => element.tagName === "img").map((element) => ({
    alt: attribute(element, "alt") ?? "",
    src: attribute(element, "src") ?? "",
    srcset: attribute(element, "srcset") ?? "",
    width: attribute(element, "width") ?? "",
    height: attribute(element, "height") ?? "",
  }));
}

async function loadPublicPosts() {
  const { loadEntries } = await import("../blog/check-reader.mjs");
  const { posts, published } = await loadEntries();
  const publishedSet = new Set(published);
  return posts.filter((post) => publishedSet.has(post));
}

async function readExpectationSource(post) {
  const file = resolve(distDir, post.path.replace(/^\/+|\/+$/g, ""), "index.html");
  const html = await readFile(file, "utf8");
  const contract = readArticleContract(html);
  if (!contract.ok) throw new Error(`${post.id}: ${contract.issues.join("；")}`);
  return { file, html, content: contract.contract.content, prose: contract.contract.prose };
}

function textSnapshot(rootNode) {
  let text = "";
  const visit = (node) => {
    if (node.nodeName === "#text") {
      text += node.value;
      return;
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(rootNode);
  return text;
}

function stubText(node) {
  if (node.nodeType === 3) return node.data ?? "";
  return node.childNodes.map(stubText).join("");
}

function stubElements(node, out = []) {
  if (node.nodeType === 1) out.push(node);
  for (const child of node.childNodes) stubElements(child, out);
  return out;
}

function stubTagCounts(rootNode) {
  const counts = new Map();
  for (const element of stubElements(rootNode)) counts.set(element.tagName, (counts.get(element.tagName) ?? 0) + 1);
  return Object.fromEntries([...counts].sort());
}

function stubImages(rootNode) {
  return stubElements(rootNode)
    .filter((element) => element.tagName === "img")
    .map((element) => ({
      alt: element.getAttribute("alt") ?? "",
      src: element.getAttribute("src") ?? "",
      srcset: element.getAttribute("srcset") ?? "",
    }));
}

function stubLinks(rootNode) {
  return stubElements(rootNode)
    .filter((element) => element.tagName === "a")
    .map((element) => element.getAttribute("href") ?? "");
}

export async function verifyContent({ writeExpectations = false } = {}) {
  const posts = await loadPublicPosts();
  const perPost = [];
  const errors = [];
  const projections = {};

  for (const post of posts) {
    const source = await readExpectationSource(post);
    const responseUrl = `https://example.test${post.path}`;
    const stub = createStubDom();
    const outcome = await convertArticleHtml(source.html, {
      target: { postId: post.id, href: post.path, title: post.title },
      responseUrl,
      document: stub.document,
      allowWithoutFingerprint: true,
    });

    const sourceProjection = normalizeContentTree(source.content);
    const sourceText = textSnapshot(source.content).replace(/\s+/g, " ").trim();
    const sourceElements = elementNameCounts(source.content);
    const sourceTextNodes = textNodeCount(source.content);
    const sourceImages = images(source.content);
    const sourceLinks = findAll(source.content, (element) => element.tagName === "a").map((element) => attribute(element, "href") ?? "");

    if (!outcome.activate) {
      errors.push(`${post.id}: 转换被拒绝（${outcome.code}）`);
      perPost.push({ postId: post.id, activate: false, code: outcome.code, diagnostics: outcome.diagnostics.slice(0, 10) });
      continue;
    }

    const convertedProjection = outcome.projection;
    const convertedSerialized = serializeProjection(convertedProjection);
    const sourceSerialized = serializeProjection(sourceProjection);
    if (convertedSerialized !== sourceSerialized) {
      errors.push(`${post.id}: 转换后投影与规范 HTML 不一致`);
    }

    // The converter must carry every text run of the source subtree. Text is
    // compared after whitespace normalisation because `normalizeContentTree`
    // intentionally drops whitespace-only text nodes between block elements;
    // the stub tree is the exact rendered text of the reader.
    const convertedText = stubText(outcome.node);
    const convertedNormalized = convertedText.replace(/\s+/g, " ").trim();
    if (convertedNormalized !== sourceText) {
      errors.push(`${post.id}: 转换后文本与规范文本不一致（含文本丢失）`);
    }

    const convertedElements = stubTagCounts(outcome.node);
    const elementDiff = {};
    for (const name of new Set([...Object.keys(sourceElements), ...Object.keys(convertedElements)])) {
      const delta = (convertedElements[name] ?? 0) - (sourceElements[name] ?? 0);
      if (delta !== 0) elementDiff[name] = delta;
    }
    // The reader adds exactly one wrapper div (the `.prose` container inside the
    // `reader-prose` root) and may drop rejected `<source>` children.
    for (const [name, delta] of Object.entries(elementDiff)) {
      if (name === "div" && delta === 1) continue;
      if (name === "source" && delta < 0 && -delta <= (sourceElements.source ?? 0)) continue;
      errors.push(`${post.id}: 元素计数变化 ${name} ${delta > 0 ? "+" : ""}${delta}`);
    }

    const convertedImages = stubImages(outcome.node);
    if (convertedImages.length !== sourceImages.length) {
      errors.push(`${post.id}: 图片数量变化 ${sourceImages.length} → ${convertedImages.length}`);
    } else {
      for (let index = 0; index < sourceImages.length; index += 1) {
        if (convertedImages[index].alt !== sourceImages[index].alt) {
          errors.push(`${post.id}: 第 ${index + 1} 张图片 alt 变化`);
        }
      }
    }

    // Every same-page fragment link must resolve to an id in the reader tree.
    const readerIds = new Set(stubElements(outcome.node).map((element) => element.getAttribute("id")).filter(Boolean));
    for (const href of stubLinks(outcome.node)) {
      if (!href.startsWith("#")) continue;
      if (!readerIds.has(decodeURIComponent(href.slice(1)))) {
        errors.push(`${post.id}: 锚点 ${href} 在 reader 树中无对应 id`);
      }
    }

    const perPostDiagnostics = outcome.diagnostics.filter((diagnostic) =>
      ["active-element", "unknown-element", "dropped-class", "dropped-style", "bad-url", "bad-attribute-value", "duplicate-id"].includes(diagnostic.kind),
    );

    perPost.push({
      postId: post.id,
      canonicalPath: post.path,
      title: post.title,
      activate: true,
      sourceProjectionNodes: countProjectionNodes(sourceProjection),
      convertedProjectionNodes: countProjectionNodes(convertedProjection),
      sourceTextNodes,
      sourceChars: sourceText.length,
      retainedChars: convertedNormalized.length,
      elementCounts: sourceElements,
      elementDiff,
      sourceImages: sourceImages.length,
      sourceLinks: sourceLinks.length,
      diagnostics: outcome.diagnostics.length,
      blockingDiagnostics: perPostDiagnostics.length,
      fingerprint: outcome.meta.fingerprint,
    });
    if (perPostDiagnostics.length) {
      errors.push(`${post.id}: 出现阻断级诊断 ${perPostDiagnostics.length} 项`);
    }

    projections[post.id] = {
      postId: post.id,
      canonicalPath: post.path,
      title: post.title,
      projectionNodes: countProjectionNodes(sourceProjection),
      proseChars: projectionText(normalizeContentTree(source.prose ?? source.content)).trim().length,
      contentChars: sourceText.length,
      contentTextSha256: createHash("sha256").update(sourceText).digest("hex"),      projectionSha256: createHash("sha256").update(sourceSerialized).digest("hex"),
      convertedSha256: createHash("sha256").update(convertedSerialized).digest("hex"),
      elements: sourceElements,
      textNodes: sourceTextNodes,
      images: sourceImages,
      links: sourceLinks.length,
      codeBlocks: findAll(source.content, (element) => element.tagName === "pre").map((pre) => textSnapshot(pre)),
      headings: findAll(source.content, (element) => /^h[1-6]$/.test(element.tagName)).map((heading) => ({
        tag: heading.tagName,
        text: textSnapshot(heading).trim(),
        id: attribute(heading, "id") ?? "",
      })),
      firstParagraphText: (findAll(source.content, (element) => element.tagName === "p")[0]
        ? textSnapshot(findAll(source.content, (element) => element.tagName === "p")[0])
        : ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80),
      lastHeadingText: (() => {
        const headings = findAll(source.content, (element) => /^h[1-6]$/.test(element.tagName));
        return headings.length ? textSnapshot(headings[headings.length - 1]).trim() : "";
      })(),
      referenceTailText: (() => {
        const headings = findAll(source.content, (element) => element.tagName === "h2");
        const reference = headings.find((heading) => textSnapshot(heading).trim() === "参考资料");
        return reference ? textSnapshot(reference).trim() : "";
      })(),
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dist: distDir,
    posts: perPost,
    errors,
  };
  await mkdir(logDir, { recursive: true });
  await writeFile(resolve(logDir, "projection-report.json"), JSON.stringify(report, null, 2) + "\n");

  if (writeExpectations) {
    const expectations = {
      generatedAt: report.generatedAt,
      note: "由 scripts/reading/verify-content.mjs 从构建后的规范 HTML 生成；测试不得用被测转换函数生成期望值。",
      posts: Object.values(projections).map((entry) => ({
        postId: entry.postId,
        canonicalPath: entry.canonicalPath,
        title: entry.title,
        projectionNodes: entry.projectionNodes,
        proseChars: entry.proseChars,
        contentChars: entry.contentChars,
        contentTextSha256: entry.contentTextSha256,
        projectionSha256: entry.projectionSha256,
        elements: entry.elements,
        textNodes: entry.textNodes,
        images: entry.images,
        links: entry.links,
        codeBlocks: entry.codeBlocks,
        headings: entry.headings,
        firstParagraphText: entry.firstParagraphText,
        lastHeadingText: entry.lastHeadingText,
        referenceTailText: entry.referenceTailText,
      })),
    };
    await writeFile(resolve(logDir, "content-expectations.json"), JSON.stringify(expectations, null, 2) + "\n");
  }

  await writeFile(resolve(logDir, "conversion-summary.json"), JSON.stringify({
    generatedAt: report.generatedAt,
    posts: perPost.map((entry) => ({
      postId: entry.postId,
      activate: entry.activate,
      ...(entry.activate
        ? {
            sourceProjectionNodes: entry.sourceProjectionNodes,
            convertedProjectionNodes: entry.convertedProjectionNodes,
            sourceChars: entry.sourceChars,
            elementDiff: entry.elementDiff,
            blockingDiagnostics: entry.blockingDiagnostics,
            fingerprint: entry.fingerprint,
          }
        : { code: entry.code }),
    })),
    errors,
  }, null, 2) + "\n");

  return report;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const writeExpectations = process.argv.includes("--write-expectations");
  const report = await verifyContent({ writeExpectations });
  for (const entry of report.posts) {
    if (!entry.activate) {
      console.log(`✖ ${entry.postId} 转换被拒绝（${entry.code}）`);
      continue;
    }
    console.log(
      `✔ ${entry.postId} 投影 ${entry.convertedProjectionNodes}/${entry.sourceProjectionNodes} 节点、` +
        `正文 ${entry.retainedChars} 字符、阻断诊断 ${entry.blockingDiagnostics}、指纹 ${(entry.fingerprint ?? "").slice(0, 12)}`,
    );
  }
  if (report.errors.length) {
    console.error(`内容对账失败 ${report.errors.length} 项：\n- ${report.errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`内容对账通过：${report.posts.length} 篇公开文章的转换结果与规范 HTML 一致${writeExpectations ? "，期望已锁定" : ""}。`);
}
