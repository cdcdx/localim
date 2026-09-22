// 群共享内嵌远程控制端到端：三 daemon(房主 A + 观众 B/C) + 三无头 Edge。
//   前置: 与群共享 e2e 一致 —— A startRoomShare 向 B/C 广播收屏，B/C accept 后收屏。
//   阶段6: B 请求控制 → A 浮层出现 ctrlReq 待办(from=B)。
//   阶段7: A resolveShareControlRequest(B, true) → B 进入控制模式(ctrl=true)；
//           B 在共享会话上 createDataChannel 并重新 offer(A 端 renegotiation 回 answer)，
//           两端该会话 dc 均 open。
//   阶段8: B 经 data channel 回传一个键盘输入 → A WebUI 转发 native media.remote_input
//           → A daemon 本地注入(日志 remote_input ... injected=1)，证明「观控共享屏」链路通。
//   阶段9: B 主动结束控制 → A 控制者清空且解除注入武装(再回传输入 hosted=0/injected=0 被拒)。
//   阶段10: 二次授权 B(复用已建通道，不追加 renegotiation) → 房主 revokeShareControl → B 退出控制。
//   拒绝路径: C 请求控制 → A 拒绝 → C 不进入控制模式。
//   用法: node drv_group_share_ctrl_e2e.mjs
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

const PRES = 8316;
const NODES = [
  { webui: 8320, peer: 8322, web: 8324 },   // A 房主
  { webui: 8420, peer: 8422, web: 8424 },   // B 观众
  { webui: 8520, peer: 8522, web: 8524 },   // C 观众
];
const CDP = { A: 8321, B: 8421, C: 8521 };

