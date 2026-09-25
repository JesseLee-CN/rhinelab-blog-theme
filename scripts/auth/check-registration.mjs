// LOGIN-IMPROVE L3b: real registration end-to-end checks against the same
// origin HTTPS harness (serve-review + real lab-auth). Registration is real:
// no mock, isolated SQLite, unique accounts per run.
//
// Page interaction uses page.evaluate polling instead of Playwright
// actionability waits, for the same headless software-WebGL reasons as
// check-flow.mjs.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { chromium, webkit } from "playwright";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i].startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const baseUrl = (args.get("base-url") ?? process.env.BASE_URL ?? "").replace(/\/$/, "");
const scenario = args.get("scenario") ?? "full";
const browserName = args.get("browser") ?? "chromium";
const password = process.env.E2E_PASSWORD;
const newUser = process.env.E2E_NEW_USER;
const oldUser = process.env.E2E_USER;
if (!baseUrl || !password || !newUser) {
  console.error("need --base-url, E2E_PASSWORD and E2E_NEW_USER");
  process.exit(2);
}

const outDir = resolve(args.get("out-dir") ?? ".tools/login-improve/L3");
mkdirSync(outDir, { recursive: true });
const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) console.error(`FAIL ${name} ${detail}`);
};

const engine = browserName === "webkit" ? webkit : chromium;
const browser = await engine.launch({
  ...(browserName === "msedge" ? { channel: "msedge" } : {}),
  args: browserName === "chromium" ? ["--no-sandbox", "--enable-unsafe-swiftshader"] : [],
});

async function openContext(options = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  return { context, page };
}

async function waitFor(page, predicate, tries = 250, gap = 80) {
  for (let i = 0; i < tries; i++) {
    const value = await page.evaluate(predicate).catch(() => null);
    if (value) return value;
    await page.waitForTimeout(gap);
  }
  throw new Error("waitFor timed out");
}
const visible = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || el.hidden) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }, sel);
const waitVisible = async (page, sel, tries = 400) => {
  for (let i = 0; i < tries; i++) {
    if (await visible(page, sel)) return;
    await page.waitForTimeout(60);
  }
  throw new Error(`waitVisible ${sel}`);
};
const click = (page, sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
const fill = (page, sel, value) =>
  page.evaluate(
    ([s, v]) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`missing ${s}`);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [sel, value],
  );
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const attr = (page, sel, name) => page.evaluate(([s, n]) => document.querySelector(s)?.getAttribute(n) ?? null, [sel, name]);
const inputValue = (page, sel) => page.evaluate((s) => document.querySelector(s)?.value ?? null, sel);

const hasSessionCookie = (context) =>
  context.cookies().then((cookies) => cookies.some((c) => c.name === "__Host-lab-session"));
const sessionState = (page) =>
  page.evaluate(() => fetch("/lab/api/auth/session").then((r) => r.json()).catch(() => null));
const waitPlaying = (page, tries = 500) =>
  waitFor(page, () => (["playing", "entered"].includes(window.rhine?.stats()?.introPhase) ? true : null), tries);

// Node-side GET for static pages: headless software WebGL can starve a heavy
// page navigation, but an HTTP read still proves the static page is served.
function raw(path) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpsRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", rejectUnauthorized: false },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolvePromise({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function listUsers() {
  const bin = process.env.E2E_AUTH_BIN;
  const db = process.env.E2E_AUTH_DB;
  if (!bin || !db) return null;
  const res = spawnSync(bin, ["user", "list", "-db", db], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const lines = res.stdout.trim().split("\n");
  const countLine = lines.find((l) => /user\(s\)$/.test(l));
  const count = countLine ? Number(countLine.split(/\s+/)[0]) : null;
  const usernames = lines.filter((l) => l.includes("\t")).map((l) => l.split("\t")[1]);
  return { count, usernames };
}
const dbHasUser = (snapshot, name) =>
  Boolean(snapshot?.usernames.some((u) => u.toLowerCase() === name.toLowerCase()));

async function gotoWithRetry(page, url, tries = 2) {
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
      return;
    } catch (error) {
      const alreadyThere = await page
        .evaluate(() => Boolean(document.querySelector("#boot-entry")))
        .catch(() => false);
      if (alreadyThere) return;
      if (i === tries) throw error;
      await page.waitForTimeout(700);
    }
  }
}
async function openLogin(page) {
  await gotoWithRetry(page, `${baseUrl}/lab/`);
  await waitVisible(page, '#boot-entry[data-phase="login"]');
}
async function openRegister(page) {
  await openLogin(page);
  await click(page, '[data-entry="register"]');
  await waitVisible(page, '#boot-entry[data-phase="register"]');
}
async function submitRegister(page, username, pw, confirm = pw) {
  await fill(page, "#entry-username", username);
  await fill(page, "#entry-password", pw);
  await fill(page, "#entry-confirm", confirm);
  await click(page, "#entry-submit");
}
const registerOutcome = (page, tries = 400) =>
  waitFor(
    page,
    () => {
      const el = document.querySelector("#boot-entry");
      if (!el) return null;
      if (el.classList.contains("has-success")) return "success";
      if (el.classList.contains("has-error") && !el.hasAttribute("data-busy")) return "error";
      return null;
    },
    tries,
  );
