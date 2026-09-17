/**
 * Reader v1 content contract: attribute names, HTML AST validation and a
 * deterministic text projection. No DOM or Node-specific APIs here so the same
 * module can run in Node tests, the build checker and the browser reader.
 */
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

export type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];
export type ParentNode = DefaultTreeAdapterMap["parentNode"];

export const READER_VERSION = "1";

export const READER_ATTRS = {
  version: "data-reader-version",
  kind: "data-reader-kind",
  postId: "data-post-id",
  canonicalPath: "data-canonical-path",
  content: "data-reader-content",
} as const;

export type ReaderContract = {
  version: string;
  kind: string;
  postId: string;
  canonicalPath: string;
  title: string;
  content: Element;
  prose: Element | null;
};

export type ContractResult =
  | { ok: true; contract: ReaderContract }
  | { ok: false; issues: string[] };

export function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

export function hasClass(element: Element, name: string): boolean {
  return (attribute(element, "class") ?? "").split(/\s+/).includes(name);
}

export function findAll(root: Node, predicate: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node && predicate(node)) found.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}

export function textContent(node: Node): string {
  if (node.nodeName === "#text") return (node as { value: string }).value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map((child) => textContent(child)).join("");
}

/**
 * Validate the reader v1 contract inside one canonical article page.
 * The article must carry the marker; every other element must be unique.
 */
export function readArticleContract(html: string): ContractResult {
  const issues: string[] = [];
  const document = parse(html);
  const marked = findAll(document, (element) => attribute(element, READER_ATTRS.version) !== undefined);

  if (marked.length === 0) return { ok: false, issues: ["没有 data-reader-version 标记"] };
  if (marked.length > 1) return { ok: false, issues: [`data-reader-version 标记出现 ${marked.length} 次`] };
  const article = marked[0];

  const version = attribute(article, READER_ATTRS.version) ?? "";
  const kind = attribute(article, READER_ATTRS.kind) ?? "";
  const postId = attribute(article, READER_ATTRS.postId) ?? "";
  const canonicalPath = attribute(article, READER_ATTRS.canonicalPath) ?? "";

  if (article.tagName !== "article") issues.push(`标记不在 article 上（${article.tagName}）`);
  if (version !== READER_VERSION) issues.push(`不支持的契约版本：${version}`);
  if (kind !== "post") issues.push(`data-reader-kind 不是 post：${kind}`);
  if (!postId) issues.push("缺少 data-post-id");
  if (!canonicalPath.startsWith("/")) issues.push(`data-canonical-path 不是绝对路径：${canonicalPath}`);

  const contents = findAll(article, (element) => attribute(element, READER_ATTRS.content) !== undefined);
  if (contents.length !== 1) issues.push(`${READER_ATTRS.content} 出现 ${contents.length} 次`);
  const content = contents[0];
  if (!content) return { ok: false, issues };

  const titles = findAll(content, (element) => element.tagName === "h1" && hasClass(element, "page-title"));
  if (titles.length !== 1) issues.push(`reader-content 内 h1.page-title 出现 ${titles.length} 次`);

  const proseNodes = findAll(content, (element) => element.tagName === "div" && hasClass(element, "prose"));
  if (proseNodes.length !== 1) issues.push(`reader-content 内 .prose 出现 ${proseNodes.length} 次`);

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    contract: { version, kind, postId, canonicalPath, title: textContent(titles[0]).trim(), content, prose: proseNodes[0] },
  };
}

/** True when the page exposes the consumable reader marker at all. */
export function hasReaderMarker(html: string): boolean {
  return findAll(parse(html), (element) => attribute(element, READER_ATTRS.version) !== undefined).length > 0;
}

export type ProjectionNode = { tag: string; text?: string; children?: ProjectionNode[] };

/** Elements that carry no reader content and never appear in a projection. */
const PROJECTION_SKIPPED = new Set(["html", "head"]);

/**
 * Deterministic, whitespace-normalized projection of a content tree. Element
 * names, nesting and text order are preserved; `img`/`source` media URLs are
 * projected through `alt` text so that image content cannot be lost silently.
 */
export function normalizeContentTree(root: Node): ProjectionNode[] {
  const elements = (...nodes: Node[]): ProjectionNode[] => {
    const out: ProjectionNode[] = [];
    for (const node of nodes) {
      if (node.nodeName === "#text") {
        const text = (node as { value: string }).value.replace(/\s+/g, " ").trim();
        if (text) out.push({ tag: "#text", text });
        continue;
      }
      if (!("tagName" in node)) continue;
      if (PROJECTION_SKIPPED.has(node.tagName)) {
        out.push(...elements(...node.childNodes));
        continue;
      }
      const children = elements(...node.childNodes);
      const alt = node.tagName === "img" ? attribute(node, "alt") : undefined;
      if (alt?.trim()) children.unshift({ tag: "#text", text: alt.replace(/\s+/g, " ").trim() });
      out.push({ tag: node.tagName, ...(children.length ? { children } : {}) });
    }
    return out;
  };
  return elements(root);
}

/** Number of nodes in a projection, counting every element and text node. */
export function countProjectionNodes(nodes: readonly ProjectionNode[]): number {
  return nodes.reduce((total, node) => total + 1 + (node.children ? countProjectionNodes(node.children) : 0), 0);
}

/** Concatenated text of a projection, in document order. */
export function projectionText(nodes: readonly ProjectionNode[]): string {
  return nodes.map((node) => [node.text ?? "", node.children ? projectionText(node.children) : ""].join("")).join("");
}

/**
 * Deterministic canonical form of a projection: one line per node with an
 * explicit closing marker. Whitespace and line breaks cannot shift the digest.
 */
export function serializeProjection(nodes: readonly ProjectionNode[]): string {
  const lines: string[] = [];
  const visit = (node: ProjectionNode, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.tag === "#text") {
      lines.push(`${pad}text ${JSON.stringify(node.text ?? "")}`);
      return;
    }
    lines.push(`${pad}${node.tag}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
    lines.push(`${pad}/${node.tag}`);
  };
  for (const node of nodes) visit(node, 0);
  return lines.join("\n");
}

export type FingerprintInput = {
  canonicalPath: string;
  postId: string;
  projection: readonly ProjectionNode[];
};

/** Input bytes of the content revision fingerprint (CONTRACT.md §2). */
export function fingerprintPayload(input: FingerprintInput): string {
  return ["reader-v1", input.canonicalPath, input.postId, serializeProjection(input.projection)].join("\n");
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the fingerprint payload using Web Crypto (browser reader path). */
export async function fingerprintContentAsync(input: FingerprintInput): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const bytes = new TextEncoder().encode(fingerprintPayload(input));
  return toHex(await subtle.digest("SHA-256", bytes));
}

export { toHex };

