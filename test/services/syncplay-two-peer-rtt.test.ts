// @vitest-environment happy-dom
//
// RTT compensation across two peers (#361 step 4).
//
// `test/services/syncplay-rtt.test.ts` already owns this seam frame by frame,
// and it is the sharper instrument for the rule itself: it hands one client one
// hand-built `State` and reads the number that comes out. What it cannot do is
// say what the compensation is *for*. `serverRtt` is an input there — a fixture
// decides what the round trip was — so that file can prove the arithmetic but
// not the claim underneath it, which is about two real peers: the far peer has
// to land where the seeker **is**, not where the seek **left**, and the gap
// between those two is exactly the flight time the term adds back.
//
// So the cases here are the ones that need a second element to be true at all.
// Each measures against the other peer's element rather than against a constant
// this file chose.
//
// Where the numbers come from, because none of them is arbitrary:
//
//  - the link is 500 ms one way, so `serverRtt` converges on 1.0 s and the term
//    under test is worth 0.5 s. That is a fat link deliberately: at the 50 ms
//    the sibling files use the term is 0.05 s, which is the slice granularity
//    `advance()` quotes its timings to.
//  - a `doSeek` frame is the carrier both times, because the renderer's apply
//    rule takes the `doSeek` arm unconditionally while the ordinary 1 Hz
//    periodics sit inside its 3 s tolerance and move nothing. A compensation
//    nobody applies is not observable, so every case here rides a seek.
//
// Two things this file cannot isolate, recorded rather than asserted around.
//
// **The periodic half of the same term.** A periodic state carries the identical
// compensation and is not applied, so on this instrument the term is only ever
// visible through the seek arm: a regression that broke it for periodics alone
// would read green here. `syncplay-rtt.test.ts` sees that, because it reads the
// emitted frame instead of the element.
//
// **What happens after the apply.** `MinElectionServer` deliberately does not
// model the server's `ignoringOnTheFly` ignore window (its own header says so),
// and at a 500 ms link that gap has teeth: the far peer's 1 Hz snapshot is a
// whole round trip stale, so the frame it already had in flight when the seek
// landed arrives afterwards, wins `min()` and re-elects the room back towards
// the pre-seek position — which then drags the *seeker* there. A real server
// discards that frame on its ignore flag. Both runs therefore stop at the apply,
// which is the whole of what these cases claim; the crossfire beyond it is a
// property of the model, not of the code, and pinning it here would be pinning
// the model.
//
// **The room-anchor half of `serverRtt`** is not here either, and that is a
// deliberate omission rather than an oversight. `handleState()` back-dates
// `lastRoomState.at` by the same `serverRtt / 2` under a `MAX_ROOM_ANCHOR_LAG_S`
// clamp, and the only peer that puts that number on the wire is one mirroring
// the room — where the mirror's own arrival cadence, the election it then feeds,
// and the clamp are three effects on one observable. Every shape tried here fed
// back into the election and oscillated. `syncplay-room-position.test.ts` and
// `syncplay-mirror-drift.test.ts` hold that axis single-client, where the inputs
// can be held still.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom } from '../helpers/syncplay-two-peer'

/** One way, in ms. `serverRtt` converges on twice this. */
const DELAY_MS = 500
/** The seek target both cases drag to. */
const SEEK_TO = 900

describe('SyncplayClient — RTT compensation across two peers', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  it('lands the far peer where the seeker is, not where the seek left', async () => {
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(6)

    // The premise, read off the client rather than re-derived from `DELAY_MS`:
    // the ping exchange converged on the network round trip, so the term under
    // test is worth half a second here.
    expect(joiner.rtt()).toBeCloseTo(1, 2)

    // Cleared so the assertion below counts the drag's writes and not the
    // convergence the seating did.
    joiner.el.seekWrites.length = 0
    host.userSeek(SEEK_TO)
    await room.advance(1.5)

    // One write, and it is *ahead* of the 900 the user asked for. The 0.05 is
    // the slice the host's element walked between the write and the `seeked`
    // that announced it; the 0.5 on top is the flight time.
    expect(joiner.el.seekWrites).toHaveLength(1)
    expect(joiner.el.seekWrites[0]).toBeCloseTo(901.05, 6)

    // Which is the claim, and it is exact rather than approximate: the far
    // element is on the same frame as the seeking element. Uncompensated the two
    // are half a second apart — a gap nothing else in the stack would close,
    // because it is inside the renderer's 3 s tolerance and inside
    // `ADOPT_TOLERANCE_S`, so both peers would call themselves converged and
    // stay there.
    expect(joiner.el.currentTime).toBeCloseTo(host.el.currentTime, 6)
    expect(joiner.el.currentTime).toBeCloseTo(901.5, 6)
  })

  it('does not shift a paused seek, because a paused position has not aged', async () => {
    // The same drag in a room standing still. Nothing aged in flight, so the
    // term would be pure error here — and a silent one: `doSeek` bypasses the
    // renderer's 3 s tolerance, so the far peer would simply be parked half a
    // second past the frame everyone else is looking at, with no drift test
    // anywhere that reads a gap that small.
    room = await createTwoPeerRoom({ position: 300, paused: true })
    const host = await room.seat({
      username: 'hostuser',
      position: 300,
      paused: true,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: 300,
      paused: true,
      delayMs: DELAY_MS
    })
    await room.advance(6)

    // Same link, same measured round trip: the term is available and worth the
    // same 0.5 s as above. What differs is only the room's pause flag, which is
    // what makes this the gate's case rather than a second copy of the first.
    expect(joiner.rtt()).toBeCloseTo(1, 2)
    expect(room.server.roomState().paused).toBe(true)

    joiner.el.seekWrites.length = 0
    host.userSeek(SEEK_TO)
    await room.advance(1.5)

    // Exactly the seeker's target, to the sample. No 0.05 either: a paused
    // element does not walk between the write and its `seeked`.
    expect(joiner.el.seekWrites).toHaveLength(1)
    expect(joiner.el.seekWrites[0]).toBe(SEEK_TO)
    expect(joiner.el.currentTime).toBe(SEEK_TO)

    // And the two elements are standing on one frame — the one place two peers
    // can be compared with no clock in the way at all.
    expect(host.el.currentTime).toBe(SEEK_TO)
    expect(joiner.el.paused).toBe(true)
    expect(host.el.paused).toBe(true)
  })
})
