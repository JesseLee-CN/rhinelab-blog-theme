import { escapeHtml } from "../../html";
import { BootEntry } from "./panel";
import { createAuthClient, type IdentityPort } from "./client";
import { HANDOFF_APP_TIME } from "./intro-motion";
import { BootIntro } from "./intro";
import type { BootIdentity, ChosenIdentity, EntryPanelPhase, IntroPhase } from "./identity";

/**
 * 启动身份门与登录/注册的状态机（G4/L1a、LOGIN-IMPROVE L0–L4c）。
 *
 * 边界（详见 src/features/README.md 与 docs/FEATURES.md）：
 * - 本模块拥有：序幕（BootIntro）、身份选择/登录/注册面板（BootEntry）、
 *   身份会话端口、身份门与序幕的阶段状态，以及“切换身份 / 退出登录”流程。
 * - 本模块不拥有：开场影片时间轴、三维场景、终端音效、舞台 inert 与
 *   阅读层。这些通过 EntryHost 端口借用，所以移除本模块不会牵动核心。
 * - 序幕必须在 start() 等待任何资源之前完成首帧遮挡（L1b），因此创建顺序
 *   由调用方决定：先 createEntryFeature()，再 await entryFeature.start()。
 */

/** 舞台矩形（序幕据此把 2D 布局对齐到三维舞台）。 */
export type StageRect = { left: number; top: number; width: number; height: number };

/** 宿主（三维档案应用）向身份门提供的最小能力集。 */
export interface EntryHost {
  /** 身份已确定、序幕退场前：静默准备第一可见帧（原创帧 169）。 */
  prepareBootFrame(identity: ChosenIdentity, appTime: number): void;
  /** 序幕退场结束：把舞台交还给三维应用，必要时继续播放开场影片。 */
  commitBootHandoff(identity: ChosenIdentity, rafMs: number): void;
  /** 身份门开合：同步舞台 inert 与移动端入口按钮。 */
  setGateInert(active: boolean): void;
  /** 序幕是否仍完整遮挡舞台（写入 #stage 的 visibility）。 */
  setStageHidden(hidden: boolean): void;
  /** 用户与面板交互：释放并解锁音频。 */
  engageAudio(): void;
  /** 关闭阅读层等叠加表面；需要等待关闭完成时返回 Promise。 */
  closeOverlays(): void | Promise<void>;
  /** 回到开场场景（重开身份选择页）。 */
  returnToBoot(): void;
  /** 终端提示条。 */
  notify(message: string): void;
}

/**
 * DEV 审阅快照（`window.rhine.stats()` 的身份门部分）。
 *
 * 键名是**对外契约**：`scripts/auth/*` 与 `scripts/reading/e2e/harness.mjs` 都按
 * `introPhase` / `panelPhase` / `panelBusy` / `identity` 读取，改名会静默破坏这些检查。
 */
export type EntryReviewSnapshot = {
  introPhase: IntroPhase;
  panelPhase: EntryPanelPhase;
  panelBusy: boolean;
  identity: BootIdentity;
  label: string;
};

export interface EntryFeature {
  /** 序幕/身份门是否仍占用屏幕：为真时一切交互入口都不得触发。 */
  isGateActive(): boolean;
  /** 序幕阶段。 */
  phase(): IntroPhase;
  /** 登录/注册面板阶段。 */
  panelPhase(): EntryPanelPhase;
  /** 面板是否正在等待服务端。 */
  panelBusy(): boolean;
  /** 当前身份（尚未选择时为 none）。 */
  identity(): BootIdentity;
  /** 当前身份标签，终端状态栏与开场影片共用。 */
  label(): string;
  /** 本次会话 URL 请求的场景（?scene=）。 */
  requestedScene(): string | null;
  /** 序幕阶段写入点：由核心的交接流程调用。 */
  setPhase(phase: IntroPhase): void;
  /** 收起序幕（交接开始时调用）。 */
  hide(): void;
  /** 身份已确定：接管身份与标签，并让核心静默准备第一帧。 */
  adopt(identity: ChosenIdentity): void;
  /** 启动：解析身份端口、恢复会话、挂载面板。 */
  start(params: URLSearchParams): Promise<void>;
  /** 启动资源不可用时给出可读错误页（无公开文章等）。 */
  resourcesFailed(message: string): void;
  /** 帧循环：推进序幕动画。 */
  tick(rafMs: number): void;
  /** 视口变化：重算序幕布局。 */
  resize(): void;
  /** 舞台矩形变化：把序幕的 2D 布局对齐到三维舞台。 */
  setStageRect(rect: StageRect): void;
  /** SYSTEM SETTINGS 顶部的身份摘要。 */
  summaryMarkup(): string;
  /** 是否展示“退出登录”。 */
  canLogout(): boolean;
  /** 显式切换身份：重开选择页并刷新记忆用户（CONTRACT.md §3.1）。 */
  switchIdentity(): void;
  /** 真实登出；失败如实提示，不伪装成功。 */
  logout(): Promise<void>;
  /** DEV 预览：跳过身份门，固定身份与标签。 */
  usePlaybackIdentity(label: string): void;
  /** DEV 预览：直接收起序幕。 */
  hideForPlayback(): void;
  /** DEV 审阅快照。 */
  snapshot(): EntryReviewSnapshot;
  /** HMR：不得留下第二份序幕/面板 DOM 与监听器。 */
  dispose(): void;
}

