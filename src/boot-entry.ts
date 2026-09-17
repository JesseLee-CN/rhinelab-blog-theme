// LOGIN-IMPROVE L1c: the 图三 login/register panel. Pure DOM/CSS, no
// framework. Owns the login/register panel phase, the lazy auth flow and its
// request contexts. The intro owns visibility, the exit animation and the
// original boot clock; this class never touches the stage.
import {
  guestIdentity,
  registeredIdentity,
  validatePassword,
  validateUsername,
  type ChosenIdentity,
  type EntryPanelPhase,
  type UsernameError,
} from "./boot-identity";
import { AuthError, type IdentityPort, type PublicUser } from "./auth-client";

export interface BootEntryOptions {
  mount: HTMLElement;
  port: IdentityPort;
  /** Server session restored from the persistent cookie, if still valid. */
  session?: PublicUser | null;
  onIdentityChosen: (identity: ChosenIdentity) => void;
  /** Synchronous user-activation hook: called from a real submit/guest click. */
  onEngage?: () => void;
  onPanelPhase: (phase: EntryPanelPhase, busy: boolean) => void;
}

const USERNAME_MESSAGES: Record<UsernameError, string> = {
  "too-short": "用户名至少 3 个字符",
  "too-long": "用户名最多 24 个字符",
  charset: "用户名只能包含字母、数字、点、短横线和下划线",
  reserved: "该用户名不可用",
};

const PASSWORD_MESSAGE = "密码长度需为 15–128 个字符";

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "用户名或密码错误",
  rate_limited: "尝试过于频繁，请稍后再试",
  origin_rejected: "请求来源被拒绝",
  csrf_rejected: "安全校验失败，请重试",
  state_conflict: "登录已失效，请重试",
  payload_too_large: "输入过长",
  unavailable: "认证服务暂不可用，可改用访客进入",
  registration_unavailable: "该用户名不可用",
  registration_disabled: "注册暂未开放，请稍后再试",
  bad_request: "请求格式错误",
  timeout: "请求超时，请重试",
  network: "网络不可用",
  protocol: "服务响应异常",
};

const TOTAL_BUDGET_MS = 20_000;

interface Attempt {
  readonly epoch: number;
  attemptId: string | null;
  readonly controller: AbortController;
  timedOut: boolean;
  loginStarted: boolean;
}

