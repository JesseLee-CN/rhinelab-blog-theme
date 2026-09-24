# 上游来源与署名

本站三维界面源自开源项目 **[LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)**，
参考《明日方舟》特别映像「莱茵生命：访问」。本模板保留原作者署名与 MIT 许可，并**不声称**与原作
官方或上游项目存在隶属、赞助或认可关系。

## 1. 署名

```
Copyright (c) 2026 LBEILC        ← 三维界面与相关程序代码
```

完整许可见 [LICENSE](../LICENSE)。上游作者对其创作且有权授权的**全部内容**统一采用 MIT，包括
程序代码、建模脚本、技术文档、Blender 源工程、GLB 模型、原创配乐与音效，以及图像、动图和其他
原创资源——非代码资产同样适用。

**不覆盖**的只有第三方内容：《明日方舟》及莱茵生命相关名称、标志、设定、原 PV、原作视觉设计、
原片音频采样及其衍生片段，以及各字体与依赖的既有许可（见 §4）。分发获授权内容时须保留版权声明
与 MIT 许可证；所有内容按原样提供，不作担保。

## 2. 上游远端

本仓库把上游配置为**只读远端**，便于对照与取用更新：

```bash
git remote -v
# origin    <你的仓库>                                  (fetch/push)
# upstream  https://github.com/LBEILC/RhineLabUI.git     (fetch)
# upstream  DISABLED_UPSTREAM_IS_READ_ONLY               (push)
```

`ops/setup-remotes.sh` 负责这套配置：`upstream` 的 push 地址被刻意改写成占位串，
**物理上无法误推上游**。合并上游更新时先 `git fetch upstream`，再按需 cherry-pick 或对照移植。

## 3. 本模板相对上游的差异

| 方面 | 说明 |
| --- | --- |
| 博客层 | 新增 Markdown 写作、Astro 静态页面、RSS/sitemap、Pagefind 检索与独立文章 URL |
| 阅读层 | 新增 `/lab/` 内的沉浸式全文阅读，见 [READER.md](READER.md) |
| 认证 | 新增启动身份选择与 Go + SQLite 认证服务，见 [IDENTITY.md](IDENTITY.md) |
| 脱敏 | 域名、主机、账号与个人内容替换为中性示例，见 [SANITIZE-NOTES.md](../SANITIZE-NOTES.md) |
| PWA | 模板 MVP 默认**关闭** PWA；上游的离线安装说明仅作历史参考 |
| 开场文字 | 固定短语使用描边图形（字形来源与许可见 `public/assets/boot-lettering-notice.txt`），仓库不分发字体文件 |

## 4. 第三方资源与许可

| 资源 | 范围 | 许可与说明 |
| --- | --- | --- |
| MiSans | 正文 / 界面字体 | 小米官方字体，允许免费商用与网页嵌入；见 [fonts/README.md](fonts/README.md) 与 `public/fonts/MiSans-license.pdf` |
| JetBrains Maple Mono | 代码字体子集 | OFL-1.1；见 `public/fonts/JetBrains-Maple-Mono-OFL.txt` |
| 开场描边文字 | 固定短语图形 | 字体文件不随仓库或发布分发，仅发行图形；来源与声明见 `public/assets/boot-lettering-notice.txt` |
| Rolling Number | 数字/文字滚动 | MIT；见 `public/licenses/rolling-number.txt` |
| parse5 | 阅读层 HTML 解析 | MIT（依赖 `entities`，BSD-2-Clause） |
| 音频 | 启动与交互音效 | 来源与授权范围见 `public/audio/README.md` |
| 三维模型与图像 | 模型、截图、动图 | 上游素材，沿用上游许可与署名要求 |

新增第三方资源时，请同时补上来源、许可与重建方式，不要删除既有的许可文件。

## 5. 处理上游更新的原则

- 保留已确认的视觉与行为基线：不擅自恢复上游已撤回的实验（光影、波浪、内构方案）。
- 上游的性能与渲染优化可以移植，但必须在本仓库复测（绘制调用、实例上传、逐像素差异），
  不能直接用上游报告当成本仓库结论。
- 与本模板既有契约冲突时，先改契约与文档，再改实现；不要留下「实现与文档各说一套」的状态。

## 6. 同步方式：内容级移植

本仓库的历史是**独立起点**（开源发布时重建），与上游**没有共同祖先**：`git merge-base` 为空，
`git rev-list` 显示双方无共同提交。因此 **`git merge` 与 `cherry-pick` 都不可用**，上游更新只能
按**内容级移植**处理。

关键陷阱：三方合并（`git merge-file`，base 取上次同步的上游提交）**不报冲突不等于我们的改动都保住了**。
实测 `src/model-viewer.ts` 与 `src/style.css` 合并结果"0 冲突"，但与上游改动仍有 15 处 / 9 处
重叠区——直接采用会静默覆盖本仓库的自有改动（脱敏替换、裁剪、身份品牌）。因此：

