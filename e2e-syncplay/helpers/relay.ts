// A byte-level TCP relay on one instance's leg, with the **same** one-way
// delay in both directions. Symmetric on purpose: the client spends its
// measured round trip twice as a one-way estimate (room-anchor back-dating and
// position compensation), so a one-directional delay is wrong by `delay / 2`
// in opposite directions. TLS survives the relay unchanged — it is bytes, and
// the leaf's `IP:127.0.0.1` SAN still validates.
//
// Capped at 250 ms per direction: that is `MAX_ROOM_ANCHOR_LAG_S`, and above
// it the back-dating clamps and the scenario silently changes regime.

import net from 'node:net'
import type { AddressInfo } from 'node:net'

export const MAX_ONE_WAY_MS = 250

export interface Relay {
  readonly port: number
  /** Drop every live connection and refuse new ones (M4's "kill the relay"). */
  cut(): void
  /** Accept connections again after `cut()`. */
  restore(): void
  close(): Promise<void>
}

export async function startRelay(targetPort: number, delayMs: number): Promise<Relay> {
  if (!(delayMs >= 0 && delayMs <= MAX_ONE_WAY_MS)) {
    throw new Error(`relay delay must be 0..${MAX_ONE_WAY_MS} ms each way, got ${delayMs}`)
  }
  const live = new Set<net.Socket>()
  let refusing = false
  const pipe = (from: net.Socket, to: net.Socket): void => {
    from.on('data', (chunk) =>
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk)
      }, delayMs)
    )
    from.on('end', () => setTimeout(() => to.end(), delayMs))
    from.on('error', () => to.destroy())
  }
  const server = net.createServer((c) => {
    if (refusing) {
      c.destroy()
      return
    }
    const u = net.connect(targetPort, '127.0.0.1')
    live.add(c)
    live.add(u)
    pipe(c, u)
    pipe(u, c)
    const drop = (): void => {
      live.delete(c)
      live.delete(u)
      c.destroy()
      u.destroy()
    }
    c.on('close', drop)
    u.on('close', drop)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    cut: () => {
      refusing = true
      for (const s of live) s.destroy()
      live.clear()
    },
    restore: () => {
      refusing = false
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of live) s.destroy()
        server.close(() => resolve())
      })
  }
}
