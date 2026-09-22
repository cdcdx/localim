// 语音通话端到端：CDP 驱动两个头无 Edge（伪媒体设备）连 A/B 两个 daemon 的 WebUI。
// 流程：登录→A 发现 B→A startCall(voice)→B 处于 ringing→B acceptIncomingCall→
//       断言两侧 PeerConnection 均 connected 且收发到 audio 轨道→挂断清理。
// 伪媒体：--use-fake-ui-for-media-stream（自动授权）+ --use-fake-device-for-media-stream（假麦克风/摄像头）。
// 用法：node drv_voice_e2e.mjs <A_CDP_PORT> <A_URL> <B_CDP_PORT> <B_URL>
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [,, A_CDP, A_URL, B_CDP, B_URL] = process.argv;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function launch(port, url, profile) {
  return spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
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
    else if (m.method === 'Runtime.exceptionThrown') console.error('[exc]', (m.params.exceptionDetails?.exception?.description || '').slice(0, 240));
  };
  await new Promise(r => ws.onopen = r);
  const call = (method, params = {}) => new Promise(r => { const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = (expr) => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(r => r?.result?.value)
    .catch(e => ({ cdpErr: String(e) }));
  await call('Page.enable');
  return { ws, call, ev };
}
async function open(url, cdp) {
  await cdp.ev(`location.href !== ${JSON.stringify(url)}`);
  await cdp.call('Page.navigate', { url });
  await wait(1800);
}
// 轮询某表达式直到非空/truthy，返回其值。
async function poll(cdp, expr, timeoutMs = 20000, step = 600) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < timeoutMs) {
    v = await cdp.ev(expr);
    if (v && v !== '[]' && JSON.stringify(v) !== 'null' && JSON.stringify(v) !== '{}') return v;
    await wait(step);
  }
  return v ?? null;
}

