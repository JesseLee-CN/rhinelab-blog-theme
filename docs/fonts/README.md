# 字体

本站自托管两套字体：**MiSans**（正文/UI）与 **JetBrains Maple Mono**（代码）。字体文件随构建
复制进发布产物，不依赖第三方 CDN。

## 1. 字体栈

| 用途 | 家族 | 字重 | 来源与许可 |
| --- | --- | --- | --- |
| 正文 / UI | **MiSans** | 300 / 400 / 600 / 700（Light / Regular / DemiBold / Bold） | 小米官方字体，允许免费商用与网页嵌入；许可原文 `public/fonts/MiSans-license.pdf` |
| 代码 | **JetBrains Maple Mono** | Regular / Bold（子集） | OFL-1.1；许可原文 `public/fonts/JetBrains-Maple-Mono-OFL.txt` |
| 回退 | PingFang SC / Microsoft YaHei / system-ui | — | 系统字体 |

- 族名统一为 `MiSans`；CSS 中**不使用 `local()`**，避免本机安装的同名字体顶替固定文件。
- `--font-mono`（含阅读层）指向 `"JetBrains Maple Mono", "MiSans", …`。
- 许可入口同时出现在设置弹框：`MiSans-license.pdf` 与 `JetBrains-Maple-Mono-OFL.txt`。

## 2. 覆盖范围

MiSans 每个字重声明 **188–189 片 woff2 分片、合计 29 415 个码位**（四字重一致）：

| 区块 | 码位 | 说明 |
| --- | --- | --- |
| 拉丁（基本 + 扩展） | 372 | 含常见标点与符号 |
| 西里尔 / 希腊 | 136 / 80 | — |
| 平假名 / 片假名 | 90 / 93 | 日文假名可用 |
| 注音 | 37 | — |
| CJK 统一表意 | 20 976 | 简体与繁体同码位（SC 字形） |
| CJK 扩展 A | 6 582 | — |
| CJK 扩展 B | 42 | — |
| CJK 扩展 C–G | 160 | 罕见字有覆盖 |
| 谚文音节 | 0 | **不含韩文**；需要时另配韩文子包或 Noto Sans KR |

## 3. 体积与传输

| 项 | 数值 |
| --- | --- |
| MiSans 资产 | 753 片 = **23.33 MiB**（4 字重 × 188/189 片） |
| 首屏实际请求 | `/lab/` **19 片**、文章页 **39 片**（按 `unicode-range` 按需拉取，实测全部 200） |
| 代码字体 | 2 × woff2 = 474 KB（文章页 2 个请求） |

> 资产体积不等于首屏传输量：浏览器只请求页面实际用到码位所在的分片。

## 4. 来源与重建

构建脚本：`.tools/font-sans/build-fonts.mjs`（该目录为本地工具目录，不随仓库分发；
下面的步骤说明它做什么，按同样规则可以自行重建）。

1. **MiSans**：从 npm 取 `misans-webfont@4.3.1`（校验 `sha512`）→ 解包 → 读取各字重
   `result.min.css` 里每片的 `unicode-range` → 按字节复制分片 → 生成 `shared/misans.css`
   （族名 `MiSans`、字重 300/400/600/700、去掉 `local()`、URL 指向 `/fonts/misans/<weight>/<shard>.woff2`）。
2. **代码字体**：下载 `JetBrainsMapleMono` 发布包 → 取 Regular/Bold → `fontTools.subset`
   （保留全部 layout features，连字不丢）→ 输出 woff2。
3. 同时落盘许可与 `*-source.json`（记录来源、包版本与逐文件 `sha256`）。

**资源投递**：`scripts/blog/prepare-assets.mjs` 按白名单把字体复制到
`.generated/lab-public/fonts/`（`/lab/`）与 `apps/blog/public/fonts/`（Astro，已 gitignore）。
后者每次构建整体重铺，并**清理不在白名单里的旧字体文件**——换字体时务必确认产物里没有旧字体残留。

## 5. 验证

```bash
npm run build:blog && npm run build:lab && npm run search:index
npm run check:site          # 产物完整性；检查字体是否只剩 misans 与 jetbrains-maple-mono
npm run test:reader         # 阅读层（含代码块字体）
```

检查要点：

- `dist` 内字体只有 `misans` 与 `jetbrains-maple-mono` 两棵目录，且不含 `.ttf`；
- `/lab/` 与文章页的字体请求全部 200，浏览器 computed `font-family` 为 `MiSans`；
- 阅读层 `pre` 的实际字体为 JetBrains Maple Mono；
- 品牌字样的排版宽度（换字重或字号后需重新量测）。

## 6. 维护

- 更新字体：重跑构建脚本 → 重新构建站点 → 复查 §5。
- 需要更广覆盖：MiSans 包内还有繁中子包、拉丁子包以及阿拉伯/天城文/泰文等子包，
  可按需加入重建脚本的字重与子包表；韩文需另找子包或 Noto Sans KR。
- 许可：OFL 要求随附许可证原文，小米许可要求保留许可声明——两者都已随发布分发并提供入口。
  **不要删除 `public/fonts/` 下的许可文件。**

## 7. 相关文档

- [docs/README.md](../README.md)：文档索引
- [UPSTREAM.md](../UPSTREAM.md)：第三方资源与许可汇总
- [../README.md](../../README.md)：项目定位与许可范围
