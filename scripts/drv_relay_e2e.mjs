// 跨网段引导中继端到端：本地起 localim_relay + 两台"不同网段"daemon(A/B，
// 各自独立 presence 端口，无局域网组播互发现)——两者只能经共享 relay(7718) 互发现
// 并拿到对端 host/port 后直连收发文字。
//   阶段1 relay 注册: A、B 各连 relay 注册 → relay 路由表含 A、B 且互相广播 peer_online。
//   阶段2 互发现落地: A/B 的 peers 表(经 roster.list)彼此可见(不靠局域网)。
//   阶段3 文字互达: A message.send 给 B(直拨 B 的 peer 端口) → B 收到；B 回一条 → A 收到。
//   阶段4 注销: 停 B 后 relay 路由表清空该条并广播 peer_offline。
//   用法: node drv_relay_e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream, readFileSync } from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = join(__dirname, '..', '..', 'src', 'out', 'localim', 'localim_daemon.exe');
const RELAY = join(__dirname, '..', '..', 'src', 'out', 'localim', 'localim_relay.exe');
const WEBUI = join(__dirname, '..', 'ui', 'out', 'webui');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RELAY_PORT = 7718;
const NODES = [
  { webui: 8020, peer: 8022, presence: 7016, web: 8024 }, // A（网段1）
  { webui: 8120, peer: 8122, presence: 7116, web: 8124 }, // B（网段2）
];
const CDP = { A: 8021, B: 8121 };

