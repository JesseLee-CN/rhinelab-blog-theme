// Lab-only lifecycle state machines.
//
// The account *rules* (username/password, identity model, label derivation) are
// shared with the blog pages and live in shared/auth/identity.ts. What stays here
// are the phases of the 3D archive's own surfaces: the boot intro curtain
// (LOGIN-IMPROVE L1a), the entry panel form, and the auth client lifecycle.
//
// This module must stay import-free so scripts/auth can load it with load-ts.mjs.

// Intro layer lifecycle. Owned only by BootIntro; the original boot timeline and
// the entry panel never write it. `disposed` is terminal and reachable from any
// other phase via dispose().
export type IntroPhase =
  | "connecting"
  | "docking"
  | "ready"
  | "exiting"
  | "handoff"
  | "playing"
  | "entered"
  | "resource-error"
  | "disposed";

// Entry panel form. The intro owns the exit animation; the panel only switches
// between the login and register forms and reports `busy` separately.
export type EntryPanelPhase = "login" | "register";

export interface EntryPanelState {
  readonly phase: EntryPanelPhase;
  readonly busy: boolean;
}

// Auth client lifecycle. `registering` covers the register request; success
// and failure always return to `idle` and never enter `confirming` directly.
// The UI close is never proof that a server-side attempt was cancelled; only
// `cancelling` completion reflects that.
export type AuthPhase =
  | "idle"
  | "verifying"
  | "confirming"
  | "cancelling"
  | "registering";

// Allowed IntroPhase edges. Main path:
// connecting -> docking -> ready -> exiting -> handoff -> playing -> entered.
// Reduced motion may skip docking (connecting -> ready) and the exit
// (ready -> handoff); replay re-enters playing with the current identity;
// switching identity returns to ready. `disposed` is reachable from anywhere.
export const INTRO_TRANSITIONS: Record<IntroPhase, readonly IntroPhase[]> = {
  connecting: ["docking", "ready", "resource-error"],
  docking: ["ready", "resource-error"],
  ready: ["exiting", "handoff"],
  exiting: ["handoff"],
  handoff: ["playing", "entered"],
  playing: ["entered", "ready", "playing"],
  entered: ["playing", "ready"],
  "resource-error": ["connecting"],
  disposed: [],
};

export function canIntroTransition(from: IntroPhase, to: IntroPhase): boolean {
  if (to === "disposed") return from !== "disposed";
  return INTRO_TRANSITIONS[from].includes(to);
}

export const ENTRY_PANEL_TRANSITIONS: Record<
  EntryPanelPhase,
  readonly EntryPanelPhase[]
> = {
  login: ["register"],
  register: ["login"],
};

export function canEntryPanelTransition(
  from: EntryPanelPhase,
  to: EntryPanelPhase,
): boolean {
  return ENTRY_PANEL_TRANSITIONS[from].includes(to);
}

export const AUTH_TRANSITIONS: Record<AuthPhase, readonly AuthPhase[]> = {
  idle: ["verifying", "registering"],
  verifying: ["confirming", "idle", "cancelling"],
  confirming: ["idle", "cancelling"],
  registering: ["idle"],
  cancelling: ["idle"],
};

export function canAuthTransition(from: AuthPhase, to: AuthPhase): boolean {
  return AUTH_TRANSITIONS[from].includes(to);
}