function isAbort(error: unknown): boolean {
  const name = (error as Error)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export class BootEntry {
  readonly element: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly title: HTMLElement;
  private readonly username: HTMLInputElement;
  private readonly password: HTMLInputElement;
  private readonly confirm: HTMLInputElement;
  private readonly confirmRow: HTMLElement;
  private readonly errorLine: HTMLElement;
  private readonly submit: HTMLButtonElement;
  private readonly registerButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly guestButton: HTMLButtonElement;
  private readonly continueButton: HTMLButtonElement;
  private readonly continueUser: HTMLElement;

  private phaseValue: EntryPanelPhase = "login";
  private busyValue = false;
  private epoch = 0;
  private attempt: Attempt | null = null;
  private composing = false;
  private started = false;
  private remembered: PublicUser | null;

  constructor(private readonly options: BootEntryOptions) {
    this.element = document.createElement("section");
    this.element.id = "boot-entry";
    this.element.className = "boot-entry";
    this.element.dataset.phase = "login";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "登录");
    this.element.innerHTML = `
      <form id="entry-form" class="entry-form" novalidate aria-label="登录或注册">
        <h1 class="entry-welcome" id="entry-title">WELCOME</h1>
        <label class="entry-field" data-intro-row>
          <span class="entry-label">USERNAME:</span>
          <input id="entry-username" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required>
        </label>
        <label class="entry-field" data-intro-row>
          <span class="entry-label">PASSWORD:</span>
          <input id="entry-password" name="password" type="password" autocomplete="current-password" required>
        </label>
        <label class="entry-field" id="entry-confirm-row" data-intro-row hidden>
          <span class="entry-label">CONFIRM PASSWORD:</span>
          <input id="entry-confirm" name="confirm" type="password" autocomplete="new-password">
        </label>
        <p class="entry-error" id="entry-error" role="status" aria-live="polite"></p>
        <button type="submit" class="entry-submit" id="entry-submit" data-intro-row>LOGIN</button>
        <button type="button" class="entry-continue" id="entry-continue" data-entry="continue" data-intro-row hidden>CONTINUE AS <strong id="entry-continue-user"></strong> <span>→</span></button>
        <div class="entry-links" data-intro-row>
          <button type="button" class="entry-link" id="entry-register" data-entry="register">REGISTER</button>
          <button type="button" class="entry-link" id="entry-back" data-entry="back" hidden>BACK TO LOGIN</button>
          <button type="button" class="entry-link" data-entry="guest">ENTER AS GUEST</button>
        </div>
      </form>`;

    this.form = this.element.querySelector<HTMLFormElement>("#entry-form")!;
    this.title = this.element.querySelector<HTMLElement>("#entry-title")!;
    this.username =
      this.element.querySelector<HTMLInputElement>("#entry-username")!;
    this.password =
      this.element.querySelector<HTMLInputElement>("#entry-password")!;
    this.confirm =
      this.element.querySelector<HTMLInputElement>("#entry-confirm")!;
    this.confirmRow =
      this.element.querySelector<HTMLElement>("#entry-confirm-row")!;
    this.errorLine = this.element.querySelector<HTMLElement>("#entry-error")!;
    this.submit =
      this.element.querySelector<HTMLButtonElement>("#entry-submit")!;
    this.registerButton =
      this.element.querySelector<HTMLButtonElement>("#entry-register")!;
    this.backButton =
      this.element.querySelector<HTMLButtonElement>("#entry-back")!;
    this.guestButton = this.element.querySelector<HTMLButtonElement>(
      '[data-entry="guest"]',
    )!;
    this.continueButton =
      this.element.querySelector<HTMLButtonElement>("#entry-continue")!;
    this.continueUser =
      this.element.querySelector<HTMLElement>("#entry-continue-user")!;
    this.remembered = options.session ?? null;
    if (this.remembered) this.username.value = this.remembered.username;

    this.element.addEventListener("click", this.onClick);
    document.addEventListener("keydown", this.onKeydown);
    this.form.addEventListener("keydown", this.onFormKeydown);
    this.form.addEventListener("submit", this.onSubmit);
    this.form.addEventListener("compositionstart", this.onCompositionStart);
    this.form.addEventListener("compositionend", this.onCompositionEnd);
    options.mount.append(this.element);
    this.applyMode();
    this.options.onPanelPhase(this.phaseValue, this.busyValue);
  }

  get phase(): EntryPanelPhase {
    return this.phaseValue;
  }

  get busy(): boolean {
    return this.busyValue;
  }

  /** Called by the intro when the login page becomes visible. */
  show(): void {
    this.reset();
    this.options.onPanelPhase(this.phaseValue, this.busyValue);
  }

  /** Refresh the remembered user after a session query or logout. */
  setRemembered(user: PublicUser | null): void {
    this.remembered = user;
    if (user) this.username.value = user.username;
    this.applyMode();
  }

  /** Explicit identity switch: back to a clean login form. */
  reset(): void {
    this.cancelAttempt();
    this.started = false;
    this.composing = false;
    delete this.form.dataset.composing;
    this.password.value = "";
    this.confirm.value = "";
    this.clearError();
    this.phaseValue = "login";
    this.element.dataset.phase = "login";
    if (this.remembered) this.username.value = this.remembered.username;
    this.applyMode();
  }

  dispose(): void {
    this.cancelAttempt();
    this.element.removeEventListener("click", this.onClick);
    document.removeEventListener("keydown", this.onKeydown);
    this.form.removeEventListener("keydown", this.onFormKeydown);
    this.form.removeEventListener("submit", this.onSubmit);
    this.form.removeEventListener("compositionstart", this.onCompositionStart);
    this.form.removeEventListener("compositionend", this.onCompositionEnd);
    this.element.remove();
  }

  // --- event handlers ---

  private onClick = (event: MouseEvent): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-entry]",
    );
    if (!target) return;
    switch (target.dataset.entry) {
      case "guest":
        this.options.onEngage?.();
        this.chooseGuest();
        break;
      case "continue":
        this.options.onEngage?.();
        this.chooseRemembered();
        break;
      case "register":
        this.openRegister();
        break;
      case "back":
        this.backToLogin();
        break;
    }
  };

  private onKeydown = (event: KeyboardEvent): void => {
    // Document-level so Escape still works while the submit is disabled and
    // focus has left the panel; ignored once an identity has been chosen.
    if (this.started || event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.phaseValue === "register") {
      this.backToLogin();
      return;
    }
    // Login page: Escape cancels an in-flight attempt and stays on the page.
    if (this.busyValue) {
      this.cancelAttempt();
      this.clearError();
    }
  };

  private onFormKeydown = (event: KeyboardEvent): void => {
    if (
      event.key === "Enter" &&
      (this.composing || event.isComposing || event.keyCode === 229)
    ) {
      event.preventDefault();
    }
  };

  private onCompositionStart = (): void => {
    this.composing = true;
    this.form.dataset.composing = "true";
  };

  private onCompositionEnd = (): void => {
    this.composing = false;
    delete this.form.dataset.composing;
  };

  private onSubmit = (event: Event): void => {
    event.preventDefault();
    if (this.composing) return;
    this.options.onEngage?.();
    void this.submitForm();
  };

  // --- panel phase ---

  private setMode(next: EntryPanelPhase, focus: boolean): void {
    const changed = this.phaseValue !== next;
    this.phaseValue = next;
    this.element.dataset.phase = next;
    this.applyMode();
    if (changed) this.options.onPanelPhase(next, this.busyValue);
    if (focus) this.username.focus({ preventScroll: true });
  }

  private applyMode(): void {
    const register = this.phaseValue === "register";
    this.title.textContent = register ? "REGISTER" : "WELCOME";
    this.submit.textContent = register ? "REGISTER" : "LOGIN";
    this.confirmRow.hidden = !register;
    this.backButton.hidden = !register;
    this.registerButton.hidden = register;
    const remembered = !register && !this.started && this.remembered !== null;
    this.continueButton.hidden = !remembered;
    if (remembered && this.remembered)
      this.continueUser.textContent = this.remembered.username;
    this.password.setAttribute(
      "autocomplete",
      register ? "new-password" : "current-password",
    );
  }

  private chooseRemembered(): void {
    if (!this.remembered || this.started) return;
    if (this.busyValue) this.cancelAttempt();
    this.finish(registeredIdentity(this.remembered.id, this.remembered.username));
  }

  private openRegister(): void {
    if (this.busyValue) this.cancelAttempt();
    this.clearError();
    this.setMode("register", true);
  }

  private backToLogin(): void {
    if (this.busyValue) this.cancelAttempt();
    this.password.value = "";
    this.confirm.value = "";
    this.clearError();
    this.setMode("login", true);
  }

  private setBusy(busy: boolean): void {
    if (this.busyValue === busy) return;
    this.busyValue = busy;
    this.element.toggleAttribute("data-busy", busy);
    this.submit.disabled = busy;
    this.options.onPanelPhase(this.phaseValue, busy);
  }

  private setError(message: string, tone: "error" | "success" = "error"): void {
    this.errorLine.textContent = message;
    if (message) this.errorLine.dataset.tone = tone;
    else delete this.errorLine.dataset.tone;
    this.element.classList.toggle(
      "has-error",
      tone === "error" && message !== "",
    );
    this.element.classList.toggle(
      "has-success",
      tone === "success" && message !== "",
    );
  }

  private clearError(): void {
    this.setError("");
  }

  // --- flow ---

  private async submitForm(): Promise<void> {
    if (this.busyValue || this.composing) return;
    const register = this.phaseValue === "register";
    const username = this.username.value;
    const password = this.password.value;
    const usernameCheck = validateUsername(username);
    if (!usernameCheck.ok) {
      this.setError(USERNAME_MESSAGES[usernameCheck.error] ?? "用户名无效");
      this.username.focus({ preventScroll: true });
      return;
    }
    if (!validatePassword(password).ok) {
      this.setError(PASSWORD_MESSAGE);
      this.password.value = "";
      this.username.focus({ preventScroll: true });
      return;
    }
    if (register && this.confirm.value !== password) {
      this.setError("两次输入的密码不一致");
      this.confirm.value = "";
      this.confirm.focus({ preventScroll: true });
      return;
    }

    this.clearError();
    this.setBusy(true);
    const epoch = ++this.epoch;
    const controller = new AbortController();
    const attempt: Attempt = {
      epoch,
      attemptId: null,
      controller,
      timedOut: false,
      loginStarted: false,
    };
    this.attempt = attempt;
    const budget = setTimeout(() => {
      if (this.attempt === attempt) {
        attempt.timedOut = true;
        controller.abort();
      }
    }, TOTAL_BUDGET_MS);

    try {
      const flow = await this.options.port.openFlow(controller.signal);
      attempt.attemptId = flow.attemptId;
      if (epoch !== this.epoch) return;
      if (register) {
        const created = await this.options.port.register(
          flow.attemptId,
          username,
          password,
          controller.signal,
        );
        if (epoch !== this.epoch) return;
        this.password.value = "";
        this.confirm.value = "";
        this.setBusy(false);
        this.setMode("login", false);
        this.setError(
          `注册成功，请登录（${created.user.username}）`,
          "success",
        );
        this.password.focus({ preventScroll: true });
        return;
      }
      attempt.loginStarted = true;
      await this.options.port.login(
        flow.attemptId,
        username,
        password,
        controller.signal,
      );
      if (epoch !== this.epoch) return;
      const confirmed = await this.options.port.confirm(
        flow.attemptId,
        controller.signal,
      );
      if (epoch !== this.epoch) return;
      this.finish(
        registeredIdentity(confirmed.user.id, confirmed.user.username),
      );
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (isAbort(error) && !attempt.timedOut) return;
      this.setBusy(false);
      const code = error instanceof AuthError ? error.code : "network";
      this.password.value = "";
      this.confirm.value = "";
      this.setError(AUTH_MESSAGES[code] ?? "操作失败，请重试");
      this.username.focus({ preventScroll: true });
    } finally {
      clearTimeout(budget);
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  private cancelAttempt(): void {
    this.epoch += 1;
    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) {
      attempt.controller.abort();
      // Registration is never undone by cancel; only a started login attempt
      // is revoked server-side.
      if (attempt.attemptId && attempt.loginStarted)
        void this.options.port.cancel(attempt.attemptId).catch(() => {});
    }
    this.setBusy(false);
  }

  private chooseGuest(): void {
    if (this.started) return;
    this.cancelAttempt();
    this.finish(guestIdentity());
  }

  private finish(identity: ChosenIdentity): void {
    if (this.started) return;
    this.started = true;
    this.setBusy(true);
    this.options.onIdentityChosen(identity);
  }
}
