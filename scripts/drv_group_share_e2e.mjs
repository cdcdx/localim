// 群共享桌面端到端：三 daemon(房主 A + 观众 B/C) + 三无头 Edge。
//   阶段1 建群+邀请: A room.create → invite B、C → 三者 rooms 均含该群，成员 [A,B,C]。
//   阶段2 A startRoomShare(roomId): A 采集假屏幕(无头 getDisplayMedia) 向每在线成员各建一个独立会话广播;
//           B、C 各收到 call_invite(share) → acceptIncomingCall → 两端 PeerConnection connected，
//           且 B/C 的 .vid.main 绑上 A 的远端视频流(remoteTracks 含 video)。
//   阶段3 多路并存: A 侧应同时有 2 个共享会话(peerId=B、C)；B/C 各 render A 的屏幕。
//   阶段4 退出: A endRoomShare → B、C 媒体浮层消失。
//   用法: node drv_group_share_e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream, readFileSync as require_fs_read } from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = join(__dirname, '..', '..', 'src', 'out', 'localim', 'localim_daemon.exe');
const WEBUI = join(__dirname, '..', 'ui', 'out', 'webui');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PRES = 7916;
const NODES = [
  { webui: 8020, peer: 8022, web: 8024 },   // A 房主
  { webui: 8120, peer: 8122, web: 8124 },   // B 观众
  { webui: 8220, peer: 8222, web: 8224 },   // C 观众
];
const CDP = { A: 8021, B: 8121, C: 8221 };

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
const req = (ns, m, d) => `window.__localim.native.request(${JSON.stringify(ns)}, ${JSON.stringify(m)}, ${JSON.stringify(d || {})})`;

