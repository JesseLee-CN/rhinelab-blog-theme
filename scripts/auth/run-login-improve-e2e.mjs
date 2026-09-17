// LOGIN-IMPROVE L3b orchestrator: real isolated HTTPS end-to-end.
//
// Locally builds the real lab-auth binary, creates a fresh SQLite database and
// a throwaway loopback TLS certificate, then runs the browser checks against
// `serve-review.mjs` (real dist + real auth proxy). Passwords exist only in
// this process memory and in the child environment; they are never written to
// argv, logs or reports.
//
//   node scripts/auth/run-login-improve-e2e.mjs \
//     --suite all --browser chromium --out-dir .tools/login-improve/L3/chromium
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2);
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "true");
  }
}
const suite = args.get("suite") ?? "all";
const browsers = (args.get("browser") ?? "chromium").split(",").map((b) => b.trim()).filter(Boolean);
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
const runDir = args.get("out-dir") ? resolve(args.get("out-dir")) : join(root, ".tools/login-improve/L3", runId);
const dist = resolve(args.get("dist") ?? join(root, "dist"));
const explicitAuthBin = args.get("auth-bin");
const skipBuild = process.argv.includes("--skip-build");
const password = randomBytes(18).toString("base64url");
const suffix = randomBytes(3).toString("hex");
const accounts = {
  old: `e2ebase${suffix}`,
  disabled: `e2edis${suffix}`,
  new: `e2enew${suffix}`,
  second: `e2enew${suffix}b`,
};

if (!["flow", "registration", "all"].includes(suite)) {
  console.error("usage: run-login-improve-e2e.mjs --suite flow|registration|all --browser chromium,webkit --out-dir <dir>");
  process.exit(2);
}
if (!existsSync(join(dist, "lab", "index.html"))) {
  console.error(`dist/lab/index.html not found under ${dist}; run "npm run build" first`);
  process.exit(2);
}
mkdirSync(runDir, { recursive: true });

// --- shared setup ---

