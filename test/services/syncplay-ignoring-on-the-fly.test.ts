// The `ignoringOnTheFly` server-counter half of the protocol (#232).
//
// Two divergences from the reference are under test, and they are separate
// mechanisms that fail differently:
//
//  1. We never zeroed our own `pendingClientAck` when a server counter arrived,
//     so a *peer's* forced State crossing our own unacked change on the wire was
//     eaten by the drop guard in handleState(). A forced State is one-shot and
//     is never resent; in the forward-seek direction the room then re-derives
//     its position from min(watchers), our stale position wins, and the peer's
//     seek is silently reverted for the whole room. The reference zeroes
//     unconditionally (protocols.py:287-288).
//  2. We only echoed the counter back on the next 1 s heartbeat. Until it lands
//     the server both discards every playstate we assert (protocols.py:788) and
//     suppresses its own periodic States (:761) — a bidirectional deaf window,
//     on the scrubbing user's *own* connection.
//
// Anti-vacuity rule, load-bearing for every case here: sendLocalState() has
// three silent exits that leave `pendingClientAck` at 0 (the adoption gate, the
// drift check once `lastRoomState` is set, and the echo-seek guard). Any of them
// makes a "the drop guard is bypassed" assertion pass against the old code too,
// so every test that means to arm the guard asserts `pendingClientAck > 0`
// before delivering the inbound frame.

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

type StateFrame = {
  ping?: Record<string, unknown>
  playstate?: { position: number; paused?: boolean; doSeek?: boolean }
  ignoringOnTheFly?: { server?: number; client?: number }
}

// Unlike statesOf() in the #220 room-presence harness, this one surfaces
// `ignoringOnTheFly` and the *presence* of a playstate key — both are the
// subject here, and projecting only `playstate` would hide the ack entirely.
const outboundStates = (sock: FakeSocket | null): StateFrame[] =>
  (sock?.write.mock.calls ?? [])
    .map(([f]) => JSON.parse(String(f)) as Record<string, unknown>)
    .filter((f) => 'State' in f)
    .map((f) => f.State as StateFrame)

