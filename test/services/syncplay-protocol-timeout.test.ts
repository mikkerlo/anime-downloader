// `PROTOCOL_TIMEOUT` as a modelled disconnect (#384 item 4), at unit scale.
//
// `conformance/syncplay-protocol-timeout.conformance.ts` is where the *rule* is
// read off the real Syncplay 1.7.6 server, and it is the only place that can be:
// it replays the same scenario against the reference and the model and compares
// them on the wire. It also runs nightly only — `vitest.config.ts` includes
// `test/**` and `src/**` and nothing else — so nothing under `conformance/` is
// exercised by a pull request. This file is the pull-request half, and it is not
// a copy of that scenario at a smaller size. Three things it holds that the
// nightly structurally cannot:
//
//  - **The band, exactly.** Wall-clock scenarios cannot sit on a millisecond
//    edge; fake timers can, so cases 2 and 3 pin "still seated at one tick
//    before, dropped at the tick" and case 4 pins that the quantiser is the
//    **tick** rather than the constant. Every edge is DERIVED from
//    `PROTOCOL_TIMEOUT_MS` and the interval — `dropAt()` below — because a
//    written `13000` would survive an upstream version bump that moved the
//    constant out from under it.
//  - **That the drop is off unless asked for.** Case 1. Nineteen scenarios and
//    the whole of `test/services/` were written against a model that never
//    dropped anyone.
//  - **The ping-only refresh, and the `send()` ordering.** Cases 5 and 7. See
//    each for what reds without it.
//
// Case 5 is also the first assertion anywhere on the pull-request gate that
// distinguishes #384's **stamp half** — `applyState` stamping `lastUpdatedOn`
// above its `if (!ps) return` rather than below it. That half landed without a
// gate-side guard of its own: the three `lastUpdatedOn` mentions across
// `test/services/` were all comments, and the ignore-counter fixture that looked
// like a candidate was re-baselined by #408. Verified by mutation rather than
// asserted: with the stamp moved back below the early return, case 5 reds and
// nothing else in `npm run test` moves.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { MinElectionServer, PROTOCOL_TIMEOUT_MS } from '../helpers/syncplay-min-election-server'
import type { ModelSocket } from '../helpers/syncplay-min-election-server'

type Frame = Record<string, any>

interface Seated {
  /** Puts one frame on this watcher's socket, as its client would. */
  send: (obj: unknown) => void
  /** Everything the server sent, parsed, in arrival order. */
  frames: Frame[]
  /** Just the `State` frames' playstates. */
  playstates: () => Frame[]
  /** The usernames in the most recent `List` reply, sorted, or `null`. */
  roster: () => string[] | null
  /** The usernames named by `Set: {user: {…: {event: {left: true}}}}` notices. */
  leaves: () => string[]
}

const file = (name: string): Record<string, unknown> => ({ name, duration: 1440, size: 1 })

/**
 * The margin the conformance scenario holds its silent peer past the constant,
 * restated here rather than imported so the two files cannot drift into sharing a
 * constant that means two different things: there it sizes a wall-clock wait,
 * here it only has to clear `dropAt()` by more than one tick.
 */
const IDLE_MARGIN_MS = 2500

/**
 * The first tick strictly past the timeout — upstream's comparison is a `>`
 * sampled on the `SERVER_STATE_INTERVAL` tick, so the drop lands on a multiple of
 * the interval and never on the constant.
 *
 * Derived, never written: at the reference's 12.5 s and 1 s this is 13000, and at
 * a 2 s interval it is 14000. Case 4 is the second of those, which is what makes
 * the quantiser observable rather than a coincidence of the first.
 */
const dropAt = (timeoutMs: number, intervalMs: number): number =>
  intervalMs * (Math.floor(timeoutMs / intervalMs) + 1)

