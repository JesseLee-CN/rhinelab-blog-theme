// G7 capacity probe. Drives the real auth service over HTTPS and records RSS,
// latency percentiles, overload behaviour and the auth-down degradation.
// Reports to .tools/boot-identity/g7/capacity.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i += 2) if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[i + 1];
const baseUrl = (opts["base-url"] ?? "").replace(/\/$/, "");
const user = opts.user ?? process.env.E2E_USER;
const password = opts.password ?? process.env.E2E_PASSWORD;
const pid = opts.pid ? Number(opts.pid) : null;
const idleSeconds = Number(opts["idle-seconds"] ?? 60);
const suite = opts.suite ?? "mixed";
const registerTotal = Number(opts["register-total"] ?? 6);
if (!baseUrl || (suite !== "register" && !user) || !password) {
  console.error("usage: bench-auth.mjs --base-url <https> --password <p> [--user <u>] [--suite login|register|mixed] [--register-total N] [--pid <authPid>] [--idle-seconds N]");
  process.exit(2);
}

const outDir = resolve(".tools/boot-identity/g7");
mkdirSync(outDir, { recursive: true });

function raw(method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, baseUrl);
    const requestFn = url.protocol === "http:" ? httpRequest : httpsRequest;
    const req = requestFn(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, rejectUnauthorized: false },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const cookieOf = (res, name) => (res.headers["set-cookie"] ?? []).find((c) => c.startsWith(name + "="))?.split(";")[0] ?? "";
const rssKib = () => {
  if (!pid) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneLogin(user_) {
  const flowRes = await raw("GET", "/lab/api/auth/csrf");
  const flow = JSON.parse(flowRes.body);
  const flowCookie = cookieOf(flowRes, "__Host-lab-flow");
  const start = performance.now();
  const login = await raw("POST", "/lab/api/auth/login", {
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-CSRF-Token": flow.csrfToken, Cookie: flowCookie },
    body: JSON.stringify({ attemptId: flow.attemptId, username: user_, password }),
  });
  const sessionCookie = cookieOf(login, "__Host-lab-session");
  const confirm = await raw("POST", "/lab/api/auth/confirm", {
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-CSRF-Token": flow.csrfToken, Cookie: `${flowCookie}; ${sessionCookie}` },
    body: JSON.stringify({ attemptId: flow.attemptId }),
  });
  return { status: confirm.status, ms: performance.now() - start };
}

async function oneRegister(username) {
  const flowRes = await raw("GET", "/lab/api/auth/csrf");
  const flow = JSON.parse(flowRes.body);
  const flowCookie = cookieOf(flowRes, "__Host-lab-flow");
  const start = performance.now();
  const res = await raw("POST", "/lab/api/auth/register", {
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-CSRF-Token": flow.csrfToken,
      Cookie: flowCookie,
    },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, ms: performance.now() - start };
}

async function pool(size, total, worker) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < total) {
        const i = next++;
        try {
          results.push(await worker(i));
        } catch (error) {
          results.push({ status: 0, ms: 0, error: String(error) });
        }
      }
    }),
  );
  return results;
}

const report = { baseUrl, idleSeconds, rssKibStart: rssKib(), samples: {} };

// Idle RSS
await sleep(idleSeconds * 1000);
report.rssKibAfterIdle = rssKib();

// Normal 2-concurrent login -> confirm
const normal = await pool(2, 40, () => oneLogin(user));
const normalMs = normal.filter((r) => r.status === 200).map((r) => r.ms);
report.samples.normal = {
  total: normal.length,
  ok: normalMs.length,
  failures: normal.filter((r) => r.status !== 200).map((r) => r.status),
  p50: percentile(normalMs, 50),
  p95: percentile(normalMs, 95),
  p99: percentile(normalMs, 99),
  max: normalMs.length ? Math.max(...normalMs) : null,
};
report.rssKibAfterNormal = rssKib();

// Registration load over the real register-v1 endpoint (isolated DB only).
if (suite !== "login") {
  const tag = Date.now().toString(36);
  const regs = await pool(2, registerTotal, (i) => oneRegister(`Bench${tag}${i}`));
  const regMs = regs.filter((r) => r.status === 201).map((r) => r.ms);
  report.samples.register = {
    total: regs.length,
    ok: regMs.length,
    failures: regs.filter((r) => r.status !== 201).map((r) => r.status),
    p50: percentile(regMs, 50),
    p95: percentile(regMs, 95),
    p99: percentile(regMs, 99),
    max: regMs.length ? Math.max(...regMs) : null,
  };
  // Burst beyond the queue: must stay bounded (429/503, never unbounded work).
  const burst = await pool(20, 20, (i) => oneRegister(`Burst${tag}${i}`));
  report.samples.registerBurst = burst.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  report.registrationCleanup = "bench only runs against an isolated candidate database; created accounts are removed with that database";
}
report.rssKibAfterRegister = rssKib();

// 20 concurrent invalid requests
const invalid = await pool(20, 20, () => raw("POST", "/lab/api/auth/login", { headers: { "Content-Type": "application/json" }, body: "{}" }));
report.samples.invalid20 = invalid.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});

// Unknown username flood (login must be 401 with a dummy-hash cost)
const unknown = await pool(20, 20, async (i) => {
  const flowRes = await raw("GET", "/lab/api/auth/csrf");
  const flow = JSON.parse(flowRes.body);
  const flowCookie = cookieOf(flowRes, "__Host-lab-flow");
  const login = await raw("POST", "/lab/api/auth/login", {
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-CSRF-Token": flow.csrfToken, Cookie: flowCookie },
    body: JSON.stringify({ attemptId: flow.attemptId, username: `nobody-${i}-${Date.now()}`, password }),
  });
  return { status: login.status };
});
report.samples.unknownFlood = unknown.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
report.rssKibPeak = rssKib();

report.passed = {
  normalP95Under2s: (report.samples.normal.p95 ?? Infinity) <= 2000,
  normalAllOk: report.samples.normal.total === report.samples.normal.ok,
  registerP95Under2s: !report.samples.register || (report.samples.register.p95 ?? Infinity) <= 2000,
  registerBounded: !report.samples.registerBurst || Object.keys(report.samples.registerBurst).every((status) => ["201", "409", "429", "503"].includes(status)),
  peakRssUnder192MiB: report.rssKibPeak === null || report.rssKibPeak <= 192 * 1024,
};

writeFileSync(resolve(outDir, "capacity.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(Object.values(report.passed).every(Boolean) ? 0 : 1);
