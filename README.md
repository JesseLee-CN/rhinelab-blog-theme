# RhineLab Blog Theme

一个可直接 fork 的个人博客模板：**Markdown 写作 + Git 发布 + 静态部署**，并保留 RhineLabUI 的 TypeScript / Three.js 三维界面作为独立的 `/lab/` 入口。

- 博客由 Astro 生成静态 HTML，文章有独立规范 URL，**禁用 JavaScript 或 WebGL 仍可阅读**
- `/lab/` 是一个三维档案终端：启动身份选择、注册/登录、档案阵列、沉浸式全文阅读
- 内容、摘要、RSS、sitemap、搜索索引与三维卡片**全部由同一份 Markdown 派生**
- 发布采用「本机构建 → 上传不可变 release → 服务器激活」，失败不替换线上、可回滚

> 本仓库是脱敏后的模板版本：域名、服务器地址、账号、备案号与个人文章均已替换为中性示例，
> 与任何真实站点无关。改动记录见 [SANITIZE-NOTES.md](SANITIZE-NOTES.md)。

## 快速开始

需要与 `package-lock.json` 兼容的 Node.js / npm（开发环境为 Node.js 24.14.0、npm 11.9.0）。

```bash
npm ci --ignore-scripts
npm run dev:blog        # 博客写作与预览
npm run dev:lab         # 三维入口开发（地址以终端输出为准）
```

构建与本地预览：

```bash
npm run check:content   # 内容 schema、路径、草稿、封面与主题引用
npm run check:features  # 功能模块边界（入口唯一、无跨功能穿透、无孤儿文件）
npm run test:blog       # 内容契约单元测试
npm run typecheck       # 三维 TypeScript 检查
npm run build           # 校验 → 功能边界 → Astro → /lab/ → Pagefind → 整站检查
npm run preview         # 静态 dist/ 预览，未知路径返回真实 404
```

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `content/posts/`、`content/pages/` | 正文唯一来源（Markdown） |
| `content/lab-collections.json` | 三维档案的五个策展主题，引用稳定文章 ID |
| `apps/blog/` | Astro 子应用：页面、布局、样式与内容契约 |
| `src/`、`lab/` | 三维应用（上游代码）与 `/lab/` 入口 |
| `src/features/<id>/` | 本站自有功能模块：启动身份门与登录（`auth`）、沉浸式阅读（`reader`） |
| `shared/` | 博客与三维入口共用的库：阅读层纯逻辑、字体 CSS |
| `scripts/blog/` | 内容校验、摘要生成、构建编排、打包与预览 |
| `ops/` | 参数化部署、nginx 配置、systemd unit、回滚与 smoke 工具 |
| `services/lab-auth/` | 启动身份认证服务（Go + SQLite） |
| `art/`、`reference/` | Blender 工程与可复现脚本、开发对照工具 |
| `docs/` | 说明性文档：写作、构建与发布、功能模块、阅读层、身份与认证、上游与许可 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/FEATURES.md](docs/FEATURES.md) | 功能模块划分：新增功能清单、宿主端口与门面、边界规则、增删流程 |
| [docs/AUTHORING.md](docs/AUTHORING.md) | 写作与内容维护：frontmatter、草稿与未来文章、URL 与重定向、三维主题映射 |
| [docs/BUILD.md](docs/BUILD.md) | 构建与发布：构建顺序、本地预览、资源白名单、release 打包与激活、回滚、排障 |
| [docs/READER.md](docs/READER.md) | 沉浸式阅读：窗口与布局参数、控件与目录导航、内容白名单、滚动恢复 |
| [docs/IDENTITY.md](docs/IDENTITY.md) | 账号体系：身份规则、接口与错误、Cookie/CSRF、账号库管理（CLI 与管理 API）、与博客共享登录态 |
| [docs/UPSTREAM.md](docs/UPSTREAM.md) | 上游来源与署名、第三方资源许可、处理上游更新的原则 |
| [docs/fonts/README.md](docs/fonts/README.md) | 字体来源、许可与重建方式 |
| [docs/README.md](docs/README.md) | 文档索引 |
| [SANITIZE-NOTES.md](SANITIZE-NOTES.md) | 本模板的脱敏范围与替换规则 |

