// @vitest-environment happy-dom
//
// The paused-room creep, handed on (#411).
//
// `buildPlaystate()`'s "Known consequence" comment used to contain its own blast
// radius in two sentences — "nobody is watching in that state", and, a dozen
// lines below it, that a crept mirror "loses every election". #411 is the
// finding that both are narrower than they read, and this file is the
// measurement, because the fix is otherwise all prose: a comment that states an
// unmeasured thing in a measured voice is the defect being corrected, so
// replacing one unmeasured claim with another would reproduce it.
//
// The shape is the one the old wording could not reach: a spectator with no
// player of its own sits **alone** in a paused room for six heartbeats, and
// then somebody joins.
//
//  - Alone, the creep is not an error term sitting above the room. The
//    spectator is the only candidate in `Room.getPosition()`'s `min()`, and a
//    single-candidate `min()` returns its argument rather than rejecting it —
//    so the crept value *is* the room. That is why "loses every election" does
//    not reach this case: nothing is contested, and there is no election to
//    lose.
//  - The joiner is then handed that value, and keeps it. It adopts where it
//    landed and reports *that* raw — `paused: true`, which the server stores
//    without the `+ fd` term — while the spectator's mirror is re-compensated a
//    forward delay *above* it and loses every election from then on. So the
//    room never comes back to the truth: the only peer that still holds it is
//    the one that will not assert it.
//
// The contrast is `syncplay-two-peer-playpause.test.ts`, "places and stops a
// peer that joins a room already standing still": the same handoff, bounded at
// one delay, with the room back on the truth at the third election — because
// there the incumbent *had* adopted a player and reports raw. The difference
// between these two files is the whole of the qualifier #411 adds to that
// comment.
//
// Deliberately not measured here: the drift rate for a spectator genuinely
// alone, which #411 puts out of scope. Six seconds is what it takes to hand a
// value over, and the series below is pinned as the route to the handoff rather
// than as a rate claim — `syncplay-mirror-drift.test.ts` owns the rate, for a
// room of two mirroring peers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50
/** Heartbeats the spectator spends alone, i.e. elections before the joiner exists. */
const ALONE_SECONDS = 6

/**
 * `ROOM_START` after `steps` of the server's forward-delay compensation,
 * accumulated the way the server accumulates it.
 *
 * Repeated addition rather than `ROOM_START + steps * d`, and the distinction is
 * load-bearing rather than cosmetic: the server re-stores each mirror frame with
 * `+= fd` — `test/helpers/syncplay-min-election-server.ts:945` ("w.position =
 * position + (ps.paused === true ? 0 : this.forwardDelayFor(w))")
 * — so three compensations of 0.05 arrive at 100.14999999999999, while
 * `100 + 3 * 0.05` is 100.15. Those are different doubles, and every exact
 * assertion below is an equality on the value the server actually built.
 */
const creptBy = (steps: number): number => {
  let v = ROOM_START
  for (let i = 0; i < steps; i += 1) v += DELAY_MS / 1000
  return v
}

/**
 * What the room reads by the time the joiner's `Hello` is answered, and what the
 * joiner is therefore handed: three compensations, not six.
 *
 * Six elections produce three because of the zero-phase artefact
 * `syncplay-mirror-drift.test.ts` documents: the mirror announces the room as it
 * was told it one second earlier, so the loop closes only every other second and
 * the ratchet is reported at half rate. Pinned as measured, which is the point —
 * a `ROOM_START + N * d` formula would encode the rate this file is not claiming.
 */
const HANDOFF_POSITION = creptBy(3)

/** Where the spectator's own mirror is stored once it is no longer the room. */
const SPECTATOR_ABOVE_ROOM = creptBy(4)

/** Discrete changes this peer originated, i.e. anything it announced of its own. */
const discreteSends = (p: Peer): number => p.counters().clientIgnoreCounter

