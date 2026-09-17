/**
 * Article HTML -> safe reader DOM.
 *
 * Pipeline (CONTRACT.md §4): parse5 HTML AST -> shared allow policy -> safe node
 * tree -> DOM built exclusively from `createElement` / `createTextNode` /
 * `setAttribute`. No parsed HTML is ever handed to `innerHTML`, and no DOM node
 * is created for content that failed validation, so a rejected response cannot
 * trigger a resource request, an event handler or an application action.
 */
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import {
  ACTIVE_ELEMENTS,
  ALLOWED_ARIA,
  ALLOWED_ELEMENTS,
  ALLOWED_ROLES,
  classifyStyleValue,
  ELEMENT_ATTRIBUTES,
  GLOBAL_ATTRIBUTES,
  isAllowedClass,
} from "./allow-list.ts";
import {
  attribute,
  fingerprintContentAsync,
  normalizeContentTree,
  READER_ATTRS,
  readArticleContract,
  type Element,
  type Node as AstNode,
  type ProjectionNode,
} from "./contract.ts";
import {
  decodeFragment,
  describeUrlProblem,
  encodeFragment,
  isSafeContentUrl,
  resolveContentUrl,
  sameCanonicalPath,
  type UrlProblem,
} from "./url-policy.ts";
import { parseSrcset, rewriteSrcset } from "./srcset.ts";

/** The DOM surface the converter needs; `document` satisfies it in the browser. */
export interface ReaderDom {
  createElement(tagName: string): HTMLElement;
  createTextNode(data: string): Text;
}

export type DiagnosticKind =
  | "unknown-element"
  | "active-element"
  | "unknown-attribute"
  | "dropped-class"
  | "dropped-style"
  | "bad-url"
  | "bad-attribute-value"
  | "duplicate-id"
  | "dangling-reference"
  | "dropped-data-attribute";

export type Diagnostic = {
  kind: DiagnosticKind;
  /** Path from the content root, e.g. `div.prose > pre:nth(3) > span`. */
  path: string;
  message: string;
};

export type ArticleMeta = {
  postId: string;
  canonicalPath: string;
  title: string;
  fingerprint: string | null;
};

export type ConvertResult =
  | { activate: true; code: "ok"; node: HTMLElement; meta: ArticleMeta; projection: ProjectionNode[]; diagnostics: Diagnostic[] }
  | { activate: false; code: "contract" | "unsupported"; diagnostics: Diagnostic[] };

export type ConvertOptions = {
  target: { postId: string; href: string; title: string };
  /** Article response URL, used as the base for every relative content URL. */
  responseUrl: string;
  document: ReaderDom;
  /** Reader instance number; keeps remapped ids unique across readers. */
  instanceId?: number;
  /** Build-time checker role: no Web Crypto, diagnostics are collected only. */
  allowWithoutFingerprint?: boolean;
};

const MAX_DIAGNOSTICS = 200;

function label(element: Element): string {
  const className = attribute(element, "class");
  return element.tagName + (className ? `.${className.split(/\s+/)[0]}` : "");
}

class PathTracker {
  private readonly counts = new Map<string, number>();

  push(element: Element): string {
    const key = label(element);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next === 1 ? key : `${key}:nth(${next})`;
  }
}

type IdMap = Map<string, string>;

/**
 * Pre-pass over the parsed content: collect every element id, remap it to a
 * reader-scoped id and detect duplicates before any DOM node exists.
 */
function collectIds(root: Element, instanceId: number): { map: IdMap; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const map: IdMap = new Map();
  let counter = 0;
  const walk = (node: AstNode) => {
    if ("tagName" in node) {
      const original = attribute(node, "id");
      if (original !== undefined) {
        if (map.has(original)) {
          diagnostics.push({ kind: "duplicate-id", path: label(node), message: `重复 id：${original}` });
        } else {
          counter += 1;
          map.set(original, `reader-${instanceId}-${counter}`);
        }
      }
      for (const child of node.childNodes) walk(child);
    }
  };
  walk(root);
  return { map, diagnostics };
}

function pushDiagnostic(list: Diagnostic[], diagnostic: Diagnostic): void {
  if (list.length < MAX_DIAGNOSTICS) list.push(diagnostic);
}

