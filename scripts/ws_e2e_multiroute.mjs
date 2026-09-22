// 多网卡 / 多网段智能选路端到端验证（mac / linux / win 通用，产物路径按平台补 .exe）。
//
// 场景：两台 daemon 各自独立 presence 端口（组播互不可达，模拟"不同网段"），
// 仅经共享 relay 互发现 —— 用来验证：
//   1) 公告/注册携带多网卡候选地址 addrs（relay 原样透传）；
//   2) roster.list 带 addrs，且选路挑出的 host 落在候选里；
//   3) 按候选地址拨号后文字单聊可互达。
//
// 用法：node scripts/ws_e2e_multiroute.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', '..', 'src', 'out', 'localim');
const EXT = process.platform === 'win32' ? '.exe' : '';
const DAEMON = join(OUT, 'localim_daemon' + EXT);
const RELAY = join(OUT, 'localim_relay' + EXT);

const RELAY_PORT = 7718;
// 两个"网段"：presence 端口不同则组播互不可达，只能靠 relay 发现。
const NODES = [
  { name: 'A', webui: 8020, peer: 8022, presence: 7016 },
  { name: 'B', webui: 8120, peer: 8122, presence: 7116 },
];

const log = (...a) => console.log('[multiroute]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
const dirs = [];

function launch(exe, args) {
  const p = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  procs.push(p);
  return p;
}

function wsOpen(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let txn = 0;
    ws.onopen = () => res({ ws, request, on });
    ws.onerror = () => rej(new Error('ws error ' + url));
    ws.onmessage = (ev) => {
      let o;
      try { o = JSON.parse(ev.data); } catch { return; }
      if ('txn' in o && pending.has(o.txn)) {
        const { resolve } = pending.get(o.txn);
        pending.delete(o.txn);
        resolve(o);
        return;
      }
      for (const L of listeners) { try { L(o); } catch {} }
    };
    function request(ns, m, d = {}) {
      return new Promise((resolve) => {
        const t = `${++txn}`;
        pending.set(t, { resolve });
        ws.send(JSON.stringify({ v: 1, dir: 'req', ns, m, txn: t, d }));
      });
    }
    function on(fn) { listeners.push(fn); }
  });
}

async function main() {
  launch(RELAY, [`--relay-port=${RELAY_PORT}`]);
  await wait(800);

  for (const n of NODES) {
    const dir = await mkdtemp(join(os.tmpdir(), `localim_${n.name}_`));
    dirs.push(dir);
    launch(DAEMON, [
      `--user-data-dir=${dir}`,
      `--webui-port=${n.webui}`,
      `--peer-port=${n.peer}`,
      `--presence-port=${n.presence}`,
      `--relay-port=${RELAY_PORT}`,
      '--relay-host=127.0.0.1',
    ]);
  }
  await wait(1500);

  const A = await wsOpen(`ws://127.0.0.1:${NODES[0].webui}`);
  const B = await wsOpen(`ws://127.0.0.1:${NODES[1].webui}`);
  log('both daemons connected');

  // 1) 经 relay 互发现 + 候选地址透传
  let peerB = null;
  for (let i = 0; i < 20 && !peerB; i++) {
    const r = await A.request('roster', 'list', {});
    const peers = (r.d && r.d.peers) || [];
    peerB = peers.find((p) => p.port === NODES[1].peer) || null;
    if (!peerB) await wait(700);
  }
  if (!peerB) { console.error('FAIL: A did not discover B via relay'); process.exit(1); }
  const addrs = peerB.addrs || [];
  log('A sees B:', peerB.deviceId, 'via=' + peerB.via, 'host=' + peerB.host, 'addrs=' + JSON.stringify(addrs));
  if (peerB.via !== 'relay') { console.error('FAIL: peer not discovered via relay'); process.exit(1); }
  if (addrs.length === 0) { console.error('FAIL: roster carried no candidate addrs'); process.exit(1); }
  if (!addrs.includes(peerB.host)) { console.error('FAIL: chosen host not in candidates'); process.exit(1); }

  // 2) 按候选地址拨号后文字互达
  const received = new Promise((resolve) => {
    B.on((o) => { if (o.ns === 'message') resolve(o); });
  });
  const body = 'route probe @ ' + Date.now();
  const sr = await A.request('message', 'send', { kind: 'text', text: body, channel: 'chat', to: peerB.deviceId });
  log('message.send ok=', sr.ok);
  const got = await Promise.race([
    received,
    new Promise((_, rej) => setTimeout(() => rej(new Error('B did not receive within 10s')), 10000)),
  ]);
  const ok = got.d && (got.d.body === body || got.d.text === body);
  log(ok ? 'PASS: relay-discovered peer dialed via ranked candidate, text delivered'
         : 'FAIL: content mismatch ' + JSON.stringify(got.d));
  process.exit(ok ? 0 : 2);
}

main()
  .catch((e) => { console.error('FAIL', e.message); process.exit(1); })
  .finally(async () => {
    for (const p of procs) { try { process.kill(-p.pid); } catch {} try { p.kill(); } catch {} }
    for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch {} }
  });