describe('SyncplayClient — a paused room crept alone, then handed to a joiner', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  it("promotes a lone spectator's crept value to the room, and the joiner keeps it", async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: true })

    // A spectator, which here means a peer whose element will never be worth
    // announcing: `readyState: 0` puts `hasAnnounceablePosition()` below its
    // floor — `src/renderer/src/composables/use-syncplay-client.ts:821-823`
    // ("return (v.readyState ?? 0) >= 1") — so no snapshot is ever pushed to
    // main and `lastSnapshotAt` stays 0. That is what keeps this peer on the
    // mirror exit for the whole run, and it is a gate rather than luck: with no
    // snapshot, `canAssertSnapshot()` is the false conjunct at
    // `src/main/syncplay.ts:2512`
    // ("if (this.canAssertSnapshot() && this.isAdopted()) {") and the `&&`
    // short-circuits before `isAdopted()` can latch.
    const spectator = await room.seat({
      username: 'ghostuser',
      position: ROOM_START,
      paused: true,
      readyState: 0,
      delayMs: DELAY_MS
    })
    await room.advance(ALONE_SECONDS)

    // The ratchet, election by election, while nobody else is in the room. The
    // repeats are the half-rate reporting, not a stall.
    expect(room.server.elections.map((e) => e.positions.ghostuser)).toEqual([
      creptBy(0),
      creptBy(1),
      creptBy(1),
      creptBy(2),
      creptBy(2),
      creptBy(3)
    ])

    // And this is the half the old comment got wrong. Every one of those
    // elections had exactly one candidate, so `min()` handed back the crept
    // value itself: it is not *above* the room, it **is** the room, and the
    // spectator is the peer the server names as having set it. The count is
    // pinned before it is quantified over, per docs/testing.md:372 ("Pin the
    // count, never just loop over the set") — `every()` on an empty array is
    // `true`, and an `elections` array that stopped being filled would leave
    // the two lines below green while asserting nothing.
    expect(room.server.elections).toHaveLength(ALONE_SECONDS)
    expect(room.server.elections.every((e) => Object.keys(e.positions).length === 1)).toBe(true)
    expect(room.server.elections.every((e) => e.setBy === 'ghostuser')).toBe(true)
    expect(room.server.roomState().position).toBe(HANDOFF_POSITION)
    expect(room.server.roomState().paused).toBe(true)

    // None of which this peer did on purpose, and none of which it can see. Its
    // element never moved off the truth, and it announced nothing discrete —
    // the creep is entirely the server's arithmetic over a frame that omits
    // `paused`, which is what `buildPlaystate()`'s mirror exit sends
    // (`src/main/syncplay.ts:2593-2596`
    // ("position: this.projectedRoomPosition(room)")). `paused` absent on every
    // frame is the observable that says it stayed on that exit —
    // `test/helpers/syncplay-min-election-server.ts:466-471` ("paused?:
    // boolean") is absent exactly for a mirror — and
    // `playbackAdopted` is the same fact read off the client.
    expect(spectator.el.currentTime).toBe(ROOM_START)
    expect(spectator.el.seekWrites).toEqual([])
    expect(discreteSends(spectator)).toBe(0)
    expect(spectator.status().playbackAdopted).toBe(false)
    const aloneFrames = room.server.wireOf('ghostuser')
    expect(aloneFrames).toHaveLength(ALONE_SECONDS)
    expect(aloneFrames.every((f) => f.paused === undefined)).toBe(true)
    // Never above the room either, which is the same finding from the other
    // side: a mirror that *was* above the room would be the case the comment
    // described, and this one is at or below it for every frame it sends.
    expect(aloneFrames.every((f) => f.position <= f.room)).toBe(true)

    // Somebody joins — a real player, seated at 0 and playing, which is what a
    // freshly bound `<video autoplay>` looks like.
    const joiner = await room.seat({
      username: 'joinuser',
      position: 0,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(6)

    // "Nobody is watching in that state" ends here: the join-time `State` places
    // this element on the crept value, ~100 s from where it was, and stops it.
    expect(joiner.el.seekWrites).toEqual([HANDOFF_POSITION])
    expect(joiner.el.currentTime).toBe(HANDOFF_POSITION)
    expect(joiner.el.paused).toBe(true)
    // Attributed to the peer that never touched a playhead, because the
    // spectator is who the room's `min()` has been electing.
    expect(joiner.ui.syncplayPausedBy.value).toBe('ghostuser')
    expect(discreteSends(joiner)).toBe(0)

    // And it stays — measured, not derived, which is the reason this fixture
    // exists rather than a sentence saying so. From the election after the
    // handoff the room is the joiner's *raw* report of the value it was handed,
    // while the spectator's mirror is stored one forward delay above it and
    // loses every one. Five elections of it, and the room does not move.
    // The join second itself is contested and still the spectator's: both
    // candidates report the handed value, and the tie names the crept mirror.
    expect(room.server.elections[ALONE_SECONDS].positions).toEqual({
      ghostuser: HANDOFF_POSITION,
      joinuser: HANDOFF_POSITION
    })
    expect(room.server.elections[ALONE_SECONDS].setBy).toBe('ghostuser')
    const settled = room.server.elections.slice(ALONE_SECONDS + 1)
    expect(settled).toHaveLength(5)
    expect(settled.every((e) => e.setBy === 'joinuser')).toBe(true)
    expect(settled.every((e) => e.positions.joinuser === HANDOFF_POSITION)).toBe(true)
    expect(settled.every((e) => e.positions.ghostuser === SPECTATOR_ABOVE_ROOM)).toBe(true)
    expect(room.server.roomState().position).toBe(HANDOFF_POSITION)
    expect(room.server.roomState().setBy).toBe('joinuser')

    // Why nothing re-asserts the truth, stated as two facts rather than as a
    // mechanism: the joiner adopted at the position it was handed, so raw is
    // exactly the offset; and the one peer whose element still reads
    // `ROOM_START` is the one that adopted nothing and announced nothing, all
    // run. That asymmetry is the whole of the difference from the playpause
    // fixture, where the incumbent had adopted the truth and put it back.
    expect(joiner.status().playbackAdopted).toBe(true)
    const joinerFrames = room.server.wireOf('joinuser')
    expect(joinerFrames).toHaveLength(6)
    expect(joinerFrames.every((f) => f.paused === true)).toBe(true)
    expect(spectator.status().playbackAdopted).toBe(false)
    expect(spectator.el.currentTime).toBe(ROOM_START)
    expect(spectator.el.seekWrites).toEqual([])
  })
})
