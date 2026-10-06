// @vitest-environment happy-dom
//
// Play/pause propagation between two peers (#361 step 4).
//
// `syncplay-two-peer-loop.test.ts` carries one direction — the host presses
// pause, the joiner's element follows — as its proof that the instrument is
// wired up. This file is about the rule rather than the wiring, so it takes the
// three shapes that direction does not reach:
//
//  - **the other direction**, where the follower is the peer that has been
//    driving the room's `min()` election, and the badge it paints names someone
//    else;
//  - **a peer joining a room that is already paused**, where nothing is
//    propagating at all — the room is simply standing still and the newcomer has
//    to be placed into it and stopped;
//  - **a peer's own action coming back**, which must propagate *nowhere*. The
//    reference server broadcasts its forced update to the setter too
//    (`server.py:187` hands it to `broadcastRoom()`, which has no sender filter,
//    `server.py:441-445`), so every discrete change a peer makes arrives back at
//    its own socket a round trip later. `src/main/syncplay.ts:2227` eats it.
//
// The third is the one worth having. The first two would survive a good deal of
// damage to the echo path; only the third goes red when the drop guard does.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50

/**
 * Where the join-time `State` places a joiner: the room's start plus **one
 * one-way delay**, not the room's start.
 *
 * The room's *playback* never moves — it is paused at `ROOM_START` and no peer
 * ever acts — so this is not the room drifting. It is one second during which
 * the server's **elected** position sits a forward delay above the room's true
 * one, and the joiner's `State` is answered inside it.
 *
 * The cause is the join-time `State` on **both** ends, because the server sends
 * one on every `Hello`, the host's included. That is what the counterfactual
 * measures rather than infers:
 *
 *  - Suppressed, the host puts *no* playstate on the wire at t=1000 at all. It
 *    has been told nothing about the room, so `buildPlaystate` stops at
 *    `src/main/syncplay.ts:2584` ("if (!room) return null"). Its first wire frame
 *    is the t=2000 one, by which point it has adopted and sends `paused: true`,
 *    which the server stores raw — so every election reads `ROOM_START` and the
 *    old `[ROOM_START]` literal was right.
 *  - Present, the host's own join-time `State` has already given it a
 *    `lastRoomState` by t=1000, while the adopted-exit gate
 *    `src/main/syncplay.ts:2556` ("if (this.canAssertSnapshot() &&
 *    this.isAdopted()) {") is still false. Both of those follow from the frame
 *    itself rather than from a separate reading: the mirror exit is only
 *    reachable past the null one, and it is the only exit that omits `paused`.
 *    So its t=1000 heartbeat takes the **mirror** exit —
 *    position, and no `paused` key at all (`src/main/syncplay.ts:2657-2660`,
 *    against the adopted exit at `src/main/syncplay.ts:2577-2581`, which does
 *    send `paused`). The server reads a missing `paused` as "not paused" and
 *    compensates it by a forward delay —
 *    `test/helpers/syncplay-min-election-server.ts:945` ("w.position = position +
 *    (ps.paused === true ? 0 : this.forwardDelayFor(w))") — so it stores this
 *    value for the host, the t=2000 election elects it, and the joiner's `Hello`,
 *    answered in that same second, carries it out.
 *
 * So the fixture did not previously model this at all: it suppressed the host's
 * mirror heartbeat by never giving it a room to mirror. The compensation is the
 * *server's* arithmetic, and production's `paused`-less frame is documented as
 * accepting it — the comment block above that mirror exit calls it a "Known
 * consequence: the server reads a missing paused as not-paused in
 * _updatePositionByAge too, so it forward-delay-compensates the mirrored
 * position even while the room is paused." What the join-time `State` changed is
 * reachability, and on half B's own provenance that is the direction of *more*
 * fidelity, not less: the frame it adds is one the reference sends and this
 * fixture did not. (Quoted by phrase rather than anchored: that sentence lives on
 * comment lines, which this repo's citation gate will not let an anchor land on.)
 *
 * Bounded at one delay, not N. The same block warns that a lone spectator's
 * crept value "compounds at ~one forward delay per second", but here exactly one
 * mirror frame is ever stored compensated — the host's t=1000 one is the only
 * frame it ever sends without a `paused` key, and its t=2000 heartbeat onward is
 * adopted and stored raw, which puts the room back on `ROOM_START` from the
 * t=3000 election to the end of the run.
 *
 * And the boundedness is the *incumbent's* doing, not the mechanism's, which is
 * the qualifier #411 added to that comment: what stops the compensation here is
 * a peer that has adopted a real player and therefore reports raw. Take that
 * peer away and nothing re-asserts the truth — the crept value is handed to the
 * joiner and kept, which is why this constant is named for the *handoff* rather
 * than for a room that moved. That case is
 * `syncplay-paused-spectator-handoff.test.ts`, and the pair of fixtures is the
 * scope of the comment's correction: the same seam, once with an incumbent and
 * once without.
 */
