# 沉浸式全文阅读（reader）

在 `/lab/` 档案详情里点「阅读全文」，会在**原地**打开一个居中窗口显示该文章的完整正文——不跳转
页面、不 pushState、不写 hash。这个窗口复用三个系统弹框（ARCHIVE INDEX / SAVED / SYSTEM）的
同一套表面，因此它的窗口盒、遮罩、进出动画与弹框逐像素一致。

## 1. 模块与职责

阅读层是一个自包含的功能模块 `src/features/reader/`（模块约定见 [FEATURES.md](FEATURES.md)）：

| 文件 | 职责 |
| --- | --- |
| `src/features/reader/index.ts` | **唯一对外入口**：`ReaderHost`（需要核心提供什么）与 `createReaderFeature()` 门面；懒加载、请求令牌、守卫、焦点恢复、pagehide 与 HMR 清理 |
| `src/features/reader/reader.ts` | 阅读层生命周期：打开/关闭事务、焦点与 inert 所有权、滚动记录、错误与重试 |
| `src/features/reader/loader.ts` | 内容加载：fetch 约定、超时与体积上限、错误码归因 |
| `src/features/reader/toc.ts` | 目录导航：只用正文已有标题 id，不解析 Markdown、不生成新锚点 |
| `src/features/reader/reader.css` | 窗口/工具栏/阅读区/目录导航的布局与主题 |
| `src/features/reader/markdown.css` | 正文 markdown 呈现（只作用于 `.article-reader .reader-content`） |
| `src/features/reader/styles.ts` | 样式懒加载入口：两份 CSS 随本模块的 chunk 一起加载，不进三维入口首屏 |

核心只通过门面使用阅读层，不接触 `ImmersiveReader`：

```ts
interface ReaderFeature {
  isActive(): boolean;
  ownsEvent(event: Event): boolean;      // 事件是否属于阅读层表面
  open(link: HTMLAnchorElement): Promise<void>;
  closeIfActive(): void;
  closeForContextChange(): Promise<void>;
  withClosed<T>(action: () => T | Promise<T>): Promise<T>;
  release(): void;                       // pagehide / bfcache
  snapshot(): ReaderReviewSnapshot;      // DEV 审阅
  dispose(): void;
}
```

门面反过来只通过 `ReaderHost` 借用核心能力（当前选中档案、就绪状态、身份门、
场景模式、提示条、音效、冻结三维输入），因此移除本模块不会牵动三维核心。

阅读层内部接口（`src/features/reader/reader.ts`）：

```ts
type ReaderTarget = Readonly<{ postId: string; href: string; title: string }>;
type SurfaceState = "closed" | "opening" | "open" | "closing";
type LoadState = "idle" | "loading" | "ready" | "error";
type CloseReason = "button" | "escape" | "context-change" | "dispose";

interface ImmersiveReader {
  readonly isActive: boolean;           // opening/open/closing 都为 true
  open(target: ReaderTarget, opener: HTMLElement): boolean;
  close(reason: CloseReason, options?: { restoreFocus?: boolean }): Promise<void>;
  setReducedMotion(value: boolean): void;
  dispose(): void;
}
```

阅读模块按需 `import()`，因此 **parse5 与阅读层 CSS 都不进入 `/lab/` 的初始包**。

## 2. 页面契约

公开文章页的 `<article>` 上带有 reader 需要的元信息，阅读层据此校验响应与恢复滚动：

```html
<article data-pagefind-body
         data-reader-version="1"
         data-reader-kind="post"
         data-post-id="wp-19"
         data-canonical-path="/2026/05/13/first-post/">
  <div data-reader-content>
    <h1 class="page-title">标题</h1>
    <div class="meta">…</div>
    <ul class="taxonomy">…</ul>
    <nav class="toc">…</nav>
    <div class="prose"><!-- Astro 渲染的正文 --></div>
  </div>
</article>
```

- 每页**唯一** post 容器、唯一 `data-reader-content`、唯一 `h1` 与 `.prose`；空 `.prose` 合法。
- `data-reader-version="1"` 是结构契约版本，不是内容修订号；阅读层与 `check:reader` 都会校验它。
- 目录项**只来自正文已有的标题 id**（`h1`–`h4[id]`），页面 collection 不输出可消费的
  `data-reader-kind="post"`。

## 3. 窗口与布局

窗口盒与内边距沿用弹框表面：几何以**舞台坐标**（1920×1080 基准）定义，按实时 `--stage-scale` 缩放。

