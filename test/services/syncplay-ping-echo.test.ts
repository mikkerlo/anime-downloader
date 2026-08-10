// Echoing the server's `ping.latencyCalculation` back to it (#231).
//
// The server stamps every outbound State with its own `time.time()` and expects
// it back, so it can measure its round trip to us and forward-delay-compensate
// the positions we report. Never echoing it left that whole mechanism dead: the
// server's `receiveMessage()` bails on a falsy timestamp, so its RTT and
// forward delay stayed pinned at 0 and our reported position was stored raw.
//
// Two independent mechanisms are under test here and they do not cover for each
// other. The hold-time correction is what makes the echoed number a *network*
// RTT rather than our heartbeat phase; consume-once keeps one server timestamp
// from feeding the server's moving average as N correlated samples. If the
// correction regresses the consume-once test still passes, and if consume-once
// regresses every value on the wire is still arithmetically correct.
//
// Wording rule, load-bearing: every case asserts on "the next outbound State",
// never on "the next heartbeat". #232 adds a second sender for the same frame,
// and a heartbeat-worded assertion would silently flip from testing consume-once
// to testing feature ordering between the two issues the moment it lands.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  destroy = vi.fn(() => {
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

const HEARTBEAT_MS = 1000

type PingBlock = {
  clientLatencyCalculation?: unknown
  clientRtt?: unknown
  latencyCalculation?: unknown
}
type StateFrame = { ping: PingBlock }

const outboundStates = (sock: FakeSocket | null): StateFrame[] =>
  (sock?.write.mock.calls ?? [])
    .map(([f]) => JSON.parse(String(f)) as Record<string, unknown>)
    .filter((f) => 'State' in f)
    .map((f) => f.State as StateFrame)

const lastOutboundState = (sock: FakeSocket | null): StateFrame => {
  const states = outboundStates(sock)
  expect(states.length).toBeGreaterThan(0)
  return states[states.length - 1]
}

