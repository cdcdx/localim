// LocalIM @ LAN — dev 一键启动：起 node 协议 daemon + 打印 WebUI 地址。
// 用法：node scripts/dev.mjs   (或 npm -C dev/daemon run dev:daemon)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const daemon = join(root, "dev", "daemon", "daemon.mjs");

console.log("[localim] 启动 dev daemon (协议子集 7615 + webui 8080)...");
const child = spawn(process.execPath, [daemon], {
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code) => process.exit(code ?? 0));