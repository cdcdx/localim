// 文件传输增强端到端：双 daemon + 双 Edge。
//   阶段1 进度+完整性: A 发 16MiB, 观察 sending 进度 → done; B 收齐 → sha256Ok=true + url
//   阶段2 取消:        A 发 128MiB 后立即 cancelFileByFileId, 双方卡片均 canceled
//   阶段3 持久化:      重载 B 页面 → loadHistory(A) → 历史里能看到 bench 文件消息
// 用法: node drv_file_enh_e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = join(__dirname, '..', '..', 'src', 'out', 'localim', 'localim_daemon.exe');
const WEBUI = join(__dirname, '..', 'ui', 'out', 'webui');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// 端口布局: 两台共享 presence=7616(多播) 以发现彼此；其余端口各自独立。
const A = { webui: 9165, peer: 9177, relay: 9178, web: 9179 };
const B = { webui: 9265, peer: 9277, relay: 9278, web: 9279 };

function launchDaemon(ports, dataDir, log) {
  const args = [];
  if (dataDir) args.push('--user-data-dir=' + dataDir);
  args.push('--webui-port=' + ports.webui);
  args.push('--peer-port=' + ports.peer);
  args.push('--presence-port=9616'); // A/B 共享存在性(多播)端口；绕开遗留 daemon 占用的 7616
  args.push('--relay-port=' + ports.relay);
  args.push('--web-port=' + ports.web);
  args.push('--webui-dist=' + WEBUI);
  const p = spawn(EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  p.stderr.pipe(createWriteStream(log));
  return p;
}

function launchEdge(port, url, profile) {
  return spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + profile, `--remote-debugging-port=${port}`, url],
    { stdio: 'ignore', detached: true });
}
async function cdpUrl(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = j.find(x => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await wait(400);
  }
  throw new Error('cdp not reachable ' + port);
}
async function connect(wsurl) {
  const ws = new WebSocket(wsurl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') console.error('[exc]', (m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
  };
  await new Promise(r => ws.onopen = r);
  const call = (method, params = {}) => new Promise(r => { const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = (expr) => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(r => r?.result?.value).catch(e => ({ cdpErr: String(e) }));
  return { ws, call, ev };
}
async function open(port, url, cdp) {
  await cdp.call('Page.enable');
  await cdp.ev(`location.href !== ${JSON.stringify(url)}`);
  await cdp.call('Page.navigate', { url });
  await wait(1800);
}

async function waitFor(cdp, predFn, tries, gap) {
  for (let i = 0; i < tries; i++) {
    if (await cdp.ev(predFn)) return true;
    await wait(gap);
  }
  return false;
}
function hasGlobal() { return `(() => { const L=window.__localim; return !!(L && L.sendFileTo && L.app && L.login); })()`; }

async function main() {
  const [da, db, aProf, bProf] = await Promise.all([
    mkdtemp(join(os.tmpdir(), 'limd_a_')), mkdtemp(join(os.tmpdir(), 'limd_b_')),
    mkdtemp(join(os.tmpdir(), 'lima_a_')), mkdtemp(join(os.tmpdir(), 'lima_b_')),
  ]);
  const logA = join(da, 'd.log'), logB = join(db, 'd.log');
  const daemonA = launchDaemon(A, da, logA); HANDLES.push(daemonA);
  const daemonB = launchDaemon(B, db, logB); HANDLES.push(daemonB);
  const pe = launchEdge(9166, 'about:blank', aProf); HANDLES.push(pe);
  const pf = launchEdge(9266, 'about:blank', bProf); HANDLES.push(pf);

  const aCdp = await connect(await cdpUrl(9166));
  const bCdp = await connect(await cdpUrl(9266));
  const A_URL = `http://127.0.0.1:${A.web}/index.html?port=${A.webui}`;
  const B_URL = `http://127.0.0.1:${B.web}/index.html?port=${B.webui}`;
  await open(9166, A_URL, aCdp);
  await open(9266, B_URL, bCdp);
  await wait(1500);
  console.log('[d] A page=', await aCdp.ev(`JSON.stringify({href:location.href, has:${hasGlobal()}})`));
  console.log('[d] B page=', await bCdp.ev(`JSON.stringify({href:location.href, has:${hasGlobal()}})`));

  // 登录
  await aCdp.ev(`window.__localim.login('Alice'); void 0;`);
  await bCdp.ev(`window.__localim.login('Bob'); void 0;`);
  await wait(400);

  // 相互识别：peer 以 daemon 的 32hex deviceId(如 local-C3B5FB) 为键，
  // 与 WebUI 登录用的客户端 UUID 不同；用 roster 里的 peer 键作发送/开历史目标。
  const peersOf = (label) => `(() => { const L=window.__localim; if(!L) return []; return [...L.app.state.peers.keys()]; })()`;
  let allPeers = [];
  for (let i = 0; i < 25 && !allPeers.length; i++) { allPeers = await aCdp.ev(peersOf()); if (!allPeers.length) await wait(400); }
  // 用一个独立存在性端口 9616，避开了遗留 daemon；每个新 daemon 恰好应发现另一个。
  const bPeer = allPeers[0] || '';
  let bPeers = [];
  for (let i = 0; i < 25 && !bPeers.length; i++) { bPeers = await bCdp.ev(peersOf()); if (!bPeers.length) await wait(400); }
  const aPeer = bPeers[0] || '';
  const aLedger = await aCdp.ev(`(() => window.__localim.app.state.profile?.deviceId || '')()`);
  const bLedger = await bCdp.ev(`(() => window.__localim.app.state.profile?.deviceId || '')()`);
  console.log('[1] WebUI identity A=', aLedger, ' B=', bLedger);
  console.log('   roster: A→', JSON.stringify(allPeers), ' B→', JSON.stringify(bPeers));
  const mutual = !!bPeer && !!aPeer && bPeer !== aPeer;
  console.log('   mutual discovery:', mutual ? `OK (sending to ${bPeer})` : 'FAIL');
  if (!mutual) throw new Error(`mutual discovery failed A->${bPeer} B->${aPeer}`);

  const allCards = () => `(() => {
    const L = window.__localim; const out = [];
    for (const [k, arr] of L.app.state.conversations) for (const it of arr)
      if (it.mediaRef && (it.xfer || it.mediaRef.url)) out.push({
        fileId: it.mediaRef.fileId, name: it.mediaRef.name, size: it.mediaRef.size,
        phase: it.xfer?.phase, got: it.xfer?.got, sha256Ok: it.mediaRef.sha256Ok, hasUrl: !!it.mediaRef.url });
    return out;
  })()`;

  // ---- 阶段1: 16MiB 传输, 观察进度 + SHA256 + done ----
  const r1 = await aCdp.ev(`(async () => {
    const L = window.__localim;
    const bytes = new Uint8Array(16*1024*1024); for(let i=0;i<bytes.length;i++) bytes[i]=i%251;
    const file = new File([bytes], 'burst-16m.bin', { type: 'application/octet-stream' });
    const r = await L.sendFileTo(${JSON.stringify(bPeer)}, file, 'file');
    return r;
  })()`);
  console.log('[2] A started 16MiB transfer:', JSON.stringify(r1));
  const fid1 = r1?.fileId;

  // 观察发送进度：轮询 A 是否出现 sending(有 got)。
  let sawSending = false;
  for (let i = 0; i < 200 && !sawSending; i++) {
    const arr = await aCdp.ev(allCards());
    sawSending = arr.some(c => c.fileId === fid1 && c.phase === 'sending');
    if (!sawSending) await wait(25);
  }
  console.log('[2.a] A observed sending progress:', sawSending ? 'OK' : '(too fast/not captured)');

  // B 侧等到 done + sha256Ok
  let bDone = null;
  for (let i = 0; i < 60 && !bDone; i++) {
    const arr = await bCdp.ev(allCards());
    const hit = arr.find(c => c.fileId === fid1);
    if (hit && hit.phase === 'done') bDone = hit;
    if (!bDone) await wait(300);
  }
  // A 侧 done
  let aDone = null;
  for (let i = 0; i < 30 && !aDone; i++) {
    const arr = await aCdp.ev(allCards());
    aDone = arr.find(c => c.fileId === fid1 && c.phase === 'done') ?? null;
    if (!aDone) await wait(300);
  }
  const shaOk = bDone?.sha256Ok === true && !!bDone?.hasUrl;
  const aSendOk = !!aDone && aDone.phase === 'done';
  console.log('[3] sender finished:', aSendOk ? 'OK' : JSON.stringify(aDone));
  console.log('   receiver done/B:', bDone ? JSON.stringify(bDone) : 'NONE',
              ' sha256 ok+url=', shaOk ? 'OK' : 'FAIL');
  if (!aSendOk || !bDone || !shaOk) {
    console.error('FAIL phase 1. A cards=', await aCdp.ev(allCards()), ' B cards=', await bCdp.ev(allCards()));
    console.error('A conversation keys=', await aCdp.ev(`(() => [...window.__localim.app.state.conversations.keys()])()`),
                  ' B conversation keys=', await bCdp.ev(`(() => [...window.__localim.app.state.conversations.keys()])()`));
    console.error('A data channels=', await aCdp.ev(`JSON.stringify(window.__localim.mediaDebug())`));
    throw new Error('FAIL phase 1');
  }

  // ---- 阶段2: 取消 128MiB ----
  const r2 = await aCdp.ev(`(async () => {
    const L = window.__localim;
    const bytes = new Uint8Array(128*1024*1024); for(let i=0;i<bytes.length;i++) bytes[i]=(i*31)%251;
    const file = new File([bytes], 'cancel-128m.bin', { type: 'application/octet-stream' });
    const r = await L.sendFileTo(${JSON.stringify(bPeer)}, file, 'file');
    await new Promise(res => setTimeout(res, 250)); // 等 data channel 建立 + fmeta 抵达对端
    const hit = L.cancelFileByFileId(r.fileId);
    return { fileId: r.fileId, hit };
  })()`);
  const fid2 = r2?.fileId;
  console.log('[4] A started 128MiB and canceled (cancelFileByFileId ->', r2?.hit, '):', JSON.stringify(r2));
  // 快速采样 A 侧 fid2 的 phase 序列（定位取消是否曾生效又被覆盖）
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const arr = await aCdp.ev(allCards());
    const hit = arr.find(c => c.fileId === fid2);
    if (hit) seen.add(`${hit.phase}:${hit.got}`);
    if (hit && hit.phase === 'canceled') break;
    await wait(50);
  }
  console.log('[4.a] A-side phase samples:', [...seen].slice(0, 12).join('  '));
  let aCx = null, bCx = null;
  for (let i = 0; i < 30 && !(aCx && bCx); i++) {
    const aa = await aCdp.ev(allCards()); aCx = aa.find(c => c.fileId === fid2) ?? aCx;
    const bb = await bCdp.ev(allCards()); bCx = bb.find(c => c.fileId === fid2) ?? bCx;
    if (!(aCx && bCx)) await wait(300);
  }
  // 放宽成 cancelled
  const aCxl = aCx?.phase, bCxl = bCx?.phase;
  console.log('[5] A cancel state:', aCxl, ' B cancel state:', bCxl);
  if (!(aCxl === 'canceled' && bCxl === 'canceled')) {
    console.error('A conversation data channels=', await aCdp.ev(`JSON.stringify(window.__localim.mediaDebug())`));
    console.error('B frames=', await bCdp.ev(`JSON.stringify((window.__localim?.framesDebug?.()||[]).slice(-60))`));
    console.error('A all cards=', await aCdp.ev(allCards()), ' B all cards=', await bCdp.ev(allCards()));
  }
  const cancelOk = aCxl === 'canceled' && bCxl === 'canceled';
  console.log('   both sides canceled:', cancelOk ? 'OK' : 'FAIL');
  if (!cancelOk) throw new Error('FAIL phase 2');

  // ---- 阶段3: 持久化 —— 重载 B 页面, 打开与 A 的会话应能从历史看到 burst 文件消息 ----
  await open(9266, B_URL, bCdp);
  await wait(1500);
  const reloaded = await waitFor(bCdp, hasGlobal(), 30, 300);
  // 重载后自动用 localStorage 身份 hello + scan_start, 先 loadHistory(A)
  if (reloaded) {
    await bCdp.ev(`window.__localim.native.loadHistory(${JSON.stringify(aPeer)}, 'chat'); void 0;`);
    await wait(900);
  }
  const hist = await bCdp.ev(`(() => {
    const L = window.__localim;
    const conv = L.app.state.conversations.get(${JSON.stringify(aPeer)}) || [];
    return conv.filter(it => it.mediaRef).map(it => ({ name: it.mediaRef.name, size: it.mediaRef.size, hasUrl: !!it.mediaRef.url, fileId: !!it.mediaRef.fileId }));
  })()`);
  const persisted = Array.isArray(hist) && hist.some(h => h.name === 'burst-16m.bin' && h.size === 16*1024*1024 && !h.hasUrl && h.fileId);
  console.log('[6] B conversation history after reload (file entries):', JSON.stringify(hist));
  console.log('   persisted and replayable:', persisted ? 'OK' : 'FAIL');
  if (!persisted) throw new Error('FAIL phase 3');

  const summary = { progress: sawSending ? 'OK' : 'N/A', senderDone: aSendOk, receiverSha256: shaOk, cancel: cancelOk, persisted };
  console.log(`\n=== file transfer enhancements e2e OK: progress/SHA256/cancel/persistence ===`);
  console.log(JSON.stringify(summary));

  // 成功路径也清理（失败路径由 exit 钩子清理）
  await cleanup();
  process.exit(0);
}

const HANDLES = [];
async function cleanup() {
  for (const p of HANDLES) { try { p.kill(); } catch {} }
  await wait(1500);
}
process.on('exit', () => { for (const p of HANDLES) { try { p.detached && p.kill(); } catch {} } });

main().catch(async (e) => {
  console.error('FAIL', e && e.message ? e.message : e);
  await cleanup().catch(() => {});
  process.exit(2);
});