async function login(page, username, pw) {
  await waitVisible(page, '#boot-entry[data-phase="login"]');
  await fill(page, "#entry-username", username);
  await fill(page, "#entry-password", pw);
  await click(page, "#entry-submit");
}
const waitIdentity = async (page) => {
  await waitPlaying(page);
  return page.evaluate(() => window.rhine.stats().identity);
};
const waitGuest = async (page) => {
  await waitPlaying(page);
  return page.evaluate(() => window.rhine.stats().identity?.kind);
};

async function scenarioFull() {
  const before = listUsers();
  const { context, page } = await openContext({ viewport: { width: 1280, height: 800 } });
  await openRegister(page);
  await submitRegister(page, newUser, password);
  check("register succeeds", (await registerOutcome(page)) === "success");
  check("register returns to the login phase", (await attr(page, "#boot-entry", "data-phase")) === "login");
  check("username stays prefilled after register", (await inputValue(page, "#entry-username")) === newUser);
  check("password is cleared after register", (await inputValue(page, "#entry-password")) === "");
  check("success message names the account", ((await text(page, "#entry-error")) ?? "").includes(newUser));
  check("register sets no session cookie", !(await hasSessionCookie(context)));
  check("register does not authenticate", (await sessionState(page))?.authenticated === false);
  const after = listUsers();
  if (after && before) {
    check("database gained exactly one account", after.count === before.count + 1, `${before.count}->${after.count}`);
    check("database contains the new account", dbHasUser(after, newUser));
  }

  await fill(page, "#entry-password", password);
  await click(page, "#entry-submit");
  await click(page, "#entry-submit");
  const identity = await waitIdentity(page);
  check("new account commits a registered identity", identity?.kind === "registered");
  check("identity label is uppercase username", identity?.label === newUser.toUpperCase(), identity?.label);
  check("footer shows the uppercase identity", (await text(page, "#session-identity")) === newUser.toUpperCase());
  const active = await sessionState(page);
  check("server session matches the UI user", active?.authenticated === true && active.user?.id === identity?.userId);
  await context.close();

  const user2 = process.env.E2E_SECOND_USER ?? `${newUser}b`;
  const second = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  await openRegister(second.page);
  await submitRegister(second.page, user2, password);
  check("second username registers independently", (await registerOutcome(second.page)) === "success");
  check("second register sets no session", !(await hasSessionCookie(second.context)));
  await login(second.page, user2, password);
  const identity2 = await waitIdentity(second.page);
  check("second account logs in after register", identity2?.kind === "registered" && identity2?.label === user2.toUpperCase());
  await second.context.close();

  const third = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  await openRegister(third.page);
  await submitRegister(third.page, newUser, "Another password value 42");
  check("duplicate register is rejected", (await registerOutcome(third.page)) === "error");
  check("duplicate register says unavailable", ((await text(third.page, "#entry-error")) ?? "").includes("该用户名不可用"));
  check("duplicate register sets no session", !(await hasSessionCookie(third.context)));
  await click(third.page, '[data-entry="back"]');
  await login(third.page, newUser, password);
  const identity3 = await waitIdentity(third.page);
  check("original password still works after duplicate attempt", identity3?.kind === "registered");
  await third.context.close();

  const final = listUsers();
  if (final && before) check("two distinct accounts persisted", final.count === before.count + 2, `${before.count}->${final.count}`);
}

