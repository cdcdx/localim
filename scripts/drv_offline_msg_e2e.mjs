// 离线消息投递端到端：A 给离线 B 发文本 → 入队；B 重新上线后 A 补投 → B 收到，A 收到送达回执。
//   阶段1 上线互发现: A、B 共享 presence 端口，各自在线 peer 表 ≥1，identity.hello 取 daemon 真实 deviceId。
//   阶段2 离线入队: 杀掉 B(保留数据目录)，A 发文本到 bId → 不在线入 offline 队列(log "offline queued")，
//           A 本端消息态保持未送达(sent)。
//   阶段3 上线补投+回执: 重启 B(同数据目录→deviceId 稳定)，A 补投 → B 收到该消息；
//           B 回 ack → A 消息态翻转为 delivered。
//   用法: node drv_offline_msg_e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream, readFileSync } from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = join(__dirname, '..', '..', 'src', 'out', 'localim', 'localim_daemon.exe');
const WEBUI = join(__dirname, '..', 'ui', 'out', 'webui');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PRES = 8616;
const N = {
  A: { webui: 9020, peer: 9022, web: 9024 },
  B: { webui: 9120, peer: 9122, web: 9124 },
};
const CDP = { A: 9021, B1: 9121, B2: 9123 };

function launchDaemon(n, dataDir, log) {
  const args = [];
  args.push('--user-data-dir=' + dataDir);
  args.push(`--webui-port=${n.webui}`);
  args.push(`--peer-port=${n.peer}`);
  args.push(`--presence-port=${PRES}`);
  args.push(`--relay-port=${n.peer + 1}`);
  args.push(`--web-port=${n.web}`);
  args.push('--webui-dist=' + WEBUI);
  args.push('--enable-logging=stderr'); args.push('--v=1');
  const p = spawn(EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  p.stderr.pipe(createWriteStream(log));
  return p;
}
function launchEdge(port, profile) {
  return spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile, `--remote-debugging-port=${port}`, 'about:blank'],
    { stdio: 'ignore', detached: true });
}
async function cdpUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = j.find((x) => x.type === 'page');
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
    else if (m.method === 'Runtime.exceptionThrown') console.error('[exc]', (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
  };
  await new Promise((r) => (ws.onopen = r));
  const call = (method, params = {}) => new Promise((r) => { const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = (expr) => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((r) => r?.result?.value).catch((e) => ({ cdpErr: String(e) }));
  await call('Page.enable');
  return { ws, call, ev };
}
async function open(url, cdp) {
  await cdp.call('Page.navigate', { url });
  await wait(1800);
}
async function waitFor(cdp, fn, tries = 60, gap = 400) {
  for (let i = 0; i < tries; i++) { if (await cdp.ev(fn)) return true; await wait(gap); }
  return false;
}
const hello = (cd) => cd.ev(`(() => window.__localim.native.request('identity','hello',{}).then(r=>JSON.stringify({id:r.deviceId,name:r.name})).catch(e=>'ERR:'+e))()`)
  .then((s) => { try { return JSON.parse(s); } catch { return null; } });

async function main() {
  const dirs = await Promise.all([mkdtemp(join(os.tmpdir(), 'limoff_')), mkdtemp(join(os.tmpdir(), 'limoff_')), mkdtemp(join(os.tmpdir(), 'limoff_')), mkdtemp(join(os.tmpdir(), 'limoff_'))]);
  const [da, db, pa, pb] = dirs; // db 必须跨重启复用，保证 B 的 deviceId 稳定。
  const handles = [];
  const track = (p) => { handles.push(p); return p; };
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1400);
    await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true }))); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });

  let pass = false;
  try {
    const aLog = join(da, 'a.log');
    track(launchDaemon(N.A, da, aLog));
    track(launchDaemon(N.B, db, join(db, 'b.log')));
    track(launchEdge(CDP.A, pa), track(launchEdge(CDP.B1, pb)));
    const [a, b] = [await connect(await cdpUrl(CDP.A)), await connect(await cdpUrl(CDP.B1))];

    await open(`http://127.0.0.1:${N.A.web}/index.html?port=${N.A.webui}`, a);
    await open(`http://127.0.0.1:${N.B.web}/index.html?port=${N.B.webui}`, b);
    await wait(1200);
    await a.ev(`window.__localim.login('Alice'); void 0;`);
    await b.ev(`window.__localim.login('Bob'); void 0;`);
    await wait(600);

    // 阶段1: 互发现
    const online1 = (cd) => `(() => { const L=window.__localim; return L?[...L.app.state.peers.keys()].filter(Boolean).length:0; })()`;
    for (const [n, cd] of [['A', a], ['B', b]]) {
      if (!(await waitFor(cd, `(() => { const L=window.__localim; if(!L) return false; return [...L.app.state.peers.keys()].filter(Boolean).length>=1; })()`, 60, 400)))
        throw new Error(`${n} 互发现失败`);
    }
    console.log('[1] 互发现 A=%s B=%s', await a.ev(online1()), await b.ev(online1()));

    const [aIdObj, bIdObj] = [await hello(a), await hello(b)];
    const aId = aIdObj?.id, bId = bIdObj?.id;
    if (!aId || !bId) throw new Error('identity.hello 未取到 deviceId');
    console.log('[1.5] daemon 身份 A=%s B=%s', aId.slice(0, 8), bId.slice(0, 8));

    // 阶段2: 杀掉 B(保留数据目录)。互发现不建 peer 连接，A 对 B 无既有连通道 → Connected 必为 false，离线入队确定。
    const bDaemon = handles[1];
    try { bDaemon.kill(); } catch {}
    await wait(1800);

    // A 发文本到 bId（离线）
    const nonce = `off-${Date.now()}`;
    const body = '离线消息 你好 B ' + Date.now();
    await a.ev(`(() => { const L=window.__localim; return L.native.send('message','send',{kind:'chat',type:'text',to:${JSON.stringify(bId)},nonce:${JSON.stringify(nonce)},ts:Date.now(),body:${JSON.stringify(body)}}); })()`);
    await wait(900);

    // 断言 A daemon 已入队
    let aLogTxt = '';
    try { aLogTxt = readFileSync(aLog, 'utf8'); } catch {}
    const queued = /offline queued to/.test(aLogTxt);
    console.log('[2] 离线入队 log(offline queued)=%s', queued);
    if (!queued) throw new Error('A 未将离线消息入队（可能走了直发丢包路径）');

    // A 本端消息态：B 离线未送达（应为 sent/undefined，而非 delivered）。
    // 注意：daemon 回显 chat.from=daemon deviceId（非 WebUI 的 self id），故发送消息落在 aId 键下——必须全会话扫描。
    const scanByNonce = (nonceJs) => `(() => { const L=window.__localim; if(!L) return null; for(const arr of L.app.state.conversations.values()){ const it=arr.find(c=>c.nonce===${nonceJs}); if(it) return it.status; } return null; })()`;
    const aStatus = await a.ev(scanByNonce(JSON.stringify(nonce)));
    console.log('[2.5] A 侧消息 status=', aStatus);
    if (aStatus === 'delivered') throw new Error('不该在 B 离线时已送达');

    // 阶段3: 重启 B（同 db 目录 → deviceId 稳定）+ 新 edge
    track(launchDaemon(N.B, db, join(db, 'b2.log')));
    const pb2 = await mkdtemp(join(os.tmpdir(), 'limoff_'));
    track(launchEdge(CDP.B2, pb2));
    const b2 = await connect(await cdpUrl(CDP.B2));
    await open(`http://127.0.0.1:${N.B.web}/index.html?port=${N.B.webui}`, b2);
    await wait(1200);
    await b2.ev(`window.__localim.login('Bob'); void 0;`);
    await wait(400);
    const b2Obj = await hello(b2);
    console.log('[3] B 重启后 deviceId=%s（应等于 %s）', (b2Obj?.id || '').slice(0, 8), bId.slice(0, 8));
    if (b2Obj?.id !== bId) throw new Error('B 重启后 deviceId 漂移，离线队列无法按键补投');

    // 补投+回执：待 A 侧消息态翻转为 delivered（B 收到并回 ack）——全会话扫描
    const delivered = await waitFor(a, `(() => { const L=window.__localim; if(!L) return false; for(const arr of L.app.state.conversations.values()){ const it=arr.find(c=>c.nonce===${JSON.stringify(nonce)}); if(it && it.status==='delivered') return true; } return false; })()`, 90, 500);
    console.log('[4] A 侧最终 status=delivered?', delivered);
    if (!delivered) {
      console.error('[dbg] A.evlog(message.ack)=', await a.ev(`JSON.stringify(window.__localim.native.evlog.filter(e=>e.ns==='message').map(e=>({m:e.m,d:e.d})).slice(-8))`));
      console.error('[dbg] B2.evlog(message)=', await b2.ev(`JSON.stringify(window.__localim.native.evlog.filter(e=>e.ns==='message').map(e=>({m:e.m,d:e.d})).slice(-8))`));
      throw new Error('B 上线后 A 未收到送达回执');
    }

    // B 侧已收到该消息（持久化进 B daemon 的 store）。B2 页面可能在补投瞬间尚未连上 daemon，
// 消息事件会被丢弃——改用 loadHistory(aId) 从 store 取回校验（同时验证离线消息确有落库）。
    const bGot = await waitFor(b2, `(async () => { const L=window.__localim; if(!L) return false;
      L.native.loadHistory(${JSON.stringify(aId)},'chat'); await new Promise(r=>setTimeout(r,200));
      const arr=L.app.state.conversations.get(${JSON.stringify(aId)})||[];
      return arr.some(c=>c.body===${JSON.stringify(body)}); })()`, 40, 400);
    console.log('[5] B 收到补投消息(store/history)=', bGot);
    if (!bGot) throw new Error('B 上线后未收到离线补投消息');

    // A daemon 补投日志佐证
    try { aLogTxt = readFileSync(aLog, 'utf8'); } catch {}
    const flushed = /offline flushed/.test(aLogTxt);
    console.log('[6] A daemon 补投 log(offline flushed)=%s', flushed);

    pass = queued && (aStatus !== 'delivered') && delivered && bGot && flushed;
    console.log('=== 离线消息投递: ' + (pass ? 'PASS（B 离线入队 → 上线 A 补投 → B 收到 → A 送达回执）' : 'FAIL') + ' ===');

    await cleanup();
    process.exit(pass ? 0 : 3);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    for (const [lg, tag] of [[join(da, 'a.log'), 'A'], [join(db, 'b.log'), 'B'], [join(db, 'b2.log'), 'B2']]) {
      try {
        const t = readFileSync(lg, 'utf8');
        const rel = t.split('\n').filter((l) => /offline|SendPeer|dial|inbound peer|未知对端|queued|flushed|ack/.test(l)).slice(-25);
        if (rel.length) console.error(`--- ${tag}.log (offline/peer) ---\n${rel.join('\n')}`);
      } catch {}
    }
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();