# 功能模块划分（相对上游新增的功能）

本模板在上游 RhineLabUI 之外增加了若干功能。本文说明它们的模块边界、装配方式，以及
后续**增删一个功能**时要动哪些地方。审阅结论是：功能代码可以完全脱离核心存在，核心不需要
知道功能的实现细节；边界由 `npm run check:features` 强制。

## 1. 审阅结论：改造前后

改造前，两个主要功能的集成逻辑直接写在 `src/main.ts` 里，并用模块级变量与核心状态互相引用：

| 位置 | 改造前 | 现在 |
| --- | --- | --- |
| 阅读层 | `main.ts` 原 116–214 行、共 99 行集成代码：懒加载、请求令牌、焦点、守卫、pagehide、HMR 清理，并直接持有 `ImmersiveReader`；核心别处另有 30 余处引用 | `src/features/reader/index.ts` 的门面，`main.ts` 只装配 7 个宿主端口成员 |
| 身份门 | `main.ts` 原 216–313 行、共 98 行状态：`entry`/`authPort`/`introPhase`/`panelPhase`/`panelBusy`/`currentIdentity`/`currentLabel`/`requestedScene` 加 5 个流程函数；核心别处另有 40 余处直接读这些变量 | `src/features/auth/entry.ts` 的状态机，`main.ts` 只保留开场影片交接（`prepareBootFrame`/`commitBootHandoff`）与 8 个宿主端口成员 |
| 文件位置 | 自有文件与上游文件平铺在 `src/` 根，靠文件名前缀区分 | 自有文件集中在 `src/features/<id>/`，上游文件路径不动 |
| 样式归属 | 功能的 CSS 由 `main.ts` 逐个 `import` | 归属功能：`auth/index.ts` 静态引入，`reader/styles.ts` 随懒加载引入 |
| 边界约束 | 无（只靠约定） | `features.manifest.json` + `npm run check:features`，四条规则逐条校验 |
| 首屏负担 | 阅读层 CSS（17.0 KB / gzip 3.5 KB）在首屏样式表里 | 移出首屏，进入阅读层自己的懒加载 chunk |

`src/main.ts` 因此从 1510 行降到 1321 行，且剩余的阅读层/身份门引用全部是门面调用
（`readerFeature.…` / `entryFeature.…`）与宿主端口实现。

## 2. 功能清单

清单的唯一事实来源是仓库根的 [`features.manifest.json`](../features.manifest.json)。

### 2.1 启动身份门与登录/注册（`auth`）

- **职责**：启动序幕（2D 开场幕布）、身份选择页、登录与公开注册面板、会话恢复与一键继续、
  切换身份、退出登录。
- **目录**：`src/features/auth/`
  - `index.ts` 唯一入口（同时静态引入本功能的两份样式表）
  - `entry.ts` 身份门状态机 + `EntryHost`/`EntryFeature` 契约
  - `intro.ts` / `intro.css` 序幕幕布；`intro-motion.ts` 纯轨迹计算（可单测）
  - `panel.ts` / `panel.css` 登录/注册面板
  - `identity.ts` 纯规则（用户名、密码、身份比较、阶段迁移表）
  - `client.ts` 同源认证端口；`dev-port.ts` DEV 专用假端口（不进生产包）
- **加载方式**：首屏静态引入。序幕必须在任何 `await` 之前完成首帧遮挡（LOGIN-IMPROVE L1b）。
- **宿主端口** `EntryHost`：`prepareBootFrame`、`commitBootHandoff`、`setGateInert`、
  `setStageHidden`、`engageAudio`、`closeOverlays`、`returnToBoot`、`notify`。
- **门面** `EntryFeature`：`isGateActive`、`phase`、`panelPhase`、`panelBusy`、`identity`、
  `label`、`requestedScene`、`setPhase`、`hide`、`adopt`、`start`、`resourcesFailed`、
  `tick`、`resize`、`setStageRect`、`summaryMarkup`、`canLogout`、`switchIdentity`、
  `logout`、`usePlaybackIdentity`、`hideForPlayback`、`snapshot`、`dispose`。
- **相关目录**：`services/lab-auth`（Go/SQLite 认证服务）、`ops/auth`、`ops/nginx/auth-location.conf`、
  `ops/systemd/example-auth.*`、`scripts/auth`。
- **检查**：`test:identity`、`test:intro`、`test:entry`、`check:entry`、`check:intro`、`check:flow`。
- **行为说明**：[IDENTITY.md](IDENTITY.md)。

### 2.2 沉浸式 Markdown 阅读（`reader`）

- **职责**：在档案详情里原地打开全文窗口——内容加载与安全白名单、目录导航、滚动恢复、
  焦点与 inert 所有权、错误与重试，以及“从详情链接进入阅读层”的全部集成逻辑。
