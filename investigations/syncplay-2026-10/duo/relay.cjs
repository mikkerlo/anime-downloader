// Byte-level TCP relay with an equal one-way delay in both directions.
// usage: node relay.cjs <listenPort> <targetPort> <delayMs>
const net = require('net')
const [lp, tp, dms] = process.argv.slice(2).map(Number)
if (!(dms >= 0 && dms <= 250)) throw new Error('delay must be 0..250 ms')
const pipe = (from, to) => {
  from.on('data', (chunk) => setTimeout(() => { if (!to.destroyed) to.write(chunk) }, dms))
  from.on('end', () => setTimeout(() => to.end(), dms))
  from.on('error', () => to.destroy())
}
net.createServer((c) => {
  const u = net.connect(tp, '127.0.0.1')
  pipe(c, u)
  pipe(u, c)
  c.on('close', () => u.destroy())
  u.on('close', () => c.destroy())
}).listen(lp, '127.0.0.1', () => console.log(`relay ${lp} -> ${tp} delay ${dms}ms each way`))
