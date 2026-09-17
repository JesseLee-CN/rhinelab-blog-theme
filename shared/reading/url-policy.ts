/**
 * URL, fragment and canonical-path policy for the immersive reader.
 *
 * The rules come from CONTRACT.md §6 and §5: only same-origin, credential-free
 * canonical article URLs may be fetched; content URLs keep http/https/mailto/tel
 * or resolve to them; canonical path comparison decodes each segment exactly
 * once and only normalises a trailing slash. No DOM or Node APIs.
 */

export const SAFE_SCHEMES = ["http:", "https:", "mailto:", "tel:"] as const;

export type UrlProblem =
  | "empty"
  | "unparsable"
  | "unsafe-scheme"
  | "protocol-relative"
  | "cross-origin"
  | "credentials"
  | "query"
  | "fragment"
  | "invalid-encoding"
  | "encoded-separator"
  | "dot-segment";

const PROBLEM_TEXT: Record<UrlProblem, string> = {
  empty: "URL 为空",
  unparsable: "URL 无法解析",
  "unsafe-scheme": "不允许的协议",
  "protocol-relative": "不接受协议相对地址",
  "cross-origin": "跨源地址被拒绝",
  credentials: "地址包含凭据",
  query: "地址不应包含查询串",
  fragment: "地址不应包含 fragment",
  "invalid-encoding": "百分号编码非法",
  "encoded-separator": "包含编码后的斜杠或反斜杠",
  "dot-segment": "包含点路径段",
};

export function describeUrlProblem(problem: UrlProblem): string {
  return PROBLEM_TEXT[problem];
}

/** Decode one percent-encoded segment, rejecting malformed escapes. */
export function decodeSegment(segment: string): { value: string } | { problem: UrlProblem } {
  if (!segment.includes("%")) return { value: segment };
  if (/%(?![0-9A-Fa-f]{2})/.test(segment)) return { problem: "invalid-encoding" };
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return { problem: "invalid-encoding" };
  }
  if (decoded.includes("/") || decoded.includes("\\")) return { problem: "encoded-separator" };
  return { value: decoded };
}

/**
 * Split a same-origin path into decoded segments. A trailing empty segment
 * (trailing slash) is dropped; dot segments are rejected instead of resolved.
 */
export function canonicalSegments(path: string): { segments: string[] } | { problem: UrlProblem } {
  const raw = path.split("/");
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  const segments: string[] = [];
  for (const segment of raw) {
    if (segment === "") continue;
    if (segment === "." || segment === "..") return { problem: "dot-segment" };
    const decoded = decodeSegment(segment);
    if ("problem" in decoded) return decoded;
    if (decoded.value === "." || decoded.value === "..") return { problem: "dot-segment" };
    segments.push(decoded.value);
  }
  return { segments };
}

/**
 * True when two same-origin paths point at the same resource. Only a trailing
 * slash is normalised: case, Han characters and punctuation stay significant.
 */
export function sameCanonicalPath(a: string, b: string): boolean {
  const left = canonicalSegments(a);
  const right = canonicalSegments(b);
  if ("problem" in left || "problem" in right) return false;
  if (left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => segment === right.segments[index]);
}

/** True when a URL string may become an attribute value in reader content. */
export function isSafeContentUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[\u0000-\u0020]/.test(value)) return false;
  if (trimmed.startsWith("//")) return false;
  let url: URL;
  try {
    url = new URL(trimmed, "https://reader.invalid/");
  } catch {
    return false;
  }
  return (SAFE_SCHEMES as readonly string[]).includes(url.protocol);
}

export type ContentUrlResult = { url: string } | { problem: UrlProblem };

/**
 * Resolve a content URL (href/src/srcset candidate) against the article
 * response URL. The result is what the reader will point at, so it must be
 * absolute and scheme-safe.
 */
export function resolveContentUrl(raw: string, base: string): ContentUrlResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { problem: "empty" };
  if (trimmed.startsWith("//")) return { problem: "protocol-relative" };
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return { problem: "unparsable" };
  }
  if (!(SAFE_SCHEMES as readonly string[]).includes(url.protocol)) return { problem: "unsafe-scheme" };
  if (url.username || url.password) return { problem: "credentials" };
  return { url: url.href };
}

export type ArticleUrlCheck = { ok: true; url: string } | { ok: false; problem: UrlProblem };

/**
 * Validate the article URL the reader is about to fetch: absolute or resolved
 * against `origin`, same-origin, no credentials, query or fragment.
 */
export function checkArticleUrl(href: string, origin: string): ArticleUrlCheck {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return { ok: false, problem: "unparsable" };
  }
  if (url.origin !== new URL(origin).origin) return { ok: false, problem: "cross-origin" };
  if (url.username || url.password) return { ok: false, problem: "credentials" };
  if (url.search) return { ok: false, problem: "query" };
  if (url.hash) return { ok: false, problem: "fragment" };
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, problem: "unsafe-scheme" };
  const segments = canonicalSegments(url.pathname);
  if ("problem" in segments) return { ok: false, problem: segments.problem };
  return { ok: true, url: url.href };
}

/** Raw (still encoded) fragment identifier of a URL string, without "#". */
export function rawFragment(value: string): string {
  const hash = value.indexOf("#");
  return hash < 0 ? "" : value.slice(hash + 1);
}

/**
 * Decoded fragment target: percent escapes are decoded once, matching how a
 * browser resolves `#id` against an element `id` attribute.
 */
export function decodeFragment(value: string): { value: string } | { problem: UrlProblem } {
  const raw = rawFragment(value);
  if (!raw) return { value: "" };
  try {
    return { value: decodeURIComponent(raw) };
  } catch {
    return { problem: "invalid-encoding" };
  }
}

/**
 * Re-encode a fragment target for an attribute value. `encodeURIComponent`
 * leaves a few characters the fragment production allows but never emits a
 * bare `#`, `%` ambiguity or whitespace.
 */
export function encodeFragment(id: string): string {
  return encodeURIComponent(id).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
}
