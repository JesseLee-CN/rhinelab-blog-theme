// Blog-side account island.
//
// One implementation serves both the header control on every page and the form on
// /account/, because they are the same question asked at two sizes. The session is
// the origin-wide `__Host-lab-session` cookie, so whatever is signed in here is
// also signed in at /lab/ — and the BroadcastChannel in shared/auth/session.ts
// makes an already-open page notice the change without a reload.
//
// Progressive enhancement: every page stays readable with JavaScript disabled, so
// this module only ever *upgrades* markup that already links to /account/.
import { AuthError } from "../../../../shared/auth/client";
import {
  createSessionBridge,
  type AccountSession,
} from "../../../../shared/auth/session";
import { validatePassword, validateUsername } from "../../../../shared/auth/identity";

const bridge = createSessionBridge();
/** Guards against a redirect target that leaves this origin. */
const safeNext = (): string | null => {
  const next = new URLSearchParams(location.search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//")) return null;
  return next;
};

const messages: Record<string, string> = {
  network: "网络不可用，请检查连接后重试。",
  timeout: "请求超时，请重试。",
  invalid_credentials: "用户名或密码不正确。",
  rate_limited: "尝试过于频繁，请稍后再试。",
  origin_rejected: "请求来源被拒绝，请刷新页面后重试。",
  csrf_rejected: "会话校验失败，请刷新页面后重试。",
  state_conflict: "上一次登录尚未结束，请稍后重试。",
  registration_disabled: "本站已关闭公开注册。",
  registration_unavailable: "暂时无法注册，请稍后再试。",
  unavailable: "账号服务暂时不可用，稍后再试。",
  payload_too_large: "提交内容过大。",
  protocol: "服务响应异常，请稍后再试。",
  bad_request: "输入不符合规则，请检查后重试。",
};

function describe(error: unknown): string {
  if (error instanceof AuthError) return messages[error.code] ?? messages.protocol;
  return "出现未知问题，请稍后再试。";
}

/** Username/password rule errors, so a field can point at itself. */
function ruleError(field: "username" | "password", error: string): string {
  if (field === "username") {
    if (error === "too-short") return "用户名至少 3 个字符。";
    if (error === "too-long") return "用户名最多 24 个字符。";
    if (error === "charset") return "用户名只能包含字母、数字与 . _ - 。";
    if (error === "reserved") return "该用户名被保留。";
  }
  if (error === "too-short") return "密码至少 6 个字符。";
  if (error === "too-long") return "密码最多 128 个字符。";
  if (error === "weak")
    return "密码至少包含一个大写字母、一个小写字母和一个数字。";
  return "输入不符合规则。";
}

// --- header control -------------------------------------------------------

function initHeader(): void {
  const link = document.querySelector<HTMLAnchorElement>("[data-account-link]");
  if (!link) return;

  const render = (session: AccountSession | null): void => {
    const user = session?.authenticated ? session.user : null;
    link.textContent = user ? user.username : "登录";
    // A signed-in reader gets their own page instead of the login form.
    link.href = user ? "/account/" : "/account/?next=" + encodeURIComponent(location.pathname);
    link.dataset.accountState = user ? "signed-in" : "signed-out";
    if (user) link.title = `已登录：${user.username}`;
    else link.removeAttribute("title");
  };

  bridge.subscribe(render);
  void bridge.read().then(render).catch(() => render(null));
}

// --- account page ---------------------------------------------------------

function initAccountPage(): void {
  const form = document.querySelector<HTMLFormElement>("[data-account-form]");
  if (!form) return;
  const sessionPanel = document.querySelector<HTMLElement>("[data-account-session]");
  const nameSlot = document.querySelector<HTMLElement>("[data-account-name]");
  const status = document.querySelector<HTMLElement>("[data-account-status]");
  const submit = form.querySelector<HTMLButtonElement>("[data-account-submit]");
  const username = form.querySelector<HTMLInputElement>("#account-username");
  const password = form.querySelector<HTMLInputElement>("#account-password");
  const confirmField = form.querySelector<HTMLElement>("[data-account-confirm]");
  const confirm = form.querySelector<HTMLInputElement>("#account-confirm");
  const revealButtons = [
    ...form.querySelectorAll<HTMLButtonElement>("[data-account-reveal]"),
  ];
  const tabs = [...form.querySelectorAll<HTMLButtonElement>("[data-account-mode]")];
  let mode: "login" | "register" = "login";

  const setStatus = (text: string, kind: "idle" | "error" | "ok" = "idle"): void => {
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind;
  };

  const revealTargets = revealButtons
    .map((button) => ({
      button,
      input: form.querySelector<HTMLInputElement>(`#${button.dataset.accountReveal}`),
    }))
    .filter((entry): entry is { button: HTMLButtonElement; input: HTMLInputElement } => entry.input !== null);

  /**
   * Show or hide the password in plain text. The browser's own reveal control is
   * not usable here: it differs per browser and in some of them it cannot be used
   * a second time, so the page owns this toggle instead.
   */
  function setRevealed(reveal: boolean): void {
    for (const { button, input } of revealTargets) {
      input.type = reveal ? "text" : "password";
      button.setAttribute("aria-pressed", String(reveal));
      button.textContent = reveal ? "隐藏" : "显示";
      button.setAttribute("aria-label", reveal ? "隐藏密码" : "显示密码");
    }
  }

  for (const { button, input } of revealTargets) {
    // Progressive enhancement: the control only appears once it can actually work.
    button.hidden = false;
    button.addEventListener("click", () => {
      setRevealed(input.type === "password");
    });
  }

  const setMode = (next: "login" | "register"): void => {
    mode = next;
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.accountMode === next));
    if (confirmField) confirmField.hidden = next !== "register";
    if (confirm) confirm.required = next === "register";
    if (submit) submit.textContent = next === "register" ? "注册" : "登录";
    if (password) password.autocomplete = next === "register" ? "new-password" : "current-password";
    setRevealed(false);
    setStatus("");
  };

  const showSession = (session: AccountSession | null): void => {
    const user = session?.authenticated ? session.user : null;
    if (sessionPanel) sessionPanel.hidden = user === null;
    if (form) form.hidden = user !== null;
    if (nameSlot) nameSlot.textContent = user?.username ?? "";
    if (user) setStatus("");
  };

  for (const tab of tabs) tab.addEventListener("click", () => setMode(tab.dataset.accountMode === "register" ? "register" : "login"));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = username?.value.trim() ?? "";
    const secret = password?.value ?? "";
    const check = validateUsername(name);
    if (!check.ok) {
      setStatus(ruleError("username", check.error), "error");
      username?.focus();
      return;
    }
    const secretCheck = validatePassword(secret);
    if (!secretCheck.ok) {
      setStatus(ruleError("password", secretCheck.error), "error");
      password?.focus();
      return;
    }
    if (mode === "register" && confirm && confirm.value !== secret) {
      setStatus("两次输入的密码不一致。", "error");
      confirm.focus();
      return;
    }

    if (submit) submit.disabled = true;
    setStatus(mode === "register" ? "正在注册…" : "正在登录…");
    const action =
      mode === "register"
        ? bridge.register(name, secret).then((user) => {
            // Registration never signs in: the server contract keeps the two
            // steps separate, so the reader confirms the new account by logging in.
            password!.value = "";
            if (confirm) confirm.value = "";
            setMode("login");
            setStatus(`账号 ${user.username} 已创建，请使用新密码登录。`, "ok");
          })
        : bridge.login(name, secret).then(() => {
            location.assign(safeNext() ?? "/account/");
          });
    action
      .catch((error: unknown) => setStatus(describe(error), "error"))
      .finally(() => {
        if (submit) submit.disabled = false;
      });
  });

  document.querySelector<HTMLButtonElement>("[data-account-logout]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    void bridge
      .logout()
      .catch((error: unknown) => setStatus(describe(error), "error"))
      .finally(() => {
        button.disabled = false;
      });
  });

  bridge.subscribe(showSession);
  void bridge
    .read()
    .then(showSession)
    .catch((error: unknown) => {
      showSession(null);
      setStatus(describe(error), "error");
    });
}

initHeader();
initAccountPage();
