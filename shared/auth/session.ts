// Cross-surface account session.
//
// The session itself is one `__Host-lab-session` cookie on the whole origin, so
// the blog pages and `/lab/` are already the same login by construction: signing
// in on either surface is visible to the other on its next `GET /session`.
//
// This bridge adds the part a cookie cannot do — telling a page that is already
// open that the state changed. Login/logout publish on a BroadcastChannel (with
// a storage-event fallback) so an open blog page updates the moment another tab
// signs in or out, without polling and without a reload.
import {
  AUTH_BASE,
  AuthError,
  createAuthClient,
  type IdentityPort,
  type PublicUser,
  type SessionState,
} from "./client";
import { passwordCodePoints, validatePassword, validateUsername } from "./identity";

export const AUTH_CHANNEL = "rhine-auth";
const PING_KEY = "rhine-auth-ping";
/** Reads are cheap but not free: coalesce them within this window. */
const CACHE_MS = 5_000;

export type AccountSession = SessionState;

export interface SessionBridgeOptions {
  base?: string;
  /** Injectable for tests; defaults to the real same-origin client. */
  port?: IdentityPort;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

export interface SessionBridge {
  readonly port: IdentityPort;
  /** Last known session, or null before the first read completes. */
  current(): AccountSession | null;
  /** Read the session; `refresh` skips the cache. Concurrent calls share one request. */
  read(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<AccountSession>;
  /** Login: open a flow, verify the credentials, then confirm the session. */
  login(username: string, password: string, signal?: AbortSignal): Promise<PublicUser>;
  /** Register: creates the account but never signs it in (server contract). */
  register(username: string, password: string, signal?: AbortSignal): Promise<PublicUser>;
  /** Logout; the cookie is cleared even when the request fails locally. */
  logout(): Promise<void>;
  /** Observe session changes from this tab and from other tabs. */
  subscribe(listener: (session: AccountSession) => void): () => void;
  dispose(): void;
}

type Ping = { at: number; session: AccountSession | null };

/**
 * Validate a credential pair with the shared rules before spending a request.
 * Returns the server-shaped error code so a form can map it to one field.
 */
export function validateCredentials(
  username: string,
  password: string,
): { ok: true } | { ok: false; field: "username" | "password"; error: string } {
  const name = validateUsername(username);
  if (!name.ok) return { ok: false, field: "username", error: name.error };
  const secret = validatePassword(password);
  if (!secret.ok) return { ok: false, field: "password", error: secret.error };
  return { ok: true };
}

export function createSessionBridge(options: SessionBridgeOptions = {}): SessionBridge {
  const port = options.port ?? createAuthClient(options.base ?? AUTH_BASE);
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(session: AccountSession) => void>();
  let cached: AccountSession | null = null;
  let readAt = 0;
  let pending: Promise<AccountSession> | null = null;

  const channel =
    typeof BroadcastChannel === "function" ? new BroadcastChannel(AUTH_CHANNEL) : null;

  function publish(session: AccountSession): void {
    cached = session;
    readAt = now();
    for (const listener of listeners) listener(session);
  }

  /** Tell other tabs; a channel message carries the value, storage does not. */
  function broadcast(session: AccountSession | null): void {
    const ping: Ping = { at: now(), session };
    try {
      channel?.postMessage(ping);
    } catch {
      // A closed channel must never break the login that already succeeded.
    }
    if (!channel) {
      try {
        localStorage.setItem(PING_KEY, JSON.stringify(ping));
      } catch {
        // Private mode or a full quota: cross-tab sync is best effort.
      }
    }
  }

  async function fetchSession(signal?: AbortSignal): Promise<AccountSession> {
    const session = await port.session(signal);
    publish(session);
    return session;
  }

  function read(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<AccountSession> {
    const fresh = options.refresh === true || cached === null || now() - readAt > CACHE_MS;
    if (!fresh && cached) return Promise.resolve(cached);
    pending ??= fetchSession(options.signal).finally(() => {
      pending = null;
    });
    return pending;
  }

  const onChannelMessage = (event: MessageEvent<Ping>) => {
    const session = event.data?.session;
    if (session) publish(session);
    else void read({ refresh: true }).catch(() => {});
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PING_KEY || !event.newValue) return;
    try {
      const ping = JSON.parse(event.newValue) as Ping;
      if (ping.session) publish(ping.session);
      else void read({ refresh: true }).catch(() => {});
    } catch {
      // A malformed ping is ignored; the next read still sees the cookie.
    }
  };
  channel?.addEventListener("message", onChannelMessage as EventListener);
  if (!channel && typeof addEventListener === "function") {
    addEventListener("storage", onStorage);
  }

  return {
    port,
    current: () => cached,
    read,
    async login(username, password, signal) {
      const check = validateCredentials(username, password);
      if (!check.ok) throw new AuthError("bad_request", `${check.field}:${check.error}`);
      const flow = await port.openFlow(signal);
      try {
        await port.login(flow.attemptId, username, password, signal);
        const confirmed = await port.confirm(flow.attemptId, signal);
        // The cookie exists now; re-read so the cached state carries the CSRF
        // token the logout call needs.
        await read({ refresh: true });
        return confirmed.user;
      } catch (error) {
        // A failed attempt must not leave a server-side attempt pending.
        void port.cancel(flow.attemptId).catch(() => {});
        throw error;
      }
    },
    async register(username, password, signal) {
      const check = validateCredentials(username, password);
      if (!check.ok) throw new AuthError("bad_request", `${check.field}:${check.error}`);
      const flow = await port.openFlow(signal);
      try {
        const created = await port.register(flow.attemptId, username, password, signal);
        return created.user;
      } finally {
        void port.cancel(flow.attemptId).catch(() => {});
      }
    },
    async logout() {
      const session = await read({ refresh: true }).catch(() => null);
      if (session?.authenticated) await port.logout(session.csrfToken);
      publish({ authenticated: false });
      broadcast({ authenticated: false });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      channel?.removeEventListener("message", onChannelMessage as EventListener);
      channel?.close();
      if (typeof removeEventListener === "function") removeEventListener("storage", onStorage);
    },
  };
}

/** Exposed for the account forms: the minimum password length in code points. */
export { passwordCodePoints };