| 场景 | 参数 |
| --- | --- |
| 桌面 / 紧凑桌面 | 舞台坐标 `1260 × 836`，`max-width: calc(100% - 100px)`，水平垂直居中；内边距 `35px 53px` |
| 紧凑 / 竖屏（`data-layout=compact\|portrait`） | `min(760px, 可用宽) × min(850px, 可用高)`；内边距 `16px 20px`；遮罩按安全区留白 `max(16px,上) max(20px,左右) max(12px,下)` |
| 遮罩 | 主题半透明底 + `backdrop-filter: blur(18px)`；`dialog::backdrop` 本身透明 |
| 进出 | 进入 300ms `cubic-bezier(.22,1,.36,1)`、退出 200ms `cubic-bezier(.4,0,1,1)`；遮罩透明度 `0↔1`，窗口 `translateY(12px)↔0`（退出落到 `8px`）；中途关闭从当前值接续 |
| 减少动态效果 | 不创建动画，立即显示/隐藏 |
| 正文排版 | 桌面 18px、≤900px 为 16px，`line-height: 1.8`；阅读列 `max-width: 78ch` 居中 |
| 滚动条 | 阅读区 `scrollbar-width: thin`，颜色 `color-mix(in srgb, ink 34%, transparent)`；窗口自身不出现第二条滚动条 |

实测几何（误差 ≤1px）：1366×768 → 896×594 @ (235,87)；1920×1080 → 1260×836 @ (330,122)；
2560×1440 → 1680×1115 @ (440,163)；390×844 → 350×816 @ (20,16)；844×390 → 760×362 @ (42,16)。

## 4. 控件

- **退出**：与弹框一致的 `CLOSE ×`——无边框无底色、`font-size: 10px`、文本与 × 间距 24px，
  × 为伪元素绘制的 14×2 十字；命中区 44×44px；无障碍名为「收起全文，返回档案」。
- **独立文章页入口**：同字号字距、纯文字无边框，保留真实 `href`（可复制、可新标签页打开）；
  与退出控件之间至少隔开 24px（约两个中文字符），避免被读成一个连体控件。
- 收起方式：右上角 `CLOSE ×` 或 `Esc`。**框外点击不关闭**，只阻止背景操作。
- 打开时焦点落在退出控件；loading/错误用 `role=status` 简短播报；Tab 始终留在窗口内。

## 5. 目录导航

窗口右缘、滚动条一侧有一条 24px 竖条，每个正文标题对应一个刻度：

- 悬停/聚焦**刻度条行本身**（每行 24×9px、间距 5px，行内 2px 横条）才展开左向面板；
  刻度栈上下的空白与窗口边缘不触发展开。
- 面板右缘与刻度条相接（约 1px 重叠），**不留缝隙**。
- 竖条内**没有按钮、也没有可见文字**（不出现「目录」二字），仅为辅助技术保留
  `nav[aria-label="目录导航"]`。
- 当前标题高亮；触屏点按任一横条即跳转并保持面板展开；**点按目录之外的正文即收起**；
  再次点按当前项也收起，且阅读层不受影响。
- `T` 键把焦点移到面板首项；`Esc` 先收起面板、再收起阅读层；刻度 `tabindex=-1`，
  面板链接是唯一的 Tab 停靠点。
- 跳转只在阅读区内滚动，并把焦点移到目标标题（定位留 16px 上边距，减少动态效果时即时滚动）。

## 6. 内容加载与安全

| 项 | 约定 |
| --- | --- |
| 请求 | `GET`，`cache: 'no-cache'`、`credentials: 'omit'`、`redirect: 'error'` |
| 目标 | 同源、无 query/hash、必须匹配页面声明的规范路径；逐段解码一次后比较，拒绝非法编码与点路径 |
| 接受 | 仅 `200` 与 `text/html`；超时 10 秒；最多 2 MiB（超限即取消） |
| 解析 | `parse5` 纯 AST → 白名单规则 → 安全节点树 → 逐节点 `createElement`/`createTextNode`，**不把原始 HTML 送进 `innerHTML`** |
| 允许元素 | 标题、段落、区块、强调、引用、列表、定义列表、`pre/code`、`kbd/samp`、上下标、链接、`time`、图文、表格、`details/summary`、任务列表（只读复选框） |
| 链接 | 仅 `http/https/mailto/tel` 与同类相对路径；`target` 仅 `_blank`/`_self`，新标签统一带 `rel="noopener noreferrer"` |
| 图片 | `src/srcset` 仅 `http/https`；保留 `alt`、正整数 `width/height`、`picture` 媒体条件；拒绝 `data:`/`blob:` 与事件属性；加载失败显示 `alt` 与原图链接 |
| 代码高亮 | 只放行 `pre/code/span` 上的白名单颜色与字重/字style，禁止 `url()`/`var()`/定位等任意样式 |
| 一律拒绝 | `script/style/link/base/meta/iframe/object/embed`、表单与可输入控件、inline SVG/MathML、自定义元素、`data-*` 应用属性 |
| 出错时 | 转为「不支持沉浸显示」，保留独立文章页入口并给出诊断；**不静默删掉正文片段后声称全文完整** |

