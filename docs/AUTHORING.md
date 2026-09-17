# 写作与内容维护

`content/` 是本站正文的**唯一来源**。首页列表、文章页、摘要、RSS、sitemap、Pagefind 搜索索引与
`/lab/` 三维卡片全部由同一份内容派生，因此改内容不需要动页面代码。

## 1. 目录约定

| 路径 | 用途 |
| --- | --- |
| `content/posts/*.md` | 博客文章，一篇一个文件 |
| `content/pages/*.md` | 独立页面（关于、友链、说明等） |
| `content/lab-collections.json` | 三维档案的五个策展主题，引用文章 `id` |
| `content/README.md` | 字段速查（与本文件配合使用） |

文件名只用于本地辨识，**规范地址由 frontmatter 的 `path` 决定**，文章身份由 `id` 决定。

## 2. frontmatter 字段

```yaml
---
id: post-hello
title: 从 WordPress 到 Markdown
description: 用于首页、搜索、分享和三维卡片的摘要。
path: /2026/09/09/hello-rhinelab/
publishedAt: "2026-09-09T10:00:00+08:00"
updatedAt: "2026-09-09T10:00:00+08:00"
draft: false
categories: [技术]
tags: [Astro, Markdown]
author: Example Author
cover: /blog/cover-sample.svg
legacyUrls:
  - /?p=101
---
```

| 字段 | 规则 |
| --- | --- |
| `id` | **稳定身份**。发布后不要因标题或排序改动；导入文章可沿用 `wp-<数字>`，新文建议 `post-<短标识>` |
| `title` | 非空；用于页面标题、分享卡片与三维卡片 |
| `description` | 非空，≤300 字；用于列表摘要、搜索与分享描述 |
| `path` | 唯一规范站内路径；**不得**与 `/lab/`、`/tags/`、`/categories/`、`/search/`、`/archive/`、`/rss.xml` 等系统路由冲突 |
| `publishedAt` / `updatedAt` | 带时区的 ISO 8601。`publishedAt` 晚于构建时间的内容视为未来文章，不进入任何公开产物 |
| `draft` | `true` 时不进入 HTML、JS/JSON、RSS、sitemap、搜索索引与 TXT |
| `categories` / `tags` | 字符串数组；分类驱动分类页与三维主题，标签只影响标签页与搜索 |
| `author` | 可选，缺省用 schema 中的默认作者 |
| `cover` | 可选；写站内路径时必须是 `apps/blog/public` 下真实存在的文件，否则校验失败 |
| `legacyUrls` | 可选；旧地址数组，用于生成一对一永久重定向 |

> **易错点**：值里出现 `: ` 必须加引号。例如 `description: 演示 draft: true 的效果` 会让 YAML
> 解析失败并报 `bad indentation of a mapping entry`——写成 `description: "演示 draft: true 的效果"`。

## 3. 写作流程

```bash
npm run dev:blog         # 本地写作与预览（默认 http://127.0.0.1:4321）
npm run check:content    # 字段、ID/路径唯一性、保留路由、封面存在性、主题引用
npm run test:blog        # 内容契约单元测试
npm run build            # 生成站点、/lab/ 与搜索索引
npm run preview          # 静态预览，未知路径返回真实 404
```

`check:content` 的判定顺序是「先校验、后构建」：任何一项不通过，构建会停在第一步，不会产出半成品。

## 4. 草稿、未来文章与私密内容

- `draft: true` 与 `publishedAt` 在未来的文章**不会**出现在首页、文章页、RSS、sitemap、搜索索引
  或三维卡片里；构建产物的任何文件中都查不到它们的标题与正文。
- 校验与检查脚本会主动核对这一点：`npm run check:site` 会扫描产物中的未公开标题并直接失败。
- **公开 Git 仓库不能保护草稿**。需要保密的正文请放在私有仓库或本地未跟踪目录，不要提交进来。

## 5. URL、重定向与删除

- `path` 是规范地址，发布后应保持稳定；确需变更时，把旧地址写进该文的 `legacyUrls`，并保证
  旧地址仍能跳到新地址（一对一），未知路径必须返回**真实 404**，不要做全站跳首页。
- 删除文章意味着它的地址失效；如果它被外部链接引用，建议先保留页面并标注归档，再决定是否移除。
- 中文路径可用，但以百分号编码出现在 URL 中；如需可复制的英文地址，直接用英文 slug 作为 `path`。

## 6. 三维主题映射

`content/lab-collections.json` 定义五个策展主题，每个主题最多八个槽位：

```json
{ "name": "技术", "description": "开发、工具与迁移记录", "postIds": ["post-hello"] }
```

- `postIds` 只能引用**已公开**文章的 `id`；悬空引用、重复引用与未公开引用会被校验拒绝。
- 主题不足八篇时可重复映射同一篇文章；空主题当前回退显示全部公开文章，不会生成假文章。
- 三维卡片上的标题、摘要与编号取自同一份内容，改文章不用改三维配置。

## 7. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `frontmatter YAML 解析失败` | 值里有 `: ` 且未加引号；见 §2 的易错点 |
| `路径与系统路由冲突` | `path` 撞上了 `/lab/`、`/search/` 等保留前缀，换一个 |
| `封面不存在` | `cover` 指向的文件不在 `apps/blog/public` 下，或路径大小写不符 |
| 草稿出现在产物里 | 检查 `draft` 与 `publishedAt`；`check:site` 会直接报出泄漏的文件名 |
| 中文标点后的 `**加粗**` 不生效 | 确认 `apps/blog/astro.config.mjs` 仍启用 `remark-cjk-friendly` |
| 三维卡片看不到新文章 | 新文章未出现在 `lab-collections.json` 的主题槽位里 |

## 8. 相关文档

- [docs/README.md](README.md)：文档索引
- [BUILD.md](BUILD.md)：构建与发布
- [READER.md](READER.md)：沉浸式阅读层
- [../content/README.md](../content/README.md)：字段速查（与本文同步维护）
