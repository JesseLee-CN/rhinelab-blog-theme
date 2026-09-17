# 阅读层 markdown 呈现 · 全面比对与 anuppuccin 落地清单

日期：2026-09-13。触发：用户反馈「底部声明的斜体没有生效」，要求全面检查阅读层还有多少 markdown 样式没生效、以及此前要求的 [anuppuccin](https://github.com/AnubisNekhet/anuppuccin) 结构还有多少没落地。

比对工具：`.tools/immerse-reading/compare-blog-reader.mjs`（**同一篇文章**在博客页与阅读层分别取计算样式：35 个元素 × 21 个属性 + `::marker`，逐项列出差异并输出特性清单）。复核工具：`.tools/immerse-reading/verify-reader-head.mjs`（斜体/选中/目录/列表实测与截图）。

## 1. 结论

- 首轮审计：**90 处差异**，其中 **4 类属真实缺陷**（斜体、选中高亮、方角列表标记、分类标签颜色），其余为两个表面之间的**刻意差异**（阅读层基准 18px vs 博客页 16px、阅读层的 anuppuccin 结构、主题令牌取色）。
- 修复后复跑：**74 处差异，全部为刻意差异**（见 §3），无未实现项。
- anuppuccin 清单：声称的 **9 项结构特性现已全部落地**（其中 2 项此前只是注释里声称、实际未写规则），另外 4 项属参考主题的插件行为/调色板，本站**有意不移植**（见 §4）。

## 2. 本轮修复（4 项）

| 缺陷 | 根因 | 修复 |
| --- | --- | --- |
| **`<em>` 斜体不生效** | 实验室根 `src/style.css:16` 设了 `font-synthesis: none`；MiSans 无斜体字面，阅读层 dialog 在 `#stage` 之外也继承到这条，而博客页没设、浏览器合成了倾斜 | `.article-reader .reader-content { font-synthesis: weight style small-caps }`（恢复初始值，只作用于阅读区）。实测 `em` → `fontStyle: italic` |
| **选中高亮未实现**（文件头声称 "accent-highlighted selections"） | 全仓没有任何 `::selection` 规则 | 新增 `.reader-content ::selection { background: color-mix(in srgb, var(--reader-accent) 30%, transparent); color: var(--reader-ink) }` |
| **方角列表标记未实现**（声称 "square list markers"） | 原规则只设置 `::marker` 颜色，没有形状 | `ul > li { list-style-type: square }`、`ul ul > li { list-style-type: circle }`（层级实心/空心交替，颜色仍按层级取 `--reader-muted` / `--reader-accent`） |
| **分类标签颜色与文章页不一致** | 新写的 `.taxonomy a` 用了 `--reader-muted` | 改为 `--reader-ink`（与博客页 `ul.taxonomy a` 一致），悬停/聚焦转 `--reader-accent` |

同时按用户要求：**内联目录去掉编号与行首符号，只用缩进区分层级**（`.toc ol { list-style: none; padding-left: 0 }`、`.toc-sub { margin-left: 1.25rem; list-style: none }`）。目录条目文字里自带的「一、」「4.1」是**标题本身的文本**，不属于列表编号，未做剥离。

## 3. 仍存在的差异（74 处，均为刻意设计）

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| `fontSize` / `lineHeight` 比例 | 12 + 19 | 阅读层基准字号 `--reader-font-size: 18px`，博客页 16px；所有字号/行高按同一比例放大，属既定阅读尺寸 |
| 间距（`marginTop`/`marginBottom`/`padding*`） | 10 + 6 + 6 | 阅读层的 anuppuccin 节奏（h2 32px 上距、引用 8.8/14.4px 内距、列表项 4px 间距、`.meta` 12px 下距等） |
| 颜色与底色 | 6 + 4 | 阅读层一律用主题令牌（`--reader-*` + `color-mix`）：引用块为强调色洗底、代码块为浅色细线框（博客页是 Shiki 深色块）、目录方块为墨色 5% 洗底（博客页是 `--paper-raised` 实色） |
| 结构标记 | 4 | `ul > li` 方角（博客页 disc）、`.toc li` / `.toc-sub` 无编号无符号（用户要求） |
| 边框 | 4 | 阅读层 h3 也有 1px 细线、代码块有 1px 直角边框（博客页无） |
| `fontWeight` 1 处 | 1 | `strong` 阅读层 600（anuppuccin 的中性强调，MiSans DemiBold 为真实字面）、博客页 700 |
| `letterSpacing` 1 处 | 1 | h2 在阅读层带 -0.6px 紧排 |

## 4. anuppuccin 落地清单

| 参考主题特性 | 状态 | 证据 |
| --- | --- | --- |
| 全直角（`border-radius: 0`） | ✅ | IR11「窗口内所有 markdown 元素都是直角」；直角守卫覆盖整个 `.reader-content` |
| h1–h3 细线分隔 | ✅ | IR11 h2/h3 `border-bottom: 1px solid` |
| 引用双层（强调色竖条 + 洗底） | ✅ | IR11 3px 竖条；实测底色为 accent 9% 洗底 |
| 表格细线 + 表头底色 + 行条纹 | ✅ | IR11（夹具文章含表格）：表格/表头/单元格 1px 细线、表头左对齐、表头底色与条纹 |
| **方角列表标记（层级实心/空心交替）** | ✅（本轮补上形状） | 实测 `ul > li` → `square`；嵌套 → `circle`；IR11「列表标记可读」 |
| 水平线 1px 细线 | ✅ | IR11「水平线是实心 1px 细线」 |
| 行内代码中性洗底 | ✅ | 实测 `ink 9%` 洗底 + 0.12/0.34em 内距 |
| **选中高亮（accent 洗底）** | ✅（本轮新增） | `.reader-content ::selection` 规则存在，wash = accent 30% |
| 代码块方角细线框 | ✅ | IR11「代码块有 1px 直角边框」；并覆盖 Shiki 行内 `github-dark` 底色 |
| 任务清单方框（`input[type=checkbox]` 自绘） | ✅ | §5 规则 + IR11 直角检查 |
| 折叠块（details/summary） | ✅ | IR11「details 折叠块有 1px 直角边框」 |
| 高亮 `mark` 的强调色洗底 | ✅ | IR11「高亮使用强调色洗底」 |
| `--ctp-*` 调色板（Catppuccin 命名色） | ⛔ 有意不移植 | 文件头已写明：颜色全部落在本站 `--reader-*` 令牌 |
| Callout / admonition 块 | ⛔ 不适用 | 本站 Markdown 无 callout 语法（允许清单里也没有对应结构） |
| 内部链接/标签的 Obsidian 式样式 | ⛔ 不适用 | 静态站点用普通 `a` 与 `ul.taxonomy`（后者已按文章页做成描边标签） |
| 列表折叠、滚动条等插件行为 | ⛔ 不适用 | 参考主题是 Obsidian 插件；阅读层是只读投影，交互由目录导航条承担 |

## 5. 回归

`test:reader`（0 失败）、`check:reader`（4 篇契约完整）、IR11 markdown 探针 **41/41**、`test:reader-e2e --suite all` **19/19 场景、338/338 检查**、五步构建 + `check:site`；生产无头实测 `em` 为 italic、`::selection` 规则存在、目录 `list-style: none` + 子项 20px 缩进、`ul` 为 square。发布 site `20260913T055016Z-9b2ec83`。