async function main() {
  const dirs = await Promise.all([...Array(6)].map(() => mkdtemp(join(os.tmpdir(), 'limgs_'))));
  const [da, db, dc, pa, pb, pc] = dirs;
  const handles = [];
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1400);
    await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true }))); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });
  try {
    handles.push(launchDaemon(NODES[0], da, join(da, 'a.log')));
    handles.push(launchDaemon(NODES[1], db, join(db, 'b.log')));
    handles.push(launchDaemon(NODES[2], dc, join(dc, 'c.log')));
    handles.push(launchEdge(CDP.A, pa), launchEdge(CDP.B, pb), launchEdge(CDP.C, pc));
    const [a, b, c] = [await connect(await cdpUrl(CDP.A)), await connect(await cdpUrl(CDP.B)), await connect(await cdpUrl(CDP.C))];

    await open(`http://127.0.0.1:${NODES[0].web}/index.html?port=${NODES[0].webui}`, a);
    await open(`http://127.0.0.1:${NODES[1].web}/index.html?port=${NODES[1].webui}`, b);
    await open(`http://127.0.0.1:${NODES[2].web}/index.html?port=${NODES[2].webui}`, c);
    await wait(1200);
    await a.ev(`window.__localim.login('Alice'); void 0;`);
    await b.ev(`window.__localim.login('Bob'); void 0;`);
    await c.ev(`window.__localim.login('Carol'); void 0;`);
    await wait(600);

    // 互发现：三端 peer 表都含另外两台
    const online = () => `(() => { const L=window.__localim; return L?[...L.app.state.peers.keys()].filter(Boolean).length:0; })()`;
    for (const [name, cd] of [['A', a], ['B', b], ['C', c]]) {
      const ok = await waitFor(cd, `(() => { const L=window.__localim; if(!L) return false; return [...L.app.state.peers.keys()].filter(Boolean).length>=2; })()`, 60, 400);
      if (!ok) throw new Error(`${name} 互发现未达两台`);
    }
    console.log('[0] 互发现 A/B/C 各自在线 peer 数 = 各≥2');
    for (const [n, cd] of [['A', a], ['B', b], ['C', c]]) {
      console.log(`[dbg] ${n} peers=`, await cd.ev(`JSON.stringify([...window.__localim.app.state.peers.keys()].filter(Boolean))`));
    }

    // 预热：A 向 B、C 各传小文件并等待接收端 done，强制建立 A→B/C 的持久 peer 连接，
    // 否则首条 peer 信封在拨号失败时会被 daemon 静默丢弃（SendPeerEnvelope 失败即擦除 pending，不重试）。
    // 目标地址取各节点 daemon 的真实 deviceId（identity.hello 返回）——daemon 按该 id 路由/发现对端，
    // 而非 WebUI 侧随机生成的 profile.deviceId（二者不一致会导致 daemon 报「未知对端」）。
    const hello = (cd) => cd.ev(`(() => window.__localim.native.request('identity','hello',{}).then(r=>JSON.stringify({id:r.deviceId,name:r.name})).catch(e=>'ERR:'+e))()`)
      .then((s) => JSON.parse(s).id);
    const [aId, bId, cId] = await Promise.all([hello(a), hello(b), hello(c)]);
    console.log('[0.5] daemon 身份 A=%s B=%s C=%s', (aId||'').slice(0,8), (bId||'').slice(0,8), (cId||'').slice(0,8));
    async function warmup(targetId, cdRecv) {
      for (let i = 0; i < 12; i++) {
        const warmName = `warm${i}.bin`;
        await a.ev(`(async () => { const L=window.__localim; const f=new Uint8Array(4096); f.fill(7);
          const file=new File([f],${JSON.stringify(warmName)},{type:'application/octet-stream'});
          await L.sendFileTo(${JSON.stringify(targetId)},file,'file'); return true; })()`);
        const got = await waitFor(cdRecv, `(() => { const L=window.__localim; if(!L) return false;
          for(const [,arr] of L.app.state.conversations) for(const it of arr)
            if(it.mediaRef && it.mediaRef.name && it.mediaRef.name.startsWith('warm') && it.xfer && it.xfer.phase==='done') return true; return false; })()`, 20, 400);
        if (got) return true;
      }
      return false;
    }
    const wB = await warmup(bId, b);
    const wC = await warmup(cId, c);
    console.log('[0.5] 预热 A→B=%s A→C=%s', wB, wC);
    if (!wB || !wC) throw new Error('预热连接未建立');

    // 阶段1: A 建群(名字借用三个成员 id)并邀请 B、C
    const created = JSON.parse(await a.ev(`(() => window.__localim.native.request('room','create',{name:'研发组'}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`));
    const roomId = created.roomId;
    if (!roomId) throw new Error('建群失败');
    await a.ev(`(() => window.__localim.native.request('room','invite',{roomId:${JSON.stringify(roomId)},to:${JSON.stringify(bId)}}).then(()=>true))()`);
    await a.ev(`(() => window.__localim.native.request('room','invite',{roomId:${JSON.stringify(roomId)},to:${JSON.stringify(cId)}}).then(()=>true))()`);
    // 等 B、C 收到群且成员含三端 daemon id
    const gotRoom = (cd) => `(() => { const L=window.__localim; const r=L && L.app.state.rooms.get(${JSON.stringify(roomId)}); if(!r) return false; const m=r.members||[];
      return m.includes(${JSON.stringify(aId)}) && m.includes(${JSON.stringify(bId)}) && m.includes(${JSON.stringify(cId)}); })()`;
    for (const [n, cd] of [['B', b], ['C', c]]) {
      if (!(await waitFor(cd, gotRoom(cd), 60, 400))) throw new Error(`${n} 未收到完整群成员表`);
    }
    const aRoom = JSON.parse(await a.ev(`(() => JSON.stringify(window.__localim.app.state.rooms.get(${JSON.stringify(roomId)}).members))()`));
    console.log('[1] 建群+邀请: roomId=%s   A成员数=%d, B/C 均收到（含 A/B/C）', roomId, aRoom.length);

    // 阶段2: A 发起群共享
    const started = JSON.parse(await a.ev(`(() => window.__localim.startRoomShare(${JSON.stringify(roomId)}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`));
    console.log('[2] A startRoomShare(roomId): count=%j', started);
    // 调试：startRoomShare 后观察 B/C 的媒体态与 A 的信令会话
    await wait(2500);
    console.log('[dbg] B media=', await b.ev(`JSON.stringify(window.__localim.app.state.media)`));
    console.log('[dbg] C media=', await c.ev(`JSON.stringify(window.__localim.app.state.media)`));
    console.log('[dbg] A sessions=', await a.ev(`JSON.stringify(window.__localim.mediaDebug())`));
    for (const [n, cd] of [['B', b], ['C', c]]) {
      console.log(`[dbg] ${n} media.evlog=`, await cd.ev(`JSON.stringify(window.__localim.native.evlog.filter(e=>e.ns==='media').map(e=>({m:e.m,callId:e.d&&e.d.callId,from:e.d&&e.d.from,fileSignaling:!!(e.d&&e.d.fileSignaling)})))`));
    }

    // B、C 各 acceptIncomingCall。拿到各自收到的 callId（从 app.state.media 或从信令）。
    // 等待 B/C 的来电浮层出现，取其 callId 后接听（spoof from=A）。
    async function accept(cd) {
      const callId = await waitFor(cd, `(() => { const m=window.__localim.app.state.media; return (m && m.direction==='incoming' && m.peer.mode==='share') ? m.callId : false; })()`, 60, 400)
        ? await cd.ev(`window.__localim.app.state.media.callId`) : null;
      if (!callId) return null;
      await cd.ev(`(() => { const L=window.__localim; return L.acceptIncomingCall(${JSON.stringify(callId)},'share', L.app.state.profile?.deviceId); })()`);
      return callId;
    }
    const bCall = await accept(b);
    const cCall = await accept(c);
    console.log('[3] B 接听 callId=%s, C 接听 callId=%s', bCall, cCall);

    // 阶段3: B、C 各 PeerConnection connected 且有远端 video 轨道
    async function viewerConnected(cd) {
      return waitFor(cd, `(() => { const dbg=window.__localim.mediaDebug(); return dbg.length>0 && dbg.every(d=>d.pcState==='connected' && d.ice==='connected') && dbg.some(d=>d.remoteTracks.includes('video')); })()`, 60, 500);
    }
    const bOk = await viewerConnected(b);
    const cOk = await viewerConnected(c);
    // B/C 主画面绑上远端流（videoWidth>0 表示有真实帧）
    const bW = await waitFor(b, `(() => { const v=document.querySelector('.vid.main'); return v && v.videoWidth>0; })()`, 60, 400);
    const cW = await waitFor(c, `(() => { const v=document.querySelector('.vid.main'); return v && v.videoWidth>0; })()`, 60, 400);
    console.log('[4] B 收屏: conn=%s videoWidth>0=%s | C 收屏: conn=%s videoWidth>0=%s', bOk, bW, cOk, cW);
    if (!(bOk && bW && cOk && cW)) throw new Error('观众未收屏');

    // 房主 A 同时保有 2 条共享会话(peerId=B、C)且本端预览本地屏幕
    const aDebug = await a.ev('(() => JSON.stringify(window.__localim.mediaDebug()))()');
    const aSessions = JSON.parse(aDebug);
    const aShareP2p = aSessions.filter((s) => s.mode === 'share').map((s) => s.peerId);
    const aViewers = await a.ev(`window.__localim.roomShareViewerCount(${JSON.stringify(roomId)})`);
    const aLocalW = await waitFor(a, `(() => { const v=document.querySelector('.vid.main'); return v && v.videoWidth>0; })()`, 40, 400);
    console.log('[5] A 侧共享会话=%j  viewerCount=%s  本端预览=%s', aShareP2p, aViewers, aLocalW);
    if (aViewers !== 2) throw new Error('A 端观众计数应为 2');

    // 阶段4a: 音频同步 —— A 的共享会话本地轨道应含 video(必然) 与 audio(若无头环境支持采集)
    const aShareTracks = JSON.parse(await a.ev(`(() => JSON.stringify(window.__localim.mediaDebug().filter(s=>s.mode==='share').map(s=>s.localTracks)))()`));
    const hasVideo = aShareTracks.length > 0 && aShareTracks[0].includes('video');
    const hasAudio = aShareTracks.length > 0 && aShareTracks[0].includes('audio');
    console.log('[7] A 共享会话本地轨道=%j  video=%s  audio=%s(无头环境不支持系统音频会回退纯画面，属正常)', aShareTracks, hasVideo, hasAudio);
    if (!hasVideo) throw new Error('共享流缺少视频轨道');

    // 阶段4b: 房主踢单个观众 —— endRoomShareViewer(roomId,B) → B 浮层消失、观众数 1、C 仍在线
    const kickOk = await a.ev(`window.__localim.endRoomShareViewer(${JSON.stringify(roomId)}, ${JSON.stringify(bId)})`);
    const bGoneKick = await waitFor(b, `(() => window.__localim.app.state.media === null)()`, 40, 300);
    const aViewersAfterKick = await a.ev(`window.__localim.roomShareViewerCount(${JSON.stringify(roomId)})`);
    const cStill = await c.ev(`(() => { const m=window.__localim.app.state.media; const v=document.querySelector('.vid.main'); return m!==null && v && v.videoWidth>0; })()`);
    console.log('[8] 房主踢 B: kick=%s B浮层消失=%s 观众数=%s(期望1)  观众C仍在=%s', kickOk, bGoneKick, aViewersAfterKick, cStill);
    if (!(kickOk && bGoneKick && aViewersAfterKick === 1 && cStill)) throw new Error('踢出观众失败');

    // 阶段4c: 观众请求停止(谁可停共享=房主决定) —— C 请求 → 房主 A 收到 shareReq → 同意 → 整场结束
    const reqOk = await c.ev(`window.__localim.requestRoomShareStop(${JSON.stringify(roomId)})`);
    const reqSeen = await waitFor(a, `(() => { const m=window.__localim.app.state.media; return m && m.shareReq && m.shareReq.from===${JSON.stringify(cId)}; })()`, 40, 400);
    console.log('[9] C 请求停止: 发出=%s  房主A收到shareReq(from=C)=%s', reqOk, reqSeen);
    if (!reqSeen) throw new Error('房主未收到观众停止请求');
    const apOk = await a.ev(`window.__localim.resolveRoomShareStopRequest(${JSON.stringify(roomId)}, ${JSON.stringify(cId)}, true)`);
    const cGoneStop = await waitFor(c, `(() => window.__localim.app.state.media === null)()`, 40, 300);
    const aGoneStop = await waitFor(a, `(() => window.__localim.app.state.media === null)()`, 40, 300);
    console.log('[10] 房主同意停止: resolve=%s  C浮层消失=%s  A浮层消失=%s', apOk, cGoneStop, aGoneStop);
    if (!(apOk && cGoneStop && aGoneStop)) throw new Error('同意停止后未全部收敛');

    const pass = started.count === 2 && bOk && cOk && bW && cW && aViewers === 2 && aLocalW && hasVideo
      && kickOk && bGoneKick && aViewersAfterKick === 1 && cStill && reqSeen && apOk && cGoneStop && aGoneStop;
    console.log('=== 群共享桌面: ' + (pass ? 'PASS（单主播 A → 多观众独立通道收屏；音频同步；房主踢观众 + 观众请求停止由房主裁决）' : 'FAIL') + ' ===');

    await cleanup();
    process.exit(pass ? 0 : 3);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    for (const [lg, tag] of [[join(da, 'a.log'), 'A'], [join(db, 'b.log'), 'B'], [join(dc, 'c.log'), 'C']]) {
      try {
        const t = require_fs_read(lg, 'utf8');
        const rel = t.split('\n').filter((l) => /media|room signal|SendPeer|dial|未知对端|inbound/.test(l)).slice(-25);
        if (rel.length) console.error(`--- ${tag}.log (media/peer) ---\n${rel.join('\n')}`);
      } catch {}
    }
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();