/**
 * Build the complex-Markdown fixture site with the *real* Astro configuration,
 * isolated under `.tools/immerse-reading/IR5/fixture-site/` (plan §11.3).
 *
 * Two environment overrides let the fixture build reuse `apps/blog` unchanged:
 *   BLOG_CONTENT_ROOT  content collection base (default `../../content`)
 *   BLOG_OUT_DIR       Astro outDir             (default `../../dist`)
 *
 * Nothing here writes into `content/` or `dist/`; the fixture content is
 * generated under `.tools/` and carries the IR5 sentinels so the release scan
 * has a positive control.
 *
 *   node scripts/reading/fixtures/build-fixture-site.mjs
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIXTURE_SENTINELS } from "./sentinel.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "../../..");
export const fixtureRoot = resolve(root, ".tools/immerse-reading/IR5/fixture-site");
const fixtureContent = resolve(root, ".tools/immerse-reading/IR5/fixture-content");

/** Sentinel used as ordinary prose text inside the fixture article. */
export const FIXTURE_TEXT_SENTINEL = FIXTURE_SENTINELS[0];
/** Sentinel used as the title of a draft post that must never be published. */
export const FIXTURE_DRAFT_SENTINEL = FIXTURE_SENTINELS[1];
/** Sentinel used as the title of a future-dated post. */
export const FIXTURE_FUTURE_SENTINEL = FIXTURE_SENTINELS[2];

/** Fixture article path; served for a real archive record by the e2e runner. */
export const FIXTURE_POST_PATH = "/2026/09/09/ir5-fixture-complex/";
export const FIXTURE_POST_ID = "post-1f5a4c9e-0f3d-4a51-9b7e-2c8d5a6f7b10";
/** Fixture article that contains an element outside the reader allow-list. */
export const FIXTURE_DISALLOWED_PATH = "/2026/09/07/ir5-fixture-disallowed/";
export const FIXTURE_DISALLOWED_POST_ID = "post-5e9b8a3c-4d71-4e95-bf12-6a2b9e0d1f54";

const complexMarkdown = `---
id: ${FIXTURE_POST_ID}
title: "夹具：复杂 Markdown 渲染"
description: "IR5 隔离夹具：表格、脚注、代码、嵌套列表、引用、图片与锚点。"
path: ${FIXTURE_POST_PATH}
publishedAt: 2026-09-09
categories: ["测试"]
tags: ["夹具", "IR5"]
author: "IR5 Fixture"
---

${FIXTURE_TEXT_SENTINEL} 用来证明这份正文只存在于夹具构建中。

## 段落与行内标记

普通段落含 **加粗**、*斜体*、\`行内代码\`、[站内链接](/about/) 与 [锚点](#表格与脚注)。
中文强调后接冒号：**注意：**这里是重点，用于验证 CJK flanking。
还有 ~~删除线~~、H~2~O 形式的下标写法保留原样，以及 <abbr title="HyperText Markup Language">HTML</abbr> 缩写。

## 列表

1. 有序第一项
2. 有序第二项
   - 嵌套无序项 A
   - 嵌套无序项 B
     - 更深一层
3. 有序第三项

- [x] 已完成事项
- [ ] 未完成事项

## 表格与脚注

| 列一 | 列二 | 列三 |
| --- | :---: | ---: |
| \`a\` | 中文 | 1 |
| \`b\` | **粗** | 22 |

表格中的脚注引用[^note-a]，以及第二个脚注[^note-b]。

[^note-a]: 第一个脚注的定义文本。
[^note-b]: 第二个脚注，含 \`代码\`。

## 代码

\`\`\`ts
export function fixture(value: number): number {
  // 中文注释与 <标签> 都必须原样保留
  return value * 2;
}
\`\`\`

\`\`\`bash
echo "ir5 fixture" && ls -la /tmp
\`\`\`

## 引用与图片

> 引用第一行
>
> 引用第二行，含 **强调**。

![夹具图片](/wp-content/uploads/2026/05/1778677188-IMG_776.jpg "本地图片标题")

<img src="/wp-content/uploads/2026/05/demo-responsive-placeholder.png" srcset="/wp-content/uploads/2026/05/demo-responsive-placeholder-150x150.png 150w, /wp-content/uploads/2026/05/demo-responsive-placeholder-300x300.png 300w" sizes="(max-width: 600px) 100vw, 300px" alt="响应式夹具图片" title="srcset 夹具" width="300" height="225" loading="eager">

## 详情折叠

<details>
<summary>展开查看</summary>

折叠内的段落文本。

</details>

## 参考资料

- 参考资料一：夹具来源。
- 参考资料二：${FIXTURE_TEXT_SENTINEL} 结尾标记。
`;

