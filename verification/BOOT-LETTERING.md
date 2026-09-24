# 开场中央文字 · Novecento

> 来源：上游提交 `8799b03`（`LBEILC/RhineLabUI`）。**本站适配版**：图形改由本地生成（与上游逐字节对齐），身份行改用本站固定标签，Bold 三段沿用上游图形。图形来源与许可说明见 `public/assets/boot-lettering-notice.txt` 与 `verification/boot-lettering/sources.json`。

开场适合的中央文案统一使用 Novecento Sans Wide 的描边图形（或授权 webfont，本站未启用）。

- Normal：访问权限、身份确认、请求接收、开始处理、权限通过，以及处理中的留白故障帧。
- Bold：`WELCOME TO`、`RHINE LAB.LLC.`、`INTERNAL DATABASE`；公司名称的黑底与灰闪层使用相同图形。
- DemiBold：左上角 `RHINE LAB`（品牌第一行）。
- 保留原逐字时间轴、声音触发、授权字距收束、欢迎黑底扫过及 HUD 投影；品牌下方两行仍为 MiSans。

## 来源与制作

- **Normal / DemiBold**：作者免费 DaFont 包（免费桌面许可），本机取包后由 `scripts/make-boot-lettering.py` 描边导出。包与字体的 SHA-256 记录在 [boot-lettering/sources.json](boot-lettering/sources.json)。
- **Bold**：本站免费 DaFont 包不含 Bold，三段图形**原样沿用上游提交**；免费渠道同样提供 Bold（FontSquirrel「Novecento wide」列为 6 个免费样式之一），补齐后可用同一生成器重导出并逐个比对。
- **身份行**：上游图形写死为对方站点显示名；本站增补 `ID CONFIRMED : JOYCE MOORE` 与 `ID CONFIRMED : GUEST` 两段（Normal），其余注册名回落为普通文字。
- 字体文件（OTF/Webfont）**不进入 Git 与发布包**；发行内容只有图形与 `assets/boot-lettering-notice.txt` 声明。

### 生成器用法（本站改写版）

```powershell
# 1) 取作者免费包并解压到 .tools/boot-lettering-src/extract/（该目录不进 Git）
# 2) 生成 src/boot-lettering-art.json（含与上游逐字节一致的 9 段 + 本站 2 段身份图形）
python scripts/make-boot-lettering.py --fonts .tools/boot-lettering-src/extract --out src/boot-lettering-art.json --mode final --upstream-art .tools/boot-lettering-src/upstream-art.json
```

与上游脚本的差别：不依赖 Pillow（宽度直接取 `hmtx` 原始 advance，已验证与上游一致）、支持 `--out`、支持 `--mode final` 合并上游 Bold 图形。脚本注释说明许可边界：只导出固定短语图形，不产出可复用字符表。

## 实现

- `src/boot-lettering.ts`：`BootLettering` 预建图形节点，只在文字变化时更新可见段；可访问文本保留在 `.boot-phrase-label`。未生成图形的文案回落为普通文字（`boot-lettering-fallback`）。
  - 本站改动 ①：`__RHINE_NOVECENTO__` 用 `typeof` 守卫读取（本站没有根 `vite.config.ts`，参考页是无配置 Vite）。
  - 本站改动 ②：`setText(value, exactText?)` —— 身份行会逐字显示动态注册名，多个短语共享 `ID CONFIRMED : ` 前缀时无法只靠前缀判断目标；调用方传入完整目标文案即可精确选段，传入值与目标不构成前缀关系时自动退回上游行为。
- `src/boot-lettering.css`：图形单元格以 `em` 计宽，随既有字号与响应式规则缩放；`.brand h1` 改为 50.75px / 1px 字距 / 48px 高，下方两行不受影响。
- `src/boot.ts`：在收集完扫描圆环路径之后再绑定 lettering（图形自身含 SVG path，不能混入圆环几何）；`update()` 中 ACCESS 与身份/请求/处理提示改走 `setText()`。
- `src/features/auth/intro.ts`：登录序幕的 `.brand.intro-brand` 与 `#stage` 的品牌共用 `brandHeading`，**同样绑定 `["brand"]` 图形**。该字块是 `width: auto`（内容撑开），只改 CSS 而不绑图形会让序幕那份变成 50.75px 的普通文字、明显偏宽（2026-09-13 用户反馈「图一未居中对齐」）；绑定后两份都是同一图形，宽度 271.02px、`OS` 贴右，与档案页一致。
- `src/main.ts`：启动准备阶段并行调用 `loadBootWebfonts()`；本站 `__RHINE_NOVECENTO__` 恒为 false，因此始终使用图形。
- `vite.lab.config.ts`：显式 `define` `__RHINE_NOVECENTO__ = false`。

## 验证

| 项 | 结果 |
| --- | --- |
| 与上游同源 | 本地 Normal/DemiBold OTF 的 SHA-256 与上游 `sources.json` 记录一致；重导出 6 段与上游图形**逐字节一致**（宽度＝字体原始 advance，上游 138 字母零误差） |
| 图形表 | `src/boot-lettering-art.json` 共 11 段（上游 9 段中 6 段本地生成 + 3 段 Bold 沿用 + 2 段本站身份图形），32,330 字节 |
| 浏览器复核 | `reference/boot-lettering-review.html`（需 `npm run dev:reference`）：上游 14 项检查在本站运行，覆盖 169–487 帧的文字变化、DOM 不重建、跳帧恢复、授权字距收束、圆环路径不混入、欢迎灰闪、Bold 四层、无意外回退 |
| 回归 | `npm run typecheck`、`check:viewport`、`test:intro`、`check:intro`、`check:entry`、`test:entry`、`check:boot-baseline`、五步构建 + `check:site` |
| 未做 | 真实 iPhone 验收；webfont 渲染路径（本站无授权包，恒走图形） |
