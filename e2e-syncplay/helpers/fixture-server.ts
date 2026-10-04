// The local HTTP server the fixture streams come from. Two properties are
// what it exists for:
//
//  - **Byte ranges.** A `<video>` seeks by issuing a ranged request; a server
//    that only answered 200 would make every seek a full re-download and hide
//    the in-flight window #488 lives in.
//  - **A per-request delay.** #487 and #488 exist only while a load or a seek
//    is in flight, and an instant local file closes that window. Every request
//    waits a uniformly drawn `[minMs, maxMs]` before its headers go out, and a
//    spec sets the band per scenario with `setDelay()`.
//
// `Access-Control-Allow-Origin: *` is required, not decoration: the player's
// `<video>` carries `crossorigin="anonymous"` and the renderer page is
// `file://`, so every fixture load is a CORS request.

import http from 'node:http'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fixtureFor } from './fixtures'

export interface FixtureServer {
  readonly base: string
  setDelay(minMs: number, maxMs?: number): void
  /** Cap each response's throughput (bytes/s; `0` = unthrottled). The
   *  fixtures are ~1 KB per second of media, so an unthrottled element
   *  buffers the whole file within seconds and every later seek lands inside
   *  the buffer without a request — no flight, no window. A throttle keeps the
   *  buffer a few minutes ahead, so a far seek needs a fresh ranged request
   *  and waits out the delay.
   *
   *  The first `UNTHROTTLED_HEAD` bytes of every file go out at full speed:
   *  the `moov` index of a 24-minute faststart MP4 is ~160 KB, and throttling
   *  it to a few KB/s holds every element at `readyState 0` for close to a
   *  minute before anything can play. */
  setRate(bytesPerSec: number): void
  /** Requests answered so far, for diagnostics. */
  requests(): number
  close(): Promise<void>
}

const UNTHROTTLED_HEAD = 256 * 1024

export async function startFixtureServer(): Promise<FixtureServer> {
  let delay = { min: 0, max: 0 }
  let rate = 0
  let count = 0
  const send = (file: string, res: http.ServerResponse, start?: number, end?: number): void => {
    const chunk = 4096
    const src = fs.createReadStream(file, { start, end, highWaterMark: chunk })
    if (rate <= 0) {
      src.pipe(res)
      return
    }
    const perChunkMs = (chunk / rate) * 1000
    let offset = start ?? 0
    src.on('data', (buf) => {
      src.pause()
      const ok = res.write(buf)
      const wait = offset < UNTHROTTLED_HEAD ? 0 : perChunkMs
      offset += buf.length
      const next = (): void => {
        setTimeout(() => src.resume(), wait)
      }
      if (ok) next()
      else res.once('drain', next)
    })
    src.on('end', () => res.end())
    src.on('error', () => res.destroy())
    res.on('close', () => src.destroy())
  }
  const server = http.createServer((req, res) => {
    count++
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const file = fixtureFor(url.pathname)
    const wait = delay.min + Math.random() * (delay.max - delay.min)
    setTimeout(() => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Headers', 'Range')
        res.writeHead(204).end()
        return
      }
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404).end()
        return
      }
      const size = fs.statSync(file).size
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Type', 'video/mp4')
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (range) {
        let start = range[1] === '' ? size - Number(range[2]) : Number(range[1])
        let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1
        start = Math.max(0, start)
        end = Math.min(end, size - 1)
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1)
        })
        if (req.method === 'HEAD') return void res.end()
        send(file, res, start, end)
        return
      }
      res.writeHead(200, { 'Content-Length': String(size) })
      if (req.method === 'HEAD') return void res.end()
      send(file, res)
    }, wait)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    setDelay: (minMs, maxMs = minMs) => {
      delay = { min: minMs, max: Math.max(minMs, maxMs) }
    },
    setRate: (bytesPerSec) => {
      rate = Math.max(0, bytesPerSec)
    },
    requests: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