async function scenarioDuplicate() {
  const username = `${newUser}c`;
  const before = listUsers();
  const { context, page: p1 } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const p2 = await context.newPage();
  await Promise.all([openRegister(p1), openRegister(p2)]);
  const pw1 = `${password}-one`;
  const pw2 = `${password}-two`;
  await Promise.all([submitRegister(p1, username, pw1), submitRegister(p2, username, pw2)]);
  const [o1, o2] = await Promise.all([registerOutcome(p1), registerOutcome(p2)]);
  check("same-name race has exactly one winner", [o1, o2].filter((o) => o === "success").length === 1, `${o1}/${o2}`);
  check("same-name race loser is rejected", [o1, o2].filter((o) => o === "error").length === 1);
  const loser = o1 === "error" ? p1 : p2;
  check("race loser reports unavailable", ((await text(loser, "#entry-error")) ?? "").includes("该用户名不可用"));
  const winnerPassword = o1 === "success" ? pw1 : pw2;
  const after = listUsers();
  if (after && before) check("race persisted exactly one account", after.count === before.count + 1, `${before.count}->${after.count}`);
  await context.close();

  const ok = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  await openLogin(ok.page);
  await login(ok.page, username, winnerPassword);
  const identity = await waitIdentity(ok.page);
  check("winner password logs in", identity?.kind === "registered" && identity?.label === username.toUpperCase());
  await ok.context.close();

  const bad = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  await openLogin(bad.page);
  await login(bad.page, username, winnerPassword === pw1 ? pw2 : pw1);
  await waitFor(bad.page, () => (document.querySelector("#boot-entry")?.classList.contains("has-error") ? true : null));
  check("loser password is rejected", ((await text(bad.page, "#entry-error")) ?? "").includes("用户名或密码错误"));
  check("loser login sets no session", !(await hasSessionCookie(bad.context)));
  await bad.context.close();
}

async function scenarioNegatives() {
  // Network failure before a response is received.
  {
    const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
    await page.route("**/lab/api/auth/register", (route) => route.abort("failed"));
    await openRegister(page);
    await submitRegister(page, `${newUser}d`, password);
    check("network abort surfaces an error", (await registerOutcome(page)) === "error");
    check("network abort message", ((await text(page, "#entry-error")) ?? "").includes("网络不可用"));
    check("network abort sets no session", !(await hasSessionCookie(context)));
    await click(page, '[data-entry="guest"]');
    check("GUEST works after network abort", (await waitGuest(page)) === "guest");
    await context.close();
  }
  // 502 from the proxy/auth backend.
  {
    const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
    await page.route("**/lab/api/auth/register", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable", message: "auth unavailable" }, requestId: "" }),
      }),
    );
    await openRegister(page);
    await submitRegister(page, `${newUser}d`, password);
    check("502 surfaces an error", (await registerOutcome(page)) === "error");
    check("502 message points to guest fallback", ((await text(page, "#entry-error")) ?? "").includes("认证服务暂不可用"));
    await click(page, '[data-entry="guest"]');
    check("GUEST works after 502", (await waitGuest(page)) === "guest");
    await context.close();
  }
  // Non-JSON 404 (route missing) must be a protocol error, not a crash.
  {
    const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
    await page.route("**/lab/api/auth/register", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
    );
    await openRegister(page);
    await submitRegister(page, `${newUser}d`, password);
    check("404 surfaces an error", (await registerOutcome(page)) === "error");
    check("404 message is defined", ((await text(page, "#entry-error")) ?? "").length > 0);
    await click(page, '[data-entry="guest"]');
    check("GUEST works after 404", (await waitGuest(page)) === "guest");
    await context.close();
  }
  // GUEST chosen while the register request is still in flight.
  {
    const { context, page } = await openContext({ viewport: { width: 1280, height: 800 } });
    await page.route("**/lab/api/auth/register", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.abort("failed");
    });
    await openRegister(page);
    await submitRegister(page, `${newUser}d`, password);
    await waitFor(page, () => (document.querySelector("#boot-entry")?.hasAttribute("data-busy") ? true : null), 100, 30);
    await click(page, '[data-entry="guest"]');
    check("GUEST wins over in-flight register", (await waitGuest(page)) === "guest");
    await page.waitForTimeout(3600);
    check("late register abort does not reopen or authenticate", (await page.evaluate(() => window.rhine.stats().identity?.kind)) === "guest");
    check("late register abort leaves no session", (await sessionState(page))?.authenticated === false);
    await context.close();
  }
}

async function scenarioLate() {
  if (process.env.E2E_REVIEW_DELAY !== "1") {
    console.error("scenario late needs serve-review --delay-register-ms");
    process.exit(2);
  }
  const { context, page } = await openContext({ viewport: { width: 1280, height: 800 } });
  const lateUser = `${newUser}e`;
  await openRegister(page);
  await submitRegister(page, lateUser, password);
  await waitFor(page, () => (document.querySelector("#boot-entry")?.hasAttribute("data-busy") ? true : null), 100, 30);
  await click(page, '[data-entry="back"]');
  await waitFor(page, () => (document.querySelector("#boot-entry")?.getAttribute("data-phase") === "login" ? true : null), 100, 50);
  await page.waitForTimeout(7000);
  check("late response leaves the login phase", (await attr(page, "#boot-entry", "data-phase")) === "login");
  check("late response shows no success", !(await page.evaluate(() => document.querySelector("#boot-entry")?.classList.contains("has-success"))));
  check("late response sets no session", !(await hasSessionCookie(context)));
  check("late response does not authenticate", (await sessionState(page))?.authenticated === false);
  await login(page, lateUser, password);
  const lateOutcome = await waitFor(
    page,
    () => {
      const el = document.querySelector("#boot-entry");
      if (!el) return null;
      if (el.classList.contains("has-error") && !el.hasAttribute("data-busy")) return "error";
      return ["playing", "entered"].includes(window.rhine?.stats()?.introPhase) ? "registered" : null;
    },
    300,
  );
  check("late registration either persisted or never reached the server", lateOutcome === "registered" || lateOutcome === "error", lateOutcome);
  check("late registration leaves no session", !(await hasSessionCookie(context)));
  if (lateOutcome === "registered") {
    const identity = await page.evaluate(() => window.rhine.stats().identity);
    check("late registration label is uppercase", identity?.label === lateUser.toUpperCase(), identity?.label);
  }
  await context.close();
}