- **目录**：`src/features/reader/`
  - `index.ts` 唯一入口 + 门面（懒加载、请求令牌、守卫、焦点恢复、pagehide、HMR 清理）
  - `reader.ts` 阅读层生命周期；`loader.ts` 内容加载；`toc.ts` 目录导航
  - `reader.css` / `markdown.css` 样式；`styles.ts` 样式懒加载入口
- **加载方式**：按需 `import()`。阅读层连同 HTML 解析栈与样式表都不进三维入口首屏。
- **宿主端口** `ReaderHost`：`currentTarget`、`isArchiveReady`、`isIdentityGateActive`、
  `currentMode`、`notify`、`playSound`、`setSceneInputSuspended`。
- **门面** `ReaderFeature`：`isActive`、`ownsEvent`、`open`、`closeIfActive`、
  `closeForContextChange`、`withClosed`、`release`、`snapshot`、`dispose`。
- **共享库**：`shared/reading/`（契约、几何、内容白名单、URL 策略、指纹、滚动存储、srcset、
  prose 样式）。博客构建与阅读层共用，因此放在 `shared/` 而不是功能目录里。
- **检查**：`test:reader`、`test:reader-e2e`、`check:reader`、`check:reader-content`、
  `build:reader-fixtures`。
- **行为说明**：[READER.md](READER.md)。

### 2.3 其他新增能力（不在 `src/features/`）

这些是构建面而不是运行时功能模块，保持原有目录：

| 能力 | 位置 | 与 `src/features/` 的关系 |
| --- | --- | --- |
| Markdown 博客（Astro 子应用、内容集合、RSS/sitemap/搜索） | `apps/blog/`、`content/`、`scripts/blog/` | 独立构建目标，不引用功能模块源码 |
| 三维入口的博客数据桥 | `src/blog-adapter.ts`、`src/data.ts` | 属于核心数据源，阅读层与身份门都依赖它 |
| 自托管字体（MiSans、JetBrains Maple Mono） | `public/fonts/`、`shared/*.css`、`scripts/blog/prepare-assets.mjs` | 跨两个构建目标共享的白名单 |
| 上游细粒度动效开关 | `src/motion-preferences.ts` 起（上游 `6185da2`） | 已在上游主线内，不属于本站新增 |

## 3. 边界规则

`npm run check:features` 校验四条规则，任一不通过即非零退出：

1. **清单与磁盘一致**：`dir`/`entry`/`styles` 存在，`publicApi` 确实从入口导出，`checks`
   在 `package.json` 中存在，`serverSide`/`ops`/`scripts`/`shared`/`docs` 指到的路径存在。
2. **外部只走入口**：`src/` 中功能目录之外的文件只能引用 `<dir>/index.ts`，深入
   `<dir>/xxx.ts` 会被报为 `deep-import`。
3. **功能之间不互相穿透**：功能文件引用另一个功能的任何文件会被报为 `cross-feature`；
   允许功能依赖核心（`../../*.ts`）与 `shared/`。
4. **没有孤儿文件**：功能目录里每个源文件都必须能从 `entry` 或 `styleEntry` 的引用链到达。

该命令已纳入 `npm run build` 的统一构建序列（在 `check:content` 之后、构建之前）。

## 4. 增删流程

### 新增一个功能

1. `src/features/<id>/` 放实现，写 `index.ts`：导出 `XxxHost`（需要核心提供什么）、
   `createXxxFeature(host)`（返回 `XxxFeature` 门面）。
2. 功能**不**直接读核心的模块级变量；需要什么就在 `XxxHost` 里声明一个方法，由
   `main.ts` 实现。核心要调功能时只调门面方法。
3. 在 `main.ts` 的装配点创建门面（位置要匹配加载策略：首屏可见的放在任何 `await` 之前）。
4. 在 `features.manifest.json` 增加条目；`eager` 必须显式声明，`runtimeMarkers` 填该功能
   产物的 chunk 名特征（`scripts/auth/check-artifacts.mjs` 用它判断博客页面没有加载 lab 资源）。
5. `npm run check:features`、`npm run typecheck`、`npm run build` 全绿。

### 移除一个功能

以移除 `reader` 为例，顺序如下（反向执行即可，无需改动核心逻辑）：

1. 删 `src/features/reader/`。
2. 删 `main.ts` 里的装配块（`const readerFeature = createReaderFeature({…})`）与所有
   `readerFeature.…` 调用，以及 HMR 里的 `readerFeature.dispose()`。
3. 删 `features.manifest.json` 的 `reader` 条目。
4. 删该功能独有的检查与脚本：`scripts/reading/`、`package.json` 中对应的 5 条 npm 命令、
   `shared/reading/`（若无其他引用；博客样式里的 `@reading/prose.css` 需一并处理）。
5. 删 `docs/READER.md` 并在 [README.md](README.md) 文档索引里去链。
6. `npm run check:features` 会报出任何遗漏（残留清单项、孤儿文件、无法解析的引用），
   `npm run typecheck` 与 `npm run build` 兜住其余问题。

