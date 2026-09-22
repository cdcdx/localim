// A→B 文字单聊端到端验证（Node>=22 全局 WebSocket）。
// 连到 A(7615) 发 message.send，连到 B(9165) 订阅，验证 B 收到聊天事件广播。
const A_WS = 'ws://127.0.0.1:7615'
const B_WS = 'ws://127.0.0.1:9165'
const log = (...a) => console.log('[e2e1n1]', ...a)
let txn = 0

function open(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const pending = new Map()   // txn -> resolve
    const listeners = []
    ws.onopen = () => res({ ws, request, on })
    ws.onerror = e => rej(new Error('ws error ' + url))
    ws.onmessage = (ev) => {
      let o; try { o = JSON.parse(ev.data) } catch { return }
      // 响应：回显我发的 txn 且带 ok 字段 → 解挂起请求
      if ('txn' in o && pending.has(o.txn)) {
        const { resolve } = pending.get(o.txn); pending.delete(o.txn)
        resolve(o)
        return
      }
      // 否则视为事件广播
      for (const L of listeners) { try { L(o) } catch {} }
    }
    function request(ns, m, d) {
      return new Promise((resolve) => {
        const t = `${++txn}`
        pending.set(t, { resolve })
        ws.send(JSON.stringify({ v: 1, dir: 'req', ns, m, txn: t, d }))
      })
    }
    function on(fn) { listeners.push(fn) }
  })
}

async function main() {
  const A = await open(A_WS)
  log('A 连接 OK')
  const r = await A.request('roster', 'list', {})
  const peers = r.d && r.d.peers ? r.d.peers : []
  log('A 在线表:', peers.length, '->', peers.map(p => `${p.name}@${p.port || '?'}`).join(', '))
  const peerB = peers.find(p => p.port === 9167)
  if (!peerB) { console.error('FAIL: A 未发现 B(9167)'); process.exit(1) }

  const B = await open(B_WS)
  log('B 连接 OK')
  B.on((o) => log('B 事件流(原样):', JSON.stringify(o)))
  const received = new Promise((resolve) => {
    B.on((o) => { if (o.ns === 'message') { log('B 收到 message 事件:', JSON.stringify(o)); resolve(o) } })
  })

  const body = 'hello from A @ ' + Date.now()
  const sr = await A.request('message', 'send', { kind: 'text', text: body, channel: 'chat', to: peerB.deviceId })
  log('A message.send 响应: ok=', sr.ok, 'accepted=', sr.d && sr.d.accepted)

  const got = await Promise.race([
    received,
    new Promise((_, rej) => setTimeout(() => rej(new Error('B 未在 10s 内收到事件')), 10000)),
  ])

  const ok = got.d && (got.d.body === body || got.d.text === body || got.d.content === body)
  log('=== 单聊链路 ' + (ok ? 'OK：A 已发送，B 已收到文本' : '但内容未完全对齐: ' + JSON.stringify(got.d)) + ' ===')
  A.ws.close(); B.ws.close()
  process.exit(ok ? 0 : 2)
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1) })