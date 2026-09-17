# 界面演示素材

本目录保存 `/lab/` 三维界面的演示素材（截图与动图）及其采集方式。素材**仅用于文档展示**，
不参与应用运行。

采集方式：使用独立的 Chrome 浏览器上下文、GPU 硬件加速与默认「原始」画质，不读取日常浏览器的
收藏与偏好。截图为 1600 × 900 JPEG（质量 93），保留真实界面与模型，没有叠加宣传文字或替换背景。

## 静态截图

全部截图为 1600 × 900 JPEG，质量参数 93。保留真实界面与模型，没有叠加宣传文字或替换背景。

| 文件 | 展示内容 |
| --- | --- |
| `archive.jpg` | 新版循环阵列与档案导航 |
| `detail.jpg` | 解密完成后的双环内构与档案概述 |
| `research.jpg` | 研究记录页签 |
| `viewer-clear.jpg` | 独立查看器，清晰玻璃 |
| `viewer-frosted.jpg` | 相同视角下的磨砂玻璃 |
| `assembly.jpg` | 六组结构拆解 |
| `search.jpg` | 搜索「莱茵」后的档案索引 |
| `settings.jpg` | 音效、音乐、减少动态效果与画质设置 |
| `boot.jpg` | 白底开场中的 Logo 与身份接入 |

## 动图

通过 Chrome DevTools Protocol 录制运行页面，按捕获时间戳保留真实节奏，再用 FFmpeg 缩放、降帧和量化。GIF 使用 96 色调色板与 Bayer 抖动，无声音，不代表应用实时帧率。浏览器仅在合成帧变化时输出录制帧，静止画面依照原时间保持。

| 文件 | 内容 | 大约时长 | 尺寸 / 帧率 |
| --- | --- | --- | --- |
| `decryption.gif` | 抽取、对角解密线、玻璃与正文同步揭示 | 7.9 秒 | 960 × 540 / 12 fps |
| `glass-motion.gif` | 清晰 → 磨砂 → 清晰 | 4.2 秒 | 800 × 450 / 12 fps |
| `assembly-motion.gif` | 拆解、旋转、视角复位与重组 | 8.0 秒 | 800 × 450 / 12 fps |
| `browse.gif` | 连续选档、切列和文字滚动 | 6.8 秒 | 640 × 360 / 8 fps |
| `boot-motion.gif` | 白底输入、Logo、权限扫描与欢迎转场 | 20.4 秒 | 800 × 450 / 12 fps |

README 直接展示解密动图，其余动图放在可展开区域。采集时间、源码版本与原始帧间隔记录见 [`capture.json`](capture.json)；GIF 编码的帧时长取整可能使成片时长略有差异。

## 重新采集

采集脚本为 [`scripts/capture-readme.mjs`](../../scripts/capture-readme.mjs)。需要 Chrome、Playwright 与 FFmpeg；它们是文档制作工具，普通应用运行不需要安装。脚本会覆盖本目录同名素材，并将中间 JPEG 帧保存在被 Git 忽略的 `.tools/readme-capture/`。

先启动应用：

```sh
npm ci
npm run dev -- --port 5186
```

再从仓库根目录执行脚本。已能通过 Node 导入 Playwright、且 FFmpeg 在 PATH 中时：

```sh
node scripts/capture-readme.mjs
```

也可以指定现有工具的位置，例如 PowerShell：

```powershell
$env:PLAYWRIGHT_MODULE = 'C:/tools/node_modules/playwright/index.mjs'
$env:FFMPEG = 'C:/tools/ffmpeg.exe'
$env:CAPTURE_URL = 'http://127.0.0.1:5186'
node scripts/capture-readme.mjs
```

其中工具路径需要替换为本机的实际位置。Windows 录制显式使用 D3D11；其他平台使用 Chrome 可用的 GPU 后端。录制后应查看截图、GIF 的起止帧及中间过渡，确认资源加载完整、没有遮挡或异常，检查 README 图片链接，并更新此处的版本与时长。
