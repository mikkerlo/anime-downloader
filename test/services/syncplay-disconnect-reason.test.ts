import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

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

import { SyncplayClient } from '../../src/main/syncplay'

type Phase = 'connecting' | 'tls-probing' | 'tls-handshake' | 'hello-sent' | 'ready'

// Drives the current attempt to the given phase. The fake socket never emits
// 'connect' on its own, so 'connecting' means doing nothing — which also makes
// it the phase every legacy fake-socket test sits in.
function reachPhase(phase: Phase): void {
  if (phase === 'connecting') return
  lastSocket!.emit('connect')
  if (phase === 'tls-probing') return
  lastSocket!.emit('data', '{"TLS":{"startTLS":"true"}}\r\n')
  if (phase === 'tls-handshake') return
  lastTlsSocket!.emit('secureConnect')
  if (phase === 'hello-sent') return
  lastTlsSocket!.emit('data', '{"Hello":{"username":"u","room":{"name":"r"}}}\r\n')
}

// The live socket after reachPhase: the TLS upgrade detaches the raw socket's
// listeners, so post-upgrade phases must close the TLS fake instead.
function liveSocket(phase: Phase): FakeSocket {
  return phase === 'connecting' || phase === 'tls-probing' ? lastSocket! : lastTlsSocket!
}

describe('SyncplayClient onSocketClose disconnect reason (#119)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  beforeEach(() => {
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  it('names the phase (not "Auto-reconnect disabled") when autoReconnect is off and the socket drops', () => {
    client.connect({
      host: 'example.test',
      port: 8999,
      room: 'r',
      username: 'u',
      autoReconnect: false
    })
    expect(lastSocket).not.toBeNull()
    // Simulate the socket dropping without ever connecting.
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Connection closed before it was established')
    expect(last.error).not.toBe('Auto-reconnect disabled')
  })

  it('still reports "Max reconnect attempts reached" (with the phase suffix) when retries are exhausted', () => {
    client.connect({
      host: 'example.test',
      port: 8999,
      room: 'r',
      username: 'u',
      autoReconnect: true
    })
    // Force the client past the max-attempts threshold so onSocketClose hits
    // the "give up" branch on the next close.
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Max reconnect attempts reached — never established')
  })
})

describe('SyncplayClient transport error surfacing (#213)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  const connect = (autoReconnect = false): void => {
    client.connect({ host: 'example.test', port: 8999, room: 'r', username: 'u', autoReconnect })
  }

  const socketError = (message: string, code?: string): void => {
    const err = new Error(message) as Error & { code?: string }
    err.code = code
    lastSocket!.emit('error', err)
  }

  beforeEach(() => {
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  it.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 93.184.216.34:8999'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND example.test'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 93.184.216.34:8999']
  ])('surfaces %s in the disconnected error instead of bare "Connection closed"', (code, msg) => {
    connect()
    socketError(msg, code)
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(`Connection closed — ${msg}`)
  })

  it('appends the code when the message does not already contain it', () => {
    connect()
    socketError('read gone wrong', 'ECONNRESET')
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.error).toBe('Connection closed — read gone wrong (ECONNRESET)')
  })

  it('suffixes the maxed-out error with the most recent attempt failure', () => {
    connect(true)
    socketError('connect ETIMEDOUT 93.184.216.34:8999', 'ETIMEDOUT')
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 4
    lastSocket!.emit('close')
    // The retry re-enters via openSocket(); its failure overwrites the stale one.
    socketError('connect ECONNREFUSED 93.184.216.34:8999', 'ECONNREFUSED')
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(
      'Max reconnect attempts reached — connect ECONNREFUSED 93.184.216.34:8999'
    )
  })

  it('clears the remembered error once the session reaches ready', () => {
    connect(true)
    // Attempt 1 fails; attempt 2 succeeds (finishHandshake fires).
    socketError('connect ECONNREFUSED 93.184.216.34:8999', 'ECONNREFUSED')
    ;(client as unknown as { finishHandshake(): void }).finishHandshake()
    // Much later the server closes cleanly (no fresh error event) during
    // retries that also close cleanly — the surfaced reason must not be the
    // stale pre-ready failure. The attempt reached ready, so the phase suffix
    // is "connection lost".
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Max reconnect attempts reached — connection lost')
  })

  it('clears the remembered error on a fresh user-initiated connect()', () => {
    connect()
    socketError('connect ECONNREFUSED 93.184.216.34:8999', 'ECONNREFUSED')
    lastSocket!.emit('close')

    connect()
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.error).toBe('Connection closed before it was established')
    expect(last.error).not.toContain('ECONNREFUSED')
  })

  it('keeps the no-config close silent: disconnected with no error at all', () => {
    connect()
    // Reproduce the !cfg branch: close arrives after config was torn down but
    // while status is not yet idle.
    ;(client as unknown as { config: unknown }).config = null
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBeUndefined()
  })
})

