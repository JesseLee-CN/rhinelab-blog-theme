// 账号端到端检查：真实的 Go 认证服务 + 构建后的 dist/，验证博客与 /lab/ 共享同一次登录。
//
//   node scripts/blog/check-account.mjs [--keep] [--browser chromium]
//
// 与被检查的对象：
//   - 用 lab-auth CLI 建账号（同时验证 CLI 的标准化语法）；
//   - 浏览器里在 /account/ 用该账号登录，页面头部应显示用户名；
//   - 同一个浏览器打开 /lab/，启动身份门应当认领同一身份（同一个 Cookie）；
//   - 退出后两边都应变为未登录；
//   - 顺带用管理令牌调用 /api/auth/admin/users，确认管理接口在真实服务上可用。
//
// 需要 Go 工具链构建 lab-auth（或通过 LAB_AUTH_BIN 指定已构建的二进制）。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dist = resolve(root, "dist");
const serviceDir = resolve(root, "services/lab-auth");
const keep = process.argv.includes("--keep");
const browserArgIndex = process.argv.indexOf("--browser");
const browserName = browserArgIndex >= 0 ? process.argv[browserArgIndex + 1] : "chromium";

const ADMIN_TOKEN = "local-account-check-admin-token-000000000000";
const ACCOUNT = { username: "AccountCheckUser", password: "a long enough account password" };

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail === undefined || detail === "" ? "" : ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function portFree(port) {
  return new Promise((done) => {
    const probe = createServer()
      .once("error", () => done(false))
      .once("listening", () => probe.close(() => done(true)))
      .listen(port, "127.0.0.1");
  });
}

async function pickPort(start) {
  for (let port = start; port < start + 60; port += 1) if (await portFree(port)) return port;
  throw new Error(`找不到空闲端口（从 ${start} 起）`);
}

/** 用 Go 构建服务，或复用已构建的二进制。 */
async function resolveBinary() {
  if (process.env.LAB_AUTH_BIN && existsSync(process.env.LAB_AUTH_BIN)) return process.env.LAB_AUTH_BIN;
  const target = resolve(root, ".tools/lab-auth", process.platform === "win32" ? "lab-auth.exe" : "lab-auth");
  if (existsSync(target)) return target;
  const go = process.env.LAB_AUTH_GO ?? "go";
  await mkdir(dirname(target), { recursive: true });
  console.log(`构建 lab-auth（${go} build）…`);
  const code = await new Promise((done) => {
    const child = spawn(go, ["build", "-o", target, "./cmd/lab-auth"], {
      cwd: serviceDir,
      stdio: "inherit",
      env: { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "local" },
    });
    child.on("error", () => done(-1));
    child.on("exit", (status) => done(status ?? -1));
  });
  if (code !== 0 || !existsSync(target)) {
    console.error("无法构建 lab-auth：请安装 Go，或设置 LAB_AUTH_BIN 指向已构建的二进制。");
    process.exit(1);
  }
  return target;
}

/** 运行 CLI 并返回 stdout（子进程输出必须继承，受限环境不允许管道）。 */
function runCLI(binary, args, stdin = "") {
  return new Promise((done) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => done({ code: -1, out }));
    child.on("exit", (code) => done({ code: code ?? -1, out }));
    child.stdin.end(stdin);
  });
}

/** 静态站点 + 同源反代 /api/auth（浏览器因此看到的是一个源）。 */
function startSite(port, authPort) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/lab/api/auth/")) {
      const target = await fetch(`http://127.0.0.1:${authPort}${url.pathname}${url.search}`, {
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${authPort}` },
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request,
        duplex: "half",
        redirect: "manual",
      }).catch(() => null);
      if (!target) {
        response.writeHead(502).end("bad gateway");
        return;
      }
      const headers = {};
      target.headers.forEach((value, key) => {
        if (key === "set-cookie") return;
        headers[key] = value;
      });
      const cookies = target.headers.getSetCookie?.() ?? [];
      if (cookies.length) headers["set-cookie"] = cookies;
      response.writeHead(target.status, headers);
      response.end(Buffer.from(await target.arrayBuffer()));
      return;
    }
    if (url.pathname === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    let path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(dist)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const info = await stat(path);
      if (info.isDirectory()) path = join(path, "index.html");
    } catch {
      path = join(path, "index.html");
    }
    if (!existsSync(path)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(await readFile(path));
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

async function waitForHealth(authPort, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${authPort}/health/ready`);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  return false;
}