function sanitizeStyle(element: Element, path: string, diagnostics: Diagnostic[]): string | null {
  const raw = attribute(element, "style");
  if (raw === undefined) return null;
  const kept: string[] = [];
  for (const declaration of raw.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!property || !value) continue;
    if (value.includes("!important") || value.includes("/*")) {
      pushDiagnostic(diagnostics, { kind: "dropped-style", path, message: `拒绝样式 ${property}（重要声明或注释）` });
      continue;
    }
    const classified = classifyStyleValue(property, value);
    if (!classified) {
      pushDiagnostic(diagnostics, { kind: "dropped-style", path, message: `拒绝样式 ${property}: ${value}` });
      continue;
    }
    kept.push(`${property}: ${value}`);
  }
  return kept.length ? kept.join("; ") : null;
}

function sanitizeClasses(element: Element, path: string, diagnostics: Diagnostic[]): string | null {
  const raw = attribute(element, "class");
  if (raw === undefined) return null;
  const kept: string[] = [];
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    if (isAllowedClass(token)) kept.push(token);
    else pushDiagnostic(diagnostics, { kind: "dropped-class", path, message: `未授权 class：${token}` });
  }
  return kept.length ? kept.join(" ") : null;
}

function positiveInteger(value: string | undefined, max: number): number | null {
  if (value === undefined) return null;
  if (!/^[0-9]+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) return null;
  return parsed;
}

