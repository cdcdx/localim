#!/usr/bin/env node
// LocalIM full-stack E2E: WebUI(WS client) <-> localim_daemon(127.0.0.1:7615)
// Sends a batch of protocol requests and prints each response envelope.
const url = process.env.LOCALIM_WS || 'ws://127.0.0.1:7615';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function request(ws, ns, m, d = {}, txn = `${ns}.${m}`) {
  ws.send(JSON.stringify({ v: 1, dir: 'req', ns, m, txn, d }));
}

const ws = new WebSocket(url);
const pending = new Map();
const results = [];

ws.onopen = async () => {
  console.log('[e2e] connected', url);
  const cases = [
    ['identity', 'hello', {}],
    ['roster', 'list', {}],
    ['room', 'create', { name: 'Test Group' }],
    ['message', 'send', { kind: 'text', text: 'hello LAN!', channel: 'chat', to: '*' }],
    ['discovery', 'scan_start', {}],
    ['nope', 'nope', {}],
  ];
  for (const [ns, m, d] of cases) {
    request(ws, ns, m, d, `${ns}.${m}`);
    await delay(150);
  }
  setTimeout(() => { ws.close(); }, 500);
};

ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { console.log('[e2e] non-json:', String(ev.data).slice(0, 200)); return; }
  const tr = `${msg.txn || 'ev'}`;
  results.push(msg);
  const ok = msg.ok === true ? 'OK ' : 'ERR';
  console.log(`[e2e] ${ok} ${tr}: ${JSON.stringify(msg.d)}`);
};

ws.onclose = () => {
  console.log('[e2e] closed. received', results.length, 'responses.');
  const okCount = results.filter((r) => r.ok).length;
  console.log(`[e2e] RESULT: ${okCount}/${results.length} ok`);
  process.exit(0);
};
ws.onerror = (e) => { console.error('[e2e] ws error', e.message || e); process.exit(1); };