1. 先取上游改动范围与我们的改动范围，算出**重叠区**；
2. 只在重叠区之外的改动可以直接采用；
3. 重叠区必须逐块确认：保留本仓库的自有改动，同时接入上游改动；
4. 移植后跑完整验证（构建、类型检查、内容契约与相关测试）才可提交。

统计重叠区的做法：对每个文件分别求「上游 base→HEAD 的改动行」与「我们相对 base 的改动行」，
两者交集即重叠区（见下表实测值）。

| 文件 | 基准行数 | 我们改动行 | 上游改动行 | 重叠区 |
| --- | --- | --- | --- | --- |
| `src/main.ts` | 1266 | 399 | 65 | **21** |
| `src/scene.ts` | 1841 | 294 | 30 | **2** |
| `src/model-viewer.ts` | 623 | 34 | 15 | **15** |
| `src/style.css` | 2104 | 13 | 9 | **9** |

## 7. 跳过范围

上游有自己的一套部署平台记录（Cloudflare Pages 相关脚本与文档）。本模板使用
「本机构建 + 不可变 release + SSH 上传激活」的部署方式（见 [BUILD.md](BUILD.md)），
因此以下内容**不进入本仓库**：上游的 Pages 部署脚本与文档，以及上游 `package.json` 中仅服务于
这些脚本的入口。

另外，本站裁剪掉了上游的 wallpaper / workbench 相关模块（本模板不分发这些实验功能），
因此依赖它们的上游脚本也不移植。

上游的动效验证文档（`MOTION-INTEGRATION.md` 等）作为开发过程记录不随模板分发；其中仍然有效的
控制关系已整理进本节与 [../AGENTS.md](../AGENTS.md)，验证入口见 `npm run check:motion-preferences`。

## 7.1 动效偏好（上游细粒度动效）

上游把原来的单一「减少动态效果」开关细化为 14 个按键偏好（`src/motion-preferences.ts`）：
开场、选档波浪、静止起伏、指针视差、拖拽动量、选档过渡、详情过渡、模型解密、正文揭示、
文字滚动、数字滚动、表面过渡、查看器导航、查看器模型过渡。

- 预设 `full` / `reduced` / `custom`：任一键被关闭即视为 `custom`；旧的 `reduced` 布尔设置会
  自动迁移为逐键偏好。
- 控制关系：`main.ts` 持有偏好并按 `motionActive(key)` 分发；`ArchiveScene.setMotion()` 接收
  阵列相关键（指针视差、拖拽动量等）；`ModelViewer.setMotion()` 接收查看器相关键；
  样式侧由 `#stage` 的 `reduce-motion` / `reduce-surfaces` 类驱动。
- 本仓库的 `scene.ts` 是裁剪版：阵列侧目前把逐键偏好归并为一次「是否降低动效」判断
  （`reduced` getter），逐键细分留作后续步骤；`setReduced()` 保留给开发对照页。

## 7.2 尚未移植的上游改动

以下上游改动已评估但**尚未落地**，需要按本仓库的裁剪版逐处适配：

- src/main.ts：上游把设置面板的单一「减少动态效果」开关换成逐键偏好面板
  （motionSettingsMarkup(prefs.motion, prefs.motionPreset)），并把各处 prefs.reduced 换成
  motionActive(key)。本仓库的 main.ts 仍是单开关版本；因上游 main.ts 依赖 9 个本模板
  已移除的模块（wallpaper、workbench、startup、rolling-clock 等），不能直接取用。
- src/scene.ts：逐键细分（selectionTransition / detailTransition / idleWave / selectionWave /
  surfaceTransitions / modelDecryption / pointerParallax）——目前归并为一次整体判断。

## 8. 同步锚点与记录

| 项 | 值 |
| --- | --- |
| 最近已同步的上游提交 | `d9ecb6c`（渲染复用与模型精度），其后补入 `8799b03`（开场排版） |
| 已评估的上游范围 | `d9ecb6c..6185da2`（17 个提交、34 个文件） |

**同步记录**

| 日期 | 上游范围 | 采纳 | 跳过 |
| --- | --- | --- | --- |
| 2026-09-13 | `51ba3b0`、`65fc700`、`d9ecb6c` | 渲染复用（同帧阴影、共享实例矩阵与变化区间上传、静止画面复用、AO/景深共享深度）与模型精度对照页 | — |
| 2026-09-13 | `8799b03` | 开场固定短语与角落品牌的描边图形；身份图形改用上游 `JOYCE MOORE` | 上游 MyFonts webfont 授权相关部分（本站不持有该授权） |
| 2026-09-24 | `d9ecb6c..6185da2` | **部分采纳**：`src/motion-preferences.ts`（逐字节取上游）、`src/model-viewer.ts` 的 `setMotion()`、`src/style.css` 的动效样式、`src/scene.ts` 的 `setMotion()` 管道、`scripts/check-motion-preferences.mjs`、许可范围调整（MIT 覆盖原创素材） | Cloudflare Pages 部署（5 个提交）及其脚本与文档；依赖 wallpaper / workbench 的上游脚本；上游动效验证文档（属开发过程记录，已整理进 §7.1） |
