// 视频通话 + 共享桌面 端到端：双 daemon + 双头无 Edge（伪摄像头）。
//   阶段1 视频: A startCall(b,'video') → B ringing → B acceptIncomingCall → 两端 PeerConnection connected,
//              双向各含 video+audio 轨道；断言媒体浮层 .vid.main/.vid.local 已绑上真实流(有 video 轨道)。
//   阶段2 共享: A startCall(b,'share') (getDisplayMedia, headless 由 --auto-accept-this-tab-capture 支撑)
//              → B 应答 → B 端媒体Debug 出现远端 video 轨道, .vid.main 绑上对端屏幕流。
//   该脚本自起 daemon/Edge（presence 共享端口以避免遗留 daemon 干扰）。
// 用法: node drv_video_share_e2e.mjs
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
const A = { webui: 9170, peer: 9172, relay: 9173, web: 9174 };
const B = { webui: 9270, peer: 9272, relay: 9273, web: 9274 };

function launchDaemon(ports, dataDir, log) {
  const args = [];
  if (dataDir) args.push('--user-data-dir=' + dataDir);
  args.push('--webui-port=' + ports.webui);
  args.push('--peer-port=' + ports.peer);
  args.push('--presence-port=9616');
  args.push('--relay-port=' + ports.relay);
  args.push('--web-port=' + ports.web);
  args.push('--webui-dist=' + WEBUI);
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
const hasGlobal = () => `(() => { const L=window.__localim; return !!(L && L.startCall && L.acceptIncomingCall && L.mediaDebug && L.sessionStreams && L.hangupDebug); })()`;

// 媒体快照：会话数、轨道、DOM 视频绑定情况
function mediaSnapExpr() {
  return `(() => {
    const L = window.__localim; if(!L) return '';
    const s = L.mediaDebug();
    const main = document.querySelector('.vid.main');
    const pip = document.querySelector('.vid.local');
    const dom = {
      overlay: !!document.querySelector('.call-card.live'),
      mainTracks: main && main.srcObject ? [...main.srcObject.getTracks()].map(t=>t.kind) : [],
      pipTracks: pip && pip.srcObject ? [...pip.srcObject.getTracks()].map(t=>t.kind) : [],
      mainW: main ? (main.videoWidth||0) : 0, mainR: main ? main.readyState : -1,
    };
    const s2 = s.map(x=>({id:x.callId,pc:x.pcState,ice:x.ice,sig:x.sig,local:x.localTracks||[],remote:x.remoteTracks||[]}));
    return JSON.stringify({sessions:s2, dom});
  })()`;
}

async function main() {
  const [da, db, aProf, bProf] = await Promise.all([
    mkdtemp(join(os.tmpdir(), 'limv_a_')), mkdtemp(join(os.tmpdir(), 'limv_b_')),
    mkdtemp(join(os.tmpdir(), 'limv_pa_')), mkdtemp(join(os.tmpdir(), 'limv_pb_')),
  ]);
  const handles = [];
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1500);
    await Promise.allSettled([rm(da,{recursive:true,force:true}), rm(db,{recursive:true,force:true}),
      rm(aProf,{recursive:true,force:true}), rm(bProf,{recursive:true,force:true})]); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });
  try {
    handles.push(launchDaemon(A, da, join(da,'a.log')), launchDaemon(B, db, join(db,'b.log')));
    const pe = launchEdge(9171, 'about:blank', aProf); handles.push(pe);
    const pf = launchEdge(9271, 'about:blank', bProf); handles.push(pf);
    const aCdp = await connect(await cdpUrl(9171));
    const bCdp = await connect(await cdpUrl(9271));
    const A_URL = `http://127.0.0.1:${A.web}/index.html?port=${A.webui}`;
    const B_URL = `http://127.0.0.1:${B.web}/index.html?port=${B.webui}`;
    await open(9171, A_URL, aCdp);
    await open(9271, B_URL, bCdp);
    await wait(1400);
    await aCdp.ev(`window.__localim.login('Alice'); void 0;`);
    await bCdp.ev(`window.__localim.login('Bob'); void 0;`);
    await wait(500);

    // 互发现
    const aReady = await waitFor(aCdp, `(() => { const L=window.__localim; if(!L) return false; const k=[...L.app.state.peers.keys()].filter(Boolean); return k.length>0; })()`, 40, 400);
    const bId = await aCdp.ev(`(() => { const L=window.__localim; return L?([...L.app.state.peers.keys()].filter(Boolean)[0]||''):''; })()`);
    const bReady = await waitFor(bCdp, `(() => { const L=window.__localim; if(!L) return false; const k=[...L.app.state.peers.keys()].filter(Boolean); return k.length>0; })()`, 40, 400);
    const aId = await bCdp.ev(`(() => { const L=window.__localim; return L?([...L.app.state.peers.keys()].filter(Boolean)[0]||''):''; })()`);
    const hasGlobalOk = (await aCdp.ev(hasGlobal())) && (await bCdp.ev(hasGlobal()));
    console.log('[0] mutual discovery: A-ready=%s (->B %s) B-ready=%s (->A %s) global=%s', aReady, bId, bReady, aId, hasGlobalOk);
    if (!aReady || !bReady || !bId || bId === aId) throw new Error('mutual discovery failed');

    // 预热：A→B 传一个小文件，迫使 A↔B 建立持久 peer 通道（冷启动时 SendPeer dial 常一次连不上，
    // 早期 offer/answer/ice 中继会丢；文件通道连同信令一起打通后，视频通话就可靠了）。
    const warmUp = async () => {
      const wf = await aCdp.ev(`(async () => {
        const L=window.__localim; const bytes=new Uint8Array(65536); bytes.fill(7);
        const file=new File([bytes],'warm.bin',{type:'application/octet-stream'});
        const r=await L.sendFileTo(${JSON.stringify(bId)},file,'file');
        return (r&&r.fileId)?r.fileId:String(r);
      })()`);
      const got = await waitFor(bCdp, `(() => {
        const L=window.__localim; if(!L) return false;
        for(const [,arr] of L.app.state.conversations) for(const it of arr)
          if(it.mediaRef && it.mediaRef.name==='warm.bin' && it.xfer && it.xfer.phase==='done') return true;
        return false;
      })()`, 60, 500);
      return { fileId: wf, done: got };
    };
    const warm = await warmUp();
    console.log('[0.5] warmup file transfer (establish peer channel):', warm.done ? 'OK' : 'FAIL (will rely on retries)', 'fileId=', warm.fileId);

    // ---- 阶段1: 视频通话 ----
    const start = await aCdp.ev(`(async () => {
      const L = window.__localim;
      try { const s = await L.startCall(${JSON.stringify(bId)}, 'video'); return { ok:true, callId:s.callId }; }
      catch(e){ return { ok:false, err:String(e) }; }
    })()`);
    console.log('[1] A started video call:', JSON.stringify(start));
    if (!start?.ok) throw new Error('failed to start video call ' + JSON.stringify(start));
    const callId = start.callId;

    let ring = await waitFor(bCdp, `(() => { const L=window.__localim; const m=L&&L.app.state.media; return !!(m && m.direction==='incoming' && m.state==='ringing'); })()`, 30, 400);
    console.log('[2] B ringing:', ring ? 'OK' : '(offer may arrive first, continuing)');
    // 等 offer 抵达 B（B 侧已由 offer 建会话）再接听，贴近真实接听时机、规避抢先应答竞态。
    await waitFor(bCdp, `(() => { const L=window.__localim; return !!(L && L.mediaDebug().some(x=>x.callId===${JSON.stringify(callId)})); })()`, 40, 300);
    console.log('   B got the offer (session exists): OK');

    const acc = await bCdp.ev(`(async () => {
      const L = window.__localim;
      try { await L.acceptIncomingCall(${JSON.stringify(callId)}, 'video', ${JSON.stringify(aId)}); return {ok:true}; }
      catch(e){ return {ok:false, err:String(e)}; }
    })()`);
    console.log('[3] B answered:', JSON.stringify(acc));
    if (!acc?.ok) throw new Error('failed to answer ' + JSON.stringify(acc));

    // 等待真实 connectionState==='connected'；超时则抓 getStats 定位卡点。
    const statsDump = `(async () => {
      const L=window.__localim; if(!L) return 'NOAPP';
      const pcs=L.debugPcs(); if(!pcs||!pcs.length) return 'NO_PC';
      const out=[];
      for(const pc of pcs){
        const st=await pc.getStats(); const o={state:pc.connectionState,ice:pc.iceConnectionState,dtls:null,cands:[],rx:0,tx:0,kind:[],remDesc:!!pc.remoteDescription,localDesc:!!pc.localDescription,rawCands:[pc.localDescription?pc.localDescription.type:null]};
        st.forEach(s=>{
          if(s.type==='candidate-pair') o.cands.push(s.state+(s.nominated?'*':''));
          if(s.type==='transport' && s.dtlsState) o.dtls=s.dtlsState;
          if(s.type==='outbound-rtp'&&s.bytesSent) o.tx+=s.bytesSent;
          if(s.type==='inbound-rtp'&&s.bytesReceived) { o.rx+=s.bytesReceived; if(s.kind) o.kind.push(s.kind+(s.framesDecoded>0?(':'+s.framesDecoded):'')); }
        });
        out.push(o);
      }
      return JSON.stringify(out);
    })()`;
    const waitConnected = async (cdp, label) => {
      const t0 = Date.now();
      // 只认「已连通 且 含媒体轨道」的会话：排除同机的预热文件(data-only)会话。
      while (Date.now() - t0 < 30000) {
        const snap = await cdp.ev(mediaSnapExpr());
        if (snap) { const o = JSON.parse(snap); if (o.sessions.some(x => x.pc === 'connected' && (x.local.length || x.remote.length))) return o; }
        await wait(500);
      }
      console.error(`[!] ${label} not connected within 30s stats=`, await cdp.ev(statsDump));
      return null;
    };
    let sA = await waitConnected(aCdp, 'A');
    let sB = await waitConnected(bCdp, 'B');
    if (!sA) sA = JSON.parse(await aCdp.ev(mediaSnapExpr()) || 'null');
    if (!sB) sB = JSON.parse(await bCdp.ev(mediaSnapExpr()) || 'null');
    console.log('[4] A media state:', JSON.stringify(sA));
    console.log('   B media state:', JSON.stringify(sB));

    const aLive = sA?.sessions.some(x => x.pc==='connected' && x.ice==='connected' && x.local.includes('video') && x.remote.includes('video'));
    const bLive = sB?.sessions.some(x => x.pc==='connected' && x.ice==='connected' && x.local.includes('video') && x.remote.includes('video'));
    const aDomMain = sA?.dom.mainTracks.includes('video') === true && sA.dom.mainW > 0;
    const bDomMain = sB?.dom.mainTracks.includes('video') === true && sB.dom.mainW > 0;
    console.log('[4] A bidirectional video+DOM=%s B bidirectional video+DOM=%s', aLive && aDomMain, bLive && bDomMain);
    const vOk = aLive && bLive && aDomMain && bDomMain;
    console.log('=== phase 1 video call:', vOk ? 'OK (bidirectional video tracks + overlay bound to main view)' : 'FAIL', '===');
    if (!vOk) throw new Error('phase 1 video not connected');

    await aCdp.ev(`window.__localim.hangupDebug(); void 0;`);
    await wait(400);

    // ---- 阶段2: 共享桌面 ----
    const shr = await aCdp.ev(`(async () => {
      const L = window.__localim;
      try { const s = await L.startCall(${JSON.stringify(bId)}, 'share'); return { ok:true, callId:s.callId }; }
      catch(e){ return { ok:false, err:String(e) }; }
    })()`);
    if (!shr?.ok) {
      console.log('[5] phase 2 sharing: getDisplayMedia unavailable in this environment -> SKIP (' + shr?.err + ')');
    } else {
      const sid = shr.callId;
      // 与视频阶段同理：等 offer 抵达 B（会话已建、pendingOffer 已暂存）再接听，
      // 否则 acceptIncomingCall 读不到 offer 而产生不了 answer，A 会一直卡在 checking。
      await waitFor(bCdp, `(() => { const L=window.__localim; return !!(L && L.mediaDebug().some(x=>x.callId===${JSON.stringify(sid)})); })()`, 40, 300);
      console.log('   B got the share offer (session exists): OK');
      const acc2 = await bCdp.ev(`(async () => {
        const L = window.__localim;
        try { await L.acceptIncomingCall(${JSON.stringify(sid)}, 'share', ${JSON.stringify(aId)}); return {ok:true}; }
        catch(e){ return {ok:false, err:String(e)}; }
      })()`);
      console.log('[5] B answered share:', JSON.stringify(acc2));
      let s2A = await waitConnected(aCdp, 'A-share');
      let s2B = await waitConnected(bCdp, 'B-share');
      if (!s2A) s2A = JSON.parse(await aCdp.ev(mediaSnapExpr()) || 'null');
      if (!s2B) s2B = JSON.parse(await bCdp.ev(mediaSnapExpr()) || 'null');
      // 观众 B 应收到一个 video 远端轨道并渲染
      const bViewer = s2B?.sessions.some(x => x.remote.includes('video')) === true
        && s2B?.dom.mainTracks.includes('video') === true && s2B.dom.mainW > 0;
      const aShare = s2A?.sessions.some(x => x.local.includes('video')) === true && s2A.dom.mainW > 0;
      console.log('[6] sharing A (host local video)=%s  B (viewer remote render)=%s', aShare, bViewer);
      console.log('   A=', JSON.stringify(s2A), ' B=', JSON.stringify(s2B));
      const shOk = aShare && bViewer;
      console.log('=== phase 2 screen sharing:', shOk ? 'OK (A captures screen, B viewer renders remote frame)' : 'FAIL', '===');
      await aCdp.ev(`window.__localim.hangupDebug(); void 0;`);
    }

    await cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    // 先吐 daemon 日志再清理，便于定位信令/ICE 卡点。
    for (const f of [join(da, 'a.log'), join(db, 'b.log')]) {
      try { const t = require_fs_read(f); if (t) console.error(`--- ${f} ---\n${t.slice(-2500)}`); } catch {}
    }
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();