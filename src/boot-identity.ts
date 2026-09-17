// G1 frozen contracts for the boot identity flow.
//
// This module is deliberately pure: no DOM, no network, no storage. It defines
// the identity data model, the username/password rules agreed in
// the allowed UI/auth phase transitions.
// The API wire contract lives in services/lab-auth/openapi.yaml.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const RESERVED_USERNAME_KEYS: readonly string[] = ["guest"];
export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 128;

export type IdentityKind = "none" | "guest" | "registered";

export interface NoIdentity {
  readonly kind: "none";
}

export interface GuestIdentity {
  readonly kind: "guest";
  readonly label: "GUEST";
}

export interface RegisteredIdentity {
  readonly kind: "registered";
  readonly userId: string;
  readonly username: string;
  readonly label: string;
}

export type BootIdentity = NoIdentity | GuestIdentity | RegisteredIdentity;

// An identity the user has actually chosen (never the "none" placeholder).
export type ChosenIdentity = GuestIdentity | RegisteredIdentity;

// Intro layer lifecycle (boot curtain, LOGIN-IMPROVE L1a). Owned only by
// BootIntro; the original boot timeline and the entry panel never write it.
// `disposed` is terminal and reachable from any other phase via dispose().
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

export type UsernameError = "too-short" | "too-long" | "charset" | "reserved";
export type PasswordError = "too-short" | "too-long";

export interface ValidUsername {
  readonly ok: true;
  readonly key: string;
  readonly username: string;
  readonly label: string;
}

export type UsernameResult =
  ValidUsername | { readonly ok: false; readonly error: UsernameError };
export type PasswordResult =
  { readonly ok: true } | { readonly ok: false; readonly error: PasswordError };

export const NO_IDENTITY: NoIdentity = { kind: "none" };

/** Uniqueness key: ASCII lower-case. Never used for display. */
export function usernameKey(username: string): string {
  return username.toLowerCase();
}

/** Display label: upper-case, matching `ID CONFIRMED : <LABEL>`. */
export function usernameLabel(username: string): string {
  return username.toUpperCase();
}

export function usernameCodePoints(value: string): number {
  return [...value].length;
}

export function validateUsername(value: string): UsernameResult {
  const length = usernameCodePoints(value);
  if (length < USERNAME_MIN) return { ok: false, error: "too-short" };
  if (length > USERNAME_MAX) return { ok: false, error: "too-long" };
  if (!USERNAME_PATTERN.test(value)) return { ok: false, error: "charset" };
  const key = usernameKey(value);
  if (RESERVED_USERNAME_KEYS.includes(key))
    return { ok: false, error: "reserved" };
  return { ok: true, key, username: value, label: usernameLabel(value) };
}

/** Passwords are never trimmed or normalised; length is Unicode code points. */
export function passwordCodePoints(value: string): number {
  return [...value].length;
}

export function validatePassword(value: string): PasswordResult {
  const length = passwordCodePoints(value);
  if (length < PASSWORD_MIN) return { ok: false, error: "too-short" };
  if (length > PASSWORD_MAX) return { ok: false, error: "too-long" };
  return { ok: true };
}

export function guestIdentity(): GuestIdentity {
  return { kind: "guest", label: "GUEST" };
}

/**
 * Build a registered identity from a server response. The label is derived
 * from the server-returned username, never from raw form input.
 */
export function registeredIdentity(
  userId: string,
  username: string,
): RegisteredIdentity {
  return {
    kind: "registered",
    userId,
    username,
    label: usernameLabel(username),
  };
}

export function sameIdentity(a: BootIdentity, b: BootIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "registered" && b.kind === "registered")
    return a.userId === b.userId;
  return true;
}

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