function launchDaemon(n, dataDir, log) {
  const args = [
    '--user-data-dir=' + dataDir,
    `--webui-port=${n.webui}`,
    `--peer-port=${n.peer}`,
    `--presence-port=${n.presence}`,
    `--relay-port=${RELAY_PORT}`,
    '--relay-host=127.0.0.1',
    `--web-port=${n.web}`,
    '--webui-dist=' + WEBUI,
    '--enable-logging=stderr', '--v=1',
  ];
  const p = spawn(EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  p.stderr.pipe(createWriteStream(log));
  return p;
}
function launchEdge(port, profile) {
  return spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
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

async function main() {
  const dirs = await Promise.all([...Array(5)].map(() => mkdtemp(join(os.tmpdir(), 'limre_'))));
  const [rl, da, db, pa, pb] = dirs;
  const handles = [];
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1400);
    await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true }))); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });
  try {
    const rlLog = join(rl, 'relay.log');
    handles.push(spawn(RELAY, [`--relay-port=${RELAY_PORT}`, '--enable-logging=stderr', '--v=1'],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
      .on('exit', (c) => { if (c !== null && c !== 0) console.error('[relay] exited', c); })
      .stderr.pipe(createWriteStream(rlLog)));
    wait(700);
    handles.push(launchDaemon(NODES[0], da, join(da, 'a.log')));
    handles.push(launchDaemon(NODES[1], db, join(db, 'b.log')));
    handles.push(launchEdge(CDP.A, pa), launchEdge(CDP.B, pb));
    const [a, b] = [await connect(await cdpUrl(CDP.A)), await connect(await cdpUrl(CDP.B))];

    await open(`http://127.0.0.1:${NODES[0].web}/index.html?port=${NODES[0].webui}`, a);
    await open(`http://127.0.0.1:${NODES[1].web}/index.html?port=${NODES[1].webui}`, b);
    await wait(1200);
    await a.ev(`window.__localim.login('Alice'); void 0;`);
    await b.ev(`window.__localim.login('Bob'); void 0;`);
    await wait(600);
    const hello = (cd) => cd.ev(`(() => window.__localim.native.request('identity','hello',{}).then(r=>JSON.stringify({id:r.deviceId,name:r.name})).catch(e=>'ERR:'+e))()`)
      .then((s) => JSON.parse(s).id);
    const [aId, bId] = await Promise.all([hello(a), hello(b)]);
    console.log('[0] daemon 身份 A=%s B=%s', (aId || '').slice(0, 8), (bId || '').slice(0, 8));
    if (!aId || !bId) throw new Error('身份解析失败');

    // 阶段1+2: A/B 经 relay 互发现。两类网段无局域网互发现(各自 presence 端口不同)，
    // 只能靠 relay 广播 peer_online → daemon peers_ → roster.list。轮询时补拉 roster。
    const other = (targetId) => `(() => { const L=window.__localim;
      if(!L) return false;
      const has = [...L.app.state.peers.keys()].includes(${JSON.stringify(targetId)});
      if(!has) { try { L.native.loadRoster(); } catch {} }
      return has; })()`;
    const aSeesB = await waitFor(a, other(bId), 40, 500);
    const bSeesA = await waitFor(b, other(aId), 40, 500);
    console.log('[1] 经 relay 互发现: A 见 B=%s  B 见 A=%s', aSeesB, bSeesA);
    if (!(aSeesB && bSeesA)) {
      throw new Error('relay 互发现失败（无局域网组播，应仅经 relay 发现）');
    }
    const aPeerVia = await a.ev(`(() => { const p=window.__localim.app.state.peers.get(${JSON.stringify(bId)}); return p? (p.via||'?') : 'none'; })()`);
    const bPeerVia = await b.ev(`(() => { const p=window.__localim.app.state.peers.get(${JSON.stringify(aId)}); return p? (p.via||'?') : 'none'; })()`);
    console.log('[1] via 标记: A→B via=%s  B→A via=%s', aPeerVia, bPeerVia);

    // 阶段3: 直拨互发文字。A 发 → B 收到；B 回 → A 收到。
    const unique = `relay-${Date.now()}`;
    await a.ev(`(() => window.__localim.native.request('message','send',{to:${JSON.stringify(bId)},kind:'chat',body:${JSON.stringify('hi-via-relay-' + unique)}}).then(()=>true).catch(()=>false))()`);
    const bGot = await waitFor(b, `(() => { const L=window.__localim; if(!L) return false;
      for(const [,arr] of L.app.state.conversations){ for(const it of arr) if(it.body===${JSON.stringify('hi-via-relay-' + unique)} && it.from!==L.app.state.profile?.deviceId) return true; }
      return false; })()`, 60, 400);
    console.log('[2] A→B(经relay发现后直拨): B 收到=%s', bGot);
    if (!bGot) throw new Error('A→B 文字未达');
    await b.ev(`(() => window.__localim.native.request('message','send',{to:${JSON.stringify(aId)},kind:'chat',body:${JSON.stringify('reply-from-B-' + unique)}}).then(()=>true).catch(()=>false))()`);
    const aGot = await waitFor(a, `(() => { const L=window.__localim; if(!L) return false;
      for(const [,arr] of L.app.state.conversations){ for(const it of arr) if(it.body===${JSON.stringify('reply-from-B-' + unique)} && it.from!==L.app.state.profile?.deviceId) return true; }
      return false; })()`, 60, 400);
    console.log('[3] B→A: A 收到=%s', aGot);

    // 阶段4: 停 B(daemon+其 Edge) → A 应收到 peer_offline（relay 注销并广播）。
    // 注意只停 B 侧：A 的 CDP 仍要用于轮询，不能动。
    try { handles[2].kill(); handles[4].kill(); } catch {}
    await wait(1200);
    const aLostB = await waitFor(a, `(() => { const L=window.__localim; if(!L) return false;
      try { L.native.loadRoster(); } catch {}
      return !L.app.state.peers.has(${JSON.stringify(bId)}); })()`, 40, 400);
    const pass = aSeesB && bSeesA && (aPeerVia === 'relay' || aPeerVia === '?') &&
                 bGot && aGot && aLostB;
    console.log('[4] B 下线 → A 侧 peer 移除=%s', aLostB);
    if (!aLostB) {
      try {
        const rl2 = readFileSync(join(rl, 'relay.log'), 'utf8');
        const rel = rl2.split('\n').filter((l) => /register|unregister|offline|connect|closed/.test(l)).slice(-20);
        if (rel.length) console.error(`--- relay.log ---\n${rel.join('\n')}`);
      } catch {}
      try {
        const al2 = readFileSync(join(da, 'a.log'), 'utf8');
        const rel = al2.split('\n').filter((l) => /relay|offline|peer|roster/.test(l)).slice(-20);
        if (rel.length) console.error(`--- A.log ---\n${rel.join('\n')}`);
      } catch {}
    }
    console.log('=== relay 跨网段发现+直拨文字互达: ' + (pass ? 'PASS' : 'FAIL') + ' ===');

    await cleanup();
    process.exit(pass ? 0 : 3);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    try {
      const t = readFileSync(join(rl, 'relay.log'), 'utf8');
      const rel = t.split('\n').filter((l) => /relay|register|connect|error|peer/.test(l)).slice(-30);
      if (rel.length) console.error(`--- relay.log ---\n${rel.join('\n')}`);
    } catch {}
    for (const [lg, tag] of [[join(da, 'a.log'), 'A'], [join(db, 'b.log'), 'B']]) {
      try {
        const t = readFileSync(lg, 'utf8');
        const rel = t.split('\n').filter((l) => /relay|peer_online|unknown|dial|message.send/.test(l)).slice(-25);
        if (rel.length) console.error(`--- ${tag}.log (relay) ---\n${rel.join('\n')}`);
      } catch {}
    }
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();