describe('SyncplayClient ignoringOnTheFly server counter (#232)', () => {
  let client: SyncplayClient
  let remoteStates: Array<{ position: number; setBy: string }>

  const pendingClientAck = (): number =>
    (client as unknown as { pendingClientAck: number }).pendingClientAck

  const pendingServerAck = (): number =>
    (client as unknown as { pendingServerAck: number }).pendingServerAck

  const connectToTls = (): void => {
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
  }

  const finishHandshake = (): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from('{"Hello":{"username":"me","room":{"name":"cinema"},"version":"1.6.9"}}\r\n')
    )
  }

  // The `List` reply is part of the fixture, not decoration: since #236 the
  // roster is what grants adoption, so without it `isAdopted()` returns false
  // and `armLocalSeek()` below never bumps `pendingClientAck` — the anti-vacuity
  // assertion every guard case here rests on. An entry for our room with nobody
  // else in it is the "alone" case, which is the shape this harness has always
  // meant to describe.
  const handshake = (): void => {
    connectToTls()
    finishHandshake()
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ List: { cinema: {} } }) + '\r\n'))
  }

  // A server-forced State as it actually appears on the wire: the counter and
  // the playstate ride the *same* frame (protocols.py:748-760). Writing them as
  // two frames would let an implementation that zeroes after the playstate block
  // pass while still shipping the bug.
  const forcedState = (opts: {
    server?: number
    client?: number
    setBy?: string | null
    position?: number
    paused?: boolean
    withPlaystate?: boolean
  }): void => {
    const state: Record<string, unknown> = { ping: { latencyCalculation: 1_770_000_000.25 } }
    const iotf: Record<string, number> = {}
    if (opts.server !== undefined) iotf.server = opts.server
    if (opts.client !== undefined) iotf.client = opts.client
    if (Object.keys(iotf).length > 0) state.ignoringOnTheFly = iotf
    if (opts.withPlaystate !== false) {
      state.playstate = {
        position: opts.position ?? 500,
        paused: opts.paused ?? false,
        doSeek: true,
        setBy: opts.setBy === undefined ? 'peer' : opts.setBy
      }
    }
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ State: state }) + '\r\n'))
  }

  // Arms the drop guard. 'seek' is the cause the issue names, and the `List`
  // reply in handshake() has latched isAdopted() by the time this runs, so the
  // counter really does bump — asserted by every caller rather than assumed.
  const armLocalSeek = (position = 100): void => {
    client.sendLocalState({ paused: false, position, cause: 'seek' })
  }

  const clearWrites = (): void => {
    lastTlsSocket!.write.mockClear()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    remoteStates = []
    client.on('remote-state', (s) => remoteStates.push(s as { position: number; setBy: string }))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  // 1. The behaviour difference. On the old code the drop guard eats this frame
  //    and nothing reaches the renderer. Note the counter and the playstate are
  //    in one frame, which is what makes this fail against an implementation
  //    that zeroes *after* the playstate block.
  it('applies a peer-forced State that arrives while a local change is unacked', () => {
    handshake()
    armLocalSeek()
    expect(pendingClientAck()).toBeGreaterThan(0)

    forcedState({ server: 7, setBy: 'peer', position: 500 })

    expect(remoteStates).toHaveLength(1)
    expect(remoteStates[0].setBy).toBe('peer')
    expect(pendingClientAck()).toBe(0)
  })

  // 2. The ack shape — the property a dedicated sendAck() exists to make
  //    testable. Deliberately non-vacuous: the trailing heartbeat assertion
  //    proves buildPlaystate() *would* have returned something at this moment,
  //    so a sendStateMessage()-based implementation cannot pass by accident.
  it('answers with a ping-only frame carrying the counter and no playstate', () => {
    handshake()
    client.updateSnapshot({ position: 100, paused: false })
    armLocalSeek()
    expect(pendingClientAck()).toBeGreaterThan(0)
    clearWrites()

    forcedState({ server: 7, setBy: 'peer', position: 500 })

    const acks = outboundStates(lastTlsSocket)
    expect(acks).toHaveLength(1)
    expect(acks[0].ignoringOnTheFly).toEqual({ server: 7 })
    expect(acks[0]).not.toHaveProperty('playstate')
    expect(acks[0].ping).toBeDefined()

    // The anti-vacuity half: the very next heartbeat does carry a playstate, so
    // its absence above is a property of the ack, not of the fixture.
    clearWrites()
    vi.advanceTimersByTime(HEARTBEAT_MS)
    expect(outboundStates(lastTlsSocket)[0]).toHaveProperty('playstate')
  })

  // 3. It is the ack, not the heartbeat: no timer is advanced anywhere above or
  //    here, and the frame is already on the wire.
  it('writes the ack without any timer advancing', () => {
    handshake()
    clearWrites()

    forcedState({ server: 3, setBy: 'peer' })

    expect(outboundStates(lastTlsSocket)).toHaveLength(1)
    expect(outboundStates(lastTlsSocket)[0].ignoringOnTheFly).toEqual({ server: 3 })
    expect(pendingServerAck()).toBe(0)
  })

  // 4. The call-site test. Tests 1-3 all deliver a peer `setBy` and so pass at
  //    either call site; this is the one that fails if sendAck() is moved to the
  //    end of handleState(), because the self-`setBy` guard returns first. And
  //    self-`setBy` is the *dominant* path for a counter-bearing frame: the
  //    server broadcasts its forced update back to the setter too, so a
  //    scrubbing user's own connection is precisely the deaf one.
  it('still acks a forced State the server reflects back with our own setBy', () => {
    handshake()
    clearWrites()

    forcedState({ server: 9, setBy: 'me', position: 500 })

    const acks = outboundStates(lastTlsSocket)
    expect(acks).toHaveLength(1)
    expect(acks[0].ignoringOnTheFly).toEqual({ server: 9 })
    expect(acks[0]).not.toHaveProperty('playstate')
    // The frame is still not applied locally — acking is not accepting.
    expect(remoteStates).toHaveLength(0)
  })

  // 5. The ready guard, and the reason sendStateMessage()'s own counter drain is
  //    not dead code after this change. dispatch() has no readiness gate, so a
  //    State genuinely reaches handleState() mid-handshake.
  describe('the ready guard', () => {
    it('sends nothing for a counter that arrives before the handshake completes', () => {
      connectToTls()
      clearWrites()

      forcedState({ server: 5, setBy: 'peer' })

      expect(outboundStates(lastTlsSocket)).toHaveLength(0)
    })

    it('retains that counter and drains it on the first heartbeat once ready', () => {
      connectToTls()
      forcedState({ server: 5, setBy: 'peer' })
      expect(pendingServerAck()).toBe(5)

      finishHandshake()
      clearWrites()
      vi.advanceTimersByTime(HEARTBEAT_MS)

      const states = outboundStates(lastTlsSocket)
      expect(states).toHaveLength(1)
      expect(states[0].ignoringOnTheFly?.server).toBe(5)
      expect(pendingServerAck()).toBe(0)
    })

    // Not a `sendAck()` ready-guard case, despite sitting in this block:
    // tearDown() calls socket.removeAllListeners() (src/main/syncplay.ts:418)
    // before destroy(), so the frame below reaches no handler and handleState()
    // never runs — `outboundStates()` alone would be empty against any
    // implementation, guard or no guard (verified: deleting the guard leaves
    // this case green while the pre-`ready` pair above goes red). What it pins
    // is that teardown detaches the socket, asserted directly on the counter
    // and the emit so the case is not vacuous. The guard itself is covered by
    // that pre-`ready` pair.
    it('does not process a counter arriving after disconnect', () => {
      handshake()
      const sock = lastTlsSocket!
      client.disconnect()
      sock.write.mockClear()

      sock.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            State: { ignoringOnTheFly: { server: 4 }, playstate: { position: 1, setBy: 'peer' } }
          }) + '\r\n'
        )
      )

      expect(pendingServerAck()).toBe(0)
      expect(remoteStates).toHaveLength(0)
      expect(outboundStates(sock)).toHaveLength(0)
    })
  })

  // 6. Unchanged behaviour. The client-echo arm still does its job on frames
  //    that carry no server key, which is the only case it can still reach.
  describe('the client-echo arm is unchanged', () => {
    it('clears a matching client echo', () => {
      handshake()
      armLocalSeek()
      const counter = pendingClientAck()
      expect(counter).toBeGreaterThan(0)

      forcedState({ client: counter, setBy: 'peer' })

      expect(pendingClientAck()).toBe(0)
      expect(remoteStates).toHaveLength(1)
    })

    it('leaves an unrelated pending ack alone on a non-matching client echo', () => {
      handshake()
      armLocalSeek()
      const counter = pendingClientAck()
      expect(counter).toBeGreaterThan(0)
      clearWrites()

      forcedState({ client: counter + 40, setBy: 'peer' })

      expect(pendingClientAck()).toBe(counter)
      // Still dropped, and no ack: there was no server counter to answer.
      expect(remoteStates).toHaveLength(0)
      expect(outboundStates(lastTlsSocket)).toHaveLength(0)
    })
  })

  // The #231 seam: the ack is a full outbound State and must build its echo
  // through the shared consume-once helper, or two senders reading the stored
  // pair independently re-introduce the duplicate-sample bug. The timestamp
  // arrives on the very frame the ack answers, so the hold is 0 ms — which is
  // exactly why that helper's window is zero-inclusive.
  describe('#231 latency echo rides the ack', () => {
    it('echoes the just-arrived server timestamp on the ack frame itself', () => {
      handshake()
      clearWrites()

      forcedState({ server: 2, setBy: 'peer' })

      const ack = outboundStates(lastTlsSocket)[0]
      expect(ack.ping?.latencyCalculation).toBe(1_770_000_000.25)
    })

    it('consumes it once — the following heartbeat carries no echo', () => {
      handshake()
      clearWrites()

      forcedState({ server: 2, setBy: 'peer' })
      vi.advanceTimersByTime(HEARTBEAT_MS)

      const states = outboundStates(lastTlsSocket)
      expect(states).toHaveLength(2)
      expect(states[0].ping?.latencyCalculation).toBe(1_770_000_000.25)
      expect(states[1].ping).not.toHaveProperty('latencyCalculation')
    })
  })
})
