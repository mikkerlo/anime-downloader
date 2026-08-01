import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  destroy = vi.fn()
  write = vi.fn()
}

let lastSocket: FakeSocket | null = null
let lastTlsSocket: FakeSocket | null = null

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    lastSocket = new FakeSocket()
    return lastSocket
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => {
    lastTlsSocket = new FakeSocket()
    return lastTlsSocket
  })
}))

import * as net from 'net'
import * as tls from 'tls'
import { SyncplayClient } from '../../src/main/syncplay'

const written = (sock: FakeSocket | null): unknown[] =>
  (sock?.write.mock.calls ?? []).map(([frame]) => JSON.parse(String(frame)))

describe('SyncplayClient startTLS probe (#216)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  const connect = (): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room: 'r',
      username: 'u',
      autoReconnect: false
    })
    lastSocket!.emit('connect')
  }

  beforeEach(() => {
    lastSocket = null
    lastTlsSocket = null
    vi.mocked(tls.connect).mockClear()
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  // Real Syncplay servers key off `startTLS`; we used to send `{option:'send'}`,
  // which the server answers by dropping the TCP connection outright.
  it('probes with the protocol key `startTLS`, not `option`', () => {
    connect()

    expect(lastSocket!.write).toHaveBeenCalledTimes(1)
    const [frame] = lastSocket!.write.mock.calls[0]
    expect(String(frame)).toBe('{"TLS":{"startTLS":"send"}}\r\n')
    expect(written(lastSocket)[0]).toEqual({ TLS: { startTLS: 'send' } })
  })

  it('upgrades and sends Hello when the server answers startTLS:"true"', () => {
    connect()
    lastSocket!.emit('data', Buffer.from('{"TLS": {"startTLS": "true"}}\r\n'))

    expect(tls.connect).toHaveBeenCalledTimes(1)
    lastTlsSocket!.emit('secureConnect')

    const hello = written(lastTlsSocket)[0] as { Hello: { username: string; version: string } }
    expect(hello.Hello.username).toBe('u')
    expect(statuses.map((s) => s.state)).toContain('hello-sent')
  })

  // The server MD5s its own --password at startup and compares digests, so a
  // plaintext password is rejected with "Wrong password supplied".
  it('sends the room password as an MD5 hex digest, never in plaintext', () => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room: 'r',
      username: 'u',
      password: 'hunter2',
      autoReconnect: false
    })
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS": {"startTLS": "true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')

    const hello = written(lastTlsSocket)[0] as { Hello: { password?: string } }
    expect(hello.Hello.password).toBe(createHash('md5').update('hunter2', 'utf8').digest('hex'))
    expect(hello.Hello.password).not.toBe('hunter2')
  })

  it('omits the password field entirely when no password is configured', () => {
    connect()
    lastSocket!.emit('data', Buffer.from('{"TLS": {"startTLS": "true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')

    const hello = written(lastTlsSocket)[0] as { Hello: Record<string, unknown> }
    expect(hello.Hello).not.toHaveProperty('password')
  })

  it('fails the handshake when the server answers startTLS:"false"', () => {
    connect()
    lastSocket!.emit('data', Buffer.from('{"TLS": {"startTLS": "false"}}\r\n'))

    expect(tls.connect).not.toHaveBeenCalled()
    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toMatch(/does not support TLS/)
  })
})

// Before #216 nothing ever got past the probe, so `tlsUpgraded` was never true
// and this path was unreachable. Fixing the probe exposed it: the reconnect in
// onSocketClose() never cleared the flag, so the retry's probe reply was treated
// as spurious and the client hung in 'tls-probing' forever.
describe('SyncplayClient reconnect after a TLS session (#216)', () => {
  let client: SyncplayClient
  const sockets: FakeSocket[] = []
  const tlsSockets: FakeSocket[] = []

  const reachReady = (): void => {
    sockets[sockets.length - 1].emit('connect')
    sockets[sockets.length - 1].emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    tlsSockets[tlsSockets.length - 1].emit('secureConnect')
    tlsSockets[tlsSockets.length - 1].emit(
      'data',
      Buffer.from('{"Hello":{"username":"u","room":{"name":"r"}}}\r\n')
    )
  }

  beforeEach(() => {
    sockets.length = 0
    tlsSockets.length = 0
    vi.mocked(tls.connect).mockClear()
    // Collect every socket, not just the last — the retry opens a second one.
    vi.mocked(net.createConnection).mockImplementation((() => {
      lastSocket = new FakeSocket()
      sockets.push(lastSocket)
      return lastSocket
    }) as unknown as typeof net.createConnection)
    vi.mocked(tls.connect).mockImplementation((() => {
      lastTlsSocket = new FakeSocket()
      tlsSockets.push(lastTlsSocket)
      return lastTlsSocket
    }) as unknown as typeof tls.connect)
    client = new SyncplayClient()
  })

  it('re-upgrades to TLS on the retry instead of hanging in tls-probing', async () => {
    vi.useFakeTimers()
    try {
      client.connect({
        host: 'syncplay.test',
        port: 8999,
        room: 'r',
        username: 'u',
        autoReconnect: true
      })
      reachReady()
      expect(client.getStatus().state).toBe('ready')

      // Server drops the connection; auto-reconnect opens a fresh socket.
      tlsSockets[0].emit('close')
      await vi.advanceTimersByTimeAsync(1500)
      expect(sockets).toHaveLength(2)

      reachReady()

      expect(tls.connect).toHaveBeenCalledTimes(2)
      expect(client.getStatus().state).toBe('ready')
      expect(client.getStatus().tls).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the per-socket ack counters when the retry opens', async () => {
    vi.useFakeTimers()
    try {
      client.connect({
        host: 'syncplay.test',
        port: 8999,
        room: 'r',
        username: 'u',
        autoReconnect: true
      })
      reachReady()
      // An unacked local change would otherwise suppress every inbound remote
      // state on the new socket, since the server never echoes a counter it
      // has not seen.
      client.sendLocalState({ paused: false, position: 12, cause: 'play' })
      expect((client as unknown as { pendingClientAck: number }).pendingClientAck).toBeGreaterThan(
        0
      )

      tlsSockets[0].emit('close')
      await vi.advanceTimersByTimeAsync(1500)

      expect((client as unknown as { pendingClientAck: number }).pendingClientAck).toBe(0)
      expect((client as unknown as { serverRtt: number }).serverRtt).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
