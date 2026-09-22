// 探针：直连两个 daemon 的 WS，确认局域网内互相发现（不带 WebUI，隔离 CDP 变量）。
const [A_WS, B_WS] = ['ws://127.0.0.1:7115/ws', 'ws://127.0.0.1:9125/ws'];
const log = (...a) => console.log('[probe]', ...a);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let seq = 0;
function open(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); const pend = new Map(); const listeners = [];
    ws.onopen = () => res({ ws, req, on });
    ws.onerror = e => rej(new Error('ws ' + url));
    ws.onmessage = e => { let o; try { o = JSON.parse(e.data) } catch { return }
      if ('txn' in o && pend.has(o.txn)) { const {r} = pend.get(o.txn); pend.delete(o.txn); r(o); return }
      for (const L of listeners) { try { L(o) } catch {} } };
    function req(ns, m, d) { return new Promise(r => { const t = `p${++seq}`; pend.set(t, { r }); ws.send(JSON.stringify({ v: 1, dir: 'req', ns, m, txn: t, d })); }); }
    function on(fn) { listeners.push(fn); }
  });
}
await new Promise(r => setTimeout(r, 3000)); // 等组播总线稳定
const A = await open(A_WS); const B = await open(B_WS);
const al = await A.req('identity', 'hello', { deviceId: 'PROBE-A', name: 'ProbeA', platform: 'win', version: 'x' });
const bl = await B.req('identity', 'hello', { deviceId: 'PROBE-B', name: 'ProbeB', platform: 'win', version: 'x' });
log('A hello ok=', al.ok, 'B hello ok=', bl.ok);
await A.req('discovery', 'scan_start', { requireCross: true });
await B.req('discovery', 'scan_start', { requireCross: true });
for (let i = 0; i < 8; i++) {
  if (i % 2 === 0) await A.req('discovery', 'scan_ping', {});
  await wait(700);
}
const ra = await A.req('roster', 'list', {});
const rb = await B.req('roster', 'list', {});
log('A roster:', (ra.d?.peers || []).map(p => `${p.name}@${p.port}`).join(', ') || '(empty)');
log('B roster:', (rb.d?.peers || []).map(p => `${p.name}@${p.port}`).join(', ') || '(empty)');
A.ws.close(); B.ws.close();
process.exit(0);