// Poll roster.list on a daemon until it sees the expected peer count (or timeout).
const port = process.argv[2];
const label = process.argv[3];
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const seen = [];
const poll = () => ws.send(JSON.stringify({ v: 1, dir: 'req', ns: 'roster', m: 'list', txn: 'probe', d: {} }));

ws.onopen = () => {
  poll();
  setInterval(poll, 800);
};
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.dir === 'res' && m.m === 'list') {
    const peers = (m.d?.peers || []).map((p) => `${p.deviceId.slice(0, 8)}(${p.name},peer:${p.port},via:${p.via})`);
    if (seen.length && JSON.stringify(seen) === JSON.stringify(peers)) return;
    seen.push(peers);
    console.log(`[${label}] roster: ${peers.length ? peers.join(' | ') : '(empty)'}`);
    if (peers.length >= 1) { console.log(`[${label}] DONE: got ${peers.length} peer(s)`); ws.close(); process.exit(0); }
  }
};
ws.onerror = () => { console.error(`[${label}] ws error`); process.exit(1); };
setTimeout(() => { console.log(`[${label}] timeout, last=${JSON.stringify(seen[seen.length - 1] || [])}`); ws.close(); process.exit(0); }, 8000);