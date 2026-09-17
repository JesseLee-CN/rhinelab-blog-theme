/**
 * Synthetic canonical-article responses for the IR5 failure suite.
 *
 * Every fixture is a complete Astro-shaped article page (reader v1 contract) so
 * the reader path under test is the real one: fetch → contract → allow-list →
 * safe DOM. Only the single property under test differs from the valid page.
 */

/** Canonical article page shape produced by `PostLayout.astro`. */
export function articleHtml({ postId, canonicalPath, title, contentHtml }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<link rel="canonical" href="${canonicalPath}"></head><body>
<header class="site"><a href="/">JOYCE_MOORE</a></header>
<main><article data-pagefind-body data-reader-version="1" data-reader-kind="post" data-post-id="${postId}" data-canonical-path="${canonicalPath}">
<div data-reader-content><h1 class="page-title">${title}</h1><div class="prose">${contentHtml}</div></div>
</article></main>
<footer class="site">© JOYCE_MOORE</footer></body></html>`;
}

/** Paragraph text large enough that a leaked fixture is unmistakable in a diff. */
export function fillerParagraphs(marker, count) {
  return Array.from({ length: count }, (_, index) => `<p>${marker} 段落 ${index + 1}：沉浸式阅读夹具正文。</p>`).join("\n");
}

export function validArticle(target, marker) {
  return articleHtml({
    postId: target.postId,
    canonicalPath: target.href,
    title: `夹具文章 ${marker}`,
    contentHtml: `<h2 id="fixture-section">夹具小节</h2>\n${fillerParagraphs(marker, 12)}`,
  });
}

/** A page without the reader marker: the contract cannot be read at all. */
export function contractBrokenArticle(target, marker) {
  return articleHtml({
    postId: target.postId,
    canonicalPath: target.href,
    title: `夹具文章 ${marker}`,
    contentHtml: fillerParagraphs(marker, 4),
  }).replace(' data-reader-version="1"', "");
}

/** An active element inside the prose subtree: the whole response is unsupported. */
export function unsupportedArticle(target, marker) {
  return articleHtml({
    postId: target.postId,
    canonicalPath: target.href,
    title: `夹具文章 ${marker}`,
    contentHtml: `${fillerParagraphs(marker, 3)}\n<video controls src="/media/fixture.mp4"></video>`,
  });
}

/** The same id twice: the response is rejected as a contract violation. */
export function duplicateIdArticle(target, marker) {
  return articleHtml({
    postId: target.postId,
    canonicalPath: target.href,
    title: `夹具文章 ${marker}`,
    contentHtml: `<h2 id="dup-anchor">一</h2>\n${fillerParagraphs(marker, 3)}\n<h2 id="dup-anchor">二</h2>`,
  });
}

/** Valid article above the 2 MiB decoded ceiling. */
export function oversizedArticle(target, bytes = 2 * 1024 * 1024 + 96 * 1024) {
  const head = articleHtml({
    postId: target.postId,
    canonicalPath: target.href,
    title: "夹具文章 oversized",
    contentHtml: "<h2>超大夹具</h2>",
  });
  const padding = `<p>${"填充".repeat(1024)}</p>\n`;
  const repeats = Math.ceil(bytes / Buffer.byteLength(padding));
  return head.replace("</div></div>\n</article>", `${padding.repeat(repeats)}</div></div>\n</article>`);
}