describe('SyncplayClient phase-aware close reasons (#215)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  const connect = (autoReconnect = false): void => {
    client.connect({ host: 'example.test', port: 8999, room: 'r', username: 'u', autoReconnect })
  }

  beforeEach(() => {
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  const LONG: Array<[Phase, string]> = [
    ['connecting', 'Connection closed before it was established'],
    [
      'tls-probing',
      'Server closed the connection during the TLS probe — it may not be a Syncplay server, or may not support TLS (Syncplay 1.6.3+ required)'
    ],
    ['tls-handshake', 'Server closed the connection during the TLS handshake'],
    ['hello-sent', 'Server closed the connection during login without a reply'],
    ['ready', 'Connection to the server was lost']
  ]

  // autoReconnect: false is the Settings test button's exact configuration, so
  // this table exercises the phase map with no retry composition on top.
  it.each(LONG)('errorless close in %s → long-form phase reason (no retry)', (phase, expected) => {
    connect(false)
    reachPhase(phase)
    liveSocket(phase).emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(expected)
  })

  const SHORT: Array<[Phase, string]> = [
    ['connecting', 'never established'],
    ['tls-probing', 'no reply to TLS probe'],
    ['tls-handshake', 'TLS handshake incomplete'],
    ['hello-sent', 'no reply to login'],
    ['ready', 'connection lost']
  ]

  it.each(SHORT)('errorless close in %s → maxed-out prefix + short variant', (phase, short) => {
    connect(true)
    reachPhase(phase)
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
    liveSocket(phase).emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(`Max reconnect attempts reached — ${short}`)
  })

  it('names the last attempt phase, not a stale transport error from an earlier attempt', async () => {
    vi.useFakeTimers()
    try {
      connect(true)
      // Attempt 1 fails with a transport error.
      const err = new Error('connect ECONNREFUSED 93.184.216.34:8999') as Error & { code?: string }
      err.code = 'ECONNREFUSED'
      lastSocket!.emit('error', err)
      lastSocket!.emit('close')
      // The retry timer fires and openSocket() opens attempt 2.
      await vi.advanceTimersByTimeAsync(1000)
      // Attempt 2 reaches tls-probing, then dies on an errorless FIN.
      lastSocket!.emit('connect')
      ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
      lastSocket!.emit('close')

      const last = statuses[statuses.length - 1]
      expect(last.state).toBe('disconnected')
      expect(last.error).toBe('Max reconnect attempts reached — no reply to TLS probe')
      expect(last.error).not.toContain('ECONNREFUSED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leak the phase forward: attempt 2 dying early names its own phase, not attempt 1’s', async () => {
    vi.useFakeTimers()
    try {
      connect(true)
      // Attempt 1 gets deep into the handshake…
      reachPhase('hello-sent')
      lastTlsSocket!.emit('close')
      // …attempt 2 opens and dies before TCP even connects.
      await vi.advanceTimersByTimeAsync(1000)
      ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
      lastSocket!.emit('close')

      const last = statuses[statuses.length - 1]
      expect(last.state).toBe('disconnected')
      expect(last.error).toBe('Max reconnect attempts reached — never established')
      expect(last.error).not.toContain('login')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SyncplayClient non-escalated server Error surfacing (#215)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  const connect = (autoReconnect = false): void => {
    client.connect({ host: 'example.test', port: 8999, room: 'r', username: 'u', autoReconnect })
  }

  beforeEach(() => {
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  it('surfaces the server text verbatim when a pre-ready Error frame precedes the FIN', () => {
    connect(false)
    reachPhase('hello-sent')
    lastTlsSocket!.emit('data', '{"Error":{"message":"Room name is invalid"}}\r\n')
    lastTlsSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Room name is invalid')
  })

  it('keeps the maxed-out prefix in front of the server text', () => {
    connect(true)
    reachPhase('hello-sent')
    lastTlsSocket!.emit('data', '{"Error":{"message":"Room name is invalid"}}\r\n')
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
    lastTlsSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.error).toBe('Max reconnect attempts reached — Room name is invalid')
  })

  it('post-ready Error frames stay room-events: a later close reads "Connection to the server was lost"', () => {
    connect(false)
    reachPhase('ready')
    lastTlsSocket!.emit('data', '{"Error":{"message":"Room name is invalid"}}\r\n')
    lastTlsSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Connection to the server was lost')
  })

  it('a login-phase Error does not outlive an attempt that reaches ready anyway', () => {
    // The server complains but then sends Hello regardless (e.g. it dropped us
    // into a default room). The pre-ready record gate alone passes this test
    // green only with the finishHandshake() clear in place.
    connect(false)
    reachPhase('hello-sent')
    lastTlsSocket!.emit('data', '{"Error":{"message":"Room name is invalid"}}\r\n')
    lastTlsSocket!.emit('data', '{"Hello":{"username":"u","room":{"name":"r"}}}\r\n')
    expect(statuses[statuses.length - 1].state).toBe('ready')

    lastTlsSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Connection to the server was lost')
  })
})

describe('SyncplayClient stale status.error hygiene (#215)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  const connect = (): void => {
    client.connect({
      host: 'example.test',
      port: 8999,
      room: 'r',
      username: 'u',
      autoReconnect: false
    })
  }

  beforeEach(() => {
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  it('a fresh attempt clears the previous failure from status.error', () => {
    connect()
    lastSocket!.emit('close')
    expect(statuses[statuses.length - 1].error).toBeDefined()

    connect()

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('connecting')
    expect(last.error).toBeUndefined()
  })

  it('reaching ready clears the previous failure from status.error', () => {
    connect()
    lastSocket!.emit('close')
    expect(statuses[statuses.length - 1].error).toBeDefined()

    connect()
    reachPhase('ready')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('ready')
    expect(last.error).toBeUndefined()

    client.disconnect()
  })

  it('an explicit Disconnect after a failure does not park the error under idle', () => {
    connect()
    lastSocket!.emit('close')
    expect(statuses[statuses.length - 1].error).toBeDefined()

    client.disconnect()

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('idle')
    expect(last.error).toBeUndefined()
  })
})

describe('SyncplayClient.getRoomUsers (#213)', () => {
  it('returns a snapshot of the current room users', () => {
    const client = new SyncplayClient()
    expect(client.getRoomUsers()).toEqual([])

    client.connect({
      host: 'example.test',
      port: 8999,
      room: 'r',
      username: 'me',
      autoReconnect: false
    })
    const internal = client as unknown as {
      handleList(payload: unknown): void
    }
    internal.handleList({
      r: {
        me: { file: null },
        friend: {
          file: { name: 'Frieren - 12', duration: 1420 },
          isReady: true
        }
      }
    })

    const users = client.getRoomUsers()
    expect(users).toHaveLength(2)
    const friend = users.find((u) => u.username === 'friend')
    expect(friend?.file).toEqual({ name: 'Frieren - 12', duration: 1420, size: undefined })
    expect(friend?.isReady).toBe(true)

    // Mutating the snapshot must not leak into client state.
    users[0].username = 'mutated'
    expect(client.getRoomUsers().map((u) => u.username)).toEqual(
      expect.arrayContaining(['me', 'friend'])
    )
  })
})
