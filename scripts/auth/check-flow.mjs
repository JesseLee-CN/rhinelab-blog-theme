// G6 real-HTTPS end-to-end checks. Runs against scripts/auth/serve-review.mjs
// (real dist + real lab-auth proxy).
//
// All page interaction uses page.evaluate polling instead of Playwright's
// actionability/waitForSelector: under headless software WebGL the renderer
// starves the protocol polling and those waits time out even for visible,
// present elements.
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
const user = process.env.E2E_USER;
const password = process.env.E2E_PASSWORD;
if (!baseUrl || !user || !password) {
  console.error("need --base-url and E2E_USER/E2E_PASSWORD");
  process.exit(2);
}

const outDir = resolve(args.get("out-dir") ?? ".tools/boot-identity/g6");
mkdirSync(outDir, { recursive: true });
const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) console.error(`FAIL ${name} ${detail}`);
};

// Test-entry trust: our own self-signed cert, separate from production.
function raw(method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpsRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, rejectUnauthorized: false },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const engine = browserName === "webkit" ? webkit : chromium;
const browser = await engine.launch({
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

async function bootGate(page) {
  await gotoWithRetry(page, `${baseUrl}/lab/`);
  await waitVisible(page, '#boot-entry[data-phase="login"]');
}
async function fillLogin(page, username, pw) {
  await waitVisible(page, '#boot-entry[data-phase="login"]');
  await fill(page, "#entry-username", username);
  await fill(page, "#entry-password", pw);
}
const waitPlaying = (page) => waitFor(page, () => ["playing", "entered"].includes(window.rhine?.stats()?.introPhase));
const waitArchive = (page) => waitFor(page, () => window.rhine?.stats()?.mode === "archive");
const session = (page) => page.evaluate(() => fetch("/lab/api/auth/session").then((r) => r.json()));
async function toArchive(page) {
  await click(page, "#skip").catch(() => {});
  try {
    await waitFor(page, () => window.rhine?.stats()?.mode === "archive", 40);
  } catch {
    await page.evaluate(() => window.rhine?.archive()).catch(() => {});
    await waitArchive(page);
  }
}

async function newFlow() {
  const res = await raw("GET", "/lab/api/auth/csrf");
  const flow = JSON.parse(res.body);
  const cookie = (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
  return { attemptId: flow.attemptId, csrfToken: flow.csrfToken, cookie };
}

async function runProtocolChecks() {
  const flow = await newFlow();
  check("csrf sets a flow cookie", /__Host-lab-flow=/.test(flow.cookie), flow.cookie.slice(0, 60));
  const loginWith = (target, body, headers = {}) =>
    raw("POST", "/lab/api/auth/login", {
      headers: { "Content-Type": "application/json", Cookie: target.cookie, ...headers },
      body,
    });
  const payload = JSON.stringify({ attemptId: flow.attemptId, username: user, password });
  check(
    "foreign origin is 403",
    (await loginWith(flow, payload, { Origin: "https://evil.example", "X-CSRF-Token": flow.csrfToken, "Sec-Fetch-Site": "cross-site" })).status === 403,
  );
  check("missing CSRF is 403", (await loginWith(flow, payload, { Origin: baseUrl })).status === 403);
  check("malformed body is 400", (await loginWith(flow, "{not json", { Origin: baseUrl, "X-CSRF-Token": flow.csrfToken })).status === 400);
  check(
    "oversize body is 413",
    (await loginWith(flow, JSON.stringify({ attemptId: flow.attemptId, username: user, password: "a".repeat(8192) }), { Origin: baseUrl, "X-CSRF-Token": flow.csrfToken })).status === 413,
  );
  check(
    "unknown field is 400",
    (await loginWith(flow, JSON.stringify({ attemptId: flow.attemptId, username: user, password, extra: 1 }), { Origin: baseUrl, "X-CSRF-Token": flow.csrfToken })).status === 400,
  );
  check(
    "wrong password is 401",
    (await loginWith(flow, JSON.stringify({ attemptId: flow.attemptId, username: user, password: "wrong password value" }), { Origin: baseUrl, "X-CSRF-Token": flow.csrfToken })).status === 401,
  );

  const ok = await loginWith(flow, payload, { Origin: baseUrl, "X-CSRF-Token": flow.csrfToken });
  check("real login succeeds", ok.status === 200, String(ok.status));
  const setCookie = (ok.headers["set-cookie"] ?? []).find((c) => c.startsWith("__Host-lab-session=")) ?? "";
  if (!setCookie) {
    check("real login sets a session cookie", false, `status=${ok.status}`);
    return;
  }
  check("session cookie has no Domain attribute", !/;\s*domain=/i.test(setCookie), setCookie.slice(0, 100));
  check("session cookie is Secure+HttpOnly+Path=/", /secure/i.test(setCookie) && /httponly/i.test(setCookie) && /path=\//i.test(setCookie), setCookie.slice(0, 100));
  const sessionCookie = setCookie.split(";")[0];
  check(
    "pending session is not authenticated",
    JSON.parse((await raw("GET", "/lab/api/auth/session", { headers: { Cookie: sessionCookie } })).body).authenticated === false,
  );
  const confirm = await raw("POST", "/lab/api/auth/confirm", {
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-CSRF-Token": flow.csrfToken, Cookie: `${flow.cookie}; ${sessionCookie}` },
    body: JSON.stringify({ attemptId: flow.attemptId }),
  });
  check("confirm activates the session", confirm.status === 200 && JSON.parse(confirm.body).authenticated === true, String(confirm.status));
  const active = JSON.parse((await raw("GET", "/lab/api/auth/session", { headers: { Cookie: sessionCookie } })).body);
  check("confirmed session returns the user", active.authenticated && active.user?.id, JSON.stringify(active));
  check("logout is 204", (await raw("POST", "/lab/api/auth/logout", { headers: { Origin: baseUrl, "X-CSRF-Token": active.csrfToken, Cookie: sessionCookie } })).status === 204);
  check(
    "session revoked after logout",
    JSON.parse((await raw("GET", "/lab/api/auth/session", { headers: { Cookie: sessionCookie } })).body).authenticated === false,
  );

  const conflict = await newFlow();
  const loginBody = JSON.stringify({ attemptId: conflict.attemptId, username: user, password });
  const first = await loginWith(conflict, loginBody, { Origin: baseUrl, "X-CSRF-Token": conflict.csrfToken });
  const second = await loginWith(conflict, loginBody, { Origin: baseUrl, "X-CSRF-Token": conflict.csrfToken });
  check("reusing a pending attempt is 409", first.status === 200 && second.status === 409, `${first.status}/${second.status}`);
}

try {
  if (scenario === "full") {
    await runProtocolChecks();

    // Animated registered + guest path, one normal-motion page.
    {
      const { context, page } = await openContext({ viewport: { width: 1280, height: 800 } });
      await bootGate(page);
      await fillLogin(page, user, password);
      await click(page, "#entry-submit");
      await waitPlaying(page);
      const stats = await page.evaluate(() => window.rhine.stats());
      check("registered identity committed", stats.identity?.kind === "registered", JSON.stringify(stats.identity));
      check("display label is uppercase username", stats.identity?.label === user.toUpperCase(), stats.identity?.label);
      check("footer shows uppercase identity", (await text(page, "#session-identity")) === user.toUpperCase());
      const active = await session(page);
      check("server userId matches the UI", active.authenticated && active.user?.id === stats.identity?.userId, JSON.stringify(active.user));

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitVisible(page, '#boot-entry[data-phase="login"]');
      check("refresh shows the login panel", await visible(page, "#entry-form"));
      check("REGISTER link present after refresh", await visible(page, '[data-entry="register"]'));

      await click(page, '[data-entry="guest"]');
      await waitPlaying(page);
      check("guest identity committed", (await page.evaluate(() => window.rhine.stats().identity?.kind)) === "guest");
      check("footer shows GUEST", (await text(page, "#session-identity")) === "GUEST");
      await toArchive(page);
      await click(page, '[data-action="replay"]');
      await waitPlaying(page);
      check("replay keeps GUEST", (await page.evaluate(() => window.rhine.stats().identity?.kind)) === "guest");
      check("replay never reopens the form", !(await visible(page, "#entry-form")));
      await context.close();
    }

    // Logout + wrong password under reduced motion (modal close completes).
    {
      const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
      await bootGate(page);
      await fillLogin(page, user, password);
      await click(page, "#entry-submit");
      await waitArchive(page);
      await click(page, '[data-action="settings"]');
      await waitVisible(page, ".terminal-modal");
      await waitVisible(page, '[data-action="logout"]', 100);
      check("settings shows logout for registered", await visible(page, '[data-action="logout"]'));
      await click(page, '[data-action="logout"]');
      // The modal close transition is compositor-driven and can be delayed by
      // software WebGL, so wait for server truth first, then the panel.
      check(
        "logout revokes the server session",
        await waitFor(
          page,
          () => fetch("/lab/api/auth/session").then((r) => r.json()).then((s) => (s.authenticated ? null : true)).catch(() => null),
          200,
          150,
        ),
      );
      await waitVisible(page, '#boot-entry[data-phase="login"]');

      await waitVisible(page, '#boot-entry[data-phase="login"]');
      await fill(page, "#entry-username", user);
      await fill(page, "#entry-password", "definitely not the password");
      await click(page, "#entry-submit");
      await waitFor(page, () => document.querySelector("#boot-entry")?.classList.contains("has-error"));
      check("wrong password keeps username", (await inputValue(page, "#entry-username")) === user);
      check("wrong password clears password", (await inputValue(page, "#entry-password")) === "");
      check("wrong password stays on login", (await attr(page, "#boot-entry", "data-phase")) === "login");
      await context.close();
    }

    if (process.env.E2E_DISABLED_USER) {
      const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
      await bootGate(page);
      await fillLogin(page, process.env.E2E_DISABLED_USER, password);
      await click(page, "#entry-submit");
      await waitFor(page, () => document.querySelector("#boot-entry")?.classList.contains("has-error"));
      check("disabled account is rejected", (await attr(page, "#boot-entry", "data-phase")) === "login");
      await context.close();
    }

    for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844], [844, 390], [320, 568], [568, 320]]) {
      const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width, height } });
      await bootGate(page);
      const entriesVisible = (await visible(page, '[data-entry="register"]')) && (await visible(page, '[data-entry="guest"]'));
      const usable = (await visible(page, "#entry-username")) && (await visible(page, "#entry-password")) && (await visible(page, "#entry-submit"));
      check(`${width}x${height}: login panel usable`, entriesVisible && usable);
      await context.close();
    }
  } else if (scenario === "cancel") {
    const { context, page } = await openContext({ viewport: { width: 1280, height: 800 } });
    await bootGate(page);
    await fillLogin(page, user, password);
    await click(page, "#entry-submit");
    await waitFor(page, () => document.querySelector("#boot-entry")?.hasAttribute("data-busy"), 100, 30);
    await click(page, '[data-entry="guest"]');
    await waitPlaying(page);
    check("GUEST wins over in-flight login", (await page.evaluate(() => window.rhine.stats().identity?.kind)) === "guest");
    await page.waitForTimeout(2500);
    check("cancelled login leaves no active session", (await session(page)).authenticated === false);
    await context.close();
  } else if (scenario === "restore") {
    // Login once, then simulate a browser restart with only the persistent
    // cookie carried over. The panel must offer a one-click continue.
    const { context, page } = await openContext({ viewport: { width: 1280, height: 800 } });
    await bootGate(page);
    await fillLogin(page, user, password);
    await click(page, "#entry-submit");
    await waitPlaying(page);
    const cookies = await context.cookies();
    check(
      "session cookie is persistent",
      cookies.some((c) => c.name === "__Host-lab-session" && c.value && c.expires > Date.now() / 1000),
      JSON.stringify(cookies.map((c) => ({ name: c.name, expires: c.expires }))),
    );
    await context.close();

    const second = await openContext({ viewport: { width: 1280, height: 800 } });
    // __Host- cookies must be restored host-only (no domain); this Playwright
    // version rejects url + path together, so rely on the implicit "/" path.
    await second.context.addCookies(cookies.map(({ domain, path, ...cookie }) => ({ ...cookie, url: baseUrl })));
    await bootGate(second.page);
    let continueVisible = false;
    try {
      await waitVisible(second.page, '[data-entry="continue"]');
      continueVisible = true;
    } catch {
      const diag = await second.page.evaluate(() => ({
        panel: document.querySelector("#boot-entry")?.dataset.phase ?? null,
        hasButton: Boolean(document.querySelector("#entry-continue")),
        hidden: document.querySelector("#entry-continue")?.hidden ?? null,
        introPhase: window.rhine?.stats()?.introPhase ?? null,
      }));
      writeFileSync(
        `${outDir}/restore-diagnostic.json`,
        `${JSON.stringify({ where: "continue", diag, session: await session(second.page), cookies: await second.context.cookies() }, null, 2)}\n`,
      );
    }
    check("continue offered for remembered session", continueVisible);
    check("remembered username is prefilled", (await inputValue(second.page, "#entry-username")) === user);
    check("continue names the remembered user", (await text(second.page, "#entry-continue-user")) === user);
    await click(second.page, '[data-entry="continue"]');
    let played = false;
    try {
      await waitPlaying(second.page);
      played = true;
    } catch {
      const diag = await second.page.evaluate(() => ({
        panel: document.querySelector("#boot-entry")?.dataset.phase ?? null,
        introPhase: window.rhine?.stats()?.introPhase ?? null,
        identity: window.rhine?.stats()?.identity ?? null,
      }));
      writeFileSync(
        `${outDir}/restore-diagnostic.json`,
        `${JSON.stringify({ where: "continue-commit", diag }, null, 2)}\n`,
      );
    }
    const restoredStats = await second.page.evaluate(() => window.rhine.stats());
    check(
      "remembered identity committed",
      played && restoredStats.identity?.kind === "registered" && restoredStats.identity?.username === user,
      JSON.stringify(restoredStats.identity),
    );
    check("session remains authenticated", (await session(second.page)).authenticated === true);
    await second.context.close();
  } else if (scenario === "auth-down") {
    const { context, page } = await openContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
    await bootGate(page);
    await fillLogin(page, user, password);
    await click(page, "#entry-submit");
    await waitFor(page, () => document.querySelector("#boot-entry")?.classList.contains("has-error"));
    check("registered path errors when auth is down", ((await text(page, "#entry-error")) ?? "").length > 0);
    await click(page, '[data-entry="guest"]');
    await waitPlaying(page);
    check("guest still works when auth is down", (await page.evaluate(() => window.rhine.stats().identity?.kind)) === "guest");
    await context.close();
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  await browser.close();
}

const passed = checks.filter((c) => c.passed).length;
writeFileSync(`${outDir}/report-${scenario}-${browserName}.json`, `${JSON.stringify({ scenario, browser: browserName, passed, total: checks.length, checks }, null, 2)}\n`);
console.log(`${scenario}/${browserName}: ${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exit(1);
