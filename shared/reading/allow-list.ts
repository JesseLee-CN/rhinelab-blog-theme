/**
 * Reader content allow policy: exactly which elements, attributes, classes and
 * inline style declarations may reach the reader DOM.
 *
 * The policy covers this blog's static Markdown output only; it is not a general
 * purpose HTML sanitiser (CONTRACT.md §4/§5). Every rejection is reported as a
 * diagnostic so that unknown content can never be dropped silently.
 */

/** Text-level and block elements the prose pipeline may emit. */
export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "div", "span", "section", "nav", "br", "hr",
  "strong", "em", "b", "i", "s", "del", "ins", "mark", "small", "u",
  "blockquote", "ul", "ol", "li", "dl", "dt", "dd",
  "pre", "code", "kbd", "samp", "var",
  "sup", "sub", "a", "time", "abbr", "cite", "q",
  "figure", "figcaption", "img", "picture", "source",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "details", "summary", "label",
  "input",
]);

/**
 * Elements that must never be created. Their presence turns the whole response
 * into "not supported for immersive reading" instead of being repaired
 * (CONTRACT.md §5 "禁止活跃元素").
 */
export const ACTIVE_ELEMENTS: ReadonlySet<string> = new Set([
  "script", "style", "link", "base", "meta", "title", "template", "noscript",
  "iframe", "frame", "frameset", "object", "embed", "applet", "param",
  "form", "fieldset", "legend", "button", "select", "option", "optgroup",
  "textarea", "datalist", "output", "progress", "meter",
  "video", "audio", "track", "canvas", "map", "area", "portal", "fencedframe",
  "dialog", "html", "head", "body",
]);

/** Elements whose subtree must be dropped when they are rejected. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set(["br", "hr", "img", "source", "col", "input", "track", "area", "base", "link", "meta", "embed", "param"]);

export const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set(["title", "lang", "dir", "class", "id", "style"]);

/** Attributes carried by contract markup and by Markdown output. */
export const ELEMENT_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["a", new Set(["href", "target", "rel", "name", "aria-label", "aria-labelledby", "aria-describedby", "role", "tabindex", "download"])],
  ["img", new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding", "referrerpolicy", "aria-label", "aria-labelledby", "aria-describedby", "role"])],
  ["source", new Set(["src", "srcset", "sizes", "type", "media", "width", "height"])],
  ["time", new Set(["datetime"])],
  ["ol", new Set(["start", "reversed", "type"])],
  ["li", new Set(["value"])],
  ["ul", new Set(["role", "aria-label"])],
  ["nav", new Set(["aria-label", "aria-labelledby", "role"])],
  ["th", new Set(["colspan", "rowspan", "scope", "abbr", "headers"])],
  ["td", new Set(["colspan", "rowspan", "headers"])],
  ["col", new Set(["span"])],
  ["colgroup", new Set(["span"])],
  ["input", new Set(["type", "checked", "disabled", "aria-label", "aria-labelledby"])],
  ["pre", new Set(["tabindex", "data-language", "data-line-numbers"])],
  ["code", new Set(["tabindex"])],
  ["span", new Set(["tabindex"])],
  ["details", new Set(["open", "role"])],
  ["summary", new Set(["aria-label", "role", "tabindex"])],
  ["label", new Set(["for"])],
  ["figure", new Set(["role"])],
  ["blockquote", new Set(["cite", "role"])],
  ["section", new Set(["role", "aria-label", "aria-labelledby"])],
  ["div", new Set(["role", "aria-label", "aria-labelledby"])],
  ["p", new Set(["role"])],
  ["table", new Set(["role", "aria-label", "aria-labelledby"])],
  ["caption", new Set(["role"])],
  ["h1", new Set(["role"])],
  ["h2", new Set(["role"])],
  ["h3", new Set(["role"])],
  ["h4", new Set(["role"])],
  ["h5", new Set(["role"])],
  ["h6", new Set(["role"])],
]);

/** ARIA attributes that survive, limited to explicit labelling and footnote roles. */
export const ALLOWED_ARIA: ReadonlySet<string> = new Set([
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
]);

export const ALLOWED_ROLES: ReadonlySet<string> = new Set([
  "doc-footnote",
  "doc-endnotes",
  "doc-noteref",
  "doc-backlink",
  "doc-tip",
  "note",
  "navigation",
  "presentation",
  "none",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "img",
  "figure",
  "group",
  "separator",
  "status",
  "alert",
  "region",
]);

/**
 * Class tokens that stay. Unknown tokens are dropped and reported: reader CSS
 * only depends on the contract wrappers and the syntax-highlight markup, and
 * Astro/Shiki emits `astro-code`, `github-dark`, `line` and `language-*`.
 */
export const ALLOWED_CLASSES: ReadonlySet<string> = new Set([
  "page-title",
  "meta",
  "taxonomy",
  "toc",
  "toc-title",
  "toc-sub",
  "prose",
  "reader-prose",
  "astro-code",
  "shiki",
  "github-dark",
  "github-light",
  "line",
  "highlighted",
  "code-line",
]);

export function isAllowedClass(token: string): boolean {
  return ALLOWED_CLASSES.has(token) || token.startsWith("language-");
}

/**
 * Inline style properties that survive, with the value shapes they may take.
 * Anything with a function, custom property, `!important` or a keyword outside
 * the list is rejected: colours, a font style, and `overflow-x: auto` for code
 * blocks. No url(), var(), positioning or sizing.
 */
export const ALLOWED_STYLE_PROPERTIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["color", new Set(["color"])],
  ["background-color", new Set(["color"])],
  ["font-style", new Set(["keyword:normal", "keyword:italic", "keyword:oblique"])],
  ["font-weight", new Set(["keyword:normal", "keyword:bold", "keyword:bolder", "keyword:lighter", "number:100-900"])],
  ["text-decoration", new Set(["keyword:none", "keyword:underline", "keyword:line-through", "keyword:underline line-through"])],
  ["overflow-x", new Set(["keyword:auto", "keyword:visible"])],
  ["white-space", new Set(["keyword:pre", "keyword:pre-wrap", "keyword:break-spaces"])],
]);

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(\s*[0-9a-zA-Z.,%/+\-\s]+\)$/;
const NAMED_COLOR = /^[a-z]{3,25}$/;
const COLOR_KEYWORDS = new Set(["transparent", "currentcolor", "inherit"]);

export type StyleValueKind =
  | { kind: "color" }
  | { kind: "keyword"; keyword: string }
  | { kind: "number"; value: number };

/**
 * Validate a declaration value against the shapes allowed for its property.
 * The caller has already stripped `!important` candidates and comments.
 */
export function classifyStyleValue(property: string, value: string): StyleValueKind | null {
  const allowed = ALLOWED_STYLE_PROPERTIES.get(property);
  if (!allowed) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (/(url|var|expression|attr)\s*\(/.test(normalized)) return null;
  if (normalized.includes("\\")) return null;
  if (allowed.has("color")) {
    if (HEX_COLOR.test(normalized)) return { kind: "color" };
    if (FUNCTIONAL_COLOR.test(normalized)) return { kind: "color" };
    if (COLOR_KEYWORDS.has(normalized)) return { kind: "color" };
    if (NAMED_COLOR.test(normalized)) return { kind: "color" };
    return null;
  }
  if (allowed.has(`keyword:${normalized}`)) return { kind: "keyword", keyword: normalized };
  if (property === "font-weight" && /^[1-9]00$/.test(normalized)) {
    return { kind: "number", value: Number(normalized) };
  }
  // `rgba(0,0,0,.5)`-style fallbacks for text-decoration shorthand are rejected.
  return null;
}
