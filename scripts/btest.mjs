import net from 'node:net'
const log = (...a) => console.log('[btest]', ...a)

function handshake(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + port +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    let acc = Buffer.alloc(0), opened = false
    const onFrame = (opcode, payload) => {
      if (handleFrame) { try { handleFrame(opcode, payload) } catch (e) { console.error(e) } }
    }
    let handleFrame = null
    s.on('data', (d) => {
      acc = Buffer.concat([acc, d])
      if (!opened) {
        const i = acc.indexOf('\r\n\r\n')
        if (i < 0) return
        const head = acc.subarray(0, i).toString('ascii')
        acc = acc.subarray(i + 4)
        opened = true
        if (!/101/.test(head)) return reject(new Error('no 101: ' + head.slice(0, 60)))
        resolve({ socket: s, send: (t) => s.write(encode(t)), onMessage: (fn) => (handleFrame = fn) })
      }
      // drain
      while (true) {
        const f = parseFrame(acc)
        if (!f) break
        acc = acc.subarray(f.used)
        if (f.opcode === 0x8) { s.end(); return }
        if (f.opcode === 0x1) onFrame(1, f.payload.toString('utf8'))
      }
    })
    s.on('error', reject)
  })
}
function encode(str) {
  const p = Buffer.from(str)
  let head
  if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length])
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0]=0x81; head[1]=0x80|126; head.writeUInt16BE(p.length,2) }
  else { head = Buffer.alloc(10); head[0]=0x81; head[1]=0x80|127; head.writeBigUInt64BE(BigInt(p.length),2) }
  const mask = Buffer.from([1,2,3,4])
  const body = Buffer.alloc(p.length)
  for (let i=0;i<p.length;i++) body[i]=p[i]^mask[i&3]
  return Buffer.concat([head, mask, body])
}
function parseFrame(buf) {
  if (buf.length < 2) return null
  const op = buf[0] & 0x0f
  let len = buf[1] & 0x7f, off = 2
  const masked = !!(buf[1] & 0x80)
  if (len === 126) { if (buf.length<off+2)return null; len=buf.readUInt16BE(off); off+=2 }
  else if (len === 127) { if (buf.length<off+8)return null; len=Number(buf.readBigUInt64BE(off)); off+=8 }
  const mask = masked ? buf.subarray(off, off+4) : null
  if (masked) off += 4
  if (buf.length < off+len) return null
  const pl = Buffer.from(buf.subarray(off, off+len))
  if (mask) for (let i=0;i<pl.length;i++) pl[i] ^= mask[i&3]
  return { opcode: op, payload: pl, used: off+len }
}

async function main() {
  const ui = await handshake(9165)
  log('B:9165 webui 订阅 OK')
  const got = new Promise((resolve) => {
    ui.onMessage((op, text) => { try { const o = JSON.parse(text); log('B:9165 收到:', o.ns+'.'+o.m, JSON.stringify(o.d)); if (o.ns==='message') resolve(o) } catch {} })
  })
  const peer = await handshake(9167)
  log('B:9167 对端握手 OK')
  const pkt = { kind:'text', text:'manual probe @ '+Date.now(), channel:'chat', to:'*' }
  const env = JSON.stringify({ v:1, dir:'req', ns:'message', m:'relay', fromId:'FAKEPEER0000000000000000', pkt })
  peer.send(env)
  log('已向 B:9167 发送 relay')
  const o = await Promise.race([ got, new Promise((_, r) => setTimeout(() => r(new Error('B:9165 未收到广播')), 6000)) ])
  log('=== B 端接收环 OK：webui 收到 message.'+o.m+' ===')
  ui.socket.end(); peer.socket.end(); process.exit(0)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })