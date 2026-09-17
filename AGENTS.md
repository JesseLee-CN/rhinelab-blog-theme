# AGENTS.md — RhineLab Blog Theme 维护与完善

本文件适用于整个仓库及其子目录，定义代理协作的项目上下文、实施边界和验证方式。
用户在当前会话中的最新明确要求优先；本文件不扩大系统、工具或用户授予的权限。

## 1. 项目目标

本仓库是**可复用的个人博客模板**：Markdown 写作、Git 发布、静态部署，并保留 RhineLabUI 的
TypeScript / Three.js 三维界面作为独立的 `/lab/` 入口。

- 博客部分：Astro 在构建时生成普通 HTML，文章有独立规范 URL，禁用 JavaScript / WebGL 仍可阅读。
- 三维部分：`/lab/` 保留原生 Three.js 实现与已核验的视觉基线。
- 认证部分：`services/lab-auth/` 是启动身份选择背后的 Go + SQLite 服务，与公开阅读解耦——
  认证不可用时 GUEST 与公开阅读仍可用。

**本仓库不含任何真实站点信息。** 域名一律为 `example.com`，主机一律为文档用网段
`203.0.113.10`，账号、密钥名与部署路径均为示例值；不要把它们替换成真实值后提交。

默认用中文沟通和编写项目文档。先给结果，再说明依据、验证和剩余问题。

## 2. 事实来源与文档优先级

开始工作时先看 `git status`、相关源码与实际命令输出，再读文档：

1. [README.md](README.md)：项目定位、快速开始、许可范围。
2. [docs/README.md](docs/README.md)：文档索引（现行说明与阅读顺序）。
3. [BLOG-MAINTAIN-PERFECT.md](BLOG-MAINTAIN-PERFECT.md)：写作、构建、发布、回滚、备份与排障。
4. [docs/AUTHORING.md](docs/AUTHORING.md)、[content/README.md](content/README.md)：frontmatter 字段与主题配置规则。
5. [DESIGN.md](DESIGN.md)：三维视觉与行为基线。
6. [docs/READER.md](docs/READER.md)：阅读层契约与参数；[docs/IDENTITY.md](docs/IDENTITY.md)：身份与认证。
7. `package.json`、锁文件与源码：判断当前真正可用的命令与功能。

区分三种信息：用户明确要求、当前工程方案、已验证事实。文档中标注“计划/待实现”的内容在落地前
不是事实；历史测试结果不代表本次测试通过。

`docs/` 是**操作与参考手册**：记录当前实现、约定、参数与操作步骤。开发过程中形成的结论应总结
进这里（或仓库根入口文档），而不是把过程记录（计划、门报告、评估、交接记录）搬进仓库；
需要保留过程记录时放在私有仓库或本地未跟踪目录。

## 3. 维护模型

- Markdown 是唯一正文来源；列表、摘要、RSS、sitemap、全文检索与三维卡片都由同一公开内容集合派生。
- 构建顺序：内容校验 → lab 摘要 → Astro → `/lab/` → Pagefind → 站点检查；后续步骤不得清空前序产物。
- 发布 = `build → release → upload --activate → smoke`；失败不替换线上，可回滚。
- 服务器只接收并激活不可变 release，**不安装 Node、不在线上目录编译或 `git pull` 覆盖**。
- 普通阅读不加载 GLB、Three.js、背景音乐或终端 CSS；三维资源只服务 `/lab/`。

## 4. 目录与构建约束

- `apps/blog/`：Astro 子应用；根 npm workspace 与统一 lockfile 管理依赖。
- `content/posts/`、`content/pages/`：Markdown 正文；`content/lab-collections.json`：主题与文章 ID 引用。
- `scripts/blog/`：内容校验、摘要生成、构建编排、打包与预览。
- `ops/`：参数化部署、Web 配置、回滚与 smoke 工具；`services/lab-auth/`：认证服务源码。
- `art/`、`reference/`、`verification/`：模型工程、开发对照与验证入口。
- `.generated/`、`dist/`、`release/` 与构建产物不作为正文来源，且不进 Git。

子路径必须覆盖 CSS 字体、GLB、图标与 HTML 链接；未知路径返回真实 404，禁止 SPA 回落首页。

## 5. 内容规则

- 分离稳定文章 ID、文件名、规范 path 与三维槽位。`id` 是身份，发布后不因标题或排序变化而重建。
- `publishedAt` 晚于构建时间或 `draft: true` 的内容**不得**出现在 HTML、JS/JSON、RSS、sitemap、
  搜索索引或 TXT 中；所有公开产物走统一公开过滤函数并使用同一 `BUILD_NOW`。
