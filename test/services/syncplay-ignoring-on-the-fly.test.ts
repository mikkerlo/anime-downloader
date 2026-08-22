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

import {
  SyncplayClient,
  ADOPT_TOLERANCE_S,
  ECHO_SEEK_EPSILON_S,
  SEEK_REASSERT_TOLERANCE_S
} from '../../src/main/syncplay'

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
  // `paused` and `doSeek` are projected as well as `position`/`setBy` since
  // #278: the rewrite rule substitutes *only* the position, and "the other three
  // fields pass through unchanged" is the half of it that keeps #228's pause
  // projection and the renderer's "X seeked to …" gating intact.
  type EmittedState = {
    position: number
    setBy: string | null
    paused: boolean
    doSeek: boolean
  }
  let remoteStates: EmittedState[]

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
  //
  // `doSeek` is an option rather than a constant because the server forces a
  // room update on a seek *or* a pause change (server.py:180-186), and the two
  // are different frames on the wire: only the seek carries `doSeek: true`, and
  // only the seek is a claim that somebody moved the room. Hardcoding it made
  // every fixture here a peer *seek* whether it meant to be one or not.
  const forcedState = (opts: {
    server?: number
    client?: number
    setBy?: string | null
    position?: number
    paused?: boolean
    doSeek?: boolean
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
        doSeek: opts.doSeek !== false,
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
    client.on('remote-state', (s) => remoteStates.push(s as EmittedState))
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

    // One frame. `forcedState()` defaults to `doSeek: true`, so on the wire this
    // is a peer seeking to 500 while our seek to 100 is unresolved — which
    // supersedes ours (#274 review), and no recovery frame follows. The property
    // under test is unchanged and is about frame [0]: the *ack* never carries a
    // playstate, whatever does or does not ride behind it.
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

    // The room's resting position and where the user scrubs to. The gap is
    // expressed in SEEK_REASSERT_TOLERANCE_S rather than hardcoded (#274
    // review): every fixture below means "the room never took our seek", which
    // is only a real divergence while the gap exceeds that tolerance, so a
    // hardcoded one would quietly stop testing anything the day the constant
    // grows past it. The converged fixtures below are derived from it too, from
    // the other side.
    const ROOM_POSITION = 100
    const SEEK_TARGET = ROOM_POSITION + 4 * SEEK_REASSERT_TOLERANCE_S

    // The forced update the room sent while it was still at its pre-seek
    // position. `setBy: 'me'` is the default because that is the dominant shape
    // of this bug: broadcastRoom() has no sender filter (server.py:180-186), so
    // the scrubbing user's own connection is the deaf one — and it is the shape
    // that proves the recovery sits *above* handleState()'s self-`setBy` guard
    // rather than below it, where it would be dead code.
    //
    // `doSeek: false` throughout: a forced update whose playstate still shows
    // the room where it was is by construction not a report that somebody
    // seeked it there. The server forces the same update on a pause change, and
    // that is the frame this describes (#274 review). The seek-carrying shape is
    // its own case in the supersede block below, where it means something else
    // entirely.
    const roomStillAt = (position: number, opts: { server?: number; setBy?: string } = {}): void =>
      forcedState({
        server: opts.server ?? 7,
        setBy: opts.setBy ?? 'me',
        position,
        paused: false,
        doSeek: false
      })

    // A peer really seeked, and the server took it: `doSeek` set, a foreign
    // `setBy`, and a position that is the peer's target rather than the room's
    // old resting place.
    const peerSeeksTo = (position: number, opts: { server?: number } = {}): void =>
      forcedState({
        server: opts.server ?? 7,
        setBy: 'peer',
        position,
        paused: false,
        doSeek: true
      })

    // Seek forward, deliberately: a *backward* seek converges by coincidence on
    // today's code, because a downgraded `doSeek: false` heartbeat still writes
    // our position server-side and Room.getPosition() takes min(watchers), so
    // the seeker happens to be the min. A regression test built on one would
    // pass against the bug.
    const armForwardSeek = (): void => {
      client.updateSnapshot({ position: ROOM_POSITION, paused: false })
      armLocalSeek(SEEK_TARGET)
      expect(pendingClientAck()).toBeGreaterThan(0)
    }

    it('re-asserts a forward seek the room never took', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(ROOM_POSITION)

      // Fails on the old code: the ack goes out and nothing else ever does,
      // because `doSeek` is one-shot and the next heartbeat re-sends the same
      // position with `doSeek: false`.
      const seeks = doSeekFrames()
      expect(seeks).toHaveLength(1)
      expect(seeks[0].playstate?.position).toBe(SEEK_TARGET)
      // The read half of the same tick (#278). Here the self-`setBy` guard is
      // what keeps the room's stale 100 away from the renderer, so the
      // assertion is that nothing was handed over at all; the peer-`setBy`
      // sibling below is where the rewrite itself carries it.
      expect(remoteStates).toHaveLength(0)
    })

    it('orders the recovery behind the ack and leaves the ack playstate-free', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(ROOM_POSITION, { server: 11 })

      // Two ordered frames, never one packed frame: the ack clears the server's
      // flag at protocols.py:776-777, *above* the :788 gate, so the playstate on
      // the frame behind it is the first one accepted. Packing them would mean
      // shipping a playstate on the ack, which #232 settled against.
      const states = outboundStates(lastTlsSocket)
      expect(states).toHaveLength(2)
      expect(states[0].ignoringOnTheFly).toEqual({ server: 11 })
      expect(states[0]).not.toHaveProperty('playstate')
      expect(states[1].playstate).toMatchObject({ position: SEEK_TARGET, doSeek: true })
      // No counter bump on the recovery: it carries no *new* intent, and
      // re-arming the drop guard here would starve the inbound convergence #232
      // opened this window to preserve.
      expect(states[1]).not.toHaveProperty('ignoringOnTheFly')
      expect(pendingClientAck()).toBe(0)
      // Both halves of the tick (#278): two frames out, nothing in.
      expect(remoteStates).toHaveLength(0)
    })

    // The placement claim, on a frame the self-`setBy` guard does not swallow:
    // recovery has to fire off a peer-`setBy` forced update too. Pause-driven on
    // purpose (#274 review) — `roomStillAt()` sends `doSeek: false`, so this is
    // "a peer paused and the room reported it is still at 100", not "a peer
    // seeked to 100". The seek-carrying version of the same frame is the
    // supersede case below and has the opposite outcome, which is exactly why
    // this one must not borrow its shape.
    it('also recovers when the forced State comes from a peer', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(ROOM_POSITION, { setBy: 'peer' })

      expect(doSeekFrames()).toHaveLength(1)
      expect(doSeekFrames()[0].playstate?.position).toBe(SEEK_TARGET)
      // **The regression assertion for #278.** This is the frame that reaches
      // the renderer, and on `main` before the fix it carried ROOM_POSITION:
      // the recovery told the *server* the room was wrong at 112 and the same
      // tick told the *renderer* to go to 100, which the renderer applies at
      // |112 − 100| = 12 > 3 and the user sees as being yanked backwards. One
      // line, and it has been failing silently on every run since #224.
      expect(remoteStates).toHaveLength(1)
      expect(remoteStates[0].position).toBe(SEEK_TARGET)
    })

    it('re-asserts where the user is now, never the position the seek targeted', () => {
      handshake()
      armForwardSeek()
      // The user played on from the target while the frame was in flight.
      // Replaying the parked target here would seek the room — and, through the
      // broadcast, the user — backwards by the elapsed playback, with min() over
      // watchers amplifying the stale value into the room's own position.
      client.updateSnapshot({ position: SEEK_TARGET + 12, paused: false })
      clearWrites()

      roomStillAt(ROOM_POSITION)

      expect(doSeekFrames()[0].playstate?.position).toBe(SEEK_TARGET + 12)
      // Both halves again (#278): the self-`setBy` guard drops this one, so the
      // room's 100 never reaches the renderer here either.
      expect(remoteStates).toHaveLength(0)
    })

    it('sends no recovery once the room has taken our position', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(SEEK_TARGET)

      expect(doSeekFrames()).toHaveLength(0)
      expect(seekIntent()).toBeNull()
      // Non-vacuous: the frame was processed, it just resolved the intent.
      expect(outboundStates(lastTlsSocket)).toHaveLength(1)
    })

    // The other side of the tolerance, and the second half of what makes
    // importing the constant worth anything: a room that stopped *within* it has
    // converged as far as the rest of the system is concerned (`isAdopted()`
    // latches, the renderer's apply rule declines to move anyone), so there is
    // nothing left for a `doSeek` to recover and holding the intent would only
    // start a fight. Shrink SEEK_REASSERT_TOLERANCE_S and this fixture becomes
    // divergent, which is precisely the coupling the hardcoded gap hid.
    it('sends no recovery for a room that came within the re-assert tolerance', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      roomStillAt(SEEK_TARGET - SEEK_REASSERT_TOLERANCE_S / 2)

      expect(doSeekFrames()).toHaveLength(0)
      expect(seekIntent()).toBeNull()
      expect(outboundStates(lastTlsSocket)).toHaveLength(1)
    })

    it('gives up after three unanswered re-asserts', () => {
      handshake()
      armForwardSeek()
      clearWrites()

      for (let i = 0; i < 6; i += 1) roomStillAt(ROOM_POSITION, { server: 20 + i })

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
        client.updateSnapshot({ position: SEEK_TARGET + i, paused: false })
      }
      clearWrites()

      roomStillAt(ROOM_POSITION)

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

      roomStillAt(ROOM_POSITION)

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

    // #288, and a behaviour difference rather than a regression guard. The
    // guard above tests `hasLivePlayback()`, which keeps its 5 s horizon — so
    // between the *assert* horizon (2 s) and it, a re-assert still passes the
    // guard and still burns an attempt. What changes is the frame it produces.
    //
    // On head `buildPlaystate()` took its live branch here, so the **frozen**
    // pre-close position went out carrying `doSeek: true` — which every peer's
    // renderer applies unconditionally instead of at its 3 s tolerance. That is
    // a stronger arm of the drag #288 is about, and the one the election traces
    // miss because those clients carried no unresolved intent. Since #288 the
    // same call falls through to the mirror, whose `doSeek` is hardcoded false.
    //
    // A live intent is deliberately *not* exempted from the demotion: exempting
    // it is exactly what would keep that arm alive.
    it('re-asserts as a mirror frame, not a frozen doSeek, once the snapshot is past the assert window', () => {
      handshake()
      armForwardSeek()

      // Silence longer than the assert window and shorter than the de-adoption
      // one — the window this case exists for. `hasLivePlayback()` is still
      // true, so the spectator guard above does *not* fire.
      vi.advanceTimersByTime(3000)
      clearWrites()

      roomStillAt(ROOM_POSITION)

      // On head: one frame at SEEK_TARGET with `doSeek: true`.
      expect(doSeekFrames()).toHaveLength(0)
      // The attempt is still burned, and the intent still lives — this is a
      // demotion, not the guard's terminal drop.
      expect(seekIntent()?.attempts).toBe(1)
      // And the frame that went out in its place is the mirror: no pause claim,
      // no doSeek, and the room's own position rather than the frozen one.
      const emitted = outboundStates(lastTlsSocket).filter((s) => s.playstate)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].playstate).not.toHaveProperty('paused')
      expect(emitted[0].playstate?.doSeek).toBe(false)
      expect(emitted[0].playstate?.position).toBeCloseTo(ROOM_POSITION, 1)
    })

    // …and it still terminates. "Attempts exhausted" no longer implies "we
    // re-asserted", but the burn stays bounded and self-clearing, so a closed
    // player's unresolved seek cannot sit in the intent forever.
    it('still retires an intent that burns its attempts on mirror frames', () => {
      handshake()
      armForwardSeek()
      vi.advanceTimersByTime(3000)
      clearWrites()

      for (let i = 0; i < 6; i += 1) roomStillAt(ROOM_POSITION, { server: 30 + i })

      expect(doSeekFrames()).toHaveLength(0)
      expect(seekIntent()).toBeNull()
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

        roomStillAt(ROOM_POSITION)

        expect(doSeekFrames()[0].playstate?.position).toBe(700)
      })

      it('is not retracted by a play/pause', () => {
        handshake()
        armForwardSeek()
        // The playhead is still where the user put it and the room still has not
        // taken it, so the intent stands — and the recovery frame carries the
        // pause too, since it asserts the current snapshot.
        client.sendLocalState({ paused: true, position: SEEK_TARGET, cause: 'pause' })
        expect(seekIntent()).not.toBeNull()
        clearWrites()

        roomStillAt(ROOM_POSITION)

        expect(doSeekFrames()[0].playstate).toMatchObject({
          position: SEEK_TARGET,
          paused: true,
          doSeek: true
        })
      })
    })

    // The #239 interaction the issue's Risks section asks for, and the answer to
    // "the drift test cannot tell a discarded seek from a superseded one" (#274
    // review).
    //
    // Syncplay is last-write-wins. A peer seek that the server took while ours
    // was in flight is genuinely the newer intent, so ours is retired rather
    // than recovered — otherwise the recovery frame and the frame we hand the
    // renderer disagree off the same tick, and since `doSeek` bypasses the
    // renderer's 3 s tolerance the whole room is yanked back to our position for
    // a round trip before the live-position rule converges it.
    //
    // Both directions are pinned here on purpose: a retraction that also killed
    // the *discarded* case would be a silent revert of #252, and only the pair
    // can tell the two apart.
    describe("a peer's seek supersedes ours (#239)", () => {
      it('retires the intent instead of re-asserting over the peer', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        peerSeeksTo(900)

        // No cross-fire: the server is not told to go back to SEEK_TARGET while
        // the renderer is being told to go to 900.
        expect(doSeekFrames()).toHaveLength(0)
        expect(seekIntent()).toBeNull()
        // Non-vacuous, and the two halves of "this frame was really applied":
        // the ack went out, and the peer's state reached the renderer.
        const states = outboundStates(lastTlsSocket)
        expect(states).toHaveLength(1)
        expect(states[0].ignoringOnTheFly).toEqual({ server: 7 })
        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0].setBy).toBe('peer')
      })

      // The renderer's suppression window, walked end to end. The apply arms
      // main's echo reference, the element's `seeked` comes back as a local
      // 'seek' at the applied value, and sendLocalState()'s echo guard swallows
      // it — so the peer's own position is never re-armed as a fresh intent and
      // handed back to them with `doSeek`.
      it('does not re-arm an intent from the echo of the applied peer seek', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        peerSeeksTo(900)
        // What the renderer applied, reported back by the element.
        client.sendLocalState({ paused: false, position: 900, cause: 'seek' })

        expect(seekIntent()).toBeNull()
        expect(doSeekFrames()).toHaveLength(0)
      })

      // The discarded case, unchanged. Same foreign `setBy`, same server
      // counter, same "the element is 12 s from the room" divergence that arms
      // the echo target below — and still recovered, because the frame carries
      // no claim that anyone seeked. This is the case a retraction gated on the
      // echo target's own arming rule (`doSeek || |snapshot − position| > 3`)
      // would swallow.
      it('still recovers when the peer frame is a pause, not a seek', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        forcedState({
          server: 7,
          setBy: 'peer',
          position: ROOM_POSITION,
          paused: true,
          doSeek: false
        })

        expect(doSeekFrames()).toHaveLength(1)
        expect(doSeekFrames()[0].playstate?.position).toBe(SEEK_TARGET)
      })

      // Our own reflected forced update is a `doSeek` frame with a `setBy` too.
      // Retracting on it would kill the dominant shape of the bug outright,
      // which is what makes the foreign-`setBy` half of the gate load-bearing
      // rather than decoration.
      it('is not retracted by our own seek reflected back with doSeek', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        forcedState({ server: 7, setBy: 'me', position: ROOM_POSITION, doSeek: true })

        expect(doSeekFrames()).toHaveLength(1)
        expect(seekIntent()).not.toBeNull()
      })

      // The ack guard, the third condition. A peer seek arriving while our own
      // change is still unacked is dropped by handleState() — the renderer never
      // sees it, so it has not superseded anything on our side, and the intent
      // has to survive to be recovered off the frame that does land.
      it('is not retracted by a peer seek this client drops as unacked', () => {
        handshake()
        armForwardSeek()
        expect(pendingClientAck()).toBeGreaterThan(0)
        clearWrites()

        // No server counter, so the #232 arm does not zero pendingClientAck and
        // the drop guard is still up.
        forcedState({ setBy: 'peer', position: 900, doSeek: true })

        expect(remoteStates).toHaveLength(0)
        expect(seekIntent()).not.toBeNull()
      })

      // The identity itself, rather than the three fixtures above that happen to
      // instantiate it (#274 review). Each case above pins one conjunct against
      // one hand-built frame; none of them notices if the retraction and the
      // drop guards stop agreeing, because every one of them delivers a frame
      // that is applied. This sweeps the frame axes that decide whether
      // handleState() reaches `emit('remote-state')` and asserts the implication
      // over all of them: **if the intent was retired, the renderer was handed
      // that frame.** A fourth drop rule added between the retraction and the
      // emit — the dangerous direction, since it silently restores the permanent
      // divergence #252 closes — goes red here as soon as it drops any frame in
      // this space, which no other case in the file would report.
      //
      // A single frame is delivered per case so the retraction is the *only*
      // route from a pending intent to null: every swept position sits further
      // than SEEK_REASSERT_TOLERANCE_S from the element, so maybeReassertSeek()
      // cannot clear it as converged, and neither the TTL nor the attempt
      // ceiling can be reached in one frame.
      it('never retires the intent for a frame the renderer is not handed', () => {
        const positions = [ROOM_POSITION, SEEK_TARGET + 8 * SEEK_REASSERT_TOLERANCE_S]
        let retired = 0
        let dropped = 0

        for (const setBy of ['me', 'peer']) {
          for (const doSeek of [true, false]) {
            for (const server of [7, undefined]) {
              for (const paused of [false, true]) {
                for (const position of positions) {
                  // A fresh client per case: the sweep is over first frames, and
                  // an intent already retired by a previous one proves nothing.
                  client.disconnect()
                  client = new SyncplayClient()
                  remoteStates = []
                  client.on('remote-state', (s) => remoteStates.push(s as EmittedState))

                  handshake()
                  armForwardSeek()
                  clearWrites()

                  forcedState({ server, setBy, position, paused, doSeek })

                  const frame = { setBy, doSeek, server, paused, position }
                  if (remoteStates.length === 0) dropped += 1
                  if (seekIntent() === null) {
                    retired += 1
                    expect(
                      { ...frame, remoteStatesEmitted: remoteStates.length },
                      'intent retired for a frame the renderer never received'
                    ).toMatchObject({ remoteStatesEmitted: 1 })
                  }
                }
              }
            }
          }
        }

        // Anti-vacuity, both halves: the sweep really does contain frames that
        // retire the intent and frames that never reach the renderer, so the
        // implication above is not satisfied by an empty antecedent or by a
        // space in which everything is applied.
        expect(retired).toBeGreaterThan(0)
        expect(dropped).toBeGreaterThan(0)
      })
    })

    // #278 — the *read* half of the same tick. maybeReassertSeek() above tells
    // the server the room is wrong; execution then falls past the drop guards
    // and hands the renderer that same contradicted position, which the
    // renderer applies because the difference exceeds its 3 s tolerance
    // (use-syncplay-client.ts:585-586). Two quick arrow presses is the user
    // report: the second lands inside the server's ignore window and is
    // discarded, and the periodic that closes the window carries the room still
    // at the first press.
    //
    // The rule is one sentence — *while a local seek intent is live,
    // handleState() hands the renderer our position instead of the room's* —
    // and it is a **rewrite, never a drop**: recordRemoteState() runs
    // unconditionally at the top of applyRemoteState() and owns the
    // pending-pause release and the "Paused by …" badge (#228), so a drop would
    // lose the pause half to save the position half.
    describe('the room does not move our playhead while our own seek is unresolved (#278)', () => {
      const OPEN = 'Show - 1'

      const openFile = (canonicalName = OPEN): void =>
        client.setFile({
          animeId: 1,
          malId: null,
          episodeInt: '1',
          translationId: null,
          canonicalName,
          duration: 1440,
          newPlayer: true
        })

      // A roster with somebody else in it. `getRoomPosition()` answers `null`
      // while the roster says we are alone, so the two bookkeeping cases below
      // need a peer — and adoption has to have latched *before* it arrives,
      // since with a peer listed `isAdopted()` stops taking the alone shortcut.
      const withPeerInRoom = (): void =>
        lastTlsSocket!.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              List: {
                cinema: {
                  me: { isReady: true, position: 0 },
                  peer: { isReady: true, position: 0 }
                }
              }
            }) + '\r\n'
          )
        )

      // Latch adoption while the roster still says we are alone, with a file
      // open so `getRoomPosition()` has something to key on.
      const openAndAdopt = (): void => {
        openFile()
        client.updateSnapshot({ position: ROOM_POSITION, paused: false })
        vi.advanceTimersByTime(HEARTBEAT_MS)
        withPeerInRoom()
      }

      // The frame class the harness never distinguished: a periodic, `doSeek:
      // false`, at the room's stale resting position, whose `setBy` has been
      // re-elected to a peer by Room.getPosition()'s min() over watchers
      // (server.py:597-604). `roomStillAt()`'s block comment frames the same
      // shape as a pause-driven forced update, which is why the retraction's
      // `doSeek` gate was never pressured by it.
      it('hands the renderer our own position for a re-elected foreign periodic', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        // Both halves of the tick, and they now agree: the server is told 112
        // and so is the renderer.
        expect(doSeekFrames()).toHaveLength(1)
        expect(doSeekFrames()[0].playstate?.position).toBe(SEEK_TARGET)
        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0].position).toBe(SEEK_TARGET)
        // Only the position is ours. `setBy` and `doSeek` ride through, which is
        // what keeps the renderer's own attribution and apply rules working.
        expect(remoteStates[0].setBy).toBe('peer')
        expect(remoteStates[0].doSeek).toBe(false)
      })

      // The interaction that makes "rewrite, never drop" load-bearing (#228).
      // The room genuinely paused at a position we contradict: the pause has to
      // reach recordRemoteState() — it releases a pending pause and hands over
      // the "Paused by …" badge — while the element stays put.
      it('passes the room’s pause and its author through, substituting only the position', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        forcedState({
          server: 7,
          setBy: 'peer',
          position: ROOM_POSITION,
          paused: true,
          doSeek: false
        })

        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0]).toMatchObject({
          paused: true,
          setBy: 'peer',
          doSeek: false,
          position: SEEK_TARGET
        })
        // The recovery still goes out, carrying the pause it was handed.
        expect(doSeekFrames()).toHaveLength(1)
        expect(doSeekFrames()[0].playstate?.position).toBe(SEEK_TARGET)
      })

      // The ordering claim: the flag is captured *above* maybeReassertSeek(), so
      // the tick the intent dies is still the last tick it protects. Read it
      // after the call instead and this goes red on the ceiling tick.
      //
      // …and the honest bound, as a characterisation (#278 review). The
      // protection is exactly one tick wide: tick 4 has no intent left to read,
      // so the room's 100 goes out unrewritten and the renderer applies it at
      // |112 − 100| = 12 > 3. In symptom 1's real shape that never happens —
      // the re-assert is accepted once the ignore window closes and the room
      // comes to us — but the user's console capture is of exactly this
      // exhausted-ceiling shape, where the fix turns four excursions into one
      // rather than none. Do not promote this to a guarantee in docs.
      it('still rewrites on the tick the attempt ceiling retires the intent — and not the tick after', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        for (let i = 0; i < 4; i += 1) {
          roomStillAt(ROOM_POSITION, { setBy: 'peer', server: 20 + i })
        }

        expect(doSeekFrames()).toHaveLength(3)
        expect(seekIntent()).toBeNull()
        // Four inbound ticks, four rewritten frames — the fourth is the ceiling
        // tick, where maybeReassertSeek() nulled the intent and asserted nothing.
        expect(remoteStates.map((s) => s.position)).toEqual([
          SEEK_TARGET,
          SEEK_TARGET,
          SEEK_TARGET,
          SEEK_TARGET
        ])

        roomStillAt(ROOM_POSITION, { setBy: 'peer', server: 24 })

        expect(remoteStates).toHaveLength(5)
        expect(remoteStates[4].position).toBe(ROOM_POSITION)
      })

      it('still rewrites on the tick the TTL retires the intent', () => {
        handshake()
        armForwardSeek()
        // Keep pushing snapshots so the player stays live — otherwise the
        // spectator branch below, not the TTL, is what this would exercise.
        for (let i = 1; i <= 6; i += 1) {
          vi.advanceTimersByTime(1000)
          client.updateSnapshot({ position: SEEK_TARGET + i, paused: false })
        }
        clearWrites()

        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        expect(doSeekFrames()).toHaveLength(0)
        expect(seekIntent()).toBeNull()
        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0].position).toBe(SEEK_TARGET + 6)
      })

      // The third terminal exit, and the frame that uses the oldest snapshot the
      // rule will ever substitute: hasLivePlayback() has just gone false at
      // PLAYBACK_STALE_MS, so the reading is 5 s old. It is still a reading of a
      // *stopped* element — nothing pushed, so nothing moved — which is the
      // whole staleness argument, asserted rather than left to it.
      it('still rewrites on the tick the spectator guard retires the intent, with the oldest snapshot it will use', () => {
        handshake()
        armForwardSeek()
        vi.advanceTimersByTime(6000)
        clearWrites()

        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        expect(doSeekFrames()).toHaveLength(0)
        expect(seekIntent()).toBeNull()
        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0].position).toBe(SEEK_TARGET)
      })

      // The substituted value is flat `this.snapshot.position`, never a forward
      // projection, and the residual is one push interval: ~0.9 s of
      // SNAPSHOT_MIN_INTERVAL_MS floor plus `timeupdate`'s own ~250 ms cadence.
      // The element only advances while it is firing `timeupdate`, so that is
      // also the widest the reading can be wrong by — comfortably inside the
      // renderer's 3 s apply tolerance.
      it('keeps the substituted value inside the renderer’s tolerance as the snapshot ages', () => {
        handshake()
        armForwardSeek()
        // One push interval of playback with no push landing.
        vi.advanceTimersByTime(1150)
        clearWrites()

        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        const whereTheElementActuallyIs = SEEK_TARGET + 1.15
        expect(remoteStates).toHaveLength(1)
        expect(Math.abs(remoteStates[0].position - whereTheElementActuallyIs)).toBeLessThan(
          ADOPT_TOLERANCE_S
        )
      })

      // The escape hatch, and it costs no branch: the #274 retraction runs above
      // the capture, so a peer's genuine seek has already nulled the intent by
      // the time the flag is read. Reorder those two and this is what breaks.
      it('does not rewrite a peer’s genuine seek — the retraction runs above the capture', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        peerSeeksTo(900)

        expect(seekIntent()).toBeNull()
        expect(doSeekFrames()).toHaveLength(0)
        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0].position).toBe(900)
        expect(remoteStates[0].doSeek).toBe(true)
      })

      // `doSeek` is provably false on every rewritten tick — a `doSeek` frame
      // that would apply retired the intent above, and one that would not apply
      // never reaches the emit — so it is passed through and the invariant is
      // asserted rather than hardcoded. Sweeping both axes is what makes it
      // break loudly if the retraction and the capture are ever reordered.
      it('only ever rewrites a frame that carries doSeek: false', () => {
        let rewritten = 0
        let passedThrough = 0

        for (const doSeek of [true, false]) {
          for (const paused of [false, true]) {
            client.disconnect()
            client = new SyncplayClient()
            remoteStates = []
            client.on('remote-state', (s) => remoteStates.push(s as EmittedState))

            handshake()
            armForwardSeek()
            clearWrites()

            forcedState({ server: 7, setBy: 'peer', position: ROOM_POSITION, paused, doSeek })

            expect(remoteStates, JSON.stringify({ doSeek, paused })).toHaveLength(1)
            if (remoteStates[0].position === SEEK_TARGET) {
              rewritten += 1
              expect(remoteStates[0].doSeek, 'a rewritten frame must carry doSeek: false').toBe(
                false
              )
            } else {
              passedThrough += 1
              expect(remoteStates[0].position).toBe(ROOM_POSITION)
            }
          }
        }

        // Anti-vacuity, both halves: the sweep really contains rewritten frames
        // and frames that pass straight through.
        expect(rewritten).toBe(2)
        expect(passedThrough).toBe(2)
      })

      // Bookkeeping, half one. The echo target is what sendLocalState() compares
      // the next local seek against within ECHO_SEEK_EPSILON_S; armed at the
      // room's stale position it swallows a genuine user seek landing near it
      // and that seek never reaches the room. Evaluating the arming test on the
      // *emitted* value answers "this state moves nothing" for exactly the
      // frames we rewrite, so no special case is needed.
      it('does not arm the echo target at the room’s stale position', () => {
        handshake()
        armForwardSeek()
        clearWrites()

        roomStillAt(ROOM_POSITION, { setBy: 'peer' })
        expect(remoteStates[0].position).toBe(SEEK_TARGET)
        clearWrites()

        // A genuine user seek that happens to land next to where the room was.
        const target = ROOM_POSITION + ECHO_SEEK_EPSILON_S / 2
        client.sendLocalState({ paused: false, position: target, cause: 'seek' })

        const seeks = doSeekFrames()
        expect(seeks).toHaveLength(1)
        expect(seeks[0].playstate?.position).toBe(target)
      })

      // Bookkeeping, half two. `lastRemoteRoomState` is skipped rather than
      // written from the emitted value: that value is ours, and
      // `getRoomPosition()` answering our own position is the regression class
      // syncplay-room-position.test.ts pins. The previous value stands and ages
      // out under ROOM_POSITION_MAX_AGE_MS.
      it('leaves getRoomPosition() on the room’s last real value', () => {
        handshake()
        openAndAdopt()
        // A foreign frame with no intent live seeds the room position.
        forcedState({ server: 5, setBy: 'peer', position: 50, paused: false, doSeek: false })
        expect(client.getRoomPosition(OPEN)).toBeCloseTo(50, 5)

        armForwardSeek()
        clearWrites()
        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        expect(remoteStates[remoteStates.length - 1].position).toBe(SEEK_TARGET)
        // Not SEEK_TARGET (ours) and not ROOM_POSITION (the contradicted claim):
        // the seed stands.
        expect(client.getRoomPosition(OPEN)).toBeCloseTo(50, 5)
      })

      // The other end of the same skip, as a characterisation of the risk (#278
      // review): if the session's *first* foreign frame lands inside the window,
      // `lastRemoteRoomState` is never seeded at all and `getRoomPosition()`
      // answers `null` for the life of the intent — read by the MKV spawn seed
      // (#262) and #276's join seed through src/main/ipc/syncplay.ipc.ts:73.
      // Bounded by SEEK_REASSERT_TTL_MS, and a spawn needs a new player, which
      // clears the intent — but it is "never seeded", not "ages".
      it('leaves getRoomPosition() null when the window covers the first foreign frame', () => {
        handshake()
        openAndAdopt()
        expect(client.getRoomPosition(OPEN)).toBeNull()

        armForwardSeek()
        clearWrites()
        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        expect(remoteStates[remoteStates.length - 1].position).toBe(SEEK_TARGET)
        expect(client.getRoomPosition(OPEN)).toBeNull()
      })

      // The window inherits `seekIntent`'s retirements exactly, because it *is*
      // `seekIntent`: no new field, no new timer, nothing extra to retire. These
      // two are the routes a rewritten frame could otherwise outlive its player.
      it('does not rewrite once a new player has retired the intent', () => {
        handshake()
        armForwardSeek()

        openFile('Show - 2')
        expect(seekIntent()).toBeNull()
        clearWrites()

        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0].position).toBe(ROOM_POSITION)
      })

      it('does not rewrite once the stale-gap re-converge has retired the intent', () => {
        handshake()
        armForwardSeek()

        // The same-episode reopen setFile() cannot see: a fresh <video> at 0.
        vi.advanceTimersByTime(6000)
        client.updateSnapshot({ position: 0, paused: true })
        expect(seekIntent()).toBeNull()
        clearWrites()

        roomStillAt(ROOM_POSITION, { setBy: 'peer' })

        // Non-vacuous: had the window survived the swap, the emitted value would
        // be the fresh element's 0 rather than the room's 100.
        expect(remoteStates).toHaveLength(1)
        expect(remoteStates[0].position).toBe(ROOM_POSITION)
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