移除 `auth` 同理，另外还要停用认证服务：`ops/auth/rollback.sh`、systemd 单元与
`services/lab-auth`。**注意**：认证服务同时承担登录与注册，移除前端身份门后
`/lab/` 会直接进入档案（GUEST 语义），不需要改三维核心。

## 5. 与上游同步的关系

- 上游自带文件一律保持原路径与原文件名，因此上游同步仍是**逐文件内容级移植**，
  路径不需要重写；新增功能集中在 `src/features/`，不会再增加 `src/` 根目录的重叠面。
- 功能模块只以“宿主端口 + 门面”接触核心，所以上游改动 `main.ts` / `scene.ts` 时，
  冲突面收敛在装配块附近。当前重叠面见表见 [UPSTREAM.md](UPSTREAM.md) §6。
- 上游没有对应实现的功能（本文全部）在同步时不参与三方合并，只做回归验证。

## 6. 验证

```bash
npm run check:features     # 模块边界（本文四条规则）
npm run typecheck          # 类型与路径
npm run test:identity      # 身份规则（auth）
npm run test:reader        # 阅读层契约（reader）
npm run check:artifacts    # 构建产物：无 DEV 假端口、博客页不加载 lab 资源
npm run build              # 统一构建（含 check:features）
```

改动功能模块时，除了上面的命令，还应在真实浏览器里跑一次对应端到端：
`npm run check:entry`（登录面板）、`npm run check:flow`（完整认证流，需
`--base-url` 与 `E2E_USER`/`E2E_PASSWORD` 指向带真实认证服务的站点）、
`npm run test:reader-e2e`（阅读层总门）。

### 6.1 模块化改造的验证记录（2026-09-24）

改造在开放仓库完成，逐项结果如下（同一台机器、同一依赖锁文件）：

| 检查 | 结果 |
| --- | --- |
| `check:features` | 通过：2 个功能、入口唯一、无跨功能穿透、无孤儿文件；另用三类反例验证守卫会失败（键名改名 / 孤儿文件 / 深入内部引用） |
| `typecheck` | 通过 |
| `test:identity` / `test:intro` / `test:entry` / `test:reader` / `test:blog` / `check:motion-preferences` | 全部通过（12 / 10 / 25 / 81+1skip / 17 例，动效偏好 12+6 例） |
| `build:blog` + `build:lab` + `search:index` + `check:site` | 通过；`check:artifacts` 1579 个产物 0 发现 |
| `test:reader-e2e`（chromium，IR5 三套件） | **19/19 用例、337/337 检查通过**（改造前基线：14/19 用例、327/335 检查，失败项与本次改造无关，见 §6.2） |
| `check:entry`（L1c 浏览器检查） | **50/50 通过**（改造前基线：48/50，见 §6.2） |
| `check:intro` | 通过（9/9，GUEST 场景） |
| `check:flow` | **未运行**：需要指向带真实认证服务的站点与测试账号（本机未构建 `services/lab-auth` 与 HTTPS 预览） |

首屏产物变化：阅读层 CSS（17.04 KB / gzip 3.53 KB）从 `index-*.css` 移入懒加载的
`styles-*.css`，`/lab/` 首屏只加载 `index-*.js` 与 `index-*.css`。

### 6.2 顺带修正的过期端到端期望

模板的文章被替换为示例内容后，两个功能各自的端到端门禁里还留着一批**写死私有仓库正文**的
期望值，表现为长期为红或静默空检查。这与模块化无关，但会让「改功能后跑门禁」失去意义，
因此一并修正：

| 位置 | 问题 | 修正 |
| --- | --- | --- |
| `scripts/reading/run-e2e.mjs` | Pagefind 正向检索词写死为私有文章的 `Multisim` | 从被断言文章已构建的正文派生（现取到 `Unicode`） |
| `scripts/reading/e2e/content.mjs` | 「初始 chunk 不含正文」探针写死私有文章句子 | 探针改为被服务文章正文的末 30 字 |
| `scripts/reading/e2e/interaction.mjs`、`failure.mjs` | `textLength > 4000` 绝对阈值 | 与被服务页面 `.prose` 的文本长度比较（≥80%） |
| `scripts/reading/e2e/interaction.mjs` | 滚动恢复按「距文末 400px」「> max×0.25」判定 | 按契约 §7 的锚点公式判定；不再假设文末之后没有内容 |
| `scripts/auth/check-entry.mjs` | 展示名期望写死 `JOYCEMOORE`，而 `usernameLabel` 只做大写不去分隔符 | 期望值从实际提交的用户名派生（`JOYCE_MOORE`） |

对照实验证明这些失败与模块化无关：把改造临时 `git stash` 回 HEAD 后重新构建，阅读层
端到端得到**完全相同的 5 个失败用例与 327/335 检查**，`check:entry` 得到**相同的 48/50**。