- `path` 唯一且不得与 `/lab/`、`/tags/`、`/categories/`、`/search/`、`/archive/`、RSS 等系统路由冲突。
- 公开 Git 仓库本身不能保护草稿；需保密的正文不要放进本仓库。
- 三维主题为五个策展主题、每主题八个虚拟槽位；空主题为不可选装饰/空状态，不制造假文章。

## 6. 三维与阅读层边界

保留现有原生实现与已验证的视觉基线，具体参数以 [DESIGN.md](DESIGN.md) 与
`src/article-reader*.ts` 的实现为准。

- 卡片抽取保持竖直升降，靠近/转向由镜头完成；不要横向移动卡片或压低背景阵列来“修复”构图。
- 快速切换保留当前位置与运动状态；不擅自恢复上游已撤回的光影、波浪或内构实验。
- 开场在阵列揭示与档案选中后结束并进入 ARCHIVE OVERVIEW，**不自动打开文件详情**。
- 保留滚动文字、减少动态效果、焦点恢复、模态输入隔离与触摸/正文滚动分离。
- “阅读全文”使用真实 `<a href>`；终端假权限、假身份不作为文章访问控制。
- 修改模型时保留 Blender 源文件与可复现脚本；不为普通内容改动重做模型。

## 7. 命令与验证

执行前读取当前 `package.json`。常用命令：

```bash
npm ci --ignore-scripts
npm run check:content          # 内容 schema、路径、草稿、封面、主题引用
npm run test:blog              # 内容契约单元测试
npm run typecheck              # 三维 TypeScript 检查
npm run test:reader            # 沉浸式阅读契约/加载器/面板单元测试
npm run test:reader-e2e        # 阅读层总门（Playwright）
npm run check:site             # 构建后产物、泄露与 lab 边界检查
npm run build                  # 校验 → Astro → lab → Pagefind → 站点检查
npm run preview                # 静态 dist/ 预览，未知路径真实 404
node ops/smoke-test.mjs <url>  # 线上/候选 smoke 检查
```

按改动风险选择检查：

| 改动 | 最低验证要求 |
| --- | --- |
| 纯文档 | 链接、命令真实性、事实与规划区分、diff 范围 |
| 内容/schema | 代表样本、异常输入、幂等、公开过滤、真实数量对账 |
| 页面/路由/SEO | 生产 HTML、深链刷新、真实 404、RSS/sitemap/索引、无 JS 阅读 |
| 三维交互 | 现有行为检查与实际浏览器交互，空槽/重复/快速切换/长期循环 |
| 部署/缓存 | 候选环境、产物 hash、配置测试、失败不激活、回滚演练 |

区分静态规则检查、桌面视口模拟与线上真实访问数据。未做的测试必须明确说明，不能沿用历史报告
冒充实测。构建产物大小不等于首屏传输量或手机帧率；性能与视觉终验在具备 GPU 的环境或真机进行。

## 8. 服务器与发布约束

- 不读取或输出无关秘密、完整服务配置、私钥与环境变量。凭据放在被 Git 忽略的
  `ops/upload.env`、`ops/deploy.env` 或受控 secret 中，不写入文档、Git、命令日志或网页。
- 自动发布目标是受限身份，不把 root 私钥交给 CI。
- 采用不可变 release、可信服务端模板、发布锁、完整版本激活与回滚；配置 `test`/`reload` 失败
  不能报告成功。
- 生产切换、退役或改架构前，先准备可审阅候选、对账与回滚目标，并取得明确授权。
- 没有生产修改授权时，停在本地/候选产物和明确剩余动作。

## 9. Git 与协作方式

- 保留用户既有改动，不 reset/clean 覆盖；编辑前后检查 `git status`/`diff`，只处理当前任务范围。
- 不猜远端地址，不向未确认的仓库推送。上游 `LBEILC/RhineLabUI` 只读。
- 文件搜索优先 `rg`，独立读取可批量进行；不重复读取整份计划来代替执行。
- 长任务先落盘一部分有效成果，再继续补齐；及时报告具体进展。
- 文档与代码注释描述最终行为，避免把推测写成事实；未执行的命令、占位符与模板要明确标注。

## 10. 许可边界

源码 MIT **不自动覆盖**游戏品牌、原作素材、模型、字体或短音。按 [LICENSE](LICENSE) 与
[README](README.md)「来源与许可」一节的范围保留署名；不删除许可文件，也不默认取得全部素材授权。