describe('SyncplayClient ping.latencyCalculation echo (#231)', () => {
  let client: SyncplayClient

  const handshake = (): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room: 'cinema',
      username: 'me',
      autoReconnect: false
    })
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')
    lastTlsSocket!.emit(
      'data',
      Buffer.from('{"Hello":{"username":"me","room":{"name":"cinema"},"version":"1.6.9"}}\r\n')
    )
  }

  // A ping-only server State — which is also the shape that proves the pair is
  // recorded above handleState()'s `if (!ps) return` guard. It deliberately
  // carries no playstate, so `lastRoomState` stays null and isAdopted() latches
  // on the first sendLocalState(), letting tests that need an immediate send
  // pick the hold exactly instead of riding the heartbeat's phase.
  const serverPing = (ping: Record<string, unknown>): void => {
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ State: { ping } }) + '\r\n'))
  }

  // Drives an immediate outbound State. 'play' rather than 'seek' so the
  // echo-seek guard in sendLocalState() can't swallow the frame.
  const sendNow = (position = 42): void => {
    client.sendLocalState({ paused: false, position, cause: 'play' })
  }

  const clearWrites = (): void => {
    lastTlsSocket!.write.mockClear()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  // 1. The behavior difference itself: on main no outbound frame ever carries
  //    this key.
  it('echoes the server timestamp on the next outbound State', () => {
    const ts = 1_770_000_000.25
    handshake()
    serverPing({ latencyCalculation: ts })
    clearWrites()

    vi.advanceTimersByTime(HEARTBEAT_MS)

    expect(lastOutboundState(lastTlsSocket).ping.latencyCalculation).toBeTypeOf('number')
  })

  // 2. The one that fails on a keep-last implementation as well as on main.
  //    A naive "did we echo it" assertion passes against keep-last just as
  //    readily, which is why this case exists.
  it('consumes the timestamp once — a second outbound State carries no echo', () => {
    handshake()
    serverPing({ latencyCalculation: 1_770_000_000.25 })
    clearWrites()

    vi.advanceTimersByTime(HEARTBEAT_MS)
    vi.advanceTimersByTime(HEARTBEAT_MS)

    const states = outboundStates(lastTlsSocket)
    expect(states).toHaveLength(2)
    expect(states[0].ping.latencyCalculation).toBeTypeOf('number')
    expect(states[1].ping).not.toHaveProperty('latencyCalculation')
  })

  // 3. The correction. The hold is the phase between delivery and the next tick
  //    of the interval armed at finishHandshake(), so the phase is set
  //    explicitly rather than by the advance amount. `ts + 0.8`, not `ts + 800`:
  //    the inbound value is the server's time.time() in seconds while the hold
  //    is a Date.now() difference in milliseconds, and this issue exists because
  //    of a unit-scale error.
  it('adds the measured hold in seconds, not the raw millisecond delta', () => {
    const ts = 1_770_000_000.25
    handshake()
    vi.advanceTimersByTime(200)
    serverPing({ latencyCalculation: ts })
    clearWrites()

    vi.advanceTimersByTime(800)

    const echo = lastOutboundState(lastTlsSocket).ping.latencyCalculation
    expect(echo).toBeCloseTo(ts + 0.8, 6)
  })

  // 8. The boundary the zero-inclusive lower edge exists for. It is #232's ack
  //    frame in miniature — a `ms > 0` guard over the drop rule would silently
  //    lose the most accurate sample this client can produce.
  it('echoes a zero-millisecond hold verbatim rather than dropping it', () => {
    const ts = 1_770_000_000.25
    handshake()
    serverPing({ latencyCalculation: ts })
    clearWrites()

    sendNow()

    expect(lastOutboundState(lastTlsSocket).ping.latencyCalculation).toBe(ts)
  })

  // 9. Tests 1-3 all pass on an implementation that overwrites the timestamp but
  //    not the arrival time; this is the one that catches it. Correct answer is
  //    ts2 + 0.5; the half-updated bug yields ts2 + 0.9.
  it('pairs a newer timestamp with the newer arrival time', () => {
    const ts1 = 1_770_000_000.25
    const ts2 = 1_770_000_111.75
    handshake()
    vi.advanceTimersByTime(100)
    serverPing({ latencyCalculation: ts1 })
    vi.advanceTimersByTime(400)
    serverPing({ latencyCalculation: ts2 })
    clearWrites()

    vi.advanceTimersByTime(500)

    const echo = lastOutboundState(lastTlsSocket).ping.latencyCalculation
    expect(echo).toBeCloseTo(ts2 + 0.5, 6)
    expect(echo).not.toBeCloseTo(ts1 + 0.5, 6)
    expect(echo).not.toBeCloseTo(ts2 + 0.9, 6)
  })

  // 7. Date.now() is a wall clock: an NTP step or a suspend between arrival and
  //    send makes the measured hold meaningless. Echoing verbatim there would
  //    hand the server a positive, plausible-looking RTT inflated by up to a
  //    full heartbeat — the exact failure the correction exists to prevent, and
  //    one the server's own guard (negatives only) cannot catch. So: no key at
  //    all, and the pair is consumed rather than parked for a late echo.
  describe('an out-of-window hold drops the pair instead of echoing it', () => {
    it('drops it when the clock steps backward between arrival and send', () => {
      handshake()
      serverPing({ latencyCalculation: 1_770_000_000.25 })
      clearWrites()

      vi.setSystemTime(Date.now() - 100)
      sendNow()
      // Step back *inside* the window before the second send, or the states[1]
      // assertion below holds for the wrong reason: with the clock still out of
      // window an implementation that parked the pair instead of consuming it
      // would emit no key on the second frame either. From here the shipped code
      // has nothing left to echo, while park-and-retry would carry ts + 0.1.
      vi.setSystemTime(Date.now() + 200)
      sendNow(43)

      const states = outboundStates(lastTlsSocket)
      expect(states).toHaveLength(2)
      expect(states[0].ping).not.toHaveProperty('latencyCalculation')
      expect(states[1].ping).not.toHaveProperty('latencyCalculation')
    })

    it('drops it when the hold reaches the 5 s ceiling', () => {
      handshake()
      serverPing({ latencyCalculation: 1_770_000_000.25 })
      clearWrites()

      vi.setSystemTime(Date.now() + 5000)
      sendNow()
      // Back inside the window before the second send — a net hold of 100 ms
      // from arrival. See the backward-step case above for why.
      vi.setSystemTime(Date.now() - 4900)
      sendNow(43)

      const states = outboundStates(lastTlsSocket)
      expect(states).toHaveLength(2)
      expect(states[0].ping).not.toHaveProperty('latencyCalculation')
      expect(states[1].ping).not.toHaveProperty('latencyCalculation')
    })
  })

  // 4. handleState() type-guards every field it reads and the new read has to as
  //    well, or a malformed frame parks a string for the next echo.
  describe('malformed frames never reach the wire', () => {
    it('ignores a State with no ping object at all', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ State: { playstate: { position: 1, paused: true, setBy: 'peer' } } }) +
            '\r\n'
        )
      )
      clearWrites()

      vi.advanceTimersByTime(HEARTBEAT_MS)

      const ping = lastOutboundState(lastTlsSocket).ping
      expect(ping.clientLatencyCalculation).toBeTypeOf('number')
      expect(ping).not.toHaveProperty('latencyCalculation')
    })

    it('ignores a non-number latencyCalculation', () => {
      handshake()
      serverPing({ latencyCalculation: '1770000000.25' })
      clearWrites()

      vi.advanceTimersByTime(HEARTBEAT_MS)

      const ping = lastOutboundState(lastTlsSocket).ping
      expect(ping.clientLatencyCalculation).toBeTypeOf('number')
      expect(ping).not.toHaveProperty('latencyCalculation')
    })

    // A malformed frame must leave a good stored value alone, not null it.
    it('keeps a previously stored timestamp when a malformed frame follows it', () => {
      const ts = 1_770_000_000.25
      handshake()
      serverPing({ latencyCalculation: ts })
      serverPing({ clientRtt: 0.05 })
      clearWrites()

      sendNow()

      expect(lastOutboundState(lastTlsSocket).ping.latencyCalculation).toBe(ts)
    })
  })

  // 5. The heartbeat is armed at finishHandshake() and can beat the server's
  //    first State. The key must be absent, not 0 — the server discards a 0
  //    anyway, and we already omit clientRtt rather than zero-filling it.
  it('sends no latencyCalculation key before any server State has arrived', () => {
    handshake()
    clearWrites()

    vi.advanceTimersByTime(HEARTBEAT_MS)

    const ping = lastOutboundState(lastTlsSocket).ping
    expect(ping.clientLatencyCalculation).toBeTypeOf('number')
    expect(ping).not.toHaveProperty('latencyCalculation')
    expect(ping.latencyCalculation).toBeUndefined()
  })
})
