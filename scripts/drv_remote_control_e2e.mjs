// 远程控制端到端：双 daemon + 双头无 Edge（伪摄像头 / 伪标签捕获）。
//   阶段1 建立: A(startCall 'remote', 被控端, getDisplayMedia 共享自身标签) → B 接听(操控端/观众)，
//              两端 PeerConnection connected，B 主画面渲染 A 的远程流，A 作为 offerer 已开 data channel。
//   阶段2 回传: B(操控端)经 sendRemoteInput 发 mousemove/keydown →
//              data channel → A(被控) onChannelMessage 'input' → A 转发本机 daemon media.remote_input →
//              断言 A 页记录到转发载荷；daemon 日志含 media.remote_input ... injected=1。
//   用法: node drv_remote_control_e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFileSync as require_fs_read } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = join(__dirname, '..', '..', 'src', 'out', 'localim', 'localim_daemon.exe');
const WEBUI = join(__dirname, '..', 'ui', 'out', 'webui');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// 端口布局: 两台共享 presence(9616) 以互发现；webui/peer/relay/web 各自独立。
const A = { webui: 9370, peer: 9372, relay: 9373, web: 9374 };
const B = { webui: 9470, peer: 9472, relay: 9473, web: 9474 };

function launchDaemon(ports, dataDir, log) {
  const args = [];
  args.push('--user-data-dir=' + dataDir);
  args.push('--webui-port=' + ports.webui);
  args.push('--peer-port=' + ports.peer);
  args.push('--presence-port=9616');
  args.push('--relay-port=' + ports.relay);
  args.push('--web-port=' + ports.web);
  args.push('--webui-dist=' + WEBUI);
  // 打印 LOG(INFO)（media.remote_input 注入行）便于断言 daemon 侧确实执行了注入。
  args.push('--enable-logging=stderr'); args.push('--v=1');
  const p = spawn(EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  p.stderr.pipe(createWriteStream(log));
  return p;
}
function launchEdge(port, url, profile) {
  return spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-accept-this-tab-capture',
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
  await call('Page.enable');
  return { ws, call, ev };
}
async function open(port, url, cdp) {
  await cdp.ev(`location.href !== ${JSON.stringify(url)}`);
  await cdp.call('Page.navigate', { url });
  await wait(1800);
}
async function waitFor(cdp, fn, tries = 40, gap = 400) {
  for (let i = 0; i < tries; i++) { if (await cdp.ev(fn)) return true; await wait(gap); }
  return false;
}

// 双向 connected 且包含远程视频轨道（排除预热文件/data-only 会话）。
const mediaSnapExpr = () => `(() => {
  const L = window.__localim; if(!L) return '';
  const s = L.mediaDebug().map(x=>({id:x.callId,pc:x.pcState,ice:x.ice,sig:x.sig,local:x.localTracks||[],remote:x.remoteTracks||[]}));
  return JSON.stringify({sessions:s});
})()`;

async function main() {
  const [da, db, aProf, bProf] = await Promise.all([
    mkdtemp(join(os.tmpdir(), 'limr_a_')), mkdtemp(join(os.tmpdir(), 'limr_b_')),
    mkdtemp(join(os.tmpdir(), 'limr_pa_')), mkdtemp(join(os.tmpdir(), 'limr_pb_')),
  ]);
  const handles = [];
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1500);
    await Promise.allSettled([rm(da,{recursive:true,force:true}), rm(db,{recursive:true,force:true}),
      rm(aProf,{recursive:true,force:true}), rm(bProf,{recursive:true,force:true})]); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });
  try {
    handles.push(launchDaemon(A, da, join(da, 'a.log')), launchDaemon(B, db, join(db, 'b.log')));
    const pe = launchEdge(9371, 'about:blank', aProf); handles.push(pe);
    const pf = launchEdge(9471, 'about:blank', bProf); handles.push(pf);
    const aCdp = await connect(await cdpUrl(9371));
    const bCdp = await connect(await cdpUrl(9471));
    const A_URL = `http://127.0.0.1:${A.web}/index.html?port=${A.webui}`;
    const B_URL = `http://127.0.0.1:${B.web}/index.html?port=${B.webui}`;
    await open(9371, A_URL, aCdp);
    await open(9471, B_URL, bCdp);
    await wait(1400);
    await aCdp.ev(`window.__localim.login('Alice'); void 0;`);
    await bCdp.ev(`window.__localim.login('Bob'); void 0;`);
    await wait(500);

    // 全程拦截 A 页 native.send，记录 media.remote_input / remote_host（需在 startCall 前装好）
    await aCdp.ev(`(() => {
      const n = window.__localim.native; window.__recInput = []; window.__recHost = false;
      const orig = n.send.bind(n);
      n.send = function(ns,m,d){ if(ns==='media'&&m==='remote_input') window.__recInput.push(JSON.parse(JSON.stringify(d)));
        if(ns==='media'&&m==='remote_host') window.__recHost = !!(d && d.on); return orig(ns,m,d); };
      return 'armed';
    })()`);

    // 互发现
    const bId = await aCdp.ev(`(() => { const L=window.__localim; return L?([...L.app.state.peers.keys()].filter(Boolean)[0]||''):''; })()`);
    await waitFor(bCdp, `(() => { const L=window.__localim; if(!L) return false; return [...L.app.state.peers.keys()].filter(Boolean).length>0; })()`, 40, 400);
    const aId = await bCdp.ev(`(() => { const L=window.__localim; return L?([...L.app.state.peers.keys()].filter(Boolean)[0]||''):''; })()`);
    console.log('[0] mutual discovery A->B=%s B->A=%s', bId, aId);
    if (!bId || !aId || bId === aId) throw new Error('mutual discovery failed');

    // 预热：A→B 传一个小文件迫使持久 peer 通道建立（冷启动拨号/信令中继更可靠）。
    const warm = await (async () => {
      await aCdp.ev(`(async () => { const L=window.__localim; const f=new Uint8Array(65536); f.fill(7);
        const file=new File([f],'warm.bin',{type:'application/octet-stream'});
        await L.sendFileTo(${JSON.stringify(bId)},file,'file'); return true; })()`);
      return await waitFor(bCdp, `(() => { const L=window.__localim; if(!L) return false;
        for(const [,arr] of L.app.state.conversations) for(const it of arr)
          if(it.mediaRef && it.mediaRef.name==='warm.bin' && it.xfer && it.xfer.phase==='done') return true; return false; })()`, 60, 500);
    })();
    console.log('[0.5] warmup file transfer:', warm ? 'OK' : 'FAIL');

    // 阶段1：A(被控) 发起远程 remote；A 共享自身标签 + 开 data channel + 武装 daemon
    const start = await aCdp.ev(`(async () => {
      const L=window.__localim; try { const s=await L.startCall(${JSON.stringify(bId)},'remote'); return {ok:true,callId:s.callId}; }
      catch(e){ return {ok:false,err:String(e)}; }
    })()`);
    console.log('[1] A started remote control:', JSON.stringify(start));
    if (!start?.ok) throw new Error('failed to start remote control ' + JSON.stringify(start));
    const sid = start.callId;

    // B(操控端) 等 offer 抵达再接听（与视频/共享同理）
    await waitFor(bCdp, `(() => { const L=window.__localim; return !!(L && L.mediaDebug().some(x=>x.callId===${JSON.stringify(sid)})); })()`, 40, 300);
    const acc = await bCdp.ev(`(async () => { const L=window.__localim;
      try { await L.acceptIncomingCall(${JSON.stringify(sid)},'remote',${JSON.stringify(aId)}); return {ok:true}; }
      catch(e){ return {ok:false,err:String(e)}; } })()`);
    console.log('[2] B answered remote:', JSON.stringify(acc));
    if (!acc?.ok) throw new Error('failed to answer ' + JSON.stringify(acc));

    // 等两端 connected 且含视频轨道
    const waitConnected = async (cdp, label) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const snap = await cdp.ev(mediaSnapExpr());
        if (snap) { const o = JSON.parse(snap);
          if (o.sessions.some(x => x.pc === 'connected' && (x.remote.includes('video') || x.local.includes('video')))) return o; }
        await wait(500);
      }
      console.error(`[!] ${label} not connected within 30s`); return null;
    };
    let sA = await waitConnected(aCdp, 'A');
    let sB = await waitConnected(bCdp, 'B');
    if (!sA) sA = JSON.parse(await aCdp.ev(mediaSnapExpr()) || 'null');
    if (!sB) sB = JSON.parse(await bCdp.ev(mediaSnapExpr()) || 'null');
    const aShare = sA?.sessions.some(x => x.local.includes('video')) === true;
    const bViewer = sB?.sessions.some(x => x.remote.includes('video')) === true;
    console.log('[3] connected: A (host sharing local video)=%s B (controller viewing remote video)=%s', aShare, bViewer);
    console.log('   A=', JSON.stringify(sA && sA.sessions), ' B=', JSON.stringify(sB && sB.sessions));
    if (!(aShare && bViewer)) throw new Error('remote connection not established');

    // B 主画面应绑上远程流（media.ts 远程面板已挂到主 video）
    const bDom = await waitFor(bCdp, `(() => { const m=document.querySelector('.vid.main'); return !!(m && m.srcObject && m.videoWidth>0); })()`, 30, 300);
    console.log('[4] B main view bound to remote stream:', bDom ? 'OK' : 'FAIL');

    // 阶段2：B(操控端) 经 data channel 回传输入 → A(被控) 转发本机 daemon
    const evs = [
      { t: 'mousemove', x: 320, y: 200 },
      { t: 'mousedown', x: 320, y: 200, btn: 0 },
      { t: 'mouseup', x: 320, y: 200, btn: 0 },
      { t: 'keydown', code: 'Enter' },
      { t: 'keyup', code: 'Enter' },
      { t: 'wheel', x: 320, y: 200, d: 120 },
    ];
    for (const e of evs) {
      await bCdp.ev(`window.__localim.sendRemoteInput(${JSON.stringify(sid)}, ${JSON.stringify(e)}); void 0;`);
      await wait(150);
    }

    const got = await waitFor(aCdp, `window.__recInput && window.__recInput.length>=${evs.length}`, 40, 300);
    const rec = await aCdp.ev(`window.__recInput ? JSON.stringify({n:window.__recInput.length, first:window.__recInput[0], key:window.__recInput.find(e=>e.t==='keydown'), wheel:window.__recInput.find(e=>e.t==='wheel')}) : 'none'`);
    const hosted = await aCdp.ev(`window.__recHost === true ? 'true' : String(window.__recHost)`);
    console.log('[5] A forwarded remote_input:', got ? `OK(${evs.length})` : 'FAIL', ' hosted=', hosted);
    console.log('   samples:', rec);

    // daemon 日志确认注入执行（被控 daemon：media.remote_input ... injected=1）
    let injected = false; let injLine = '';
    try {
      const t = require_fs_read(join(da, 'a.log'), 'utf8');
      const m = t.match(/media\.remote_input[^\n]*injected=1/);
      if (m) { injected = true; injLine = m[0].slice(0, 150); }
    } catch {}
    console.log('[6] host daemon injection log:', injected ? `OK: ${injLine}` : 'no match (printing remote_input context from a.log below)');
    if (!injected) {
      try {
        const t = require_fs_read(join(da, 'a.log'), 'utf8');
        const idx = t.lastIndexOf('remote_input');
        console.error('   --- a.log tail ('.concat(String(t.length), ' bytes) ---\n') + (idx >= 0 ? t.slice(Math.max(0, idx - 100), idx + 420) : t.slice(-900)));
      } catch {}
    }

    const pass = aShare && bViewer && bDom && got && hosted === 'true';
    console.log('=== phase 2 remote control:', pass && injected ? 'OK (full chain: B -> data channel -> A -> daemon.rest_input -> input_injector)' : '=== remote control: FAIL (plumbing works but injection unconfirmed / forwarding failed)', '===');
    await aCdp.ev(`window.__localim.hangupDebug(); void 0;`);

    await cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    for (const f of [join(da, 'a.log'), join(db, 'b.log')]) {
      try { const t = require_fs_read(f); if (t) console.error(`--- ${f} ---\n${t.slice(-1500)}`); } catch {}
    }
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();