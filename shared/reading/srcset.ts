/**
 * WHATWG srcset candidate parsing and rewriting.
 *
 * Implemented after the HTML Standard "parse a srcset attribute" algorithm
 * (https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute)
 * so that URLs containing commas, several whitespace forms and w/x descriptors
 * survive a rewrite. No DOM APIs are used: the module runs in Node tests, in the
 * build checker and in the browser reader.
 */

export type SrcsetDescriptor =
  | { kind: "width"; value: number; raw: string }
  | { kind: "density"; value: number; raw: string };

export type SrcsetCandidate = {
  url: string;
  descriptor: SrcsetDescriptor | null;
  descriptorRaw: string | null;
};

export type SrcsetParseResult = {
  candidates: SrcsetCandidate[];
  /** Per-candidate syntax problems. A non-empty list must not be trusted. */
  errors: string[];
};

const ASCII_WHITESPACE = /[\t\n\f\r ]/;

function isAsciiWhitespace(char: string | undefined): boolean {
  return char !== undefined && ASCII_WHITESPACE.test(char);
}

/** Collect one whitespace-delimited token, stopping before a comma. */
function collectToken(input: string, position: number): { token: string; position: number; atComma: boolean } {
  let token = "";
  let index = position;
  for (;;) {
    const char = input[index];
    if (char === undefined) return { token, position: index, atComma: false };
    if (isAsciiWhitespace(char)) {
      while (isAsciiWhitespace(input[index])) index += 1;
      if (input[index] === ",") return { token, position: index + 1, atComma: true };
      return { token, position: index, atComma: false };
    }
    if (char === ",") return { token, position: index + 1, atComma: true };
    token += char;
    index += 1;
  }
}

/** Collect one parenthesised descriptor, allowing nested parentheses. */
function collectParenthesised(input: string, position: number): { token: string; position: number; atComma: boolean; unterminated: boolean } {
  let token = "(";
  let depth = 1;
  let index = position + 1;
  for (;;) {
    const char = input[index];
    if (char === undefined) return { token, position: index, atComma: false, unterminated: true };
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        token += ")";
        index += 1;
        while (isAsciiWhitespace(input[index])) index += 1;
        if (input[index] === ",") return { token, position: index + 1, atComma: true, unterminated: false };
        return { token, position: index, atComma: false, unterminated: false };
      }
    }
    token += char;
    index += 1;
  }
}

function parseDescriptor(token: string): { descriptor: SrcsetDescriptor | null; error: string | null } {
  const width = /^([0-9]+)w$/.exec(token);
  if (width) {
    const value = Number(width[1]);
    if (!Number.isSafeInteger(value) || value <= 0) return { descriptor: null, error: `无效宽度 descriptor：${token}` };
    return { descriptor: { kind: "width", value, raw: token }, error: null };
  }
  const density = /^([0-9]*\.[0-9]+|[0-9]+\.?[0-9]*)x$/.exec(token);
  if (density) {
    const value = Number(density[1]);
    if (!Number.isFinite(value) || value <= 0) return { descriptor: null, error: `无效像素密度 descriptor：${token}` };
    return { descriptor: { kind: "density", value, raw: token }, error: null };
  }
  return { descriptor: null, error: `无法识别的 descriptor：${token}` };
}

/**
 * Parse a srcset attribute into candidates. Mirrors the spec closely enough for
 * author-written `srcset` values produced by Markdown/Astro rendering.
 */