const authBin = explicitAuthBin ? resolve(explicitAuthBin) : join(runDir, "lab-auth");
if (!skipBuild || !existsSync(authBin)) {
  console.log("building real lab-auth binary ...");
  const build = spawnSync("go", ["build", "-trimpath", "-o", authBin, "./cmd/lab-auth"], {
    cwd: join(root, "services", "lab-auth"),
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error("go build failed");
    process.exit(1);
  }
}

const certPath = join(runDir, "tls", "cert.pem");
const keyPath = join(runDir, "tls", "key.pem");
if (!existsSync(certPath) || !existsSync(keyPath)) {
  mkdirSync(join(runDir, "tls"), { recursive: true });
  const gen = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) {
    console.error(`openssl self-signed cert failed: ${gen.stderr}`);
    process.exit(1);
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

function openLog(dir, name) {
  mkdirSync(dir, { recursive: true });
  return openSync(join(dir, name), "a");
}

function waitHttp(urlString, { timeoutMs = 15000, insecure = false } = {}) {
  const url = new URL(urlString);
  const doRequest = insecure ? httpsRequest : httpRequest;
  const started = Date.now();
  return new Promise((res, rej) => {
    const attempt = () => {
      const req = doRequest(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", rejectUnauthorized: false },
        (response) => {
          response.resume();
          if ((response.statusCode ?? 500) < 500) res();
          else retry();
        },
      );
      req.on("error", retry);
      req.setTimeout(2000, () => req.destroy(new Error("timeout")));
      req.end();
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) rej(new Error(`readiness timeout ${urlString}`));
      else setTimeout(attempt, 200);
    };
    attempt();
  });
}

// --- per-browser environment ---

const report = { runId, suite, startedAt: new Date().toISOString(), browsers: {} };
let failures = 0;

async function runBrowser(browserName) {
  const browserDir = join(runDir, browserName);
  mkdirSync(join(browserDir, "logs"), { recursive: true });
  mkdirSync(join(browserDir, "reports"), { recursive: true });
  const dbPath = join(browserDir, "auth.db");
  const authPort = await freePort();
  let authChild = null;
  const reviewChildren = [];
  const results = [];

  const authEnv = (registrationEnabled) => ({
    ...process.env,
    LAB_AUTH_ENV: "development",
    LAB_AUTH_LISTEN: `127.0.0.1:${authPort}`,
    LAB_AUTH_DB: dbPath,
    LAB_AUTH_REGISTRATION_ENABLED: registrationEnabled ? "1" : "0",
    LAB_AUTH_REGISTER_SOURCE_HOURLY: "1000",
    LAB_AUTH_REGISTER_GLOBAL_DAILY: "1000",
    LAB_AUTH_REGISTER_MAX_USERS: "1000",
    LAB_AUTH_SOURCE_RATE_PER_MIN: "1000",
    LAB_AUTH_USERNAME_RATE: "1000",
  });

  function startAuth(registrationEnabled) {
    const fd = openLog(join(browserDir, "logs"), "auth.log");
    authChild = spawn(authBin, ["serve"], {
      cwd: root,
      env: authEnv(registrationEnabled),
      stdio: ["ignore", fd, fd],
      detached: false,
    });
    closeSync(fd);
    authChild.on("exit", (code) => console.log(`[${browserName}] auth exited code=${code}`));
  }

  function stopAuth() {
    return new Promise((res) => {
      if (!authChild || authChild.exitCode !== null) {
        authChild = null;
        res();
        return;
      }
      const child = authChild;
      authChild = null;
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        res();
      });
      child.kill("SIGTERM");
    });
  }

  async function startReview(extra = []) {
    const port = await freePort();
    const fd = openLog(join(browserDir, "logs"), "review.log");
    const child = spawn(
      process.execPath,
      [
        join(root, "scripts", "auth", "serve-review.mjs"),
        "--cert", certPath,
        "--key", keyPath,
        "--dist", dist,
        "--auth", `http://127.0.0.1:${authPort}`,
        "--port", String(port),
        ...extra,
      ],
      { cwd: root, stdio: ["ignore", fd, fd] },
    );
    closeSync(fd);
    reviewChildren.push(child);
    await waitHttp(`https://127.0.0.1:${port}/lab/`, { insecure: true });
    return port;
  }

  function createAccount(name, { disabled = false } = {}) {
    const created = spawnSync(authBin, ["user", "create", "-db", dbPath, name], {
      input: `${password}\n${password}\n`,
      encoding: "utf8",
      env: process.env,
    });
    if (created.status !== 0) throw new Error(`user create ${name} failed: ${created.stderr}`);
    if (disabled) {
      const off = spawnSync(authBin, ["user", "disable", "-db", dbPath, name], { encoding: "utf8", env: process.env });
      if (off.status !== 0) throw new Error(`user disable ${name} failed: ${off.stderr}`);
    }
  }

  function runCheck(script, scenario, { port, env = {}, timeoutMs = 420000 } = {}) {
    const targetPort = port ?? mainPort;
    const argv = [
      join(root, "scripts", "auth", script),
      "--base-url", `https://127.0.0.1:${targetPort}`,
      "--scenario", scenario,
      "--browser", browserName,
      "--out-dir", join(browserDir, "reports"),
    ];
    const checked = spawnSync(process.execPath, argv, {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        BASE_URL: `https://127.0.0.1:${targetPort}`,
        E2E_USER: accounts.old,
        E2E_PASSWORD: password,
        E2E_NEW_USER: accounts.new,
        E2E_SECOND_USER: accounts.second,
        E2E_DISABLED_USER: accounts.disabled,
        E2E_AUTH_BIN: authBin,
        E2E_AUTH_DB: dbPath,
        ...env,
      },
    });
    const record = {
      script,
      scenario,
      browser: browserName,
      status: checked.status,
      timedOut: checked.error?.code === "ETIMEDOUT",
      passed: checked.status === 0,
      stdout: (checked.stdout ?? "").trim().split("\n").slice(-3).join("\n"),
      stderr: (checked.stderr ?? "").trim().split("\n").slice(-4).join("\n"),
    };
    results.push(record);
    if (!record.passed) failures += 1;
    console.log(`[${browserName}] ${script} ${scenario}: ${record.passed ? "PASS" : `FAIL (${record.status ?? "timeout"})`}`);
    if (!record.passed) console.error((checked.stderr ?? "").trim() || (checked.stdout ?? "").trim());
    return record.passed;
  }

  console.log(`[${browserName}] run dir ${browserDir}`);
  startAuth(true);
  await waitHttp(`http://127.0.0.1:${authPort}/health/ready`);
  const mainPort = await startReview();
  createAccount(accounts.old);
  createAccount(accounts.disabled, { disabled: true });

  try {
    if (suite === "flow" || suite === "all") {
      runCheck("check-flow.mjs", "full");
      runCheck("check-flow.mjs", "cancel");
      runCheck("check-flow.mjs", "restore");
    }
    if (suite === "registration" || suite === "all") {
      runCheck("check-registration.mjs", "full");
      runCheck("check-registration.mjs", "duplicate");
      runCheck("check-registration.mjs", "negatives");

      const latePort = await startReview(["--delay-register-ms", "6000"]);
      runCheck("check-registration.mjs", "late", { port: latePort, env: { E2E_REVIEW_DELAY: "1" }, timeoutMs: 120000 });

      const timeoutPort = await startReview(["--delay-register-once-ms", "25000"]);
      runCheck("check-registration.mjs", "timeout", { port: timeoutPort, env: { E2E_REVIEW_ONCE_DELAY: "1" }, timeoutMs: 150000 });

      await stopAuth();
      startAuth(true);
      await waitHttp(`http://127.0.0.1:${authPort}/health/ready`);
      runCheck("check-registration.mjs", "after-restart");

      await stopAuth();
      startAuth(false);
      await waitHttp(`http://127.0.0.1:${authPort}/health/ready`);
      runCheck("check-registration.mjs", "disabled");
    }

    await stopAuth();
    runCheck("check-flow.mjs", "auth-down");
    if (suite === "registration" || suite === "all") {
      runCheck("check-registration.mjs", "auth-down");
    }
  } finally {
    await stopAuth();
    for (const child of reviewChildren) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 300));
    report.browsers[browserName] = { dbPath, results };
  }
}

for (const browserName of browsers) {
  try {
    await runBrowser(browserName);
  } catch (error) {
    failures += 1;
    console.error(`[${browserName}] orchestrator error: ${error.message}`);
    report.browsers[browserName] ??= { results: [] };
    report.browsers[browserName].error = error.message;
  }
}

report.finishedAt = new Date().toISOString();
report.passed = failures === 0;
writeFileSync(join(runDir, "run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nlogin-improve e2e ${report.passed ? "PASS" : `FAIL (${failures})`}: ${runDir}`);
process.exit(failures === 0 ? 0 : 1);
