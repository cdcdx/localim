// 群聊(room)端到端：双 daemon + 双无头 Edge。
//   阶段1 建群: A(Alice, 房主) room.create → 生成 roomId → room.invite(Bob) →
//              B 经 peer 信封收到 room.invited → B 本地导入成员表 + WebUI 显示群。
//   阶段2 群消息: A send(kind=room) → daemon 向成员(B) 直发广播 → B 收到 room.room_message；
//              双方 app.state.conversations 出现该群会话。B 再回一条 → A 收到。
//   阶段3 历史: A loadHistory(roomId,'room') 应含双向消息。
//   用法: node drv_group_e2e.mjs
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
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const A = { webui: 9570, peer: 9572, relay: 9573, web: 9574 };
const B = { webui: 9670, peer: 9672, relay: 9673, web: 9674 };

function launchDaemon(ports, dataDir, log) {
  const args = [];
  args.push('--user-data-dir=' + dataDir);
  args.push('--webui-port=' + ports.webui);
  args.push('--peer-port=' + ports.peer);
  args.push('--presence-port=9616');
  args.push('--relay-port=' + ports.relay);
  args.push('--web-port=' + ports.web);
  args.push('--webui-dist=' + WEBUI);
  args.push('--enable-logging=stderr'); args.push('--v=1');
  const p = spawn(EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  p.stderr.pipe(createWriteStream(log));
  return p;
}
function launchEdge(port, url, profile) {
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
  await cdp.call('Page.navigate', { url });
  await wait(1800);
}
async function waitFor(cdp, fn, tries = 40, gap = 400) {
  for (let i = 0; i < tries; i++) { if (await cdp.ev(fn)) return true; await wait(gap); }
  return false;
}
const req = (ns, m, d) => `window.__localim.native.request(${JSON.stringify(ns)}, ${JSON.stringify(m)}, ${JSON.stringify(d || {})})`;

async function main() {
  const [da, db, aProf, bProf] = await Promise.all([
    mkdtemp(join(os.tmpdir(), 'limg_a_')), mkdtemp(join(os.tmpdir(), 'limg_b_')),
    mkdtemp(join(os.tmpdir(), 'limg_pa_')), mkdtemp(join(os.tmpdir(), 'limg_pb_')),
  ]);
  const handles = [];
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1500);
    await Promise.allSettled([rm(da,{recursive:true,force:true}), rm(db,{recursive:true,force:true}),
      rm(aProf,{recursive:true,force:true}), rm(bProf,{recursive:true,force:true})]); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });
  try {
    handles.push(launchDaemon(A, da, join(da, 'a.log')), launchDaemon(B, db, join(db, 'b.log')));
    const pe = launchEdge(9571, 'about:blank', aProf); handles.push(pe);
    const pf = launchEdge(9671, 'about:blank', bProf); handles.push(pf);
    const aCdp = await connect(await cdpUrl(9571));
    const bCdp = await connect(await cdpUrl(9671));
    await open(9571, `http://127.0.0.1:${A.web}/index.html?port=${A.webui}`, aCdp);
    await open(9671, `http://127.0.0.1:${B.web}/index.html?port=${B.webui}`, bCdp);
    await wait(1200);
    await aCdp.ev(`window.__localim.login('Alice'); void 0;`);
    await bCdp.ev(`window.__localim.login('Bob'); void 0;`);
    await wait(500);

    // 互发现
    const bId = await aCdp.ev(`(() => { const L=window.__localim; return L?([...L.app.state.peers.keys()].filter(Boolean)[0]||''):''; })()`);
    await waitFor(bCdp, `(() => { const L=window.__localim; if(!L) return false; return [...L.app.state.peers.keys()].filter(Boolean).length>0; })()`, 40, 400);
    const aId = await bCdp.ev(`(() => { const L=window.__localim; return L?([...L.app.state.peers.keys()].filter(Boolean)[0]||''):''; })()`);
    console.log('[0] mutual discovery A->B=%s B->A=%s', bId, aId);
    if (!bId || !aId || bId === aId) throw new Error('mutual discovery failed');

    // 预热：A→B 传一个小文件，先建立对端 peer 通道(后续 invite/群广播走复用的 outgoing 连接)。
    const warm = await (async () => {
      await aCdp.ev(`(async () => { const L=window.__localim; const f=new Uint8Array(65536); f.fill(7);
        const file=new File([f],'warm.bin',{type:'application/octet-stream'});
        await L.sendFileTo(${JSON.stringify(bId)},file,'file'); return true; })()`);
      return await waitFor(bCdp, `(() => { const L=window.__localim; if(!L) return false;
        for(const [,arr] of L.app.state.conversations) for(const it of arr)
          if(it.mediaRef && it.mediaRef.name==='warm.bin' && it.xfer && it.xfer.phase==='done') return true; return false; })()`, 60, 500);
    })();
    console.log('[0.5] warmup file transfer:', warm ? 'OK' : 'FAIL');

    // 阶段1a: A 建群
    const created = await aCdp.ev(`(() => window.__localim.native.request('room','create',{name:'Tech Group'}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`);
    const roomId = JSON.parse(created).roomId;
    console.log('[1] A created group:', created, ' roomId=', roomId);
    if (!roomId) throw new Error('failed to create group');

    // 阶段1b: A 邀请 B
    const inv = await aCdp.ev(`(() => window.__localim.native.request('room','invite',{roomId:${JSON.stringify(roomId)},to:${JSON.stringify(bId)}}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`);
    console.log('[2] A invited B:', inv);
    // B 端应收到 room.invited 并在 rooms map 出现该群，成员=[A,B]
    const bGotRoom = await waitFor(bCdp, `(() => { const L=window.__localim; const r=L&&L.app.state.rooms.get(${JSON.stringify(roomId)}); return !!(r && r.members && r.members.includes(${JSON.stringify(aId)})); })()`, 40, 300);
    const bRoom = await bCdp.ev(`(() => { const r=window.__localim.app.state.rooms.get(${JSON.stringify(roomId)}); return r ? JSON.stringify({name:r.name,owner:r.owner,members:r.members}) : 'none'; })()`);
    const aRoomM = await aCdp.ev(`(() => { const r=window.__localim.app.state.rooms.get(${JSON.stringify(roomId)}); return r ? JSON.stringify(r.members) : 'none'; })()`);
    console.log('[3] B got group:', bGotRoom ? 'OK' : 'FAIL', bRoom, ' A members=', aRoomM);
    if (!bGotRoom) throw new Error('B did not receive invited');

    // 阶段2a: A 发群消息 -> B 收到
    const msgA = 'hello from A';
    await aCdp.ev(`window.__localim.native.send('message','send',{kind:'room',type:'text',to:${JSON.stringify(roomId)},body:${JSON.stringify(msgA)},nonce:'g-a-1',ts:Date.now()}); void 0;`);
    const bGotMsg = await waitFor(bCdp, `(() => { const L=window.__localim; const arr=L&&L.app.state.conversations.get(${JSON.stringify(roomId)}); return !!(arr && arr.some(x=>x.body===${JSON.stringify(msgA)})); })()`, 40, 300);
    console.log('[4] A->B group message:', bGotMsg ? 'OK' : 'FAIL');

    // 阶段2b: B 回群消息 -> A 收到
    const msgB = 'hello from B';
    await bCdp.ev(`window.__localim.native.send('message','send',{kind:'room',type:'text',to:${JSON.stringify(roomId)},body:${JSON.stringify(msgB)},nonce:'g-b-1',ts:Date.now()}); void 0;`);
    const aGotMsg = await waitFor(aCdp, `(() => { const L=window.__localim; const arr=L&&L.app.state.conversations.get(${JSON.stringify(roomId)}); return !!(arr && arr.some(x=>x.body===${JSON.stringify(msgB)})); })()`, 40, 300);
    console.log('[5] B->A group message:', aGotMsg ? 'OK' : 'FAIL');

    // 阶段3: A 群历史含双向
    await aCdp.ev(`window.__localim.native.loadHistory(${JSON.stringify(roomId)},'room'); void 0;`);
    const hist = await waitFor(aCdp, `(() => { const arr=window.__localim.app.state.conversations.get(${JSON.stringify(roomId)}); if(!arr) return false;
      return arr.some(x=>x.body===${JSON.stringify(msgA)}) && arr.some(x=>x.body===${JSON.stringify(msgB)}); })()`, 30, 300);
    const histDump = await aCdp.ev(`(() => { const arr=window.__localim.app.state.conversations.get(${JSON.stringify(roomId)})||[]; return JSON.stringify(arr.map(x=>x.body)); })()`);
    console.log('[6] A group history (both directions):', hist ? 'OK' : 'FAIL', histDump);

    // 阶段4: B 确认 daemon 成员表已同步（可广播）
    const bMembers = await bCdp.ev(`(() => { const m=window.__localim.app.state.rooms.get(${JSON.stringify(roomId)}); return m?JSON.stringify({members:m.members,owner:m.owner}):'none'; })()`);
    console.log('[7] B group member list:', bMembers);

    const pass = bGotRoom && bGotMsg && aGotMsg && hist;
    console.log('=== group chat mode: ' + (pass ? 'PASS (create -> invite -> member sync -> bidirectional group messages -> history, full chain)' : 'FAIL') + ' ===');

    await cleanup();
    process.exit(pass ? 0 : 3);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    for (const f of [join(da, 'a.log'), join(db, 'b.log')]) {
      try { const t = require_fs_read(f, 'utf8'); if (t) console.error(`--- ${f} ---\n${t.slice(-1200)}`); } catch {}
    }
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();