const draftMarkdown = `---
id: post-2b6e5d0f-1a4e-4b62-8c8f-3d9e6b7a8c21
title: "${FIXTURE_DRAFT_SENTINEL} 草稿不得发布"
description: "IR5 草稿夹具：任何公开产物都不得包含它。"
path: /2026/09/08/ir5-fixture-draft/
publishedAt: 2026-09-08
draft: true
---

草稿正文。
`;

const futureMarkdown = `---
id: post-3c7f6e1a-2b5f-4c73-9d90-4e0f7c8b9d32
title: "${FIXTURE_FUTURE_SENTINEL} 未来样本"
description: "IR5 未来日期夹具：BUILD_NOW 之前不得发布。"
path: /2099/01/01/ir5-fixture-future/
publishedAt: 2099-01-01
---

未来正文。
`;

const aboutMarkdown = `---
id: post-4d8a7f2b-3c60-4d84-ae01-5f1a8d9c0e43
title: "夹具关于页"
description: "IR5 页面夹具。"
path: /ir5-fixture-about/
publishedAt: 2026-09-01
---

页面夹具正文。
`;

/**
 * Raw HTML that the reader allow-list does not cover. The documented behaviour
 * (CONTRACT.md §5) is one clean fallback for the whole article rather than a
 * half-rendered page, so this fixture asserts the fallback on real Astro
 * output instead of on a hand-written response.
 */
const disallowedMarkdown = `---
id: post-5e9b8a3c-4d71-4e95-bf12-6a2b9e0d1f54
title: "夹具：未授权元素回退"
description: "IR5 夹具：文章正文包含允许清单之外的元素，必须整体回退到独立文章页。"
path: /2026/09/07/ir5-fixture-disallowed/
publishedAt: 2026-09-07
---

开头段落。

> 引用内容
>
> <footer>引用来源</footer>

结尾段落。
`;

export async function writeFixtureContent() {
  await rm(fixtureContent, { recursive: true, force: true });
  await mkdir(resolve(fixtureContent, "posts"), { recursive: true });
  await mkdir(resolve(fixtureContent, "pages"), { recursive: true });
  await writeFile(resolve(fixtureContent, "posts/ir5-fixture-complex.md"), complexMarkdown);
  await writeFile(resolve(fixtureContent, "posts/ir5-fixture-draft.md"), draftMarkdown);
  await writeFile(resolve(fixtureContent, "posts/ir5-fixture-future.md"), futureMarkdown);
  await writeFile(resolve(fixtureContent, "posts/ir5-fixture-disallowed.md"), disallowedMarkdown);
  await writeFile(resolve(fixtureContent, "pages/ir5-fixture-about.md"), aboutMarkdown);
  return fixtureContent;
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}`))));
  });
}

/** Build the fixture site; returns the HTML of the fixture article. */
export async function buildFixtureSite({ now = "2026-09-10T00:00:00.000Z" } = {}) {
  await writeFixtureContent();
  await rm(fixtureRoot, { recursive: true, force: true });
  // The Astro content-layer cache is a build artefact that survives between
  // builds; clearing it on both sides keeps fixture entries out of the real
  // `dist/` build (and vice versa). The sentinel scan in check-reader is the
  // independent guard on the same property.
  await clearContentCache();
  try {
    // The harness refuses `spawnSync(..., {stdio:'inherit'})` for npm wrappers,
    // so the workspace binary is invoked directly with an explicit stdio.
    const astro = resolve(root, "node_modules/astro/bin/astro.mjs");
    await run(process.execPath, [astro, "build"], {
      cwd: resolve(root, "apps/blog"),
      env: {
        ...process.env,
        BUILD_NOW: now,
        BLOG_CONTENT_ROOT: fixtureContent,
        BLOG_OUT_DIR: fixtureRoot,
      },
    });
  } finally {
    await clearContentCache();
  }
  return readFixtureArticleHtml();
}

/** Drop the Astro content-layer cache (`apps/blog/.astro`). */
export async function clearContentCache() {
  await rm(resolve(root, "apps/blog/.astro"), { recursive: true, force: true });
}

export async function readFixtureArticleHtml(path = FIXTURE_POST_PATH) {
  const file = resolve(fixtureRoot, path.replace(/^\/+|\/+$/g, ""), "index.html");
  return readFile(file, "utf8");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const html = await buildFixtureSite();
  console.log(`夹具站点构建完成：${fixtureRoot.replace(root, ".")}（文章 HTML ${Buffer.byteLength(html)} 字节）`);
}
