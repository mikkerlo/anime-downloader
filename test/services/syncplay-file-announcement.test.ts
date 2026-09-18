// `sendFileUpdate`'s guard, which is a *truthiness* test rather than a null
// test: `server.py:175-178` is `if watcher.getFile():`, and in Python both
// `None` and `{}` are falsey. So a `Set: {file: {}}` keeps its seat in the
// election — `__lt__` asks `self._file is None` — while announcing nothing.
//
// The model relayed `{}` unconditionally until
// `conformance/syncplay-file-membership.conformance.ts` put the two side by
// side against the real 1.7.6 server and captured
// `real=[] model=[{"user":"bravo","file":null}]`. This is that finding at unit
// scale, so the gate that runs on every PR holds the line the nightly found.

import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'
import type { ModelSocket } from '../helpers/syncplay-min-election-server'

interface Seated {
  send: (obj: unknown) => void
  /** The `Set: {user: {…}}` relays carrying a `file`, in arrival order. */
  announcements: () => Array<Record<string, unknown>>
}

describe('MinElectionServer — Set:{file} announcement', () => {
  let server: MinElectionServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
  })

  const seat = (host: MinElectionServer, username: string): Seated => {
    const plain = new EventEmitter() as ModelSocket
    const tls = new EventEmitter() as ModelSocket
    const heard: Array<Record<string, unknown>> = []
    let buf = ''
    tls.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      for (;;) {
        const i = buf.indexOf('\r\n')
        if (i < 0) break
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (!line.trim()) continue
        const msg = JSON.parse(line) as { Set?: { user?: Record<string, unknown> } }
        const users = msg.Set?.user
        if (!users) continue
        for (const body of Object.values(users)) {
          if (body && typeof body === 'object' && 'file' in body) {
            heard.push(body as Record<string, unknown>)
          }
        }
      }
    })
    host.seat({ username, plain, takeTls: () => tls })
    return {
      send: (obj) => plain.write(JSON.stringify(obj)),
      announcements: () => heard
    }
  }

  it('relays a named file to the whole room, sender included', () => {
    // The premise for the two cases below: this path does announce, and it
    // announces back to its own sender (no exclusion, unlike `sendJoinMessage`).
    server = new MinElectionServer({ room: 'cinema', position: 0, paused: true })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')

    bravo.send({ Set: { file: { name: 'b.mkv', duration: 1440, size: 1 } } })

    expect(bravo.announcements()).toHaveLength(1)
    expect(alpha.announcements()).toHaveLength(1)
    expect(alpha.announcements()[0].file).toEqual({ name: 'b.mkv', duration: 1440, size: 1 })
  })

  it('announces nothing for Set:{file:{}}, which is falsey in the reference', () => {
    server = new MinElectionServer({ room: 'cinema', position: 0, paused: true })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')

    bravo.send({ Set: { file: {} } })

    expect(alpha.announcements()).toEqual([])
    expect(bravo.announcements()).toEqual([])
  })

  it('announces nothing for Set:{file:null} either', () => {
    server = new MinElectionServer({ room: 'cinema', position: 0, paused: true })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')

    bravo.send({ Set: { file: { name: 'b.mkv', duration: 1440, size: 1 } } })
    const before = alpha.announcements().length
    bravo.send({ Set: { file: null } })

    expect(alpha.announcements()).toHaveLength(before)
  })
})
