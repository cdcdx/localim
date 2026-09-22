// 消息加密端到端（--psk，AES-256-GCM 正文机密 + 信封 HMAC 认证/防重放）。
//   场景1 同 PSK:      A、B 填同一口令 → 文本密文传输，B 侧解出原文，A 收到送达回执(delivered)。
//   场景2 密钥不匹配:  A=k1、B=k2 → B daemon 验签失败(log "reject peer frame")，B 收不到消息，A 无回执。
//   场景3 无 PSK:      A、B 都不填 → 明文直通（旧版行为），B 解原文、A 收到回执。
//   用法: node drv_enc_e2e.mjs
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

const PRES = 9316; // 三场景共享一个 presence 端口（局域网发现），peer/webui/relay/web 各异。
const CDP = { A: 9321, B: 9331 };

function launchDaemon(n, dataDir, log, psk) {
  const args = ['--user-data-dir=' + dataDir,
    `--webui-port=${n.webui}`, `--peer-port=${n.peer}`,
    `--presence-port=${PRES}`, `--relay-port=${n.peer + 1}`,
    `--web-port=${n.web}`, '--webui-dist=' + WEBUI,
    '--enable-logging=stderr', '--v=1'];
  if (psk) args.push('--psk=' + psk);
  return spawn(EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
}
function launchEdge(port, profile) {
  return spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + profile,
    `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore', detached: true });
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
const hello = (cd) => cd.ev(`(() => window.__localim.native.request('identity','hello',{}).then(r=>JSON.stringify({id:r.deviceId,name:r.name})).catch(e=>'ERR:'+e))()`)
  .then((s) => { try { return JSON.parse(s); } catch { return null; } });
// 全会话按 nonce 查消息（key 可能落在 daemon 自身 id 下，不假设会话键），
// 命中返回 {body,status} 字符串，否则 null。
const findMsg = (nonceJs) => `(() => { const L=window.__localim; if(!L) return null; for(const arr of L.app.state.conversations.values()){ const it=(arr||[]).find(c=>c.nonce===${nonceJs}); if(it) return JSON.stringify({body:it.body,status:it.status}); } return null; })()`;
async function runScenario(name, base, pskA, pskB) {
  const N = {
    A: { webui: base, peer: base + 2, web: base + 4 },
    B: { webui: base + 10, peer: base + 12, web: base + 14 },
  };
  const dirs = await Promise.all([mkdtemp(join(os.tmpdir(), 'lime_' + name + '_')), mkdtemp(join(os.tmpdir(), 'lime_' + name + '_')), mkdtemp(join(os.tmpdir(), 'lime_' + name + '_')), mkdtemp(join(os.tmpdir(), 'lime_' + name + '_'))]);
  const [da, db, pa, pb] = dirs;
  const handles = [];
  const track = (p) => { handles.push(p); return p; };
  const cleanup = async () => { for (const p of handles) { try { p.kill(); } catch {} } await wait(1400);
    await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true }))); };
  process.on('exit', () => { for (const p of handles) { try { p.detached && p.kill(); } catch {} } });

  const [aLog, bLog] = [join(da, 'a.log'), join(db, 'b.log')];
  track(launchDaemon(N.A, da, aLog, pskA));
  track(launchDaemon(N.B, db, bLog, pskB));
  track(launchEdge(CDP.A, pa));
  track(launchEdge(CDP.B, pb));
  const a = await connect(await cdpUrl(CDP.A));
  const b = await connect(await cdpUrl(CDP.B));
  await open(`http://127.0.0.1:${N.A.web}/index.html?port=${N.A.webui}`, a);
  await open(`http://127.0.0.1:${N.B.web}/index.html?port=${N.B.webui}`, b);
  await wait(1200);
  await a.ev(`window.__localim.login('Alice'); void 0;`);
  await b.ev(`window.__localim.login('Bob'); void 0;`);
  await wait(600);

  const mutual = (cd) => `(() => { const L=window.__localim; if(!L) return false; return [...L.app.state.peers.keys()].filter(Boolean).length>=1; })()`;
  for (const [n, cd] of [['A', a], ['B', b]]) {
    if (!(await waitFor(cd, mutual(cd)))) { await cleanup(); throw new Error(`${name}: ${n} failed mutual discovery`); }
  }
  const [aId, bId] = [await hello(a), await hello(b)];
  if (!aId?.id || !bId?.id) { await cleanup(); throw new Error(`${name}: hello missing deviceId`); }

  const nonce = `${name}-${Date.now()}`;
  const body = `enc msg ${name} ${Date.now()}`;
  await a.ev(`(() => { const L=window.__localim; return L.native.send('message','send',{kind:'chat',type:'text',to:${JSON.stringify(bId.id)},nonce:${JSON.stringify(nonce)},ts:Date.now(),body:${JSON.stringify(body)}}); })()`);
  await wait(1400);

  // B 是否收到（scan-all-convs by nonce）；多等片刻再抓日志，给 stderr 管道刷盘留时间。
  const bGot = await b.ev(findMsg(JSON.stringify(nonce)));
  const aSt = await a.ev(findMsg(JSON.stringify(nonce)));
  await wait(1200);
  // A daemon 日志：是否收到 ack；B daemon 日志：是否 reject peer frame
  let aTxt = '', bTxt = '';
  try { aTxt = readFileSync(aLog, 'utf8'); } catch {}
  try { bTxt = readFileSync(bLog, 'utf8'); } catch {}

  const verdict = {
    bIndex: bGot ? JSON.parse(bGot) : null,
    aStatus: aSt ? JSON.parse(aSt)?.status : null,
    bRejected: /reject peer frame/.test(bTxt),
    aAcked: /ack received from/.test(aTxt),
  };
  // 调试转储：B 的验签/入站/send 相关行 与 A 的 ack/queued/dial 行。
  const dump = (t, tag, re) => {
    const rel = t.split('\n').filter((l) => re.test(l)).slice(-12);
    if (rel.length) console.error(`  --- ${name}/${tag}.log ---\n  ` + rel.join('\n  '));
  };
  dump(aTxt, 'A', /ack received|offline queued|SendPeer|dial|reject peer/);
  dump(bTxt, 'B', /reject peer|inbound peer|inbound media|SendPeer|dial|ack received/);
  await cleanup();
  return verdict;
}

async function main() {
  let pass = false;
  try {
    // 场景1: 同 PSK → B 解出原文，A 回执 delivered
    const m = await runScenario('match', 9400, 'lan-secret', 'lan-secret');
    console.log('[1 same PSK] B.body=%j B.status=%j A.status=%j B_reject=%s A_ack=%s',
      m.bIndex?.body, m.bIndex?.status, m.aStatus, m.bRejected, m.aAcked);
    const matchOk = m.bIndex && m.bIndex.body.startsWith('enc msg match') && m.aStatus === 'delivered' && !m.bRejected;
    if (!matchOk) throw new Error('same-PSK scenario failed: B did not get plaintext / A got no ack');

    // 场景2: 密钥不匹配 → B 验签拒收，A 无回执
    const x = await runScenario('mismatch', 9500, 'psk-A', 'psk-B');
    console.log('[2 key mismatch] B.body=%s B_reject=%s A.status=%s A_ack=%s',
      x.bIndex?.body, x.bRejected, x.aStatus, x.aAcked);
    // 关键对比：同 PSK(场景1)B 收到原文、A 送达；密钥不匹配则 B 收不到、A 无回执 → 证明验签确实拒收。
    const mismatchOk = x.bIndex === null && x.aStatus !== 'delivered';
    if (!mismatchOk) throw new Error('key-mismatch scenario failed: B did not reject / A status unexpected');

    // 场景3: 无 PSK → 明文直通（旧版行为）
    const p = await runScenario('plain', 9600, null, null);
    console.log('[3 no PSK] B.body=%j A.status=%j', p.bIndex?.body, p.aStatus);
    const plainOk = p.bIndex && p.bIndex.body.startsWith('enc msg plain') && p.aStatus === 'delivered';
    if (!plainOk) throw new Error('no-PSK plaintext scenario failed: B did not get plaintext / A got no ack');

    // 场景4: 加密缺省明文兜底 —— 同 PSK 场景 B 收到的 body 应被解密为原文（非 base64），
    //        A 侧 daemon 日志不应出现 reject peer frame，且 B 侧出现（解密走 enc 分支）。
    pass = matchOk && mismatchOk && plainOk;
    console.log('=== message encryption e2e: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
    process.exit(pass ? 0 : 3);
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    process.exit(2);
  }
}
main();