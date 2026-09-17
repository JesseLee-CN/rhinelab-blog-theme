// LOGIN-IMPROVE L1b/L1c: the boot intro curtain.
//
// Owns the CONNECTING composition and the one recycled Logo node from
// connecting to exiting, hides the original #stage, animates the login panel
// entrance, then reports a single handoff commit. All trajectory math lives in
// the pure boot-intro-motion module; this class only writes DOM. It never
// requests authentication.
import { brandHeading, logo } from "./brand";
import { BootLettering } from "./boot-lettering";
import {
  DOCKING_MS,
  EXIT_MS,
  Revision,
  exitStateAt,
  formRowStateAt,
  introLayout,
  logoStateAt,
  type IntroLayout,
} from "./boot-intro-motion";
import type { ChosenIdentity, IntroPhase } from "./boot-identity";

// Size of the legacy loading mark (style.css `.loading-mark`).
const CONNECTING = { width: 150, height: 90 } as const;
const FALLBACK_LOGO = { width: 256, height: 153 } as const;
const FALLBACK_FORM = { width: 423, height: 225 } as const;

export interface BootIntroOptions {
  viewport: HTMLElement;
  reducedMotion: boolean;
  onReady: () => void;
  onCommit: (identity: ChosenIdentity, rafMs: number) => void;
  onPhase?: (phase: IntroPhase) => void;
}

export class BootIntro {
  readonly element: HTMLElement;
  readonly panel: HTMLElement;
  private readonly panelClip: HTMLElement;
  private readonly background: HTMLElement;
  private readonly logoNode: HTMLElement;
  private readonly connecting: HTMLElement;
  private readonly brand: HTMLElement;
  private readonly powered: HTMLElement;
  private readonly error: HTMLElement;
  private readonly revision = new Revision();
  private readonly reduced: boolean;

  private phaseValue: IntroPhase = "connecting";
  private layout: IntroLayout;
  private panelSize: { width: number; height: number } = { ...FALLBACK_FORM };
  private dockStart: number | null = null;
  private exitStart: number | null = null;
  private pendingIdentity: ChosenIdentity | null = null;

  constructor(private readonly options: BootIntroOptions) {
    this.reduced = options.reducedMotion;
    this.element = document.createElement("div");
    this.element.id = "boot-intro";
    this.element.className = "boot-intro";
    this.element.dataset.introPhase = "connecting";
    this.element.innerHTML = `
      <div class="intro-background" aria-hidden="true"></div>
      <header class="brand intro-brand">${brandHeading}</header>
      <div class="intro-logo-clip"><div class="intro-logo" id="intro-logo">${logo}</div></div>
      <div class="intro-connecting"><span>CONNECTING TO INTERNAL DATABASE</span><i></i></div>
      <div class="intro-panel-clip"><div class="intro-panel" id="intro-panel"></div></div>
      <div class="powered intro-powered">POWERED BY <b>RHINE LAB</b><i></i></div>
      <div class="intro-resource-error" hidden><strong>CONNECTION INTERRUPTED</strong><p>三维档案资源未能载入。请确认浏览器已启用硬件加速，然后重新连接。</p><button type="button" data-intro-action="reload">RECONNECT →</button></div>`;
    options.viewport.append(this.element);
    this.panelClip =
      this.element.querySelector<HTMLElement>(".intro-panel-clip")!;
    this.panel = this.element.querySelector<HTMLElement>("#intro-panel")!;
    this.background =
      this.element.querySelector<HTMLElement>(".intro-background")!;
    this.logoNode = this.element.querySelector<HTMLElement>("#intro-logo")!;
    this.connecting =
      this.element.querySelector<HTMLElement>(".intro-connecting")!;
    this.brand = this.element.querySelector<HTMLElement>(".intro-brand")!;
    // 序幕的品牌字块与 #stage 的那一份共用 brandHeading，也必须绑定同一套
    // Novecento 描边图形：boot-lettering.css 把 `.brand h1` 调成 50.75px / 1px 字距，
    // 只作用于文字时序幕那份会明显偏宽、与档案页不一致（2026-09-13 用户反馈）。
    new BootLettering(this.brand.querySelector("h1")!, ["brand"]).setText(
      "RHINE LAB",
    );
    this.powered = this.element.querySelector<HTMLElement>(".intro-powered")!;
    this.error = this.element.querySelector<HTMLElement>(
      ".intro-resource-error",
    )!;
    this.error.addEventListener("click", this.onErrorClick);
    this.layout = this.computeLayout();
    this.applyLayout();
    this.applyConnecting();
  }