export function createEntryFeature(options: {
  host: EntryHost;
  viewport: HTMLElement;
  /** 逐键动效偏好全部关闭时，序幕直接进入稳定停靠态。 */
  reducedMotion: boolean;
}): EntryFeature {
  const { host } = options;
  let entry: BootEntry | undefined;
  let authPort: IdentityPort | undefined;
  let introPhase: IntroPhase = "connecting";
  let panelPhase: EntryPanelPhase = "login";
  let panelBusy = false;
  let currentIdentity: BootIdentity = { kind: "none" };
  let currentLabel = "JOYCE MOORE";
  let requestedScene: string | null = null;

  const entryDone = (): boolean => introPhase === "playing" || introPhase === "entered";
  const isGateActive = (): boolean => !entryDone();
  const applyInert = (): void => host.setGateInert(isGateActive());

  /** 序幕在交接前完整遮挡舞台，首帧不会露出未初始化的三维舞台（L1b）。 */
  const coversStage = (): boolean =>
    introPhase === "connecting" ||
    introPhase === "docking" ||
    introPhase === "ready" ||
    introPhase === "exiting";
  const applyStageVisibility = (): void => host.setStageHidden(coversStage());

  const intro = new BootIntro({
    viewport: options.viewport,
    reducedMotion: options.reducedMotion,
    onReady: () => entry?.show(),
    onCommit: (identity, rafMs) => host.commitBootHandoff(identity, rafMs),
    onPhase: (phase) => {
      introPhase = phase;
      applyStageVisibility();
    },
  });
  applyStageVisibility();

  async function resolvePort(params: URLSearchParams): Promise<IdentityPort> {
    if (import.meta.env.DEV && params.has("entryMock")) {
      const { createDevIdentityPort } = await import("./dev-port");
      return createDevIdentityPort(params.get("entryMock"));
    }
    return createAuthClient();
  }

  function adopt(identity: ChosenIdentity): void {
    currentIdentity = identity;
    currentLabel = identity.label;
    const footerIdentity = document.querySelector<HTMLElement>("#session-identity");
    if (footerIdentity) footerIdentity.textContent = currentLabel;
    // 备案信息（按需填写）：需要展示备案号时，把备案 DOM 挂到 .system-footer 内。
    host.prepareBootFrame(identity, HANDOFF_APP_TIME);
  }

  function startBootWith(identity: ChosenIdentity): void {
    host.engageAudio();
    adopt(identity);
    intro.requestExit(identity);
  }

  function summaryMarkup(): string {
    if (currentIdentity.kind === "registered") return `当前身份 <strong>${escapeHtml(currentIdentity.label)}</strong>`;
    if (currentIdentity.kind === "guest") return "访客身份 <strong>GUEST</strong>";
    return "尚未选择身份";
  }

  function switchIdentity(): void {
    if (!entry) return;
    void host.closeOverlays();
    host.returnToBoot();
    intro.showIdentity();
    entry.reset();
    entry.show();
    // 刷新记忆用户：过期或被吊销的会话绝不提供一键继续。
    void authPort?.session()
      .then((state) => entry?.setRemembered(state.authenticated ? state.user : null))
      .catch(() => entry?.setRemembered(null));
  }

  async function logout(): Promise<void> {
    if (!authPort) return;
    await host.closeOverlays();
    try {
      const state = await authPort.session();
      if (state.authenticated) await authPort.logout(state.csrfToken);
      host.notify("已退出登录");
    } catch {
      host.notify("退出未确认，请重试");
    }
    switchIdentity();
  }

  async function start(params: URLSearchParams): Promise<void> {
    requestedScene = params.get("scene");
    const port = await resolvePort(params);
    authPort = port;
    // 会话 Cookie 是持久 Cookie：服务端仍认得这个浏览器时提供一键继续。
    const restored = await port.session().catch(() => null);
    entry = new BootEntry({
      mount: intro.panel,
      port,
      session: restored?.authenticated ? restored.user : null,
      onIdentityChosen: startBootWith,
      onEngage: () => host.engageAudio(),
      onPanelPhase: (phase, busy) => {
        panelPhase = phase;
        panelBusy = busy;
        applyInert();
      },
    });
    intro.measurePanel();
    applyInert();
    intro.resourcesReady();
  }

  function usePlaybackIdentity(label: string): void {
    currentIdentity = { kind: "registered", userId: "legacy", username: label, label };
    currentLabel = label;
  }

  return {
    isGateActive,
    phase: () => introPhase,
    panelPhase: () => panelPhase,
    panelBusy: () => panelBusy,
    identity: () => currentIdentity,
    label: () => currentLabel,
    requestedScene: () => requestedScene,
    setPhase: (phase) => {
      introPhase = phase;
    },
    hide: () => intro.hide(),
    adopt,
    start,
    resourcesFailed: (message) => intro.resourcesFailed(message),
    tick: (rafMs) => intro.tick(rafMs),
    resize: () => intro.resize(),
    setStageRect: (rect) => intro.setStageRect(rect),
    summaryMarkup,
    canLogout: () => currentIdentity.kind === "registered",
    switchIdentity,
    logout,
    usePlaybackIdentity,
    hideForPlayback: () => intro.hideForPlayback(),
    snapshot: () => ({
      introPhase,
      panelPhase,
      panelBusy,
      identity: currentIdentity,
      label: currentLabel,
    }),
    dispose: () => {
      intro.dispose();
      entry?.dispose();
      entry = undefined;
    },
  };
}
