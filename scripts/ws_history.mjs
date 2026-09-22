#!/usr/bin/env node
// LocalIM 消息落库 E2E：
//   PHASE=send  —— 连 WebUI，向对端 X 发 N 条，再查 message.history，断言收发一致。
//   PHASE=check —— 连 WebUI，查 message.history，断言与期望条数一致（跨重启验证落库）。
// 用法:
//   LOCALIM_WS=ws://127.0.0.1:<port> PHASE=send X=peer NONCE_PREFIX=h1 node ws_history.mjs
//   LOCALIM_WS=ws://127.0.0.1:<port> PHASE=check X=peer EXPECT=<n> node ws_history.mjs
const url = process.env.LOCALIM_WS || 'ws://127.0.0.1:7615';
const phase = process.env.PHASE || 'send';
const X = process.env.X || 'fake-peer-1';
const N = Number(process.env.N || 3);
const EXPECT = Number(process.env.EXPECT || 0);
const prefix = process.env.NONCE_PREFIX || 'persist';
const limit = Number(process.env.LIMIT || 200);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function txn() { return 't-' + Date.now() + '-' + Math.floor(Math.random() * 1e6); }

function open() {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.dir === 'res') { const p = pending.get(m.txn); if (p) { pending.delete(m.txn); p.resolve(m); } }
    else if (m.dir === 'ev') events.push(m);
  };
  const request = (ns, m, d) => new Promise((resolve) => {
    const id = txn();
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ v: 1, dir: 'req', ns, m, txn: id, d }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, d: { msg: 'timeout' } }); } }, 8000);
  });
  return new Promise((res) => { ws.onopen = () => res({ ws, request, events }); });
}

function fail(msg) { console.error('FAIL:', msg); process.exit(2); }

async function main() {
  const c = await open();
  const hello = await c.request('identity', 'hello', {});
  if (!hello.ok) fail('hello failed');
  if (phase === 'send') {
    const bodies = [];
    for (let i = 0; i < N; i++) {
      const body = `${prefix}-${i} @ ${X}`;
      bodies.push(body);
      const r = await c.request('message', 'send', {
        kind: 'chat', type: 'text', to: X, nonce: `${prefix}-${X}-${i}`, ts: Date.now(), body,
      });
      if (!r.ok || r.d?.accepted !== true) fail(`message #${i} not accepted: ${JSON.stringify(r.d)}`);
      await delay(60);
    }
    const h = await c.request('message', 'history', { to: X, kind: 'chat', limit });
    if (!h.ok) fail('history request failed');
    const items = (h.d?.items || []);
    const got = items.filter((it) => it.body && bodies.includes(it.body)).map((it) => it.body);
    const miss = bodies.filter((b) => !got.includes(b));
    console.log(`[history] sent ${N} -> history returned ${items.length}, ${got.length} of them from this run`
      + (miss.length ? `, missing: ${miss.join(', ')}` : ''));
    if (miss.length) fail('missing persisted items');
    const ordered = bodies.every((b, i) => got[i] === b);
    console.log(`[history] order ${ordered ? 'OK (old->new)' : 'OUT OF ORDER'}`);
    if (!ordered) fail('history order mismatch');
    console.log(`[history] PHASE=send PASS: ${N} items persisted and replayed in order`);
  } else {
    const h = await c.request('message', 'history', { to: X, kind: 'chat', limit });
    const items = (h.d?.items || []);
    console.log(`[history] PHASE=check: ${X} history ${items.length} items (expected ${EXPECT})`);
    if (items.length !== EXPECT) fail(`history count mismatch: expected ${EXPECT}, got ${items.length}`);
    if (EXPECT > 0) console.log(`[history] latest item: ${JSON.stringify(items[items.length - 1].body)}`);
    console.log(`[history] PHASE=check PASS: history survived restart (${EXPECT} items)`);
  }
  c.ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e); process.exit(2); });