const JOIN_TIME_ROOM_POSITION = ROOM_START + DELAY_MS / 1000

/**
 * `SyncplayClient`'s `clientIgnoreCounter` — bumped once per *discrete* change
 * the client originates, and by nothing else. Read here to say "this peer
 * announced nothing of its own", which is what distinguishes following a room
 * from arguing with it. Private by design, so it arrives through the harness's
 * `Peer.counters()` rather than a cast spelled out per file.
 */
const discreteSends = (p: Peer): number => p.counters().clientIgnoreCounter

describe('SyncplayClient — play/pause across two peers', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const seatBoth = async (): Promise<[Peer, Peer]> => {
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    return [host, joiner]
  }

  it('carries a pause from the joiner back to the host, and releases it again', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)
    expect(host.el.paused).toBe(false)
    host.frames.length = 0

    // The joiner presses pause. Nothing programmatic is armed, so the `pause`
    // its element queues is classified as the user's by `consumePlaybackOp`
    // returning nothing, and leaves through `sendLocalState('pause')`.
    joiner.userPause()
    await room.advance(1)

    expect(room.server.roomState().paused).toBe(true)
    expect(host.el.paused).toBe(true)
    expect(host.ui.syncplayPausedBy.value).toBe('joinuser')
    expect(host.ui.shouldElementPlay()).toBe(false)

    // One frame did it, and it is the server's forced update rather than a
    // periodic: the reference attributes a frame to an actor only on the
    // transition that flips the room's paused-ness, and every periodic behind it
    // carries a `setBy` re-elected to `min(watchers)`. Measured at t=4150 — the
    // press lands on the element at 4050, reaches the server at 4100 and comes
    // back at 4150 across two 50 ms hops.
    const carrier = host.frames.find((f) => f.state.paused)
    expect(carrier, 'the host never saw a paused frame').toBeDefined()
    expect(carrier!.state.setBy).toBe('joinuser')
    expect(carrier!.state.doSeek).toBe(false)
    expect(carrier!.at).toBe(4150)

    // And the host *followed*: it did not answer the room with a discrete change
    // of its own. This is the assertion that separates following from a loop —
    // a follower that re-announced what it was just told would put a second
    // pause on the wire and the two peers would take turns forever. The host's
    // 1 Hz heartbeat still reports the new paused-ness; a heartbeat bumps no
    // counter.
    expect(discreteSends(host)).toBe(0)
    expect(discreteSends(joiner)).toBe(1)

    // The same door in the other direction. `syncplayPausedBy` clears on the
    // resume rather than lingering on the last pauser.
    joiner.userPlay()
    await room.advance(1)
    expect(room.server.roomState().paused).toBe(false)
    expect(host.el.paused).toBe(false)
    expect(host.ui.syncplayPausedBy.value).toBeNull()
    expect(discreteSends(host)).toBe(0)
    expect(discreteSends(joiner)).toBe(2)
  })

  it('places and stops a peer that joins a room already standing still', async () => {
    // Nothing propagates here: no peer acts for the whole run. The room is
    // paused at `ROOM_START` before the joiner exists, so what reaches the
    // joiner first is the server's join-time `State` — `doSeek: false`,
    // `paused: true`, `setBy` the host — and both halves of the apply rule have
    // to fire off that one frame. That it is the join-time frame and not a
    // periodic is measured, not assumed: suppressing the send guarded by
    // `test/helpers/syncplay-min-election-server.ts:800` ("if (joined) {") in the
    // fixture's `Hello` arm moves the joiner's first frame from t=2050 to t=3050
    // and its single seek write from `JOIN_TIME_ROOM_POSITION` to `ROOM_START`.
    // The element is seated at 0 and *playing*, which is what a freshly bound
    // `<video autoplay>` looks like.
    room = await createTwoPeerRoom({ position: ROOM_START, paused: true })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: true,
      delayMs: DELAY_MS
    })
    await room.advance(2)
    const joiner = await room.seat({
      username: 'joinuser',
      position: 0,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    // The seek half: ~100 s of divergence against a 3 s tolerance, on a frame
    // that never set `doSeek`. Still exactly one write, but no longer because
    // the number never changes. The join-time `State` places the element at
    // `JOIN_TIME_ROOM_POSITION`; the host's first adopted heartbeat then drops
    // the room back to `ROOM_START`, so every later periodic carries a
    // *different* position, 0.05 s away. The tolerance is what swallows those:
    // `src/renderer/src/composables/use-syncplay-client.ts:1569` ("const
    // wouldSeek = state.doSeek || diff > 3.0") leaves `needsSeek` un-armed at a
    // 0.05 s gap, and with the element already paused
    // `src/renderer/src/composables/use-syncplay-client.ts:1751` ("if (!needsSeek
    // && !needsPlayPause) return") returns before the write.
    expect(joiner.el.seekWrites).toEqual([JOIN_TIME_ROOM_POSITION])
    expect(joiner.el.currentTime).toBe(JOIN_TIME_ROOM_POSITION)

    // The play/pause half, and the roster half of the badge: the joiner can name
    // the peer the server attributed the standing pause to, which is a fact no
    // single-peer fixture can produce.
    expect(joiner.el.paused).toBe(true)
    expect(joiner.ui.syncplayPausedBy.value).toBe('hostuser')
    expect(joiner.ui.shouldElementPlay()).toBe(false)

    // And it arrived without announcing anything: a newcomer that answered the
    // room with a discrete state would assert `position: 0` into a `min()`
    // election and drag every other watcher back to the start of the file. The
    // last two are also what keeps the `JOIN_TIME_ROOM_POSITION` above honest —
    // the room and the incumbent both finish on `ROOM_START`, so the joiner's
    // extra 0.05 s is the one frame it was handed on arrival and not a room that
    // crept while nobody was looking.
    expect(discreteSends(joiner)).toBe(0)
    expect(host.el.currentTime).toBe(ROOM_START)
    expect(room.server.roomState().position).toBe(ROOM_START)

    // Which election puts it back, by ordinal rather than by "later" (#411).
    // The middle row is the one the comment's scoping turns on: for one second
    // the host is the *only* candidate, so `min()` returns its compensated
    // mirror frame and `JOIN_TIME_ROOM_POSITION` is not a value above the room,
    // it is the room — which is what the joiner's `Hello` is answered with. The
    // row after it is the recovery, and it is the third election, not an
    // eventual one: the host's first adopted heartbeat is stored raw, the
    // joiner's own report is the offset it was handed, and `min()` takes the
    // host's.
    const elections = room.server.elections
    expect(elections).toHaveLength(6)
    expect(elections[1].positions).toEqual({ hostuser: JOIN_TIME_ROOM_POSITION })
    expect(elections[2].positions).toEqual({
      hostuser: ROOM_START,
      joinuser: JOIN_TIME_ROOM_POSITION
    })
    expect(elections[2].at - elections[0].at).toBe(2000)
    // And it holds for the rest of the run rather than oscillating: three more
    // elections, all naming the incumbent at the truth. Counted before it is
    // quantified over, per docs/testing.md:389 ("Pin the count, never just loop
    // over the set").
    const afterRecovery = elections.slice(2)
    expect(afterRecovery).toHaveLength(4)
    expect(afterRecovery.every((e) => e.setBy === 'hostuser')).toBe(true)
    expect(afterRecovery.every((e) => e.positions.hostuser === ROOM_START)).toBe(true)
  })

  it('never hands the pauser its own pause back', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)
    host.frames.length = 0
    host.el.seekWrites.length = 0

    host.userPause()
    await room.advance(4.6)

    // The control: this run is not vacuously quiet. The pause did reach the
    // room and the other element, so there was a real forced update in flight —
    // and the server sends it to the setter too.
    expect(room.server.roomState().paused).toBe(true)
    expect(joiner.el.paused).toBe(true)
    expect(joiner.frames.some((f) => f.state.paused && f.state.setBy === 'hostuser')).toBe(true)

    // The claim: none of it came back. The host's renderer saw nothing at all
    // for the whole 4.6 s — not the forced update at t=4150 and not the four
    // `paused: true` periodics behind it, all of which are `setBy` the host and
    // die at `src/main/syncplay.ts:2227`.
    expect(host.frames).toEqual([])
    // So its element was never written and never re-paused programmatically.
    expect(host.el.seekWrites).toEqual([])
    // And exactly one discrete change left the host for the whole run. A peer
    // that applied its own echo would re-classify the resulting element event as
    // the user's and announce it again — the self-sustaining loop the guard
    // exists to stop.
    expect(discreteSends(host)).toBe(1)
    const pauseFrames = room.server.wireOf('hostuser').filter((f) => f.paused === true)
    expect(pauseFrames.length).toBeGreaterThan(1)
    expect(pauseFrames.every((f) => f.doSeek !== true)).toBe(true)
  })
})
