// 文件分片端到端：CDP 驱动两个 Edge 实例连到 A/B 两个 daemon 的 WebUI。
// A 页写身份→hello→扫描发现 B→A 页 sendFileTo(内存文件)→B 页断言收到文件消息。
// 用法：node drv_file_e2e.mjs <A_CDP_PORT> <A_PAGE_URL> <B_CDP_PORT> <B_PAGE_URL>
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [,, A_CDP, A_URL, B_CDP, B_URL] = process.argv;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function launch(port, url, profile) {
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
    else if (m.method === 'Runtime.exceptionThrown') console.error('[exc]', (m.params.exceptionDetails?.exception?.description || '').slice(0, 240));
  };
  await new Promise(r => ws.onopen = r);
  const call = (method, params = {}) => new Promise(r => { const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = (expr) => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(r => r?.result?.value)
    .catch(e => ({ cdpErr: String(e) }));
  return { ws, call, ev };
}
async function open(port, url, cdp) {
  await cdp.call('Page.enable');
  await cdp.ev(`location.href !== ${JSON.stringify(url)}`);
  await cdp.call('Page.navigate', { url });
  await wait(1800);
}

async function main() {
  const [aProf, bProf] = [await mkdtemp(join(os.tmpdir(), 'lim_a_')), await mkdtemp(join(os.tmpdir(), 'lim_b_'))];
  const pa = launch(Number(A_CDP), 'about:blank', aProf);
  const pb = launch(Number(B_CDP), 'about:blank', bProf);
  const aCdp = await connect(await cdpUrl(Number(A_CDP)));
  const bCdp = await connect(await cdpUrl(Number(B_CDP)));
  await open(Number(A_CDP), A_URL, aCdp);
  await open(Number(B_CDP), B_URL, bCdp);
  await wait(1200);
  console.log('[diag] A href/state/global=',
    await aCdp.ev(`JSON.stringify({href:location.href, rs:document.readyState, hasGlobal:!!window.__localim, html:(document.getElementById('app')?.childElementCount)})`));
  console.log('[diag] A modules=', await aCdp.ev(`[...document.querySelectorAll('script[src]')].map(s=>s.src).join(' | ')`));
  console.log('[diag] A resources=', await aCdp.ev(`performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script'||r.initiatorType==='link').map(r=>r.name.split('/').pop()).join(',')`));

  // 通过登录入口上线：触发 identity.hello + discovery.scan_start
  await aCdp.ev(`window.__localim.login('Alice'); void 0;`);
  await bCdp.ev(`window.__localim.login('Bob'); void 0;`);

  // 等 A 发现 B（roster 里能查到对端 deviceId 即可；对端名是 daemon 内置 local-*）
  let bId = null, ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    const ids = await aCdp.ev(`(() => { const L=window.__localim; if(!L) return ''; return [...L.app.state.peers.keys()].join(',') })()`);
    if (ids) { const arr = ids.split(',').filter(Boolean).map(x => x.trim()); if (arr.length > 0) { bId = arr[0]; ok = true; } }
    if (!ok) await wait(600);
  }
  console.log('[1] A discovered peer:', ok ? 'OK deviceId=' + bId : 'FAIL');
  if (!ok) {
    const aState = await aCdp.ev(`(() => { const L=window.__localim; if(!L) return 'NOAPP'; return JSON.stringify({connected:L.app.state.connected, profile:L.app.state.profile, peers:[...L.app.state.peers].map(([k,v])=>k+':'+v?.name)}) })()`);
    const bState = await bCdp.ev(`(() => { const L=window.__localim; if(!L) return 'NOAPP'; return JSON.stringify({connected:L.app.state.connected, profile:L.app.state.profile, peers:[...L.app.state.peers].map(([k,v])=>k+':'+v?.name)}) })()`);
    console.error('A state=', aState, '\nB state=', bState);
    process.exit(1);
  }

  // A 发文件（256KiB 带节奏的二进制）
  const send = await aCdp.ev(`(async () => {
    const L = window.__localim; if(!L) return {err:'no global'};
    const bId = ${JSON.stringify(bId)};
    const bytes = new Uint8Array(256*1024); for(let i=0;i<bytes.length;i++) bytes[i]=i%251;
    const file = new File([bytes], 'bench-bin.bin', { type: 'application/octet-stream' });
    await L.sendFileTo(bId, file, 'file');
    return { ok:true, bId, size:bytes.length };
  })()`);
  console.log('[2] A calls sendFileTo:', JSON.stringify(send));
  if (!send || !send.ok) { console.error('FAIL send', send); process.exit(1); }

  // B 页断言：等待收到文件消息（Type=file, mediaRef.name=bench-bin.bin）
  let got = null;
  for (let i = 0; i < 60 && !got; i++) {
    got = await bCdp.ev(`(() => {
      const L = window.__localim; if(!L) return null;
      for (const [k, arr] of L.app.state.conversations) {
        for (const it of arr) if (it.type === 'file' && it.mediaRef && it.mediaRef.name === 'bench-bin.bin') return { key:k, name:it.mediaRef.name, size:it.mediaRef.size, hasUrl:!!it.mediaRef.url, body:it.body };
      }
      return null;
    })()`);
    if (!got) await wait(700);
  }
  console.log('[3] B received file message:', got ? JSON.stringify(got) : 'NONE');
  const pass = !!got && got.name === 'bench-bin.bin' && got.size === 256 * 1024;
  console.log('=== file chunking e2e ' + (pass ? 'OK: A sent over WebRTC data channel, B reassembled and displayed it' : 'FAIL') + ' ===');

  try { pa.kill(); pb.kill(); } catch {}
  await wait(1200);
  await Promise.allSettled([rm(aProf, { recursive: true, force: true }), rm(bProf, { recursive: true, force: true })]);
  process.exit(pass ? 0 : 2);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); })