async function main() {
  if (!existsSync(join(dist, "account", "index.html")) || !existsSync(join(dist, "lab", "index.html"))) {
    console.error("dist/ 不完整：请先 npm run build:blog && npm run build:lab。");
    process.exit(1);
  }
  const binary = await resolveBinary();
  const sitePort = await pickPort(5410);
  const authPort = await pickPort(5510);
  const workDir = await mkdtemp(join(tmpdir(), "lab-auth-check-"));
  const dbPath = join(workDir, "auth.db");

  const authEnv = {
    ...process.env,
    LAB_AUTH_ENV: "development",
    LAB_AUTH_LISTEN: `127.0.0.1:${authPort}`,
    LAB_AUTH_DB: dbPath,
    LAB_AUTH_ALLOWED_ORIGINS: `http://127.0.0.1:${sitePort}`,
    LAB_AUTH_REGISTRATION_ENABLED: "1",
    LAB_AUTH_ADMIN_TOKEN: ADMIN_TOKEN,
    // 测试用低开销参数：真实部署沿用默认值（19 MiB / 2 次迭代）。
    LAB_AUTH_ARGON_MEMORY_KIB: "8192",
    LAB_AUTH_ARGON_ITERATIONS: "1",
    LAB_AUTH_ARGON_PARALLELISM: "1",
    LAB_AUTH_SOURCE_RATE_PER_MIN: "10000",
    LAB_AUTH_USERNAME_RATE: "10000",
  };

  const stopped = [];
  const auth = spawn(binary, ["serve"], { env: authEnv, stdio: ["ignore", "inherit", "inherit"] });
  stopped.push(() => auth.kill());
  const site = await startSite(sitePort, authPort);
  stopped.push(() => site.close());
  const cleanup = async () => {
    for (const stop of stopped) stop();
    await sleep(200);
    if (!keep) await rm(workDir, { recursive: true, force: true });
  };

  try {
    if (!(await waitForHealth(authPort))) throw new Error("认证服务未就绪");
    record("认证服务已就绪", true, `http://127.0.0.1:${authPort}`);

    // 1. 用 CLI 建账号：同时验证 CLI 的标准化语法与 $schema 迁移。
    const created = await runCLI(binary, ["user", "create", "-db", dbPath, "-json", ACCOUNT.username], `${ACCOUNT.password}\n${ACCOUNT.password}\n`);
    record("lab-auth user create -json 建号成功", created.code === 0 && created.out.includes('"username"'), created.out.trim());
    const listed = await runCLI(binary, ["user", "list", "-db", dbPath, "-json"]);
    record("lab-auth user list -json 可读", listed.code === 0 && listed.out.includes(ACCOUNT.username));
    const status = await runCLI(binary, ["db", "status", "-db", dbPath, "-json"]);
    record("lab-auth db status 报告 schema 版本", status.code === 0 && /"schemaVersion"\s*:\s*[1-9]/.test(status.out), status.out.trim().slice(0, 120));
    const audit = await runCLI(binary, ["audit", "list", "-db", dbPath, "-json"]);
    record("CLI 操作写入审计（actor cli:）", audit.code === 0 && audit.out.includes("cli:") && audit.out.includes("user.create"));

    // 2. 管理接口（真实服务 + 令牌）。
    const adminNoToken = await fetch(`http://127.0.0.1:${authPort}/api/auth/admin/users`);
    record("管理接口拒绝无令牌请求", adminNoToken.status === 401, `status=${adminNoToken.status}`);
    const adminUsers = await fetch(`http://127.0.0.1:${authPort}/api/auth/admin/users`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const adminBody = await adminUsers.json().catch(() => null);
    record(
      "管理接口列出账号",
      adminUsers.status === 200 && adminBody?.users?.some((user) => user.username === ACCOUNT.username),
      adminBody,
    );

    // 3. 浏览器：博客登录 → /lab/ 认领同一身份 → 退出后两边都失效。
    const playwright = await import("playwright");
    const engine = playwright[browserName];
    if (!engine) throw new Error(`Playwright 不支持 ${browserName}`);
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const base = `http://127.0.0.1:${sitePort}`;

    await page.goto(`${base}/account/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-account-form]");
    record("账号页可访问且表单可见", await page.isVisible("[data-account-form]"));

    await page.fill("#account-username", ACCOUNT.username);
    await page.fill("#account-password", ACCOUNT.password);
    await page.click("[data-account-submit]");
    await page.waitForFunction(() => document.querySelector("[data-account-session]")?.hidden === false, null, { timeout: 20_000 });
    const shownName = (await page.textContent("[data-account-name]"))?.trim();
    record("博客登录后显示用户名", shownName === ACCOUNT.username, shownName);

    // Playwright 会按 URL 过滤 Secure Cookie，而被测页面是 http://127.0.0.1
    // （受信任源，Chromium 接受 Secure Cookie）：因此不带 URL 查询全部 Cookie。
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === "__Host-lab-session");
    record(
      "会话 Cookie 为 __Host-lab-session、path=/ 且 Secure",
      Boolean(sessionCookie) && sessionCookie.path === "/" && sessionCookie.secure === true,
      sessionCookie,
    );

    // 头部控件（所有页面共用的岛）也应显示用户名。
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("[data-account-link]")?.dataset.accountState === "signed-in", null, { timeout: 10_000 });
    record("首页头部显示已登录", (await page.textContent("[data-account-link]"))?.trim() === ACCOUNT.username);

    // /lab/ 读同一个 Cookie：启动身份门提供「以该身份继续」。
    await page.goto(`${base}/lab/`, { waitUntil: "domcontentloaded" });
    const labClaimed = await page
      .waitForFunction(
        (name) => {
          const panel = document.querySelector("#boot-entry");
          return panel ? panel.textContent.includes(name) : false;
        },
        ACCOUNT.username,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    record("/lab/ 启动身份门认领同一登录", labClaimed);

    const legacySession = await page.evaluate(async () => {
      const response = await fetch("/lab/api/auth/session", { credentials: "same-origin" });
      return { status: response.status, body: await response.json() };
    });
    record(
      "旧前缀 /lab/api/auth/session 报告已登录",
      legacySession.status === 200 && legacySession.body?.authenticated === true,
      legacySession.body,
    );

    await page.goto(`${base}/account/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-account-logout]");
    await page.click("[data-account-logout]");
    await page.waitForFunction(() => document.querySelector("[data-account-session]")?.hidden !== false, null, { timeout: 20_000 });
    record("博客退出后回到未登录", await page.isVisible("[data-account-form]"));

    const afterLogout = await context.cookies();
    record("退出后会话 Cookie 已清除", !afterLogout.some((cookie) => cookie.name === "__Host-lab-session" && cookie.value));

    await page.goto(`${base}/lab/`, { waitUntil: "domcontentloaded" });
    const labSignedOut = await page
      .waitForFunction(
        (name) => {
          const panel = document.querySelector("#boot-entry");
          return panel ? !panel.textContent.includes(name) : false;
        },
        ACCOUNT.username,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    record("/lab/ 不再提供已退出的身份", labSignedOut);

    await browser.close();
  } finally {
    await cleanup();
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n账号端到端：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.error("失败项：");
    for (const entry of failed) console.error(`- ${entry.name}`);
    process.exit(1);
  }
  console.log("账号端到端通过（博客与 /lab/ 共享同一次登录）。");
}

await main();
