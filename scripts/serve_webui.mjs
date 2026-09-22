// LocalIM @ LAN — 静态托管构建好的 WebUI，供 native 守护进程(7615)配套使用。
// 说明：dev/daemon/daemon.mjs 同时占 7615+8080；当你想跑 native(localim_daemon.exe) 时，
//      用本脚本单独把 ui/out/webui 吐到 8080 即可，二者可并存（UI 连 127.0.0.1:7615）。
// 用法：node scripts/serve_webui.mjs    (自定义端口 PORT=8080 node scripts/serve_webui.mjs)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const uiDist = join(__dirname, "..", "ui", "out", "webui");
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

http
  .createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || "/").split("?")[0]);
      if (p === "/") p = "/index.html";
      const file = normalize(join(uiDist, p));
      if (!file.startsWith(normalize(uiDist))) {
        res.writeHead(403);
        res.end();
        return;
      }
      const st = await stat(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(PORT, "127.0.0.1", () =>
    console.log(`[localim] WebUI served: http://127.0.0.1:${PORT}`)
  );