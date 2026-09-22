// LocalIM @ LAN — dev 守护进程（node 协议子集）。
// 目的：让 WebUI 脱离 native 编译即可联调协议。实现 protocol/schema.json 里
// identity/roster/message/room/file/media 的浅薄但可交互子集；所有请求应答、事件
// echo 回本连接，便于观察信封结构。
//
// 运行（自定义端口）：
//   PORT_WEBUI=8080 PORT_WS=7615 node dev/daemon/daemon.mjs
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const uiDist = join(__dirname, "..", "..", "ui", "out", "webui");
const PORT_WS = Number(process.env.PORT_WS || 7615);
const PORT_WEBUI = Number(process.env.PORT_WEBUI || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

const peers = {};
let seq = 0;
const rooms = {};

function replyObj(res) {
  seq += 1;
  return {
    v: 1,
    txn: "dev-" + seq,
    dir: "res",
    ns: res.ns || "",
    m: res.m || "",
    ok: true,
    d: res.d || {},
  };
}

function peerList() {
  return Object.values(peers).map((it) => ({
    deviceId: it.deviceId,
    name: it.name,
    host: it.host,
    netmask: it.netmask || "",
    via: it.via || "lan",
    lastSeen: it.lastSeen || Date.now(),
    caps: ["chat", "media", "file", "remote", "share"],
  }));
}

function handleReq(env, p) {
  const d = p.d || {};
  switch (p.ns + "." + p.m) {
    case "identity.hello":
      return replyObj({ ns: p.ns, m: p.m, d: {
        deviceId: "dev-node-1", name: "dev-machine", platform: "win", version: "0.1.0",
      } });
    case "identity.set_profile":
      return replyObj({ ns: p.ns, m: p.m, d: {} });
    case "roster.list":
      return replyObj({ ns: p.ns, m: p.m, d: { peers: peerList() } });
    case "discovery.scan_start":
      // 模拟一台假设备，5 秒后触发 peer_found 事件。
      setTimeout(() => {
        peers["node-2"] = { deviceId: "node-2", name: "tax-2", host: "192.168.1.22", via: "lan" };
        env.ev({ ns: "discovery", m: "peer_found", d: peerList()[0] });
      }, 400);
      return replyObj({ ns: p.ns, m: p.m, d: {} });
    case "discovery.scan_stop":
      return replyObj({ ns: p.ns, m: p.m, d: {} });
    case "message.send": {
      const msg = {
        kind: d.kind || "chat",
        type: d.type || "text",
        from: "dev-node-1",
        to: d.to || "",
        nonce: d.nonce || "",
        ts: Date.now(),
        body: d.body,
        seq: seq,
      };
      setTimeout(() => env.ev({ ns: "message", m: "chat", d: msg }), 200);
      return replyObj({ ns: p.ns, m: p.m, d: { seq, accepted: true } });
    }
    case "message.history":
      return replyObj({ ns: p.ns, m: p.m, d: { items: [], cursor: "" } });
    case "room.create": {
      const id = "room-" + Date.now().toString(16);
      rooms[id] = { roomId: id, name: d.name || "群聊", owner: "dev-node-1", members: ["dev-node-1"] };
      return replyObj({ ns: p.ns, m: p.m, d: { roomId: id, name: rooms[id].name } });
    }
    case "room.join": {
      const roomId = d.roomId || "";
      if (rooms[roomId]) rooms[roomId].members.push("dev-node-1");
      return replyObj({ ns: p.ns, m: p.m, d: { roomId } });
    }
    case "room.members": {
      const room = rooms[d.roomId] || { members: [], owner: "" };
      return replyObj({ ns: p.ns, m: p.m, d: { members: room.members, owner: room.owner } });
    }
    case "profile.get":
      return replyObj({ ns: p.ns, m: p.m, d: {
        deviceId: "dev-node-1", name: "dev-machine", avatar: "",
        joinedRooms: Object.keys(rooms),
      } });
    case "file.transfer_begin":
      return replyObj({ ns: p.ns, m: p.m, d: { fileId: d.fileId || ("f-" + Date.now()) } });
    default:
      return replyObj({ ns: p.ns, m: p.m, d: { note: "dev stub: " + p.ns + "." + p.m } });
  }
}

// ---- WebSocket (7615)：极简实现（握手 + 文本帧 unmasked 服务端发送）----
import { createServer } from "node:net";
import crypto from "node:crypto";

function acceptKey(k) {
  return crypto.createHash("sha1")
    .update(k + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}
function encodeText(str) {
  const payload = Buffer.from(str);
  const head = [];
  head.push(0x81);
  if (payload.length < 126) head.push(payload.length);
  else if (payload.length < 65536) { head.push(126, payload.length >> 8, payload.length & 0xff); }
  else { head.push(127); const big = Buffer.alloc(8); big.writeBigUInt64BE(BigInt(payload.length)); Array.prototype.push.apply(head, big); }
  return Buffer.concat([Buffer.from(head), payload]);
}

const wsSrv = createServer((sock) => {
  let handshaken = false;
  let buf = "";
  const env = {
    ev(obj) { if (sock.write) sock.write(encodeText(JSON.stringify({ v:1, dir:"ev", ...obj }))); },
  };
  sock.on("data", (chunk) => {
    buf += chunk.toString("latin1");
    if (!handshaken) {
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const headers = buf.slice(0, i).split("\r\n");
      let key = "";
      for (const h of headers) if (h.toLowerCase().startsWith("sec-websocket-key:")) key = h.split(":")[1].trim();
      buf = buf.slice(i + 4);
      handshaken = true;
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n");
    }
    // 只处理单帧长度的小信封；分帧/掩码解包留给真实 daemon。
    while (buf.length >= 2) {
      const b0 = buf.charCodeAt(0) & 0x0f;
      const b1 = buf.charCodeAt(1);
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = (buf.charCodeAt(2) << 8) | buf.charCodeAt(3);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        let n = 0;
        for (let k = 0; k < 8; k++) n = n * 256 + buf.charCodeAt(2 + k);
        len = n;
        off = 10;
      }
      let mask = null;
      if (masked) {
        // buf 是 latin1 字符串，必须转成字节 Buffer，否则 mask[i] 是字符串，
        // 与 payload[i] 异或时被 ToInt32->0 擦除，导致永远解不出掩码帧。
        mask = Buffer.from(buf.slice(off, off + 4), "latin1");
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.slice(off, off + len), "latin1");
      buf = buf.slice(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (b0 === 0x8) { sock.end(); return; }
      if (b0 !== 0x1) continue;
      let req;
      try { req = JSON.parse(payload.toString("utf8")); } catch { continue; }
      const res = handleReq(env, req);
      sock.write(encodeText(JSON.stringify(res)));
    }
  });
});
wsSrv.listen(PORT_WS, "127.0.0.1", () => console.log(`[localim/dev] ws ready on ws://127.0.0.1:${PORT_WS}`));

// ---- WebUI 静态服务 ----
const uiSrv = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = normalize(join(uiDist, p));
    if (!file.startsWith(normalize(uiDist))) { res.writeHead(403); res.end(); return; }
    const st = await stat(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
uiSrv.listen(PORT_WEBUI, "127.0.0.1", () => console.log(`[localim/dev] webui ready: http://127.0.0.1:${PORT_WEBUI}`));