function launchDaemon(n, dataDir, log) {
  const args = ['--user-data-dir=' + dataDir, `--webui-port=${n.webui}`,
    `--peer-port=${n.peer}`, `--presence-port=${PRES}`, `--relay-port=${n.peer + 1}`,
    `--web-port=${n.web}`, '--webui-dist=' + WEBUI,
    '--enable-logging=stderr', '--v=1'];
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
async function open(url, cdp) { await cdp.call('Page.navigate', { url }); await wait(1800); }
async function waitFor(cdp, fn, tries = 60, gap = 400) {
  for (let i = 0; i < tries; i++) { if (await cdp.ev(fn)) return true; await wait(gap); }
  return false;
}

async function main() {
  const [da, db, dc, pa, pb, pc] = await Promise.all(
    [mkdtemp(join(os.tmpdir(), 'gsc_')), mkdtemp(join(os.tmpdir(), 'gsc_')), mkdtemp(join(os.tmpdir(), 'gsc_')),
     mkdtemp(join(os.tmpdir(), 'gsc_')), mkdtemp(join(os.tmpdir(), 'gsc_')), mkdtemp(join(os.tmpdir(), 'gsc_'))]);
  const handles = [];
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1400); await Promise.allSettled([da, db, dc, pa, pb, pc].map((d) => rm(d, { recursive: true, force: true }))); };
  const track = (p) => { handles.push(p); return p; };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });

  try {
    track(launchDaemon(NODES[0], da, join(da, 'a.log')));
    track(launchDaemon(NODES[1], db, join(db, 'b.log')));
    track(launchDaemon(NODES[2], dc, join(dc, 'c.log')));
    track(launchEdge(CDP.A, pa)); track(launchEdge(CDP.B, pb)); track(launchEdge(CDP.C, pc));
    const [a, b, c] = [await connect(await cdpUrl(CDP.A)), await connect(await cdpUrl(CDP.B)), await connect(await cdpUrl(CDP.C))];

    await open(`http://127.0.0.1:${NODES[0].web}/index.html?port=${NODES[0].webui}`, a);
    await open(`http://127.0.0.1:${NODES[1].web}/index.html?port=${NODES[1].webui}`, b);
    await open(`http://127.0.0.1:${NODES[2].web}/index.html?port=${NODES[2].webui}`, c);
    await wait(1200);
    await a.ev(`window.__localim.login('Alice'); void 0;`);
    await b.ev(`window.__localim.login('Bob'); void 0;`);
    await c.ev(`window.__localim.login('Carol'); void 0;`);
    await wait(600);

    for (const [n, cd] of [['A', a], ['B', b], ['C', c]]) {
      const ok = await waitFor(cd, `(() => { const L=window.__localim; if(!L) return false; return [...L.app.state.peers.keys()].filter(Boolean).length>=2; })()`, 60, 400);
      if (!ok) throw new Error(`${n} did not discover both peers`);
    }
    console.log('[0] mutual discovery: A/B/C each >=2');

    const hello = (cd) => cd.ev(`(() => window.__localim.native.request('identity','hello',{}).then(r=>JSON.stringify({id:r.deviceId,name:r.name})).catch(e=>'ERR:'+e))()`)
      .then((s) => JSON.parse(s).id);
    const [aId, bId, cId] = await Promise.all([hello(a), hello(b), hello(c)]);
    console.log('[0.5] daemon identity A=%s B=%s C=%s', (aId||'').slice(0, 8), (bId||'').slice(0, 8), (cId||'').slice(0, 8));

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
    const wB = await warmup(bId, b); const wC = await warmup(cId, c);
    console.log('[0.5] warmup A->B=%s A->C=%s', wB, wC);
    if (!wB || !wC) throw new Error('warmup connections not established');

    const created = JSON.parse(await a.ev(`(() => window.__localim.native.request('room','create',{name:'RD Group'}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`));
    const roomId = created.roomId;
    if (!roomId) throw new Error('failed to create group');
    await a.ev(`(() => window.__localim.native.request('room','invite',{roomId:${JSON.stringify(roomId)},to:${JSON.stringify(bId)}}).then(()=>true))()`);
    await a.ev(`(() => window.__localim.native.request('room','invite',{roomId:${JSON.stringify(roomId)},to:${JSON.stringify(cId)}}).then(()=>true))()`);
    const gotRoom = (cd) => `(() => { const L=window.__localim; const r=L && L.app.state.rooms.get(${JSON.stringify(roomId)}); if(!r) return false; const m=r.members||[];
      return m.includes(${JSON.stringify(aId)}) && m.includes(${JSON.stringify(bId)}) && m.includes(${JSON.stringify(cId)}); })()`;
    for (const [n, cd] of [['B', b], ['C', c]]) if (!(await waitFor(cd, gotRoom(cd), 60, 400))) throw new Error(`${n} did not receive the full group member list`);
    console.log('[1] group created + invited ok roomId=%s', roomId);

    const started = JSON.parse(await a.ev(`(() => window.__localim.startRoomShare(${JSON.stringify(roomId)}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`));
    await wait(2500);
    console.log('[2] A startRoomShare: count=%j', started);

    async function accept(cd) {
      const callId = await waitFor(cd, `(() => { const m=window.__localim.app.state.media; return (m && m.direction==='incoming' && m.peer.mode==='share') ? m.callId : false; })()`, 60, 400)
        ? await cd.ev(`window.__localim.app.state.media.callId`) : null;
      if (!callId) return null;
      await cd.ev(`(() => { const L=window.__localim; return L.acceptIncomingCall(${JSON.stringify(callId)},'share', L.app.state.profile?.deviceId); })()`);
      return callId;
    }
    const bCall = await accept(b); const cCall = await accept(c);
    console.log('[3] B answered=%s C answered=%s', bCall, cCall);

    async function viewerConnected(cd) {
      return waitFor(cd, `(() => { const dbg=window.__localim.mediaDebug(); return dbg.length>0 && dbg.every(d=>d.pcState==='connected' && d.ice==='connected') && dbg.some(d=>d.remoteTracks.includes('video')); })()`, 60, 500);
    }
    const [bOk, cOk] = [await viewerConnected(b), await viewerConnected(c)];
    const bW = await waitFor(b, `(() => { const v=document.querySelector('.vid.main'); return v && v.videoWidth>0; })()`, 60, 400);
    const cW = await waitFor(c, `(() => { const v=document.querySelector('.vid.main'); return v && v.videoWidth>0; })()`, 60, 400);
    console.log('[4] B receiving screen=%s wx%d   C receiving screen=%s wx%d', bOk, bW, cOk, cW);
    if (!(bOk && bW && cOk && cW)) throw new Error('viewer did not receive the shared screen');

    // ===== 群共享远程控制 =====
    // 阶段6: B 请求控制 → A 浮层出 ctrlReq 待办
    await b.ev(`(() => { const L=window.__localim; return L.requestShareControl(${JSON.stringify(bCall)}); })()`);
    const reqSeen = await waitFor(a, `(() => { const m=window.__localim.app.state.media; return !!(m && m.roomShare && m.ctrlReq && m.ctrlReq.from===${JSON.stringify(bId)}); })()`, 60, 400);
    console.log('[6] B requested control: sent=true  A got ctrlReq=%s', reqSeen);
    if (!reqSeen) throw new Error('host did not receive the control request');

    // 拒绝路径：C 请求 → A 拒绝 → C 不进入控制
    await c.ev(`(() => { const m=window.__localim.app.state.media; return m ? window.__localim.requestShareControl(m.callId) : false; })()`);
    const cReqSeen = await waitFor(a, `(() => { const m=window.__localim.app.state.media; return !!(m && m.roomShare && m.ctrlReq && m.ctrlReq.from===${JSON.stringify(cId)}); })()`, 40, 400);
    await a.ev(`(() => { const L=window.__localim; return L.resolveShareControlRequest(${JSON.stringify(cId)}, false); })()`);
    await wait(300);
    const cCtrl = await c.ev(`(!!(window.__localim.app.state.media && window.__localim.app.state.media.ctrl))`);
    await waitFor(a, `(() => { const m=window.__localim.app.state.media; return !m || m.ctrlReq?.from!==${JSON.stringify(cId)}; })()`, 20, 300);
    console.log('[6b] C requested -> A denied: C entered control mode=%s (should be false)', cCtrl);
    if (cCtrl) throw new Error('C should not enter control mode after being denied');

    // 阶段7: A 授权 B → B 进入控制 + renegotiation 建 data channel（两端 dc open）
    await a.ev(`(() => { const L=window.__localim; return L.resolveShareControlRequest(${JSON.stringify(bId)}, true); })()`);
    const bCtrl = await waitFor(b, `(() => (!!(window.__localim.app.state.media && window.__localim.app.state.media.ctrl)))()`, 60, 400);
    const [bDc, aDc] = [await waitFor(b, `(() => window.__localim.mediaDebug().some(d => d.pcState==='connected' && d.dc==='open'))()`, 40, 400),
      await waitFor(a, `(() => window.__localim.mediaDebug().some(s => s.mode==='share' && s.peerId===${JSON.stringify(bId)} && s.dc==='open'))()`, 40, 400)];
    console.log('[7] A granted B: B in control=%s  B dc open=%s  A (B session) dc open=%s', bCtrl, bDc, aDc);
    if (!(bCtrl && bDc && aDc)) {
      console.error('[dbg7] B offers=', await b.ev(`JSON.stringify(window.__localim.native.evlog.filter(e=>e.ns==='media').map(e=>e.m))`));
      console.error('[dbg7] A offers=', await a.ev(`JSON.stringify(window.__localim.native.evlog.filter(e=>e.ns==='media').map(e=>e.m))`));
      console.error('[dbg7] B shareSessions=', await b.ev(`JSON.stringify(window.__localim.mediaDebug().filter(s=>s.mode==='share'))`));
      console.error('[dbg7] A shareSessions=', await a.ev(`JSON.stringify(window.__localim.mediaDebug().filter(s=>s.mode==='share'))`));
      throw new Error('control channel not established (renegotiation failed)');
    }

    // 阶段8: B 回传键盘输入 → A daemon 远程注入(injected=1)
    await b.ev(`(() => { const L=window.__localim; return L.sendRemoteInput(${JSON.stringify(bCall)}, {t:'keydown', code:'KeyA'}); })()`);
    let injected = false;
    for (let i = 0; i < 80; i++) {
      await wait(300);
      try {
        const t = readFileSync(join(da, 'a.log'), 'utf8');
        if (/media\.remote_input[\s\S]*?injected=1/.test(t)) { injected = true; break; }
        if (t.includes('remote_input')) break; // 已看到 remote_input 但 injected 尚未=1
      } catch {}
    }
    console.log('[8] B sent input -> A daemon injected=%s', injected);

    const aLog = () => { try { return readFileSync(join(da, 'a.log'), 'utf8'); } catch { return ''; } };
    const offerCount = () => (aLog().match(/inbound media signal .* m=offer/g) || []).length;

    // 阶段9: B 主动结束控制 → A 摘除控制者并解除注入武装；此后 B 再回传输入被拒(hosted=0)。
    const offersBeforeRelease = offerCount();
    await b.ev(`(() => { window.__localim.disableShareControl(${JSON.stringify(bCall)}); return true; })()`);
    const cleared = await waitFor(a, `(() => window.__localim.roomShareControllers(${JSON.stringify(roomId)}).length===0)()`, 40, 300);
    const mark = aLog().length;
    await b.ev(`(() => window.__localim.sendRemoteInput(${JSON.stringify(bCall)}, {t:'keydown', code:'KeyB'}))()`);
    let refused = false;
    for (let i = 0; i < 30; i++) {
      await wait(300);
      const tail = aLog().slice(mark);
      if (/hosted=0 injected=0/.test(tail)) { refused = true; break; }
      if (/hosted=1 injected=1/.test(tail)) break; // 未解除武装，反例
    }
    console.log('[9] B ended control: A controller cleared=%s  further input rejected (hosted=0)=%s', cleared, refused);
    if (!(cleared && refused)) throw new Error('A did not disarm injection after control ended');

    // 阶段10: 二次授权 B（复用已建 data channel，不再产生新的 renegotiation）→ 房主撤销 → B 退出控制。
    await b.ev(`(() => window.__localim.requestShareControl(${JSON.stringify(bCall)}))()`);
    await waitFor(a, `(() => { const m=window.__localim.app.state.media; return !!(m && m.roomShare && m.ctrlReq && m.ctrlReq.from===${JSON.stringify(bId)}); })()`, 40, 400);
    await a.ev(`(() => window.__localim.resolveShareControlRequest(${JSON.stringify(bId)}, true))()`);
    const bCtrl2 = await waitFor(b, `(() => !!(window.__localim.app.state.media && window.__localim.app.state.media.ctrl))()`, 40, 300);
    const offersAfterRegrant = offerCount();
    const aCtrlList = await a.ev(`JSON.stringify(window.__localim.roomShareControllers(${JSON.stringify(roomId)}))`);
    await a.ev(`(() => window.__localim.revokeShareControl(${JSON.stringify(roomId)}, ${JSON.stringify(bId)}))()`);
    const bRevoked = await waitFor(b, `(() => !(window.__localim.app.state.media && window.__localim.app.state.media.ctrl))()`, 40, 300);
    const aCtrlEmpty = await waitFor(a, `(() => window.__localim.roomShareControllers(${JSON.stringify(roomId)}).length===0)()`, 40, 300);
    const reused = offersBeforeRelease === offersAfterRegrant && offersAfterRegrant > 0;
    console.log('[10] re-granted B: ctrl=%s channel reused (offer %d->%d)=%s A controllers=%s  revoked->B exited=%s A cleared=%s',
      bCtrl2, offersBeforeRelease, offersAfterRegrant, reused, aCtrlList, bRevoked, aCtrlEmpty);
    if (!(bCtrl2 && reused && bRevoked && aCtrlEmpty)) throw new Error('re-grant/revoke control chain is broken');

    const pass = reqSeen && bCtrl && bDc && aDc && injected && !cCtrl && cleared && refused && bCtrl2 && reused && bRevoked && aCtrlEmpty;
    console.log('=== remote control inside group sharing: ' + (pass ? 'PASS (viewer can operate the shared screen once the host grants control; input goes back over the data channel and gets injected on the host; exiting/revoking disarms injection)' : 'FAIL') + ' ===');
    await cleanup();
    process.exit(pass ? 0 : 3);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    for (const [lg, tag] of [[join(da, 'a.log'), 'A'], [join(db, 'b.log'), 'B'], [join(dc, 'c.log'), 'C']]) {
      try {
        const t = readFileSync(lg, 'utf8');
        const rel = t.split('\n').filter((l) => /media|SendPeer|dial|unknown peer|inbound/.test(l)).slice(-20);
        if (rel.length) console.error(`--- ${tag}.log (media/peer) ---\n${rel.join('\n')}`);
      } catch {}
    }
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();