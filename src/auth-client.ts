// Real same-origin client for /lab/api/auth/ (G1 contract + register-v1). The
// UI talks to an IdentityPort so DEV browser checks can substitute a mock while
// production always uses this client.
//
// Flow state is keyed by attemptId: a late openFlow/cancel completion can only
// clean up its own context and never clobber a newer attempt.
import type { BootIdentity } from "./boot-identity";

export interface PublicUser {
  id: string;
  username: string;
}

export type SessionState =
  | { authenticated: false }
  | {
      authenticated: true;
      user: PublicUser;
      sessionExpiresAt: number;
      csrfToken: string;
    };

export type AuthErrorCode =
  | "network"
  | "timeout"
  | "bad_request"
  | "invalid_credentials"
  | "origin_rejected"
  | "csrf_rejected"
  | "state_conflict"
  | "payload_too_large"
  | "rate_limited"
  | "unavailable"
  | "registration_unavailable"
  | "registration_disabled"
  | "protocol";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface IdentityPort {
  openFlow(signal?: AbortSignal): Promise<{ attemptId: string }>;
  login(
    attemptId: string,
    username: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<{ user: PublicUser }>;
  register(
    attemptId: string,
    username: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<{ user: PublicUser }>;
  confirm(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<{ user: PublicUser }>;
  cancel(attemptId: string): Promise<void>;
  session(signal?: AbortSignal): Promise<SessionState>;
  logout(csrfToken: string, signal?: AbortSignal): Promise<void>;
}

const STATUS_CODES: Record<number, AuthErrorCode> = {
  400: "bad_request",
  401: "invalid_credentials",
  403: "csrf_rejected",
  409: "state_conflict",
  413: "payload_too_large",
  429: "rate_limited",
  503: "unavailable",
};

// Each network step gets its own deadline; BootEntry adds the 20s attempt budget.
const STEP_TIMEOUT_MS = 10_000;
const MAX_FLOWS = 8;

export function createAuthClient(base = "/lab/api/auth"): IdentityPort {
  const flows = new Map<string, { csrfToken: string }>();

  function remember(attemptId: string, csrfToken: string): void {
    flows.set(attemptId, { csrfToken });
    while (flows.size > MAX_FLOWS) {
      const oldest = flows.keys().next().value;
      if (oldest === undefined) break;
      flows.delete(oldest);
    }
  }

  function csrfFor(attemptId: string): string {
    const entry = flows.get(attemptId);
    if (!entry) throw new AuthError("protocol", "流程状态缺失");
    return entry.csrfToken;
  }

  async function request<T>(
    path: string,
    init: {
      method: string;
      body?: unknown;
      csrf?: string;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.csrf) headers["X-CSRF-Token"] = init.csrf;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STEP_TIMEOUT_MS);
    const onCallerAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onCallerAbort, { once: true });
    let response: Response;
    try {
      response = await fetch(base + path, {
        method: init.method,
        headers,
        credentials: "same-origin",
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (timedOut) throw new AuthError("timeout", "请求超时，请重试");
      throw new AuthError("network", "网络不可用");
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onCallerAbort);
    }
    if (response.status === 204) return undefined as T;
    let payload: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new AuthError("protocol", "服务响应无法解析", response.status);
      }
    }
    if (!response.ok) {
      const code = (payload as { error?: { code?: AuthErrorCode } })?.error
        ?.code;
      throw new AuthError(
        code ?? STATUS_CODES[response.status] ?? "protocol",
        "请求失败",
        response.status,
      );
    }
    return payload as T;
  }

  return {
    async openFlow(signal) {
      const data = await request<{ attemptId: string; csrfToken: string }>(
        "/csrf",
        { method: "GET", signal },
      );
      remember(data.attemptId, data.csrfToken);
      return { attemptId: data.attemptId };
    },
    login(attemptId, username, password, signal) {
      return request<{ user: PublicUser }>("/login", {
        method: "POST",
        body: { attemptId, username, password },
        csrf: csrfFor(attemptId),
        signal,
      });
    },
    register(attemptId, username, password, signal) {
      return request<{ user: PublicUser }>("/register", {
        method: "POST",
        body: { username, password },
        csrf: csrfFor(attemptId),
        signal,
      });
    },
    confirm(attemptId, signal) {
      return request<{ user: PublicUser }>("/confirm", {
        method: "POST",
        body: { attemptId },
        csrf: csrfFor(attemptId),
        signal,
      });
    },
    async cancel(attemptId) {
      const entry = flows.get(attemptId);
      if (!entry) return;
      try {
        await request<void>("/cancel", {
          method: "POST",
          body: { attemptId },
          csrf: entry.csrfToken,
        });
      } finally {
        // Only this attempt's context is removed; other flows stay usable.
        flows.delete(attemptId);
      }
    },
    session(signal) {
      return request<SessionState>("/session", { method: "GET", signal });
    },
    async logout(csrfToken, signal) {
      await request<void>("/logout", {
        method: "POST",
        csrf: csrfToken,
        signal,
      });
    },
  };
}

export function identityFromUser(user: PublicUser): BootIdentity {
  // Derive the label from the server-returned username only.
  return {
    kind: "registered",
    userId: user.id,
    username: user.username,
    label: user.username.toUpperCase(),
  };
}
