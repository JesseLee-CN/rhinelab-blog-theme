// Account rules shared by every surface (blog pages and the /lab/ archive).
//
// This module is deliberately pure: no DOM, no network, no storage. It defines
// the identity data model and the username/password rules that the Go service
// mirrors in internal/identity (see services/lab-auth/internal/identity). The
// API wire contract lives in services/lab-auth/openapi.yaml.
//
// It is imported by:
//   - apps/blog (the static account page and the header account control)
//   - src/features/auth (the boot identity gate and the 3D archive)
//   - scripts/auth fixtures, which load it through scripts/auth/load-ts.mjs
// so it must stay import-free at runtime.

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