function sanitizeSizes(value: string): string | null {
  if (/(url|var|expression|attr)\s*\(/i.test(value)) return null;
  if (value.includes("\\") || value.includes(";") || value.includes('"') || value.includes("'")) return null;
  // Keep only lengths/media-condition tokens the browser can evaluate.
  if (!/^[0-9a-zA-Z.,%()\s\-+*/:]+$/.test(value)) return null;
  const trimmed = value.replace(/[\t\n\f\r ]+/g, " ").trim();
  return trimmed || null;
}

function collectReferencedIds(element: Element): string[] {
  if (!("tagName" in element)) return [];
  const ids: string[] = [];
  for (const name of ALLOWED_ARIA) {
    if (name === "aria-label" || name === "aria-hidden") continue;
    const value = attribute(element, name);
    if (value) ids.push(...value.split(/\s+/).filter(Boolean));
  }
  return ids;
}

function rewriteMediaUrl(
  raw: string,
  base: string,
  path: string,
  attributeName: string,
  diagnostics: Diagnostic[],
): { url: string } | { error: string } {
  const resolved = resolveContentUrl(raw, base);
  if ("problem" in resolved) {
    const message = `拒绝 ${attributeName}（${describeUrlProblem(resolved.problem)}）：${raw.slice(0, 120)}`;
    pushDiagnostic(diagnostics, { kind: "bad-url", path, message });
    return { error: message };
  }
  return { url: resolved.url };
}

export async function convertArticleHtml(html: string, options: ConvertOptions): Promise<ConvertResult> {
  const { target, responseUrl, document: dom } = options;
  const instanceId = options.instanceId ?? 1;
  const diagnostics: Diagnostic[] = [];

  // ---- 1. Contract -----------------------------------------------------------------
  const contractResult = readArticleContract(html);
  if (!contractResult.ok) {
    return {
      activate: false,
      code: "contract",
      diagnostics: contractResult.issues.map((issue) => ({ kind: "unknown-element" as const, path: "article", message: issue })),
    };
  }
  const { contract } = contractResult;
  if (contract.postId !== target.postId) {
    return {
      activate: false,
      code: "contract",
      diagnostics: [{ kind: "unknown-element", path: "article", message: `postId 不匹配：响应为 ${contract.postId}，期望 ${target.postId}` }],
    };
  }
  let expectedPath = target.href;
  try {
    expectedPath = new URL(target.href, responseUrl).pathname;
  } catch {
    expectedPath = target.href;
  }
  if (!sameCanonicalPath(contract.canonicalPath, expectedPath)) {
    return {
      activate: false,
      code: "contract",
      diagnostics: [{ kind: "unknown-element", path: "article", message: `canonical 路径不匹配：响应为 ${contract.canonicalPath}，期望 ${expectedPath}` }],
    };
  }

  // ---- 2. Input bounds -------------------------------------------------------------
  let nodeBudget = 50_000;
  const depthBudget = 128;
  const countAndCheck = (node: AstNode, depth: number): boolean => {
    if (depth > depthBudget) return false;
    nodeBudget -= 1;
    if (nodeBudget < 0) return false;
    if ("childNodes" in node) for (const child of node.childNodes) if (!countAndCheck(child, depth + 1)) return false;
    return true;
  };
  if (!countAndCheck(contract.content, 1)) {
    return {
      activate: false,
      code: "unsupported",
      diagnostics: [{ kind: "unknown-element", path: "article", message: "转换后节点数或深度超出限制" }],
    };
  }

  // ---- 3. Ids ----------------------------------------------------------------------
  // Duplicate ids are rejected outright (CONTRACT.md §6.6): a half-mapped
  // document would leave two elements claiming the same reader id.
  const { map: idMap, diagnostics: idDiagnostics } = collectIds(contract.content, instanceId);
  if (idDiagnostics.length) {
    return { activate: false, code: "contract", diagnostics: idDiagnostics };
  }

  // ---- 4. Safe node creation -------------------------------------------------------
  let activeRejected = false;

  /**
   * The single place a reader element is created. `buildElement` screens the tag
   * first, so reaching this with a rejected tag is a programming error, not a
   * content problem - the guard keeps the "no DOM for invalid nodes" invariant
   * checkable from tests with a recording DOM stub.
   */
  const createElement = (tag: string): HTMLElement => {
    if (!isAllowedElementName(tag)) throw new Error(`reader: 未授权元素创建被拒绝 <${tag}>`);
    return dom.createElement(tag);
  };

  const buildChildren = (parent: AstNode, path: string, into: HTMLElement | DocumentFragment): void => {
    if (!("childNodes" in parent)) return;
    const tracker = new PathTracker();
    for (const child of parent.childNodes) {
      if (child.nodeName === "#text") {
        into.appendChild(dom.createTextNode((child as { value: string }).value));
        continue;
      }
      if (!("tagName" in child)) continue;
      const childPath = `${path} > ${tracker.push(child)}`;
      const built = buildElement(child, childPath);
      if (built) into.appendChild(built);
    }
  };

  const buildElement = (element: Element, path: string): HTMLElement | null => {
    const tag = element.tagName;
    if (ACTIVE_ELEMENTS.has(tag)) {
      activeRejected = true;
      pushDiagnostic(diagnostics, { kind: "active-element", path, message: `禁止的活跃元素：<${tag}>` });
      return null;
    }
    if (!ALLOWED_ELEMENTS.has(tag)) {
      activeRejected = true;
      pushDiagnostic(diagnostics, { kind: "unknown-element", path, message: `未授权元素：<${tag}>` });
      return null;
    }
    const node = createElement(tag);

    for (const { name, value } of element.attrs) {
      const lower = name.toLowerCase();
      if (lower.startsWith("data-")) {
        if (!(tag === "pre" && lower === "data-language")) {
          pushDiagnostic(diagnostics, { kind: "dropped-data-attribute", path, message: `未带入应用数据属性：${lower}` });
        }
        continue;
      }
      const allowedHere = GLOBAL_ATTRIBUTES.has(lower) || ELEMENT_ATTRIBUTES.get(tag)?.has(lower) === true;
      if (!allowedHere) {
        pushDiagnostic(diagnostics, { kind: "unknown-attribute", path, message: `未授权属性：${lower}` });
        continue;
      }
      if (lower === "id") continue;
      if (lower === "class" || lower === "style") continue;
      if (lower.startsWith("aria-")) {
        if (ALLOWED_ARIA.has(lower)) node.setAttribute(lower, value);
        else pushDiagnostic(diagnostics, { kind: "unknown-attribute", path, message: `未授权 ARIA 属性：${lower}` });
        continue;
      }
      if (lower === "role") {
        if (ALLOWED_ROLES.has(value)) node.setAttribute("role", value);
        else pushDiagnostic(diagnostics, { kind: "unknown-attribute", path, message: `未授权 role：${value}` });
        continue;
      }
      if (lower === "lang" || lower === "dir" || lower === "title") {
        node.setAttribute(lower, value);
        continue;
      }
      if (lower === "href") continue;
      if (lower === "target") {
        if (value === "_blank" || value === "_self") node.setAttribute("target", value);
        else pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 target：${value}` });
        continue;
      }
      // `rel` is derived from `target`; a source `download` would turn the link
      // into a file download, so it never reaches the reader DOM.
      if (lower === "rel" || lower === "download") continue;
      if (lower === "name" && tag === "a") continue;
      if (lower === "src" || lower === "srcset" || lower === "sizes") continue;
      if (lower === "loading" || lower === "decoding" || lower === "referrerpolicy") continue;
      // `alt` is allowed on `img` only and is applied in the media branch below;
      // it must not fall through to the "unhandled attribute" diagnostic.
      if (lower === "alt") continue;
      if (lower === "width" || lower === "height") {
        const size = positiveInteger(value, 100_000);
        if (size === null) pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 ${lower}：${value}` });
        else node.setAttribute(lower, String(size));
        continue;
      }
      if (lower === "datetime") {
        if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) {
          node.setAttribute("datetime", value.trim());
        } else {
          pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 datetime：${value}` });
        }
        continue;
      }
      if (lower === "colspan" || lower === "rowspan" || lower === "span") {
        const count = positiveInteger(value, 1000);
        if (count === null) pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 ${lower}：${value}` });
        else node.setAttribute(lower, String(count));
        continue;
      }
      if (lower === "scope") {
        const scope = value.toLowerCase();
        if (["row", "col", "rowgroup", "colgroup"].includes(scope)) node.setAttribute("scope", scope);
        else pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 scope：${value}` });
        continue;
      }
      if (lower === "start" || lower === "value") {
        if (/^-?\d+$/.test(value.trim())) node.setAttribute(lower, value.trim());
        else pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 ${lower}：${value}` });
        continue;
      }
      if (lower === "reversed") {
        node.setAttribute("reversed", "");
        continue;
      }
      if (lower === "type") {
        if (tag === "ol" && ["1", "a", "A", "i", "I"].includes(value)) node.setAttribute("type", value);
        else if (tag === "input") {
          if (value === "checkbox") node.setAttribute("type", "checkbox");
          else pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 input type：${value}` });
        } else if (tag === "source" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(value.trim())) {
          node.setAttribute("type", value.trim());
        }
        continue;
      }
      if (lower === "checked" || lower === "disabled" || lower === "open") {
        node.setAttribute(lower, "");
        continue;
      }
      if (lower === "media") {
        const media = value.replace(/[\t\n\f\r ]+/g, " ").trim();
        if (media && !/["'\\;]/.test(media) && !/(url|var|expression)\s*\(/i.test(media)) node.setAttribute("media", media);
        else pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 media：${value}` });
        continue;
      }
      if (lower === "headers" || lower === "abbr" || lower === "cite" || lower === "colspan" || lower === "for") {
        if (!/[<>"']/.test(value)) node.setAttribute(lower, value);
        continue;
      }
      if (lower === "tabindex") {
        if (value.trim() === "0") node.setAttribute("tabindex", "0");
        else pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 tabindex：${value}` });
        continue;
      }
      pushDiagnostic(diagnostics, { kind: "unknown-attribute", path, message: `未处理的属性：${lower}` });
    }

    const id = attribute(element, "id");
    if (id !== undefined) {
      const mapped = idMap.get(id);
      if (mapped) node.setAttribute("id", mapped);
    }
    const classes = sanitizeClasses(element, path, diagnostics);
    if (classes) node.setAttribute("class", classes);
    const style = sanitizeStyle(element, path, diagnostics);
    if (style) node.setAttribute("style", style);

    if (tag === "a") {
      const href = attribute(element, "href");
      if (href !== undefined) {
        const hashIndex = href.indexOf("#");
        const beforeHash = hashIndex < 0 ? href : href.slice(0, hashIndex);
        const rawFragmentValue = hashIndex < 0 ? "" : href.slice(hashIndex + 1);
        // A fragment-only link and a same-page link both target reader content;
        // every other link keeps its real canonical URL, only re-based.
        const isSamePageReference = href.trim().startsWith("#") || sameCanonicalPath(beforeHash || "/", new URL(responseUrl).pathname);
        const fragment = decodeFragment(href);
        if (
          isSamePageReference &&
          rawFragmentValue &&
          !rawFragmentValue.includes("/") &&
          !("problem" in fragment) &&
          Boolean(fragment.value)
        ) {
          const mapped = idMap.get(fragment.value);
          if (mapped) node.setAttribute("href", `#${encodeFragment(mapped)}`);
          else {
            pushDiagnostic(diagnostics, { kind: "dangling-reference", path, message: `fragment 无对应目标：#${fragment.value}` });
          }
        } else {
          const resolved = resolveContentUrl(href, responseUrl);
          if ("problem" in resolved) {
            pushDiagnostic(diagnostics, { kind: "bad-url", path, message: `拒绝 href（${describeUrlProblem(resolved.problem)}）：${href.slice(0, 120)}` });
          } else {
            node.setAttribute("href", resolved.url);
            if (node.getAttribute("target") === "_blank") node.setAttribute("rel", "noopener noreferrer");
          }
        }
      }
      const name = attribute(element, "name");
      if (name !== undefined) {
        const mapped = idMap.get(name);
        if (mapped) node.setAttribute("id", mapped);
      }
    }

    if (tag === "img" || tag === "source") {
      const src = attribute(element, "src");
      if (src !== undefined) {
        const rewritten = rewriteMediaUrl(src, responseUrl, path, "src", diagnostics);
        if ("url" in rewritten) node.setAttribute("src", rewritten.url);
      }
      const srcset = attribute(element, "srcset");
      if (srcset !== undefined && srcset.trim()) {
        const rewritten = rewriteSrcset(srcset, (candidate) => rewriteMediaUrl(candidate, responseUrl, path, "srcset", diagnostics));
        for (const error of rewritten.errors) {
          pushDiagnostic(diagnostics, { kind: "bad-url", path, message: `srcset：${error}` });
        }
        if (rewritten.value) node.setAttribute("srcset", rewritten.value);
        else pushDiagnostic(diagnostics, { kind: "bad-url", path, message: "srcset 全部候选被拒绝" });
      }
      const sizes = attribute(element, "sizes");
      if (sizes !== undefined) {
        const sanitized = sanitizeSizes(sizes);
        if (sanitized) node.setAttribute("sizes", sanitized);
        else pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 sizes：${sizes}` });
      }
      if (tag === "img") {
        const alt = attribute(element, "alt");
        if (alt !== undefined) node.setAttribute("alt", alt);
        node.setAttribute("loading", "lazy");
        node.setAttribute("decoding", "async");
      }
      if (tag === "source" && !node.getAttribute("src") && !node.getAttribute("srcset") && !node.getAttribute("media")) {
        return null;
      }
    }

    if (tag === "pre") {
      const language = attribute(element, "data-language");
      if (language && /^[a-z0-9+#._-]{1,32}$/i.test(language)) {
        node.setAttribute("data-language", language);
      } else if (language) {
        pushDiagnostic(diagnostics, { kind: "bad-attribute-value", path, message: `拒绝 data-language：${language}` });
      }
    }

    if (tag === "input") {
      if (node.getAttribute("type") !== "checkbox") return null;
      node.setAttribute("disabled", "");
    }

    if (tag === "a" && !node.getAttribute("href")) {
      // A link without a usable target keeps its text but stops being a link.
      const text = (element.childNodes ?? [])
        .map((child) => (child.nodeName === "#text" ? (child as { value: string }).value : ""))
        .join("");
      pushDiagnostic(diagnostics, { kind: "bad-url", path, message: `链接缺少可用 href（文本 ${text.slice(0, 30)}）` });
      const replacement = createElement("span");
      buildChildren(element, path, replacement);
      return replacement;
    }

    buildChildren(element, path, node);
    return node;
  };

  const root = createElement("div");
  root.setAttribute("class", "reader-prose");
  buildChildren(contract.content, "reader", root);

  // ARIA references resolve after every id is known; unresolved ones are dropped.
  const resolveAria = (node: HTMLElement) => {
    for (const name of ALLOWED_ARIA) {
      if (name === "aria-label" || name === "aria-hidden") continue;
      const value = node.getAttribute?.(name);
      if (!value) continue;
      const mapped = value
        .split(/\s+/)
        .filter(Boolean)
        .map((original) => idMap.get(original))
        .filter((id): id is string => Boolean(id));
      if (mapped.length) node.setAttribute(name, mapped.join(" "));
      else node.removeAttribute?.(name);
    }
    for (const child of node.children ?? []) resolveAria(child as unknown as HTMLElement);
  };
  resolveAria(root);

  for (const reference of collectReferencedIds(contract.content)) {
    if (!idMap.has(reference)) {
      pushDiagnostic(diagnostics, { kind: "dangling-reference", path: "reader", message: `ARIA 引用无对应 id：${reference}` });
    }
  }

  if (activeRejected) {
    return {
      activate: false,
      code: "unsupported",
      diagnostics: [
        ...diagnostics,
        {
          kind: "active-element",
          path: "reader",
          message: "响应含禁止或未授权元素，整篇转为“不支持沉浸显示”，保留独立文章页入口",
        },
      ],
    };
  }

  const projection = normalizeContentTree(contract.content);
  const fingerprint = await fingerprintContentAsync({
    canonicalPath: contract.canonicalPath,
    postId: contract.postId,
    projection,
  });
  if (!fingerprint && !options.allowWithoutFingerprint) {
    pushDiagnostic(diagnostics, { kind: "unknown-element", path: "reader", message: "Web Crypto 不可用，放弃跨次滚动恢复" });
  }

  return {
    activate: true,
    code: "ok",
    node: root,
    meta: {
      postId: contract.postId,
      canonicalPath: contract.canonicalPath,
      title: contract.title || target.title,
      fingerprint,
    },
    projection,
    diagnostics,
  };
}

/** Detached React-less guard used by tests: reject any non-allowlisted tag. */
export function isAllowedElementName(tag: string): boolean {
  return ALLOWED_ELEMENTS.has(tag) && !ACTIVE_ELEMENTS.has(tag);
}

export { READER_ATTRS, parseSrcset };
