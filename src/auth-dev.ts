// DEV-only fake identity port for browser UI checks (G4/L1c). Never imported by
// the production bundle: main.ts loads it behind `import.meta.env.DEV`. The
// register mock only exercises the UI; it is not evidence of real registration.
import { validatePassword, validateUsername } from "./boot-identity";
import { AuthError, type IdentityPort, type PublicUser } from "./auth-client";

type Mode =
  | "success"
  | "fail"
  | "timeout"
  | "confirm-fail"
  | "register-fail"
  | "register-disabled";

const MODES: readonly Mode[] = [
  "success",
  "fail",
  "timeout",
  "confirm-fail",
  "register-fail",
  "register-disabled",
];

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createDevIdentityPort(rawMode: string | null): IdentityPort {
  const mode: Mode = MODES.includes((rawMode ?? "") as Mode)
    ? (rawMode as Mode)
    : "success";
  let counter = 0;
  let pending: PublicUser | null = null;

  return {
    async openFlow(signal) {
      await abortableDelay(80, signal);
      counter += 1;
      return { attemptId: `dev-attempt-${counter}` };
    },
    async login(_attemptId, username, password, signal) {
      await abortableDelay(mode === "timeout" ? 2500 : 150, signal);
      if (
        mode === "fail" ||
        !validateUsername(username).ok ||
        !validatePassword(password).ok
      ) {
        throw new AuthError("invalid_credentials", "用户名或密码错误", 401);
      }
      pending = { id: `dev-${username.toLowerCase()}`, username };
      return { user: pending };
    },
    async register(_attemptId, username, password, signal) {
      await abortableDelay(mode === "timeout" ? 2500 : 150, signal);
      if (mode === "register-disabled") {
        throw new AuthError("registration_disabled", "注册暂未开放", 503);
      }
      if (
        mode === "register-fail" ||
        !validateUsername(username).ok ||
        !validatePassword(password).ok ||
        username.toLowerCase() === "taken"
      ) {
        throw new AuthError("registration_unavailable", "该用户名不可用", 409);
      }
      return { user: { id: `dev-${username.toLowerCase()}`, username } };
    },
    async confirm(_attemptId, signal) {
      await abortableDelay(80, signal);
      if (mode === "confirm-fail" || !pending) {
        throw new AuthError("state_conflict", "会话未确认", 409);
      }
      return { user: pending };
    },
    async cancel() {
      pending = null;
    },
    async session() {
      return { authenticated: false };
    },
    async logout() {},
  };
}