export function parseSrcset(value: string): SrcsetParseResult {
  const errors: string[] = [];
  const candidates: SrcsetCandidate[] = [];
  let input = (value ?? "").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  // Trailing commas are allowed by the spec and simply ignored.
  input = input.replace(/,+$/, "");
  if (!input) return { candidates, errors };

  let position = 0;
  let awaitingUrl = false;

  for (;;) {
    while (isAsciiWhitespace(input[position])) position += 1;
    if (!awaitingUrl && input[position] === ",") {
      position += 1;
      continue;
    }

    let url: string;
    if (input[position] === "(") {
      const collected = collectParenthesised(input, position);
      url = collected.token;
      position = collected.position;
      awaitingUrl = !collected.atComma;
      if (collected.unterminated) errors.push(`未闭合的括号：${collected.token}`);
    } else {
      const collected = collectToken(input, position);
      url = collected.token;
      position = collected.position;
      awaitingUrl = !collected.atComma;
    }
    if (!url) {
      if (position >= input.length) break;
      continue;
    }

    let descriptor: SrcsetDescriptor | null = null;
    let descriptorRaw: string | null = null;
    for (;;) {
      while (isAsciiWhitespace(input[position])) position += 1;
      if (position >= input.length || input[position] === ",") break;
      let token: string;
      let atComma: boolean;
      if (input[position] === "(") {
        const collected = collectParenthesised(input, position);
        token = collected.token;
        position = collected.position;
        atComma = collected.atComma;
        if (collected.unterminated) errors.push(`未闭合的括号：${token}`);
      } else {
        const collected = collectToken(input, position);
        token = collected.token;
        position = collected.position;
        atComma = collected.atComma;
      }
      if (!token) break;
      if (descriptor === null) {
        const parsed = parseDescriptor(token);
        if (parsed.error) errors.push(parsed.error);
        descriptor = parsed.descriptor;
        descriptorRaw = token;
      } else {
        errors.push(`多余的 descriptor：${token}`);
      }
      if (atComma) break;
      if (position >= input.length) break;
    }

    candidates.push({ url, descriptor, descriptorRaw });
    if (position >= input.length) break;
  }

  const seenWidths = new Set<number>();
  const seenDensities = new Set<number>();
  for (const candidate of candidates) {
    if (!candidate.descriptor) continue;
    const bucket = candidate.descriptor.kind === "width" ? seenWidths : seenDensities;
    if (bucket.has(candidate.descriptor.value)) {
      errors.push(`重复 descriptor：${candidate.descriptorRaw}`);
    }
    bucket.add(candidate.descriptor.value);
  }

  return { candidates, errors };
}

/**
 * Percent-encode the characters that would change how a rewritten `srcset`
 * parses: whitespace, the delimiter comma and the parenthesis form.
 */
export function encodeSrcsetUrl(url: string): string {
  return url.replace(/[\t\n\f\r ,()"'\\]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return "%" + code.toString(16).toUpperCase().padStart(2, "0");
  });
}

/** Serialise candidates back into a `srcset` attribute value. */
export function serializeSrcset(candidates: readonly SrcsetCandidate[]): string {
  return candidates
    .map((candidate) => {
      const url = encodeSrcsetUrl(candidate.url);
      return candidate.descriptorRaw ? `${url} ${candidate.descriptorRaw}` : url;
    })
    .join(", ");
}

export type SrcsetRewrite = {
  value: string | null;
  candidates: SrcsetCandidate[];
  errors: string[];
  dropped: { url: string; reason: string }[];
};

/**
 * Rewrite every candidate URL through `rewrite`. A candidate that the rewriter
 * rejects is dropped and reported; the surviving candidates are serialised in
 * source order. When nothing survives the attribute is removed (`value: null`).
 */
export function rewriteSrcset(
  value: string,
  rewrite: (url: string) => { url: string } | { error: string },
): SrcsetRewrite {
  const parsed = parseSrcset(value);
  const errors = [...parsed.errors];
  const dropped: { url: string; reason: string }[] = [];
  const candidates: SrcsetCandidate[] = [];
  for (const candidate of parsed.candidates) {
    const result = rewrite(candidate.url);
    if ("error" in result) {
      dropped.push({ url: candidate.url, reason: result.error });
      continue;
    }
    candidates.push({ ...candidate, url: result.url });
  }
  return { value: candidates.length ? serializeSrcset(candidates) : null, candidates, errors, dropped };
}

/** Normalised whitespace form, for tests and comparisons. */
export function normalizeSrcset(value: string): string {
  return serializeSrcset(parseSrcset(value).candidates);
}