  get phase(): IntroPhase {
    return this.phaseValue;
  }

  /** Re-measure the mounted entry panel, then refresh the docked layout. */
  measurePanel(): void {
    const entry = this.panel.firstElementChild as HTMLElement | null;
    if (entry) {
      this.panelSize = {
        width: Math.max(1, entry.offsetWidth || FALLBACK_FORM.width),
        height: Math.max(1, entry.offsetHeight || FALLBACK_FORM.height),
      };
    }
    this.layout = this.computeLayout();
    this.applyLayout();
  }

  private computeLayout(): IntroLayout {
    const viewport = this.options.viewport;
    const logoSize = {
      width: this.logoNode.offsetWidth || FALLBACK_LOGO.width,
      height: this.logoNode.offsetHeight || FALLBACK_LOGO.height,
    };
    return introLayout({
      width: viewport.clientWidth || window.innerWidth,
      height: viewport.clientHeight || window.innerHeight,
      logo: logoSize,
      form: this.panelSize,
    });
  }

  private applyLayout(): void {
    this.panel.style.left = `${this.layout.form.x}px`;
    this.panel.style.top = `${this.layout.form.y}px`;
    this.panel.style.width = `${this.layout.form.width}px`;
    if (this.layout.mode === "stack") {
      // Let the curtain scroll on short screens instead of clipping the panel.
      this.panelClip.style.height = `${this.layout.contentHeight}px`;
      this.powered.style.top = `${this.layout.contentHeight - 34}px`;
      this.powered.style.bottom = "auto";
    } else {
      this.panelClip.style.height = "";
      this.powered.style.top = "";
      this.powered.style.bottom = "";
    }
  }

  private setPhase(next: IntroPhase): void {
    if (this.phaseValue === next) return;
    this.phaseValue = next;
    this.element.dataset.introPhase = next;
    this.options.onPhase?.(next);
  }

  private setLogo(state: {
    x: number;
    y: number;
    scale: number;
    opacity: number;
  }): void {
    this.logoNode.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    this.logoNode.style.opacity = String(state.opacity);
  }

  private showCorners(): void {
    this.brand.style.opacity = "1";
    this.powered.style.opacity = "1";
  }

  private panelRows(): HTMLElement[] {
    return [...this.panel.querySelectorAll<HTMLElement>("[data-intro-row]")];
  }

  private applyPanelEnter(elapsedMs: number): void {
    this.panelRows().forEach((row, index) => {
      const state = formRowStateAt(elapsedMs, index);
      row.style.opacity = state.visible ? "1" : "0";
      row.style.transform = `translateY(${state.translateY}px)`;
    });
  }

  private settlePanel(): void {
    this.panelRows().forEach((row) => {
      row.style.opacity = "1";
      row.style.transform = "";
    });
  }

  /** Align the intro background with the on-screen stage box so the letterbox
   *  area keeps the viewport colour and the handoff has no side seam. */
  setStageRect(rect: { left: number; top: number; width: number; height: number }): void {
    this.background.style.left = `${rect.left}px`;
    this.background.style.top = `${rect.top}px`;
    this.background.style.right = "auto";
    this.background.style.bottom = "auto";
    this.background.style.width = `${rect.width}px`;
    this.background.style.height = `${rect.height}px`;
  }

  private applyConnecting(): void {
    this.setLogo(logoStateAt(0, this.layout, CONNECTING));
    this.connecting.hidden = false;
    this.brand.style.opacity = "0";
    this.powered.style.opacity = "0";
    this.panelClip.style.visibility = "hidden";
    this.panel.style.transform = "";
  }

  /** Loading finished: dock the Logo (or jump straight to ready when reduced). */
  resourcesReady(): void {
    if (this.phaseValue !== "connecting") return;
    const token = this.revision.next();
    this.connecting.hidden = true;
    this.showCorners();
    this.panelClip.style.visibility = "visible";
    // The panel is interactive from this moment; ready must not reset a form
    // the user may already be submitting while the Logo docks.
    this.options.onReady();
    if (this.reduced) {
      this.setLogo(logoStateAt(DOCKING_MS, this.layout, CONNECTING));
      this.settlePanel();
      this.finishDocking(token);
      return;
    }
    this.applyPanelEnter(0);
    this.setPhase("docking");
    this.dockStart = performance.now();
  }