## 换掉示例内容

1. 编辑 `content/posts/*.md` 与 `content/pages/*.md`，按 [content/README.md](content/README.md) 填写 frontmatter。
2. 在 `content/lab-collections.json` 里把主题槽位指向你自己的文章 `id`。
3. 站点 origin 通过环境变量 `BLOG_SITE_ORIGIN` 指定（默认值见 `apps/blog/astro.config.mjs`）。
4. 站名、作者与页脚在 `apps/blog/src/layouts/BaseLayout.astro`、`apps/blog/src/pages/index.astro` 与
   `apps/blog/src/content/schema.mjs` 的 `author` 默认值中调整。
5. 如需备案信息，按 `BaseLayout.astro` 页脚注释处填回自己的备案号（模板默认不含任何备案号与图标）。

## 部署

部署相关文件全部参数化，仓库内**不含任何真实主机、密钥或账号**：

```bash
cp ops/upload.env.example ops/upload.env      # SSH_HOST / SSH_USER / SSH_IDENTITY / DEPLOY_ROOT
npm run build
npm run release -- --id "$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
bash ops/upload-release.sh --id <release-id> --activate
node ops/smoke-test.mjs https://example.com
```

服务器侧只接收并激活不可变 release，不安装 Node、不在线上编译。回滚、备份、健康检查与排障见
[BLOG-MAINTAIN-PERFECT.md](BLOG-MAINTAIN-PERFECT.md)。

## 三维入口与阅读层

三维视觉与行为基线见 [DESIGN.md](DESIGN.md)；沉浸式全文阅读的页面契约、窗口与布局参数、控件与
目录导航、内容白名单与滚动恢复见 [docs/READER.md](docs/READER.md)，**改动 reader 之前先读它**。
三维复核入口见 [verification/README.md](verification/README.md)。

## 来源与许可

三维界面基于 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)，参考《明日方舟》特别映像
「莱茵生命：访问」。保留原作者 **Copyright (c) 2026 LBEILC** 署名与 [MIT License](LICENSE)；
本项目与原作官方无隶属关系。

**授权范围**：上游作者对其创作且有权授权的全部内容统一采用 MIT，版权署名为
**Copyright (c) 2026 LBEILC**。范围包括程序代码、建模脚本、技术文档、Blender 源工程、GLB 模型、
原创配乐与音效，以及图像、动图和其他原创资源——**非代码资产同样适用该许可**。

这意味着你可以使用、复制、修改、制作衍生版本和再分发这些内容（随仓库、Release 或安装包发布，
以及用于截图、GIF 与演示视频），商业、非商业、开源或闭源项目均可，无需另行取得作者许可；
分发上述内容或其重要部分时，须保留版权声明与 MIT 许可证。所有获授权内容按原样提供，不作担保。

以下第三方内容与权利**不在** MIT 授权范围内：

- **《明日方舟》相关内容**：包括《明日方舟》及莱茵生命相关名称、标志、设定、原 PV、原作视觉设计、
  原片音频采样及其衍生片段，以及它们在模型、界面、截图或演示文本中的呈现。相关权利归各自权利人
  所有，本项目无法代替他们授权。
- **其他第三方资源**：各字体、依赖与素材继续遵循各自的许可证与版权声明，不因授权范围扩大而改变：

- [MiSans 字体许可](public/fonts/MiSans-license.pdf)（正文/UI；小米官方 woff2 分包）
- [JetBrains Maple Mono 许可](public/fonts/JetBrains-Maple-Mono-OFL.txt)（代码字体；OFL-1.1 子集）
- [开场文字字形来源与声明](public/assets/boot-lettering-notice.txt)（描边图形；字体文件不随仓库分发）
- [字体来源与第三方声明](public/fonts/NOTICE.txt)
- [Rolling Number 许可](public/licenses/rolling-number.txt)
- [音频来源与授权范围](public/audio/README.md)