错误码归因为 `network / timeout / http / content-type / contract / unsupported / too-large`，
界面上只给可行动的提示（重试 / 关闭 / 打开独立页），不展示堆栈。

## 7. 滚动恢复

- 记录只保存 `postId + canonicalPath + 内容指纹 → 锚点、相对偏移、scrollTop`，
  按最近使用淘汰到 20 条，不缓存 DOM 或正文文本。
- 内容指纹 = 规范路径 + postId + 规范化后的允许 AST 的 SHA-256；正文变了指纹就变，
  滚动记录失效并回到顶部。
- 首次打开从顶部；同文同指纹优先按锚点 + 偏移恢复，锚点找不到则用 clamp 后的 `scrollTop`。
- 恢复在字体就绪或最多 500ms 后、首轮布局完成时执行；字体/图片迟到触发的重排会在
  2 秒窗口内做有界修正；**用户一旦滚动、触摸或键盘定位，立即停止自动修正**。
- 旋转屏幕保留同一份正文 DOM，用锚点恢复可视段落。

## 8. 与其他模块的边界

- 背景三维场景**继续更新，只暂停输入**：未完成的镜头阻尼、自然动效与解密照常到终态。
  冻结输入只能走宿主端口 `ReaderHost.setSceneInputSuspended`，阅读层不直接命令场景。
- 阅读层不直接调用 `setMode()`；由主应用负责「先关阅读层、再执行动作」的编排，
  阅读层只提供 `withClosed()` / `closeForContextChange()` 两个等待型入口。
- 阅读层不读核心的模块级状态（当前选中档案、就绪标志、身份门、场景模式），
  全部经 `ReaderHost` 查询；因此核心的变量改名不会影响本模块。
- 模态锁按所有权恢复：不把 `stage.inert` 无条件写回 `false`。
- 主题读取 lab 的 `--theme-*` 变量（含浅色回退），不假设系统主题与用户选择一致；
  不整包导入 `blog.css`（其 `:root`/`body`/`a` 等全局规则会污染三维应用）。

## 9. 验证

```bash
npm run test:reader          # 契约 / 加载器 / 面板单元测试
npm run test:reader-e2e      # 端到端总门（Playwright；--browser/--suite/--out-dir）
npm run check:reader         # 构建后 dist 的 reader 契约与夹具哨兵检查
npm run check:reader-content # 阅读内容与契约的独立校验
npm run check:features       # 模块边界：入口唯一、无跨功能穿透、无孤儿文件
npm run build:reader-fixtures
```

改动 reader 时至少覆盖：契约字段与版本、白名单拒绝项、超时与体积上限、错误码归因、
目录跳转与收起、Esc 与焦点恢复、减少动态效果、以及「背景仍在更新但输入被暂停」。

### 9.1 端到端期望必须从内容派生

`test:reader-e2e` 的期望值**不得写死具体文章的词句或长度**。模板的示例文章会被替换，
写死之后轻则必然失败、重则静默变成永远通过的空检查（旧版本就有这个问题：正向检索词固定为
私有仓库文章的 `Multisim`，正文哨兵固定为 `参考资料`，长度阈值固定为 `textLength > 4000`，
滚动恢复容差固定为距文末 400px——换成示例文章后 5 个场景长期为红）。现行做法：

| 断言 | 期望值来源 |
| --- | --- |
| Pagefind 正向检索 | 从被断言文章**已构建的正文**中派生出现频最高的拉丁词（无拉丁词时取中文串） |
| 「初始 chunk 不含文章正文」 | 探针取自被服务文章正文的末 30 字，而不是某一句话 |
| 「reader 渲染出整篇正文」 | 与被服务页面的 `.prose` 文本长度比较（≥80%），不设绝对字符数 |
| 滚动恢复 | 按契约 §7 的锚点公式（`anchorTop − anchorOffset`，clamp 到可达范围）与实际记录比对 |

滚动恢复尤其不能按「距文末多少像素」判定：文末之后仍有内容时，最后一个锚点本就落在可达滚动
范围之外，长短文章都会如此。

## 10. 相关文档

- [docs/README.md](README.md)：文档索引
- [FEATURES.md](FEATURES.md)：功能模块划分与增删流程
- [BUILD.md](BUILD.md)：构建与发布
- [../DESIGN.md](../DESIGN.md)：三维视觉与行为基线
