import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dist = resolve(root, "dist");
const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

async function findFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, safe);
  if (!file.startsWith(dist + sep) && file !== dist) return null;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
    const fileInfo = await stat(file);
    return fileInfo.isFile() ? file : null;
  } catch {
    return null;
  }
}

/** The account API is an optional component and this preview has no backend. */
const SESSION_PATHS = ["/api/auth/session", "/lab/api/auth/session"];

createServer(async (request, response) => {
  const urlPath = (request.url ?? "/").split("?")[0];
  // 账号岛在每个页面查询一次登录态。静态预览没有账号服务，这里只回答
  // 「未登录」，让页头渲染真实的未登录状态，而不是在控制台留下一个 404。
  // 其余 /api/auth/* 一律真实 404——预览不假装登录可用。
  if (SESSION_PATHS.includes(urlPath)) {
    response.writeHead(200, {
      "Content-Type": MIME[".json"],
      "Cache-Control": "no-store",
    });
    response.end('{"authenticated":false}');
    return;
  }
  const file = await findFile(request.url ?? "/");
  if (!file) {
    const notFound = join(dist, "404.html");
    try {
      await stat(notFound);
      response.writeHead(404, { "Content-Type": MIME[".html"] });
      createReadStream(notFound).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": MIME[".txt"] });
      response.end("404 Not Found\n");
    }
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`预览 http://127.0.0.1:${port}/ （静态 dist/，未知路径返回真实 404）`);
  console.log("账号接口未接入本预览：登录态固定为未登录，登录表单会提示服务不可用。");
});
