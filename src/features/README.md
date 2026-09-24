# src/features/ —— 本站自有功能的模块目录

这个目录只放**开放仓库相对上游新增的功能**。上游自带的 `src/*.ts`（三维场景、模型查看器、
动效、主题、音频、PWA 等）保持原路径不动：本站与上游没有共同祖先，同步是逐文件内容级移植，
移动上游文件会让每次同步都要重写路径。

每个功能目录都是一个自包含单元，遵守四条约定（`npm run check:features` 会逐条校验）：

1. **唯一入口**：目录外只允许 `import { … } from "./features/<id>"`，即该目录的 `index.ts`。
   功能内部文件之间可以自由互引，但不允许 `main.ts` 或其他核心文件深入内部路径。
2. **不互相穿透**：一个功能不得引用另一个功能的任何文件；共享能力下沉到 `shared/`。
3. **宿主端口**：功能不直接使用核心的模块级状态。它声明一个 `XxxHost` 接口（需要核心提供
   什么），由 `src/main.ts` 作为组合根实现；核心反过来只通过功能门面（`XxxFeature`）调用它。
4. **自带资产与清单**：样式表、检查脚本、服务端与运维目录都归属该功能，并登记在仓库根的
   `features.manifest.json`。目录里不允许留下没有任何入口引用链覆盖的孤儿文件。

## 现有功能

| 功能 | 目录 | 加载方式 | 宿主端口 | 门面 |
| --- | --- | --- | --- | --- |
| 启动身份门与登录/注册 | `auth/` | 首屏静态引入 | `EntryHost` | `EntryFeature` |
| 沉浸式 Markdown 阅读 | `reader/` | 按需 `import()` | `ReaderHost` | `ReaderFeature` |

加载方式决定样式表归属：`auth/` 的 CSS 由 `index.ts` 直接引入（序幕必须遮挡首帧），
`reader/` 的 CSS 由 `styles.ts` 引入并被门面的懒加载路径一并 `import()`（首屏不为阅读层付费）。

## 增删一个功能

新增：

1. 建 `src/features/<id>/`，把功能自身代码放进去，写 `index.ts` 作为唯一入口。
2. 在 `index.ts` 里声明并导出 `XxxHost`（需要核心提供的能力）与 `createXxxFeature(host)`。
3. 在 `src/main.ts` 的装配点实现 host、创建门面，核心其余部分只调用门面。
4. 在 `features.manifest.json` 增加一条：`id/dir/entry/publicApi/hostPort/facade/eager/
   styles/styleEntry/checks/runtimeMarkers` 以及 `scripts`、`ops`、`serverSide`、`shared`、`docs`。
5. `npm run check:features` 通过后，在 `docs/FEATURES.md` 与 `docs/README.md` 登记。

移除 = 反向执行：删目录、删 `main.ts` 装配块、删清单条目、删该功能独有的脚本/服务端/运维目录
与 npm 命令。守卫会报出清单不一致、残留入口引用、跨功能穿透和孤儿文件。

模块划分与增删流程的完整说明见 [../../docs/FEATURES.md](../../docs/FEATURES.md)。