async function scenarioTimeout() {
  if (process.env.E2E_REVIEW_ONCE_DELAY !== "1") {
    console.error("scenario timeout needs serve-review --delay-register-once-ms");
    process.exit(2);
  }
  const { context, page } = await openContext({ viewport: { width: 1280, height: 800 } });
  await openRegister(page);
  await submitRegister(page, `${newUser}f`, password);
  check("timed-out register surfaces an error", (await registerOutcome(page, 450)) === "error");
  check("timed-out register message", ((await text(page, "#entry-error")) ?? "").includes("请求超时"));
  check("timed-out register is not stuck busy", !(await page.evaluate(() => document.querySelector("#boot-entry")?.hasAttribute("data-busy"))));
  check("timed-out register sets no session", !(await hasSessionCookie(context)));
  await click(page, '[data-entry="guest"]');
  check("panel recovers after a timeout", (await waitGuest(page)) === "guest");
  await context.close();
}

async function scenarioAfterRestart() {
  for (const account of [oldUser, newUser]) {
    if (!account) continue;
    const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
    await openLogin(page);
    await login(page, account, password);
    const identity = await waitIdentity(page);
    check(`${account} logs in after restart`, identity?.kind === "registered" && identity?.label === account.toUpperCase());
    const active = await sessionState(page);
    check(`${account} session is real after restart`, active?.authenticated === true && active.user?.id === identity?.userId);
    await context.close();
  }
}

async function scenarioDisabled() {
  const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  await openRegister(page);
  await submitRegister(page, `${newUser}g`, password);
  check("disabled register surfaces an error", (await registerOutcome(page)) === "error");
  check("disabled register message", ((await text(page, "#entry-error")) ?? "").includes("注册暂未开放"));
  check("disabled register sets no session", !(await hasSessionCookie(context)));
  check("database gained no account", !dbHasUser(listUsers(), `${newUser}g`));
  await click(page, '[data-entry="guest"]');
  check("GUEST works while registration is disabled", (await waitGuest(page)) === "guest");
  const home = await raw("/");
  check("blog home stays readable", home.status === 200 && /<html/i.test(home.body) && /example/i.test(home.body), String(home.status));
  await context.close();
}

async function scenarioAuthDown() {
  const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  await openRegister(page);
  await submitRegister(page, `${newUser}h`, password);
  check("auth-down register surfaces an error", (await registerOutcome(page)) === "error");
  check("auth-down register message", ((await text(page, "#entry-error")) ?? "").includes("认证服务暂不可用"));
  await click(page, '[data-entry="guest"]');
  check("GUEST works while auth is down", (await waitGuest(page)) === "guest");
  const home = await raw("/");
  check("blog home stays readable while auth is down", home.status === 200 && /<html/i.test(home.body) && /example/i.test(home.body), String(home.status));
  await context.close();
}

try {
  switch (scenario) {
    case "full":
      await scenarioFull();
      break;
    case "duplicate":
      await scenarioDuplicate();
      break;
    case "negatives":
      await scenarioNegatives();
      break;
    case "late":
      await scenarioLate();
      break;
    case "timeout":
      await scenarioTimeout();
      break;
    case "after-restart":
      await scenarioAfterRestart();
      break;
    case "disabled":
      await scenarioDisabled();
      break;
    case "auth-down":
      await scenarioAuthDown();
      break;
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
} catch (error) {
  check(`scenario ${scenario} completed`, false, `${error?.name ?? "Error"}: ${error?.message ?? error}`);
} finally {
  await browser.close().catch(() => {});
}

const passed = checks.filter((c) => c.passed).length;
writeFileSync(
  `${outDir}/report-registration-${scenario}-${browserName}.json`,
  `${JSON.stringify({ scenario, browser: browserName, passed, total: checks.length, checks }, null, 2)}\n`,
);
console.log(`registration/${scenario}/${browserName}: ${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exit(1);
