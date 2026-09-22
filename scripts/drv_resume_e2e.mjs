// 断点续传端到端：单机双 daemon(共享 presence 端口互发现) + 双无头 Edge。
//  阶段1 基线：A→B 完整传一个文件（回归：常规传输不破坏）。
//  阶段2 断点续传：A 传一个大文件，中途 interruptFile 模拟断连 →
//        发送端保留源与进度(sndGot>0)、接收端保留已收分片(recvGot>0) → resumeFile 续传 →
//        接收端收满且 sha256Ok 通过；并断言续传只补缺失块(resumeFromIndex>0 且 recvBytes≈size，
//        非全量重传)。随后再用 UI 触发条目与 transferDebug 校验。
//   用法: node drv_resume_e2e.mjs
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const NODES = [
  { webui: 8320, peer: 8322, presence: 8316, web: 8324 }, // A
  { webui: 8420, peer: 8422, presence: 8316, web: 8424 }, // B（共享 presence → 局域网互发现）
];
const CDP = { A: 8321, B: 8421 };

function launchDaemon(n, dataDir, log) {
  const args = [
    '--user-data-dir=' + dataDir,
    `--webui-port=${n.webui}`, `--peer-port=${n.peer}`, `--presence-port=${n.presence}`,
    `--web-port=${n.web}`, '--webui-dist=' + WEBUI,
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
async function waitFor(cdp, fn, tries = 80, gap = 300) {
  for (let i = 0; i < tries; i++) { if (await cdp.ev(fn)) return true; await wait(gap); }
  return false;
}

async function main() {
  const dirs = await Promise.all([...Array(4)].map(() => mkdtemp(join(os.tmpdir(), 'limrs_'))));
  const [da, db, pa, pb] = dirs;
  const handles = [];
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1400);
    await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true }))); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });
  let pass = false;
  try {
    handles.push(launchDaemon(NODES[0], da, join(da, 'a.log')));
    handles.push(launchDaemon(NODES[1], db, join(db, 'b.log')));
    handles.push(launchEdge(CDP.A, pa), launchEdge(CDP.B, pb));
    const [a, b] = [await connect(await cdpUrl(CDP.A)), await connect(await cdpUrl(CDP.B))];

    await open(`http://127.0.0.1:${NODES[0].web}/index.html?port=${NODES[0].webui}`, a);
    await open(`http://127.0.0.1:${NODES[1].web}/index.html?port=${NODES[1].webui}`, b);
    await wait(1200);
    await a.ev(`window.__localim.login('Alice'); void 0;`);
    await b.ev(`window.__localim.login('Bob'); void 0;`);
    await wait(900);
    const hello = (cd) => cd.ev(`(() => window.__localim.native.request('identity','hello',{}).then(r=>JSON.stringify({id:r.deviceId})).catch(e=>'ERR:'+e))()`).then((s) => JSON.parse(s).id);
    const [aId, bId] = await Promise.all([hello(a), hello(b)]);
    const seen = (t) => `(() => { const L=window.__localim; if(!L) return false;
      const has=[...L.app.state.peers.keys()].includes(${JSON.stringify(t)});
      if(!has){ try { L.native.loadRoster(); } catch {} } return has; })()`;
    await waitFor(a, seen(bId)); await waitFor(b, seen(aId));
    console.log('[0] A/B mutual discovery: A sees B=%s B sees A=%s', await a.ev(seen(bId)), await b.ev(seen(aId)));

    // 注入文件：A 页面构造 File（与已验证 file 传输一致）并直接走 sendFileTo（真实调用路径）。
    const mkFile = (size, tag) => `(() => { const a=new Uint8Array(${size}); for(let i=0;i<a.length;i++) a[i]=(i*31)&0xff;
      window.__tf_${tag} = new File([a], 'res-${tag}.bin', {type:'application/octet-stream'}); return window.__tf_${tag}.size; })()`;

    // ---- 阶段1 基线：2MiB 完整传 ----
    const baseSize = 2 * 1024 * 1024;
    await a.ev(mkFile(baseSize, 'base'));
    const baseRes = await a.ev(`(() => window.__localim.sendFileTo(${JSON.stringify(bId)}, window.__tf_base, 'file').then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`);
    const baseFileId = (baseRes).includes('fileId') ? JSON.parse(baseRes).fileId : null;
    if (!baseFileId) throw new Error('baseline sendFileTo failed: ' + baseRes);
    const baseOk = await waitFor(b, `(() => { const L=window.__localim; if(!L) return false;
      for(const [,arr] of L.app.state.conversations){ for(const it of arr) if(it.mediaRef?.fileId===${JSON.stringify(baseFileId)} && it.xfer?.phase==='done' && it.mediaRef.sha256Ok===true) return true; }
      return false; })()`);
    if (!baseOk) {
      const bd = await b.ev(`(() => { const L=window.__localim; const o=[]; for(const [,arr] of L.app.state.conversations){ for(const it of arr) if(it.mediaRef?.fileId===${JSON.stringify(baseFileId)}) o.push({phase:it.xfer?.phase,got:it.xfer?.got,total:it.xfer?.total,sha:it.mediaRef?.sha256Ok}); } return JSON.stringify({cards:o, tdbg:window.__localim?.transferDebug()}); })()`);
      const ad = await a.ev(`(() => JSON.stringify({dbg:window.__localim?.transferDebug(), md:window.__localim?.mediaDebug()}))()`);
      const aev = await a.ev(`(() => JSON.stringify((window.__localim?.native?.evlog||[]).slice(-12)))()`);
      console.error('--- baseline failure diagnostics B=%s A=%s evlog=%s ---', bd, ad, aev);
      throw new Error('baseline transfer failed');
    }
    console.log('[1] baseline 2MiB: B received all and sha256Ok=%s', baseOk);

    // ---- 阶段2 断点续传：64MiB==1024块, 中途中断后在断点续传 ----
    const size = 64 * 1024 * 1024;
    const chunk = 1 << 16;
    await a.ev(mkFile(size, 'res'));
    const res1 = await a.ev(`(() => window.__localim.sendFileTo(${JSON.stringify(bId)}, window.__tf_res, 'file').then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`);
    const fileId = res1.includes('fileId') ? JSON.parse(res1).fileId : null;
    if (!fileId) throw new Error('sendFileTo failed: ' + res1);

    // 等接收端已收一部分（>1 块 且 < 全量），随后中断发送。
    const partial = await waitFor(b, `(() => { const t=window.__localim?.transferDebug(); if(!t) return false;
      const g=t.recvGot[${JSON.stringify(fileId)}]||0; return g>${chunk} && g<${size}; })()`, 80, 300);
    if (!partial) throw new Error('receiver did not observe partial progress');
    const gBefore = await a.ev(`(() => window.__localim.transferDebug().sndGot[${JSON.stringify(fileId)}]||0)()`);
    const rBefore = await b.ev(`(() => window.__localim.transferDebug().recvGot[${JSON.stringify(fileId)}]||0)()`);
    console.log('[2] progress before interrupt: sender sndGot=%d  receiver recvGot=%d', gBefore, rBefore);

    // 模拟断连：静默中断发送（保留源+进度），并关闭会话使对端 onclose 失败且保留已收。
    const interrupted = await a.ev(`(() => window.__localim.interruptFile(${JSON.stringify(fileId)}))()`);
    console.log('[3] interruptFile issued=%s', interrupted);
    // 等发送端进度保留、接收端置为传输中断(失败态)且已收分片仍保留。
    await waitFor(a, `(() => { const t=window.__localim?.transferDebug(); return !!t && (t.sndGot[${JSON.stringify(fileId)}]||0)>0; })()`);
    await waitFor(b, `(() => { const t=window.__localim?.transferDebug(); return !!t && (t.recvGot[${JSON.stringify(fileId)}]||0)>0 && (t.recvGot[${JSON.stringify(fileId)}]||0)<${size}; })()`);
    const gMid = await a.ev(`(() => window.__localim.transferDebug().sndGot[${JSON.stringify(fileId)}]||0)()`);
    const rMid = await b.ev(`(() => window.__localim.transferDebug().recvGot[${JSON.stringify(fileId)}]||0)()`);
    console.log('[4] retained after interrupt: sender sndGot=%d(>0)  receiver recvGot=%d', gMid, rMid);
    if (!(gMid > 0 && rMid > 0 && rMid < size)) throw new Error('unexpected checkpoint state');

    // 断点续传：发送端对同一 fileId 重开会话，经 fresume 协商对端进度，从断点只补缺失块。
    const ok = await a.ev(`(() => window.__localim.resumeFile(${JSON.stringify(fileId)}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e))()`);
    const rj = ok.includes('ok') ? JSON.parse(ok) : null;
    if (!rj?.ok) throw new Error('resumeFile failed: ' + ok);
    console.log('[5] resumeFile issued: %s', JSON.stringify(rj));

    // 决定性断言 A：续传是否真的从断点启动。resumeFromIndex 只在续传进行中可读
    // （传输完成后 sendState 被清，sndFrom 不可见），故立即轮询发送端抓取其值。
    let sndFrom = 0;
    for (let i = 0; i < 100 && sndFrom === 0; i++) {
      sndFrom = await a.ev(`(() => { const t=window.__localim?.transferDebug(); return (t?.sndFrom[${JSON.stringify(fileId)}]||0)|0; })()`);
      if (sndFrom > 0) break;
      await wait(50);
    }
    console.log('[5b] resume start chunk=%d (block index), expected >0 meaning only missing parts are resent', sndFrom);
    if (!(sndFrom > 0)) throw new Error('resume did not start from checkpoint (looks like a full retransmit)');

    // 收端收满且 sha256 校验通过（内容一致性：续传拼接出的文件必须与源完全一致）。
    const doneOk = await waitFor(b, `(() => { const L=window.__localim; if(!L) return false;
      for(const [,arr] of L.app.state.conversations){ for(const it of arr) if(it.mediaRef?.fileId===${JSON.stringify(fileId)} && it.xfer?.phase==='done' && it.mediaRef.sha256Ok===true) return true; }
      return false; })()`, 100, 300);
    console.log('[6] resume finished: B received all and sha256Ok=%s', doneOk);
    if (!doneOk) {
      const bd2 = await b.ev(`(() => { const L=window.__localim; const o=[]; for(const [,arr] of L.app.state.conversations){ for(const it of arr) if(it.mediaRef?.fileId===${JSON.stringify(fileId)}) o.push({phase:it.xfer?.phase,got:it.xfer?.got,total:it.xfer?.total,sha:it.mediaRef?.sha256Ok,url:!!it.mediaRef?.url}); } return JSON.stringify({cards:o, tdbg:window.__localim?.transferDebug()}); })()`);
      const ad2 = await a.ev(`(() => JSON.stringify({tdbg:window.__localim?.transferDebug(), md:window.__localim?.mediaDebug()}))()`);
      console.error('--- resume failure diagnostics B=%s A=%s ---', bd2, ad2);
      throw new Error('resume did not complete on receiver');
    }

    // 决定性断言 B：接收端累计收到的分片字节 ≈ 文件大小（只补缺失，未重复接收已持有的块）。
    const rDone = await b.ev(`(() => { const t=window.__localim?.transferDebug(); const g=t?.recvGot[${JSON.stringify(fileId)}]; return g? {got:g, bytes:t.recvBytes[${JSON.stringify(fileId)}]||0}: null; })()`);
    console.log('[7] resume start chunk=%d (block index)  recvBytes=%d (accumulated received bytes, size=%d)  recvGot=%d',
      sndFrom, rDone ? rDone.bytes : -1, size, rDone ? rDone.got : -1);
    if (!rDone || Math.abs(rDone.bytes - size) > chunk) throw new Error('abnormal accumulated received bytes (looks like duplicated chunks)');
    if (!(rDone.got === size)) throw new Error('receiver did not receive everything');

    pass = true;
    console.log('=== resumable transfer: baseline + retained after interrupt + only missing parts resent: PASS ===');
    await cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    await cleanup().catch(() => {});
    process.exit(2);
  }
}
main();