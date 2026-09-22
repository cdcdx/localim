const url = process.argv[2] || 'ws://127.0.0.1:7615'
const ws = new WebSocket(url)
ws.onopen = () => {
  ws.send(JSON.stringify({ v:1, dir:'req', ns:'identity', m:'hello', txn:'hi', d:{} }))
  setTimeout(()=> ws.send(JSON.stringify({ v:1, dir:'req', ns:'roster', m:'list', txn:'ro', d:{} })), 200)
}
ws.onmessage = e => {
  const o = JSON.parse(e.data)
  if (o.txn === 'hi' || o.txn === 'ro') {
    console.log(url, 'resp', o.txn, '=>', JSON.stringify(o.d))
    if (o.txn==='ro') ws.close()
  }
}
ws.onclose = () => process.exit(0)
setTimeout(()=>{console.error('timeout');process.exit(1)}, 5000)