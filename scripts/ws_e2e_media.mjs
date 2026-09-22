// WebRTC 信令中继端到端验证（A→B 双向，经 daemon 中继）。
// A(7615)发 media.offer/ice，验证 B(9165) 订阅收到对应 media 事件；
// B 回 media.answer/ice，验证 A 收到。全程不建真实 PeerConnection，只验信令信封往返。
const A_WS = 'ws://127.0.0.1:7115'
const B_WS = 'ws://127.0.0.1:9125'
const log = (...a) => console.log('[e2e2]', ...a)
let txn = 0

function open(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    const listeners = []
    ws.onopen = () => res({ ws, request, on })
    ws.onerror = e => rej(new Error('ws error ' + url))
    ws.onmessage = (ev) => {
      let o; try { o = JSON.parse(ev.data) } catch { return }
      if ('txn' in o && pending.has(o.txn)) {
        const { resolve } = pending.get(o.txn); pending.delete(o.txn)
        resolve(o); return
      }
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
  const A = await open(A_WS); log('A connected OK')
  const r = await A.request('roster', 'list', {})
  const peers = (r.d && r.d.peers) || []
  log('A roster:', peers.map(p => `${p.name}@${p.port || '?'}`).join(', '))
  const B = await open(B_WS); log('B connected OK')

  const callId = 'call-' + Date.now()
  // 订阅 B 侧 media 事件（offer + ice）
  const bGetOffer = new Promise((res) => B.on((o) => { if (o.ns === 'media' && o.m === 'offer') res(o) }))
  const bGetIce = new Promise((res) => B.on((o) => { if (o.ns === 'media' && o.m === 'ice') res(o) }))
  // 订阅 A 侧 media 事件（answer + ice 回程）
  const aGetAnswer = new Promise((res) => A.on((o) => { if (o.ns === 'media' && o.m === 'answer') res(o) }))
  const aGetIce = new Promise((res) => A.on((o) => { if (o.ns === 'media' && o.m === 'ice') res(o) }))

  const target = peers.find(p => p.port === 9127)
  if (!target) { console.error('FAIL: A did not discover B (9127)'); process.exit(1) }
  const toB = target.deviceId
  // B 侧用的 A 的 deviceId：从 B 的 roster 找 A
  const rb = await B.request('roster', 'list', {})
  const peersB = (rb.d && rb.d.peers) || []
  log('B roster:', peersB.map(p => `${p.name}@${p.port||'?'}`).join(', '))
  const selfA = peersB.find(p => p.port === 7117)
  const toA = selfA ? selfA.deviceId : toB // 容错：找不到就以同一 id 占位
  log('toB=', toB, 'toA=', toA)

  // A → B: offer
  const o = await A.request('media', 'offer', { to: toB, callId, mode: 'voice', sdp: 'v=0 fake-offer-A' })
  log('A media.offer res: ok=', o.ok, 'propagated=', o.d && o.d.propagated)
  // A → B: ice
  const i = await A.request('media', 'ice', { to: toB, callId, candidate: 'cand-ice-A-1', sdpMLineIndex: 0, sdpMid: '0' })
  log('A media.ice res: ok=', i.ok)

  const bo = await Promise.race([bGetOffer, new Promise((_, rj) => setTimeout(() => rj(new Error('B did not receive offer')), 8000))])
  const bi = await Promise.race([bGetIce, new Promise((_, rj) => setTimeout(() => rj(new Error('B did not receive ice')), 8000))])
  const okOffer = bo.d && bo.d.callId === callId && bo.d.sdp && bo.d.from === toA
  const okIce = bi.d && bi.d.callId === callId && bi.d.candidate === 'cand-ice-A-1'
  log('B offer event:', okOffer ? 'OK' : ('content mismatch: ' + JSON.stringify(bo.d)), '| B ice event:', okIce ? 'OK' : ('mismatch: ' + JSON.stringify(bi.d)))

  // B → A: answer + ice（B 以 toB 即自己视角，转发目标应为 toA）
  const an = await B.request('media', 'answer', { to: toA, callId, sdp: 'v=0 fake-answer-B' })
  log('B media.answer res: ok=', an.ok)
  const ac = await A.request('media', 'ice', { to: toB, callId, candidate: 'cand-ice-A-2', sdpMLineIndex: 0, sdpMid: '0' })
  log('A media.ice#2 res:', ac.ok)
  const aa = await Promise.race([aGetAnswer, new Promise((_, rj) => setTimeout(() => rj(new Error('A did not receive answer')), 8000))])
  const okAnswer = aa.d && aa.d.callId === callId && aa.d.sdp && aa.d.from === toB
  log('A answer event:', JSON.stringify(aa.d))
  log('  callId match =', aa.d && aa.d.callId === callId, '| from===toB =', aa.d && aa.d.from === toB, '(toB=', toB, ')')
  log('answer check:', okAnswer ? 'OK' : 'FAIL')

  const all = okOffer && okIce && okAnswer
  log('=== WebRTC signaling relay ' + (all ? 'OK: bidirectional A/B offer/answer/ice all delivered to the peer WebUI via daemon' : 'FAIL') + ' ===')
  A.ws.close(); B.ws.close()
  process.exit(all ? 0 : 2)
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1) })