  private finishDocking(token: number): void {
    if (!this.revision.isCurrent(token)) return;
    this.dockStart = null;
    this.settlePanel();
    this.setPhase("ready");
    if (this.pendingIdentity) this.beginExit();
  }

  /** Single RAF driver. Pure sampling: elapsed time comes from the caller. */
  tick(rafMs: number): void {
    if (this.phaseValue === "docking" && this.dockStart !== null) {
      const token = this.revision.current();
      const elapsed = rafMs - this.dockStart;
      this.setLogo(logoStateAt(elapsed, this.layout, CONNECTING));
      this.applyPanelEnter(elapsed);
      if (elapsed >= DOCKING_MS) this.finishDocking(token);
      return;
    }
    if (this.phaseValue === "exiting" && this.exitStart !== null) {
      const elapsed = rafMs - this.exitStart;
      const state = exitStateAt(elapsed, this.layout);
      this.logoNode.style.transform = `translate(${this.layout.logo.x + state.logoDx}px, ${this.layout.logo.y}px) scale(1)`;
      this.logoNode.style.opacity = state.visible ? "1" : "0";
      this.brand.style.opacity = state.visible ? "1" : "0";
      this.powered.style.opacity = state.visible ? "1" : "0";
      this.panel.style.transform = `translateX(${state.formDx}px)`;
      if (!state.visible) this.panelClip.style.visibility = "hidden";
      if (elapsed >= EXIT_MS) {
        this.exitStart = null;
        this.setPhase("handoff");
        const identity = this.pendingIdentity;
        this.pendingIdentity = null;
        if (identity) this.options.onCommit(identity, rafMs);
      }
    }
  }

  /** Accepted once; queued while the Logo is still docking, then locked. */
  requestExit(identity: ChosenIdentity): void {
    if (this.pendingIdentity) return;
    if (this.phaseValue === "docking") {
      // A fast user can choose an identity before docking completes; the exit
      // must wait for the docked backdrop instead of being dropped.
      this.pendingIdentity = identity;
      return;
    }
    if (this.phaseValue !== "ready") return;
    this.pendingIdentity = identity;
    this.beginExit();
  }

  private beginExit(): void {
    const identity = this.pendingIdentity;
    if (!identity) return;
    if (this.reduced) {
      this.revision.next();
      this.logoNode.style.opacity = "0";
      this.brand.style.opacity = "0";
      this.powered.style.opacity = "0";
      this.panelClip.style.visibility = "hidden";
      this.setPhase("handoff");
      this.pendingIdentity = null;
      this.options.onCommit(identity, performance.now());
      return;
    }
    this.setPhase("exiting");
    this.exitStart = performance.now();
  }

  /** Explicit identity switch: jump to the stable docked login backdrop. */
  showIdentity(): void {
    this.revision.next();
    this.element.hidden = false;
    this.setLogo(logoStateAt(DOCKING_MS, this.layout, CONNECTING));
    this.connecting.hidden = true;
    this.showCorners();
    this.panelClip.style.visibility = "visible";
    this.panel.style.transform = "";
    this.settlePanel();
    this.setPhase("ready");
  }

  /** DEV preview / replay: hide the curtain and hand the stage back. */
  hideForPlayback(): void {
    this.revision.next();
    this.element.hidden = true;
    this.setPhase("playing");
  }

  /** Hide the element without changing the phase (used inside handoff commit). */
  hide(): void {
    this.element.hidden = true;
  }

  resourcesFailed(message: string): void {
    this.revision.next();
    this.connecting.hidden = true;
    this.panelClip.style.visibility = "hidden";
    if (message) {
      const paragraph = this.error.querySelector("p");
      if (paragraph) paragraph.textContent = message;
    }
    this.error.hidden = false;
    this.setPhase("resource-error");
  }

  resize(): void {
    this.layout = this.computeLayout();
    this.applyLayout();
    if (this.phaseValue === "connecting") this.applyConnecting();
    else if (this.phaseValue === "ready")
      this.setLogo(logoStateAt(DOCKING_MS, this.layout, CONNECTING));
    // docking/exiting keep the new layout on the next tick.
  }

  private onErrorClick = (event: MouseEvent): void => {
    if ((event.target as HTMLElement)?.dataset.introAction === "reload")
      location.reload();
  };

  dispose(): void {
    this.revision.next();
    this.error.removeEventListener("click", this.onErrorClick);
    this.element.remove();
    this.setPhase("disposed");
  }
}