describe('MinElectionServer — PROTOCOL_TIMEOUT as a modelled drop', () => {
  let server: MinElectionServer | null = null

  beforeEach(() => {
    // Before the constructor, always: the periodic `State` timer is armed in it,
    // so a real-timer construction would leave a tick loose on the fake clock.
    vi.useFakeTimers()
  })

  afterEach(() => {
    server?.stop()
    server = null
    vi.useRealTimers()
  })

  const seat = (host: MinElectionServer, username: string, delayMs = 0): Seated => {
    const plain = new EventEmitter() as ModelSocket
    const tls = new EventEmitter() as ModelSocket
    const frames: Frame[] = []
    let buf = ''
    tls.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      for (;;) {
        const i = buf.indexOf('\r\n')
        if (i < 0) break
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (line.trim()) frames.push(JSON.parse(line) as Frame)
      }
    })
    host.seat({ username, delayMs, plain, takeTls: () => tls })
    return {
      send: (obj) => tls.write(JSON.stringify(obj)),
      frames,
      playstates: () => frames.filter((f) => f.State?.playstate).map((f) => f.State.playstate),
      roster: () => {
        for (let i = frames.length - 1; i >= 0; i--) {
          const list = frames[i].List
          if (list) return Object.keys(Object.values(list)[0] as object).sort()
        }
        return null
      },
      leaves: () => {
        const out: string[] = []
        for (const f of frames) {
          for (const [user, body] of Object.entries((f.Set?.user ?? {}) as Record<string, Frame>)) {
            if (body?.event?.left === true) out.push(user)
          }
        }
        return out
      }
    }
  }

  /** A seat that is a candidate in the election — `__lt__` orders a fileless one last. */
  const announce = (p: Seated, name: string, position: number): void => {
    p.send({ Set: { file: file(name) } })
    p.send({ State: { playstate: { position, paused: true } } })
  }

  /**
   * One clock refresh that perturbs nothing: the same position and the same pause
   * flag the room already has, so `applyState` stores and stamps and
   * `forcePositionUpdate` is never reached. A frame that flipped `paused` would
   * force an update, and a forced update reaches `sendState` off the tick — which
   * would move the drop off the grid the band cases are measuring.
   */
  const refresh = (p: Seated, position: number): void => {
    p.send({ State: { playstate: { position, paused: true } } })
  }

  it('never drops anyone when no caller asks for a timeout', () => {
    // 1. The default, and the whole of this feature's additivity claim. Every
    //    fixture in `test/services/` and all nineteen conformance scenarios were
    //    written against a model that let a silent watcher sit there forever.
    server = new MinElectionServer({ position: 0, paused: true, stateIntervalMs: 1000 })
    const alpha = seat(server, 'alpha')
    announce(alpha, 'a.mkv', 500)

    vi.advanceTimersByTime(PROTOCOL_TIMEOUT_MS + IDLE_MARGIN_MS)
    const ticked = alpha.playstates().length
    expect(ticked).toBeGreaterThan(PROTOCOL_TIMEOUT_MS / 1000)

    // Still seated, and still being ticked after the window — two assertions
    // because either alone has a quiet failure: a roster that still lists a
    // watcher nothing writes to, or a tick count that stopped growing.
    alpha.send({ List: {} })
    expect(alpha.roster()).toEqual(['alpha'])
    expect(alpha.leaves()).toEqual([])
    vi.advanceTimersByTime(3000)
    expect(alpha.playstates().length).toBeGreaterThan(ticked)
  })

  it('still holds the seat on the last tick before the edge', () => {
    // 2. The lower edge. The last tick inside the window samples an idle of
    //    12 000 ms against a 12 500 ms timeout, so nothing is dropped — the
    //    strict `>` and the 1 s sampling together mean the *elapsed* 12 999 ms
    //    never gets looked at.
    const STATE_INTERVAL_MS = 1000
    server = new MinElectionServer({
      position: 0,
      paused: true,
      stateIntervalMs: STATE_INTERVAL_MS,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS
    })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')
    announce(alpha, 'a.mkv', 300)
    announce(bravo, 'b.mkv', 500)

    // `bravo` is the survivor and has to be kept on the clock, or it is dropped
    // in the same tick and there is nobody left to read the roster from.
    vi.advanceTimersByTime(6000)
    refresh(bravo, 500)
    vi.advanceTimersByTime(dropAt(PROTOCOL_TIMEOUT_MS, STATE_INTERVAL_MS) - 1 - 6000)

    bravo.send({ List: {} })
    expect(bravo.roster()).toEqual(['alpha', 'bravo'])
    expect(bravo.leaves()).toEqual([])
    expect(alpha.leaves()).toEqual([])
  })

  it('drops on the first tick past the edge', () => {
    // 3. The upper edge, one millisecond further on than case 2 — the adjacent
    //    pair is the pin. A single-sided assertion passes just as well on a model
    //    that drops everyone immediately.
    const STATE_INTERVAL_MS = 1000
    server = new MinElectionServer({
      position: 0,
      paused: true,
      stateIntervalMs: STATE_INTERVAL_MS,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS
    })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')
    announce(alpha, 'a.mkv', 300)
    announce(bravo, 'b.mkv', 500)

    vi.advanceTimersByTime(6000)
    refresh(bravo, 500)
    vi.advanceTimersByTime(dropAt(PROTOCOL_TIMEOUT_MS, STATE_INTERVAL_MS) - 6000)

    expect(bravo.leaves()).toEqual(['alpha'])
    bravo.send({ List: {} })
    expect(bravo.roster()).toEqual(['bravo'])

    // And nothing is written to it afterwards. The roster check alone would pass
    // on a model that forgot the seat but kept broadcasting to the socket.
    const sent = alpha.frames.length
    vi.advanceTimersByTime(4000)
    expect(alpha.frames.length).toBe(sent)
  })

  it('moves the edge with the tick, not with the constant', () => {
    // 4. The quantiser. At a 2 s interval the same 12.5 s timeout drops at 14 s,
    //    not at 13 s and not at 12.5 s — which is what makes the two edges above
    //    a property of the sampling rather than an arithmetic coincidence of a 1 s
    //    interval. Both sides in one case, because the 2 s claim is only
    //    interesting as a *difference* from the 1 s one.
    const STATE_INTERVAL_MS = 2000
    const edge = dropAt(PROTOCOL_TIMEOUT_MS, STATE_INTERVAL_MS)
    expect(edge).toBe(dropAt(PROTOCOL_TIMEOUT_MS, 1000) + STATE_INTERVAL_MS - 1000)

    server = new MinElectionServer({
      position: 0,
      paused: true,
      stateIntervalMs: STATE_INTERVAL_MS,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS
    })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')
    announce(alpha, 'a.mkv', 300)
    announce(bravo, 'b.mkv', 500)

    vi.advanceTimersByTime(6000)
    refresh(bravo, 500)
    // Past the 1 s interval's edge, and still seated: a model that read the
    // constant rather than the tick would have dropped `alpha` 1 s ago.
    vi.advanceTimersByTime(edge - 1 - 6000)
    expect(bravo.leaves()).toEqual([])

    vi.advanceTimersByTime(1)
    expect(bravo.leaves()).toEqual(['alpha'])
  })

  it('keeps a watcher that sends only ping-only State frames', () => {
    // 5. The reset rule's surviving arm, and the first pull-request-gate
    //    assertion that distinguishes #384's stamp half. `applyState` stamps
    //    `lastUpdatedOn` *above* its `if (!ps) return`, mirroring upstream's
    //    `_lastUpdatedOn = time.time()` above the `if position is not None`
    //    guard, so a `State` carrying a `ping` and no `playstate` at all —
    //    `sendAck()`'s own shape — refreshes the clock.
    //
    //    Move that stamp back below the early return and this case is the only
    //    thing in the default run that notices: `alpha` stops refreshing, and is
    //    dropped on the tick case 3 pins.
    const STATE_INTERVAL_MS = 1000
    server = new MinElectionServer({
      position: 0,
      paused: true,
      stateIntervalMs: STATE_INTERVAL_MS,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS
    })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')
    announce(alpha, 'a.mkv', 300)
    announce(bravo, 'b.mkv', 500)

    const PING_EVERY_MS = 4000
    for (let t = 0; t < PROTOCOL_TIMEOUT_MS + IDLE_MARGIN_MS; t += PING_EVERY_MS) {
      vi.advanceTimersByTime(PING_EVERY_MS)
      alpha.send({ State: { ping: { clientLatencyCalculation: 1, latencyCalculation: 1 } } })
      refresh(bravo, 500)
    }

    expect(alpha.leaves()).toEqual([])
    expect(bravo.leaves()).toEqual([])
    bravo.send({ List: {} })
    expect(bravo.roster()).toEqual(['alpha', 'bravo'])
  })

  it('drops a watcher whose only traffic is List and Set', () => {
    // 6. The reset rule's other arm, and the control for case 5: `alpha` is not
    //    silent on the socket at all, it is silent in `State`. `_lastUpdatedOn`
    //    has exactly two writes upstream and the second is in `updateState`,
    //    whose only caller is the tail of `handleState` — so `List` and `Set`
    //    traffic refreshes nothing however often it arrives. Without this case,
    //    case 5 would pass on a model that had simply stopped dropping anyone.
    const STATE_INTERVAL_MS = 1000
    server = new MinElectionServer({
      position: 0,
      paused: true,
      stateIntervalMs: STATE_INTERVAL_MS,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS
    })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')
    announce(alpha, 'a.mkv', 300)
    announce(bravo, 'b.mkv', 500)

    const CHATTER_EVERY_MS = 4000
    for (let t = 0; t < PROTOCOL_TIMEOUT_MS + IDLE_MARGIN_MS; t += CHATTER_EVERY_MS) {
      vi.advanceTimersByTime(CHATTER_EVERY_MS)
      alpha.send({ List: {} })
      alpha.send({ Set: { ready: { isReady: true, manuallyInitiated: false } } })
      refresh(bravo, 500)
    }

    expect(bravo.leaves()).toEqual(['alpha'])
    bravo.send({ List: {} })
    expect(bravo.roster()).toEqual(['bravo'])
  })

  it('delivers the drop tick frame and then the leave notice on a delayed link', () => {
    // 7. The `send()` call-time capture, and the one change in this feature
    //    argued from transport semantics rather than from upstream source text.
    //    Upstream's order is send at
    //    `server.py:860 ("self._connector.sendState(position, paused, doSeek, setBy, forcedUpdate)")`,
    //    test at
    //    `server.py:861 ("if time.time() - self._lastUpdatedOn > constants.PROTOCOL_TIMEOUT:")`,
    //    drop at `server.py:863 ("self._connector.drop()")`, and
    //    `drop()` is a flushing `loseConnection` — so the drop tick's own `State`
    //    reaches the client. With a link delay the model queues that frame and
    //    then removes the watcher inside the same call, so a `deliver()` that
    //    re-looked-the-watcher-up would find it gone and eat **both** the drop
    //    tick's `State` and the leave notice queued behind it.
    //
    //    What reds without the capture: `alpha`'s last frame becomes the
    //    *previous* tick's `State` instead of the notice. The entry guard is
    //    deliberately kept, so a call made after the removal still sends nothing —
    //    which the frame count at the end is what holds.
    const DELAY_MS = 1500
    const STATE_INTERVAL_MS = 1000
    server = new MinElectionServer({
      position: 0,
      paused: true,
      stateIntervalMs: STATE_INTERVAL_MS,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS
    })
    const alpha = seat(server, 'alpha', DELAY_MS)
    const bravo = seat(server, 'bravo')
    announce(alpha, 'a.mkv', 300)
    announce(bravo, 'b.mkv', 500)

    // `alpha`'s inbound frame pays the delay, so its clock starts at `DELAY_MS`
    // and the drop tick is one delay later than case 3's.
    const edge = dropAt(PROTOCOL_TIMEOUT_MS + DELAY_MS, STATE_INTERVAL_MS)
    vi.advanceTimersByTime(6000)
    refresh(bravo, 500)
    // Far enough past the drop tick for that tick's own outbound frames to have
    // paid the delay as well.
    vi.advanceTimersByTime(edge + DELAY_MS + 100 - 6000)

    const last = alpha.frames[alpha.frames.length - 1]
    const previous = alpha.frames[alpha.frames.length - 2]
    expect(last.Set.user.alpha.event).toEqual({ left: true })
    expect(previous.State.playstate).toBeTruthy()
    expect(alpha.leaves()).toEqual(['alpha'])

    const sent = alpha.frames.length
    vi.advanceTimersByTime(5000)
    expect(alpha.frames.length).toBe(sent)
  })

  it('re-elects the room and tells both peers the seat is gone', () => {
    // 8. The drop's two observable consequences, which are also exactly the three
    //    divergences the conformance scenario red reported: the room re-elects
    //    off the departed watcher, and the notice reaches the **survivor** and the
    //    **departing peer** both — `broadcast` has no sender exclusion, and
    //    `sendLeftMessage` runs before the watcher loses its room, so the
    //    departing peer is still a recipient and still has a name to be given.
    //
    //    `alpha` at 300 owns the election while it is seated and `bravo` at 500
    //    takes it afterwards, so the re-election moves `setBy` *and* the position.
    //    A tie would leave the roster as the only observable.
    const STATE_INTERVAL_MS = 1000
    server = new MinElectionServer({
      position: 0,
      paused: true,
      stateIntervalMs: STATE_INTERVAL_MS,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS
    })
    const alpha = seat(server, 'alpha')
    const bravo = seat(server, 'bravo')
    announce(alpha, 'a.mkv', 300)
    announce(bravo, 'b.mkv', 500)

    vi.advanceTimersByTime(6000)
    refresh(bravo, 500)
    const before = bravo.playstates()
    expect(before[before.length - 1]).toMatchObject({ position: 300, setBy: 'alpha' })

    // One tick past the drop, so the election that follows the removal has run.
    vi.advanceTimersByTime(dropAt(PROTOCOL_TIMEOUT_MS, STATE_INTERVAL_MS) + 1000 - 6000)

    const after = bravo.playstates()
    expect(after[after.length - 1]).toMatchObject({ position: 500, setBy: 'bravo' })
    expect(bravo.leaves()).toEqual(['alpha'])
    expect(alpha.leaves()).toEqual(['alpha'])
  })
})
