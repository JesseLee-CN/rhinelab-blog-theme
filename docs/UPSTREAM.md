# 上游来源与署名

本站三维界面源自开源项目 **[LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)**，
参考《明日方舟》特别映像「莱茵生命：访问」。本模板保留原作者署名与 MIT 许可，并**不声称**与原作
官方或上游项目存在隶属、赞助或认可关系。

## 1. 署名

```
Copyright (c) 2026 LBEILC        ← 三维界面与相关程序代码
```

完整许可见 [LICENSE](../LICENSE)。MIT **只**适用于仓库声明有权授权的程序代码、建模脚本与配套
技术文档，**不自动覆盖**游戏名称、标志、设定、原作视觉、Blender / GLB 模型、图像、动图或原片短音。

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