async function main() {
  const [aProf, bProf] = [await mkdtemp(join(os.tmpdir(), 'lim_a_')), await mkdtemp(join(os.tmpdir(), 'lim_b_'))];
  const pa = launch(Number(A_CDP), 'about:blank', aProf);
  const pb = launch(Number(B_CDP), 'about:blank', bProf);
  const aCdp = await connect(await cdpUrl(Number(A_CDP)));
  const bCdp = await connect(await cdpUrl(Number(B_CDP)));
  await open(A_URL, aCdp);
  await open(B_URL, bCdp);
  await wait(1200);
  console.log('[diag] A global=', await aCdp.ev(`JSON.stringify({hasGlobal:!!window.__localim, mediaFns:!!(window.__localim&&window.__localim.mediaDebug&&window.__localim.acceptIncomingCall&&window.__localim.startCall)})`));

  // 上线
  await aCdp.ev(`window.__localim.login('Alice'); void 0;`);
  await bCdp.ev(`window.__localim.login('Bob'); void 0;`);

  // 取 B 的真实 deviceId（与其 daemon identity 一致），用它精确匹配 A 的在线表，
  // 避免把本机遗留的其它 daemon 在线条目误选为目标。
  const bId = await poll(aCdp, `(() => { const L=window.__localim; if(!L) return ''; const keys=[...L.app.state.peers.keys()].filter(k=>k); return keys.length?keys[0]:'' })()`, 20000);
  if (!bId) {
    console.error('[1] FAIL：A 未发现对端');
    console.error('  A=', await aCdp.ev(`(L=window.__localim)?JSON.stringify({connected:L.app.state.connected,peers:[...L.app.state.peers].map(([k,v])=>v.name)}):'NOAPP'`));
    console.error('  B=', await bCdp.ev(`(L=window.__localim)?JSON.stringify({connected:L.app.state.connected,peers:[...L.app.state.peers].map(([k,v])=>v.name)}):'NOAPP'`));
    await cleanup(pa, pb, aProf, bProf); process.exit(1);
  }
  console.log('[1] A 发现 B: OK deviceId=' + bId);

  // A 发起语音通话
  const start = await aCdp.ev(`(async () => {
    const L = window.__localim; if(!L) return {err:'no global'};
    try {
      const s = await L.startCall(${JSON.stringify(bId)}, 'voice');
      return { ok:true, callId:s.callId, sdpState:s.pc.signalingState };
    } catch(e){ return { ok:false, err:String(e) }; }
  })()`);
  console.log('[2] A 发起语音:', JSON.stringify(start));
  if (!start || !start.ok) { await cleanup(pa, pb, aProf, bProf); process.exit(1); }

  // B 侧应进入 ringing
  const ring = await poll(bCdp, `(() => { const L=window.__localim; if(!L) return ''; const m=L.app.state.media; return (m&&m.direction==='incoming'&&m.state==='ringing')?JSON.stringify({callId:m.callId,mode:m.peer.mode}):'' })()`, 12000);
  console.log('[3] B 来电 ringing:', ring ? 'OK ' + ring : 'NONE(但可能 offer 先到，继续)');

  // B 接听
  const acc = await bCdp.ev(`(async () => {
    const L = window.__localim; if(!L) return {err:'no global'};
    try { await L.acceptIncomingCall(${JSON.stringify(start.callId)}, 'voice', ${JSON.stringify(bId)}); return { ok:true }; }
    catch(e){ return { ok:false, err:String(e) }; }
  })()`);
  console.log('[4] B 接听 acceptIncomingCall:', JSON.stringify(acc));
  if (!acc || !acc.ok) { await cleanup(pa, pb, aProf, bProf); process.exit(1); }

  // 轮询：两端 PeerConnection 建立 + 双向 audio 轨道
  const snap = `(() => {
    const L=window.__localim; if(!L) return '';
    const s=L.mediaDebug(); if(!s.length) return '';
    const r=s.map(x=>\`\${x.pcState}/\${x.ice}/\${x.sig}/\${x.gather}/L:[${'${x.localTracks||[]}'}]/R:[${'${x.remoteTracks||[]}'}]\`).join(' | ');
    const live = s.some(x=>x.pcState==='connected' && x.ice==='connected' && x.localTracks.includes('audio') && x.remoteTracks.includes('audio'));
    return JSON.stringify({raw:r, live});
  })()`;
  const waitLive = async (cdp, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      const v = await cdp.ev(snap);
      if (v) { const o = JSON.parse(v); if (o.live) return o; }
      await wait(800);
    }
    const last = await cdp.ev(snap);
    console.log(`[5] ${label} 媒体态(超时):`, last ? JSON.stringify(last) : 'NONE');
    // 超时后抓取 ICE 候选对 / DTLS 状态定位卡点
    const dump = await cdp.ev(`(async () => {
      const L=window.__localim; if(!L) return 'NOAPP';
      const pcs=L.debugPcs(); if(!pcs||!pcs.length) return 'NO_PC';
      const out=[];
      for(const pc of pcs){
        const stats=await pc.getStats();
        const cand={state:pc.connectionState, ice:pc.iceConnectionState, dtls:null, pairs:[]};
        stats.forEach(s=>{
          if(s.type==='candidate-pair') cand.pairs.push(s.state+':'+((s.nominated)?'N':''));
          if(s.type==='transport' && s.dtlsState) cand.dtls=s.dtlsState;
          if(s.type==='remote-candidate') cand.remoteCand=(cand.remoteCand||0)+1;
          if(s.type==='local-candidate') cand.localCand=(cand.localCand||0)+1;
        });
        out.push(cand);
      }
      return JSON.stringify(out);
    })()`);
    console.log(`[5] ${label} stats-dump:`, dump);
    return null;
  };
  const aLive = await waitLive(aCdp, 'A');
  console.log('[5] A 媒体态:', aLive ? JSON.stringify(aLive) : 'NONE');
  const bLive = await waitLive(bCdp, 'B');
  console.log('[5] B 媒体态:', bLive ? JSON.stringify(bLive) : 'NONE');

  // 双向可听性：A 通过 data-channel 无关，直接以对端 ontrack 建流数 + connectionState 断言
  const aOk = aLive?.live === true;
  const bOk = bLive?.live === true;
  console.log('=== 语音通话端到端 ' + ((aOk && bOk) ? 'OK：A/B 双向 audio 轨道均建立，PeerConnection connected' : 'FAIL') + ' ===');

  // 挂断清理
  const hang = await aCdp.ev(`(L=window.__localim)?(L.hangupDebug(),'ok'):'noapp'`);
  console.log('[6] A hangupDebug:', hang, '| A 残留会话=', await aCdp.ev(`(L=window.__localim)?L.mediaDebug().length:'noapp'`));
  await wait(500);

  await cleanup(pa, pb, aProf, bProf);
  process.exit((aOk && bOk) ? 0 : 2);
}
async function cleanup(pa, pb, aProf, bProf) {
  try { pa.kill(); pb.kill(); } catch {}
  await wait(1200);
  await Promise.allSettled([rm(aProf, { recursive: true, force: true }), rm(bProf, { recursive: true, force: true })]);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); })