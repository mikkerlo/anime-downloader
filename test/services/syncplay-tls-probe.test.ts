import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  // Mirrors real net.Socket: destroy surfaces an error first (when there is
  // one), then always 'close'. Order matters — 'close' runs
  // resetTransportState(), so an error emitted after it would be read against
  // the next attempt's state. Cannot re-enter onSocketClose() from the
  // teardown paths: tearDown() calls removeAllListeners() before destroy().
  destroyError: (Error & { code?: string }) | null = null
  destroy = vi.fn(() => {
    if (this.destroyError) this.emit('error', this.destroyError)
    this.emit('close')
  })
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

describe('SyncplayClient protocol garbage detection (#215)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>
  const sockets: FakeSocket[] = []
  const tlsSockets: FakeSocket[] = []

  const GARBAGE_REASON =
    'Server sent data that is not Syncplay protocol — is this a Syncplay server?'

  const connect = (autoReconnect = false): void => {
    client.connect({ host: 'syncplay.test', port: 8999, room: 'r', username: 'u', autoReconnect })
  }

  beforeEach(() => {
    sockets.length = 0
    tlsSockets.length = 0
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
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  it('aborts the handshake after 5 unparseable lines (HTTP server on the port)', () => {
    connect()
    lastSocket!.emit('connect')
    lastSocket!.emit(
      'data',
      'HTTP/1.1 400 Bad Request\r\n' +
        'Content-Type: text/html\r\n' +
        'Connection: close\r\n' +
        '\r\n' +
        '<html>bad request</html>\r\n' +
        'trailing junk\r\n'
    )

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(GARBAGE_REASON)
  })

  it('aborts on the 64 KB byte cap when the stream has no newlines at all', () => {
    connect()
    lastSocket!.emit('connect')
    lastSocket!.emit('data', 'x'.repeat(64 * 1024))

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(GARBAGE_REASON)
  })

  it('does not accumulate parse failures across attempts', async () => {
    vi.useFakeTimers()
    try {
      connect(true)
      // Attempt 1: three garbage lines — below the threshold of 5 — then dies.
      sockets[0].emit('connect')
      sockets[0].emit('data', 'junk one\r\njunk two\r\njunk three\r\n')
      sockets[0].emit('close')
      await vi.advanceTimersByTimeAsync(1000)

      // Attempt 2: three more garbage lines. A session-scoped counter would
      // cross the threshold here and kill a server that recovers.
      sockets[1].emit('connect')
      sockets[1].emit('data', 'junk four\r\njunk five\r\njunk six\r\n')
      expect(statuses[statuses.length - 1].state).not.toBe('disconnected')

      // The same attempt then completes normally.
      sockets[1].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
      tlsSockets[0].emit('secureConnect')
      tlsSockets[0].emit('data', '{"Hello":{"username":"u","room":{"name":"r"}}}\r\n')
      expect(client.getStatus().state).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts failures across the TLS upgrade within one attempt', () => {
    connect()
    // Three garbage lines on the plaintext socket…
    sockets[0].emit('connect')
    sockets[0].emit('data', 'junk one\r\njunk two\r\njunk three\r\n')
    sockets[0].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
    tlsSockets[0].emit('secureConnect')
    // …and two more on the TLS socket cross the threshold for the attempt.
    tlsSockets[0].emit('data', 'junk four\r\njunk five\r\n')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(GARBAGE_REASON)
  })

  it('does not kill a live session on a corrupt line post-ready', () => {
    connect()
    sockets[0].emit('connect')
    sockets[0].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
    tlsSockets[0].emit('secureConnect')
    tlsSockets[0].emit('data', '{"Hello":{"username":"u","room":{"name":"r"}}}\r\n')
    expect(client.getStatus().state).toBe('ready')

    tlsSockets[0].emit('data', 'corrupt frame that is not JSON\r\n')

    expect(client.getStatus().state).toBe('ready')
    client.disconnect()
  })
})

describe('SyncplayClient handshake watchdog (#215)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>
  let roomEvents: Array<{ level: string; text: string }>
  const sockets: FakeSocket[] = []
  const tlsSockets: FakeSocket[] = []

  const connect = (autoReconnect: boolean): void => {
    client.connect({ host: 'syncplay.test', port: 8999, room: 'r', username: 'u', autoReconnect })
  }

  const poke = (): { reconnectAttempts: number } =>
    client as unknown as { reconnectAttempts: number }

  beforeEach(() => {
    sockets.length = 0
    tlsSockets.length = 0
    vi.useFakeTimers()
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
    statuses = []
    roomEvents = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
    client.on('room-event', (e) => roomEvents.push(e as { level: string; text: string }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires after 8s of silence and names the phase (no retry configured)', async () => {
    connect(false)
    sockets[0].emit('connect')
    await vi.advanceTimersByTimeAsync(8000)

    expect(sockets[0].destroy).toHaveBeenCalled()
    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('No reply received in 8s while in tls-probing')
  })

  it('uses the TCP-specific wording in the connecting phase, where nothing was sent yet', async () => {
    connect(false)
    // No 'connect' event — the TCP connect itself is hanging.
    await vi.advanceTimersByTimeAsync(8000)

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(
      'Could not establish a TCP connection within 8s — the host may be unreachable or the port filtered'
    )
  })

  it('defers to the reconnect path instead of hard-aborting, with its own neutral room-event', async () => {
    connect(true)
    sockets[0].emit('connect')
    await vi.advanceTimersByTimeAsync(8000)

    expect(statuses[statuses.length - 1].state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)

    expect(roomEvents.some((e) => e.text === 'No reply received in 8s while in tls-probing')).toBe(
      true
    )
    expect(roomEvents.some((e) => e.text.startsWith('Connection error'))).toBe(false)
  })

  it('carries the short watchdog wording into the maxed-out error', async () => {
    connect(true)
    sockets[0].emit('connect')
    await vi.advanceTimersByTimeAsync(8000)
    await vi.advanceTimersByTimeAsync(1000)
    poke().reconnectAttempts = 5
    sockets[1].emit('connect')
    await vi.advanceTimersByTimeAsync(8000)

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(
      'Max reconnect attempts reached — no reply received in 8s while in tls-probing'
    )
  })

  it('does not fire when the handshake completes in time', async () => {
    connect(false)
    sockets[0].emit('connect')
    sockets[0].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
    tlsSockets[0].emit('secureConnect')
    tlsSockets[0].emit('data', '{"Hello":{"username":"u","room":{"name":"r"}}}\r\n')
    expect(client.getStatus().state).toBe('ready')

    await vi.advanceTimersByTimeAsync(20000)

    // Assert on states, not write counts — the 1s heartbeat also fires here.
    expect(client.getStatus().state).toBe('ready')
    expect(statuses.some((s) => s.state === 'disconnected')).toBe(false)
    client.disconnect()
  })

  it('a watchdog armed on attempt N does not fire during a successful attempt N+1', async () => {
    connect(true)
    // Attempt 1 dies early on a transport error, well before 8s.
    const err = new Error('connect ECONNREFUSED 1.2.3.4:8999') as Error & { code?: string }
    err.code = 'ECONNREFUSED'
    sockets[0].emit('error', err)
    sockets[0].emit('close')
    await vi.advanceTimersByTimeAsync(1000)

    // Attempt 2 completes; the (cleared) attempt-1 timer must not kill it.
    sockets[1].emit('connect')
    sockets[1].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
    tlsSockets[0].emit('secureConnect')
    tlsSockets[0].emit('data', '{"Hello":{"username":"u","room":{"name":"r"}}}\r\n')
    expect(client.getStatus().state).toBe('ready')

    await vi.advanceTimersByTimeAsync(10000)
    expect(client.getStatus().state).toBe('ready')
    expect(statuses.some((s) => s.state === 'disconnected')).toBe(false)
    client.disconnect()
  })

  it('suppresses the fatal-TLS classifier for the destroy-induced ECONNRESET in tls-handshake', async () => {
    connect(true)
    sockets[0].emit('connect')
    sockets[0].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
    // Node reports destroy-before-secureConnect exactly like this:
    const err = new Error(
      'Client network socket disconnected before secure TLS connection was established'
    ) as Error & { code?: string }
    err.code = 'ECONNRESET'
    tlsSockets[0].destroyError = err

    await vi.advanceTimersByTimeAsync(8000)

    // Reconnect path, not the hard abort the classifier would produce.
    expect(statuses[statuses.length - 1].state).toBe('reconnecting')
    expect(statuses.some((s) => s.error?.startsWith('TLS error'))).toBe(false)
    expect(roomEvents.some((e) => e.text.startsWith('Connection error'))).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
  })

  it('watchdogDetail outranks the destroy-induced transport error in the final message', async () => {
    connect(true)
    sockets[0].emit('connect')
    sockets[0].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
    const err = new Error(
      'Client network socket disconnected before secure TLS connection was established'
    ) as Error & { code?: string }
    err.code = 'ECONNRESET'
    tlsSockets[0].destroyError = err
    poke().reconnectAttempts = 5

    await vi.advanceTimersByTimeAsync(8000)

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(
      'Max reconnect attempts reached — no reply received in 8s while in tls-handshake'
    )
    expect(last.error).not.toContain('ECONNRESET')
  })

  it('a genuine ECONNRESET in tls-handshake on the next attempt still hard-aborts', async () => {
    // The only case that distinguishes a per-attempt fired flag from a
    // per-session one.
    connect(true)
    sockets[0].emit('connect')
    await vi.advanceTimersByTimeAsync(8000)
    await vi.advanceTimersByTimeAsync(1000)

    sockets[1].emit('connect')
    sockets[1].emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
    const err = new Error('read ECONNRESET') as Error & { code?: string }
    err.code = 'ECONNRESET'
    tlsSockets[0].emit('error', err)

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toMatch(/^TLS error/)
  })

  it('is cleared on user teardown — no fire after disconnect()', async () => {
    connect(false)
    client.disconnect()
    const count = statuses.length
    expect(statuses[statuses.length - 1].state).toBe('idle')

    await vi.advanceTimersByTimeAsync(20000)

    expect(statuses).toHaveLength(count)
  })
})
