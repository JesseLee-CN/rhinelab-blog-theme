// Same-origin HTTPS review harness for G6/G8/G9. Serves the built dist/ and
// proxies /lab/api/auth/ to a real lab-auth process, so __Host- cookies are
// validated under real TLS. Binds loopback only unless --allow-public is set.
//
//   node scripts/auth/serve-review.mjs \
//     --cert .tools/.../cert.pem --key .tools/.../key.pem \
//     --dist dist --auth http://127.0.0.1:8099 --port 8443
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}
const certPath = args.get("cert");
const keyPath = args.get("key");
const dist = resolve(args.get("dist") ?? "dist");
const authTarget = new URL(args.get("auth") ?? "http://127.0.0.1:8099");
const port = Number(args.get("port") ?? 8443);
const host = args.get("host") ?? "127.0.0.1";
const allowPublic = process.argv.includes("--allow-public");
const delayLoginMs = Number(args.get("delay-login-ms") ?? 0);
const delayConfirmMs = Number(args.get("delay-confirm-ms") ?? 0);
// Register delays hold the response after the auth write completed, so they
// simulate "write succeeded, response late/lost" without racing the backend.
const delayRegisterMs = Number(args.get("delay-register-ms") ?? 0);
const delayRegisterOnceMs = Number(args.get("delay-register-once-ms") ?? 0);
let registerOnceUsed = false;

if (!certPath || !keyPath) {
  console.error("usage: serve-review.mjs --cert <pem> --key <pem> [--dist dist] [--auth http://127.0.0.1:8099] [--port 8443]");
  process.exit(2);
}
if (host === "0.0.0.0" && !allowPublic) {
  console.error("refusing to bind 0.0.0.0 without --allow-public");
  process.exit(2);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = resolve(root, "." + normalize(decoded));
  return candidate.startsWith(root) ? candidate : null;
}

async function serveStatic(req, res) {
  const urlPath = req.url?.split("?")[0] ?? "/";
  let file = safeJoin(dist, urlPath);
  if (!file) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (urlPath.endsWith("/")) file = join(file, "index.html");
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  const headers = { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" };
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

function proxyAuth(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const options = {
      hostname: authTarget.hostname,
      port: authTarget.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: authTarget.host },
    };
    const upstreamReq = httpRequest(options, (upstreamRes) => {
      let delay = 0;
      if (req.url?.startsWith("/lab/api/auth/login")) delay = delayLoginMs;
      else if (req.url?.startsWith("/lab/api/auth/confirm")) delay = delayConfirmMs;
      else if (req.url?.startsWith("/lab/api/auth/register")) {
        if (delayRegisterOnceMs > 0 && !registerOnceUsed) {
          registerOnceUsed = true;
          delay = delayRegisterOnceMs;
        } else {
          delay = delayRegisterMs;
        }
      }
      const send = () => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      };
      if (delay > 0) setTimeout(send, delay);
      else send();
    });
    upstreamReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "unavailable", message: "auth unavailable" }, requestId: "" }));
    });
    if (body.length) upstreamReq.write(body);
    upstreamReq.end();
  });
}

const server = createServer(
  { cert: await readFile(certPath), key: await readFile(keyPath) },
  (req, res) => {
    if ((req.url ?? "").startsWith("/lab/api/auth/")) proxyAuth(req, res);
    else void serveStatic(req, res);
  },
);
server.listen(port, host, () => {
  console.log(`serve-review listening on https://${host}:${port} (dist=${dist}, auth=${authTarget.origin}${delayLoginMs ? `, delayLogin=${delayLoginMs}ms` : ""})`);
});
