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

  const connectToTls = (opts: { autoReconnect?: boolean } = {}): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room: 'cinema',
      username: 'me',
      autoReconnect: opts.autoReconnect === true
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
  const handshake = (opts: { autoReconnect?: boolean } = {}): void => {
    connectToTls(opts)
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

    // Two frames since #252, not one: this fixture is 400 s divergent (snapshot
    // 100, room 500) with a seek intent pending, so the recovery frame follows
    // the ack. The property under test is unchanged and is about frame [0] —
    // the *ack* never carries a playstate, whatever rides behind it.
    const acks = outboundStates(lastTlsSocket)
    expect(acks).toHaveLength(2)
    expect(acks[0].ignoringOnTheFly).toEqual({ server: 7 })
    expect(acks[0]).not.toHaveProperty('playstate')
    expect(acks[0].ping).toBeDefined()
    expect(acks[1].playstate?.doSeek).toBe(true)

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

  // #252 — the other half of the same deaf window. #232 made us answer the
  // counter on receipt instead of on the heartbeat, shortening the interval in
  // which the server discards our playstates (protocols.py:788-789) to ~1 RTT.
  // It did not close it: a seek already on the wire, or issued before the
  // forced State reached us, is thrown away, and nothing re-asserts it — the
  // seeker's player moves, the room does not, and the divergence is permanent
  // because our own reflected forced State returns at the self-`setBy` guard.
  //
  // Every case here carries the anti-vacuity precondition from the header:
  // `pendingClientAck > 0` proves the seek was really asserted rather than
  // dropped by one of sendLocalState()'s silent exits.
  describe('re-asserting a seek the server threw away (#252)', () => {
    const seekIntent = (): { at: number; attempts: number } | null =>
      (client as unknown as { seekIntent: { at: number; attempts: number } | null }).seekIntent

    const doSeekFrames = (): StateFrame[] =>
      outboundStates(lastTlsSocket).filter((s) => s.playstate?.doSeek === true)

    // The forced update our own seek caused, reflected back with the room still
    // at its pre-seek position. `setBy: 'me'` is the default because that is the
    // dominant shape of this bug: broadcastRoom() has no sender filter
    // (server.py:180-186), so the scrubbing user's own connection is the deaf
    // one — and it is the shape that proves the recovery sits *above*
    // handleState()'s self-`setBy` guard rather than below it, where it would be
    // dead code.
    const roomStillAt = (position: number, opts: { server?: number; setBy?: string } = {}): void =>
      forcedState({
        server: opts.server ?? 7,
        setBy: opts.setBy ?? 'me',
        position,
        paused: false
      })

    // Seek forward, deliberately: a *backward* seek converges by coincidence on
    // today's code, because a downgraded `doSeek: false` heartbeat still writes
    // our position server-side and Room.getPosition() takes min(watchers), so
    // the seeker happens to be the min. A regression test built on one would
    // pass against the bug.
    const armForwardSeek = (): void => {
      client.updateSnapshot({ position: 100, paused: false })
      armLocalSeek(400)
      expect(pendingClientAck()).toBeGreaterThan(0)
    }

    it('re-asserts a forward seek the room never took', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(100)

      // Fails on the old code: the ack goes out and nothing else ever does,
      // because `doSeek` is one-shot and the next heartbeat re-sends the same
      // position with `doSeek: false`.
      const seeks = doSeekFrames()
      expect(seeks).toHaveLength(1)
      expect(seeks[0].playstate?.position).toBe(400)
    })

    it('orders the recovery behind the ack and leaves the ack playstate-free', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(100, { server: 11 })

      // Two ordered frames, never one packed frame: the ack clears the server's
      // flag at protocols.py:776-777, *above* the :788 gate, so the playstate on
      // the frame behind it is the first one accepted. Packing them would mean
      // shipping a playstate on the ack, which #232 settled against.
      const states = outboundStates(lastTlsSocket)
      expect(states).toHaveLength(2)
      expect(states[0].ignoringOnTheFly).toEqual({ server: 11 })
      expect(states[0]).not.toHaveProperty('playstate')
      expect(states[1].playstate).toMatchObject({ position: 400, doSeek: true })
      // No counter bump on the recovery: it carries no *new* intent, and
      // re-arming the drop guard here would starve the inbound convergence #232
      // opened this window to preserve.
      expect(states[1]).not.toHaveProperty('ignoringOnTheFly')
      expect(pendingClientAck()).toBe(0)
    })

    it('also recovers when the forced State comes from a peer', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(100, { setBy: 'peer' })

      expect(doSeekFrames()).toHaveLength(1)
    })

    it('re-asserts where the user is now, never the position the seek targeted', () => {
      handshake()
      armForwardSeek()
      // The user played on from the target while the frame was in flight.
      // Replaying the parked target here would seek the room — and, through the
      // broadcast, the user — backwards by the elapsed playback, with min() over
      // watchers amplifying the stale value into the room's own position.
      client.updateSnapshot({ position: 412, paused: false })
      clearWrites()

      roomStillAt(100)

      expect(doSeekFrames()[0].playstate?.position).toBe(412)
    })

    it('sends no recovery once the room has taken our position', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(400)

      expect(doSeekFrames()).toHaveLength(0)
      expect(seekIntent()).toBeNull()
      // Non-vacuous: the frame was processed, it just resolved the intent.
      expect(outboundStates(lastTlsSocket)).toHaveLength(1)
    })

    it('gives up after three unanswered re-asserts', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      for (let i = 0; i < 6; i += 1) roomStillAt(100, { server: 20 + i })

      // The bound. Unbounded stickiness is a permanent fight with the renderer's
      // 3 s apply rule against a room that will never adopt us.
      expect(doSeekFrames()).toHaveLength(3)
      expect(seekIntent()).toBeNull()
    })

    it('drops an intent the room never answered within the TTL', () => {
      handshake()
      armForwardSeek()
      // Keep pushing snapshots so the player stays live — otherwise the
      // spectator guard, not the TTL, is what this would be testing.
      for (let i = 1; i <= 6; i += 1) {
        vi.advanceTimersByTime(1000)
        client.updateSnapshot({ position: 400 + i, paused: false })
      }
      clearWrites()

      roomStillAt(100)

      expect(doSeekFrames()).toHaveLength(0)
      expect(seekIntent()).toBeNull()
    })

    it('never stamps doSeek on the spectator mirror (#220)', () => {
      handshake()
      armForwardSeek()
      // The player closed: no more snapshot pushes, so hasLivePlayback() goes
      // false and buildPlaystate() falls through to the room's own mirror.
      // Stamping doSeek on that hands the room its own position back as a seek.
      vi.advanceTimersByTime(6000)
      clearWrites()

      roomStillAt(100)

      expect(doSeekFrames()).toHaveLength(0)
      expect(seekIntent()).toBeNull()
      // Anti-vacuity: buildPlaystate() *does* have something to return at this
      // moment — the mirror — so the absence above is a property of the guard
      // rather than of an empty fixture.
      clearWrites()
      vi.advanceTimersByTime(HEARTBEAT_MS)
      const mirror = outboundStates(lastTlsSocket)[0]
      expect(mirror.playstate).toBeDefined()
      expect(mirror.playstate).not.toHaveProperty('paused')
      expect(mirror.playstate?.doSeek).toBe(false)
    })

    describe('a superseding local state', () => {
      it('re-arms on a second seek and recovers the newest position', () => {
        handshake()
        armForwardSeek()
        armLocalSeek(700)
        // Last write wins, and because the recovery reads the live snapshot
        // rather than a parked target, "the newest seek" and "where the user is
        // now" are the same value.
        expect(seekIntent()?.attempts).toBe(0)
        clearWrites()

        roomStillAt(100)

        expect(doSeekFrames()[0].playstate?.position).toBe(700)
      })

      it('is not retracted by a play/pause', () => {
        handshake()
        armForwardSeek()
        // The playhead is still where the user put it and the room still has not
        // taken it, so the intent stands — and the recovery frame carries the
        // pause too, since it asserts the current snapshot.
        client.sendLocalState({ paused: true, position: 400, cause: 'pause' })
        expect(seekIntent()).not.toBeNull()
        clearWrites()

        roomStillAt(100)

        expect(doSeekFrames()[0].playstate).toMatchObject({
          position: 400,
          paused: true,
          doSeek: true
        })
      })
    })

    describe('scope', () => {
      it('survives a reconnect', () => {
        // A dropped socket is precisely a reason the seek never landed, so
        // clearing the intent in resetTransportState() would discard it exactly
        // when it is most likely to be unresolved.
        handshake({ autoReconnect: true })
        armForwardSeek()

        lastTlsSocket!.emit('close')

        expect(seekIntent()).not.toBeNull()
        // Non-vacuous: the per-socket state really was reset around it.
        expect(pendingClientAck()).toBe(0)
      })

      it('does not survive tearDown', () => {
        handshake()
        armForwardSeek()

        client.disconnect()

        expect(seekIntent()).toBeNull()
      })

      it('does not survive a new player announcing a file', () => {
        handshake()
        armForwardSeek()

        client.setFile({
          animeId: 1,
          malId: null,
          episodeInt: '2',
          translationId: null,
          canonicalName: 'Show - 2',
          duration: 1440,
          newPlayer: true
        })

        expect(seekIntent()).toBeNull()
      })

      it('does not survive the player going away and coming back', () => {
        // The same-episode reopen setFile() cannot see: a fresh <video> under a
        // byte-identical canonicalName. updateSnapshot()'s staleness check is
        // the detector, and it de-adopts here too.
        handshake()
        armForwardSeek()

        vi.advanceTimersByTime(6000)
        client.updateSnapshot({ position: 0, paused: true })

        expect(seekIntent()).toBeNull()
      })
    })
  })
})
