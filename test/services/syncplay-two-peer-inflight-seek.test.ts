// @vitest-environment happy-dom
//
// What a peer announces while its own seek is still in flight (#368).
//
// `HarnessVideo` used to model a mid-seek element as **frozen** at its
// pre-write position. #368 captured the opposite against the stock build:
// setting `currentTime` updates the official playback position synchronously,
// so the getter hands back the **seek target** for the whole of the flight and
// it is only *readiness* that lags. Four drags 110 ms apart on a real seek bar
// each read back the preceding target exactly — 1107.7, then 1136.1, then
// 1164.5 — at `readyState` 1, with `buffered` sitting at `[[0, 83.083]]`
// throughout. A frozen element would have read the pre-drag 20.686 every time.
//
// The sign of the modelled error was therefore backwards, and this file is the
// regression pin for the correction. It is a separate file from
// `syncplay-two-peer-adoption.test.ts` on purpose, because the two halves of
// the correction are not both pinnable in one place:
//
//  - The adoption file's first case rebuilds its "permanently at 0" peer on
//    **readiness** — a reloaded element whose metadata is 30 s out. That is the
//    right subject for it, but it is green on the *stock* harness too: with no
//    `currentTime` write ever taken the element has no pending seek, so the
//    getter cannot come into play and the two harness versions are provably
//    identical for it. It restates the premise correctly; it pins nothing about
//    the correction.
//  - The other half is what this file holds, and it is red before and green
//    after. A peer whose seek is merely *slow* is not sitting at 0 at all. It is
//    up at its target, it looks converged the instant the write happens, it
//    therefore **adopts** — and then it asserts that target at 1 Hz while the
//    room walks on without it, wins `Room.getPosition()`'s `min()`, and ratchets
//    the room backwards onto a position its element has not reached.
//
// Measured on the stock (frozen) harness the same fixture gives
// `electionsJoiner 0`, `roomPos 605.95 setBy hostuser`, `currentTime 0` and
// seven writes `[601, 602.05, 601.05, 602, 603, 604, 605]` — the frozen peer
// never adopts, so it mirrors the room back and wins nothing. On the corrected
// harness it takes one write and wins four elections. That is the whole
// difference and it is the reason this file exists.
//
// The room is dragged back by seconds here rather than by the capture's
// minutes, and the bound is the point rather than a weakness of the fixture:
// what a mid-seek peer announces is its **target**, so the damage is bounded by
// how far the target lags the room, not by 0. `syncplay-seek-crossfire.test.ts`
// is the same mechanism at the scale the capture found it, where the target is
// 545 s away from where the room ends up.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import { HarnessVideo } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { WireFrame } from '../helpers/syncplay-min-election-server'

const DELAY_MS = 50

/** As `syncplay-two-peer-adoption.test.ts` separates them: a mirror omits the
 *  `paused` key entirely, so `undefined` is the discriminator. */
const asserting = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.paused !== undefined)
const mirroring = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.paused === undefined)

describe('SyncplayClient — a peer announcing a seek target it has not reached', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  it('elects itself with a position its element has not reached', async () => {
    // The joiner is 600 s behind and its element takes 8 s to honour a seek —
    // longer than this whole run, so the single write it takes never lands.
    room = await createTwoPeerRoom({ position: 600, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: 600,
      paused: false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: 0,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: 8000
    })
    await room.advance(8)

    // The premise. One write, never landed: the element is still seeking and is
    // parked on the target it was handed rather than on 0. On the stock frozen
    // harness this read `0` with seven writes behind it.
    expect(joiner.el.seekWrites).toHaveLength(1)
    expect(joiner.el.seekWrites[0]).toBeCloseTo(601, 2)
    expect(joiner.el.currentTime).toBeCloseTo(601, 2)
    expect(joiner.el.seeking).toBe(true)

    // Readiness is what lags, not the position — which is exactly why the
    // outbound door lets this out. `hasAnnounceablePosition()` tests
    // `readyState >= 1` (`use-syncplay-client.ts:770`) and the element is at 1
    // throughout, with no data anywhere near the position it is announcing.
    expect(joiner.el.readyState).toBe(1)
    expect(joiner.el.readyStates).toEqual([1])

    // Because it *looks* converged at write time, it adopts — and an adopted
    // peer asserts rather than mirroring. Every frame it put on the wire is an
    // assertion, counted rather than sampled.
    expect(joiner.status().playbackAdopted).toBe(true)
    const wire = room.server.wireOf('joinuser')
    expect(wire).toHaveLength(7)
    expect(asserting(wire)).toHaveLength(7)
    expect(mirroring(wire)).toHaveLength(0)

    // And every one of those assertions carries the target, not the element's
    // real progress and not 0: seven frames all at 601 while the room walks from
    // 601 to past 606.
    expect(wire.every((f) => Math.abs(f.position - 601) < 0.5)).toBe(true)

    // The claim: it wins the election with that position, four times, and drags
    // the room back onto it. On the stock harness the joiner won none of them
    // and the room ended at 605.95 under the host.
    expect(room.server.electionsSetBy('joinuser')).toHaveLength(4)
    expect(room.server.roomState().setBy).toBe('joinuser')
    expect(room.server.roomState().position).toBeCloseTo(602, 2)

    // The host is dragged with it — it is the peer that had done nothing wrong.
    expect(host.el.currentTime).toBeLessThan(606.95)
  })

  it('is bounded by the seek target rather than by 0, and the bound moves with the latency', async () => {
    // The same fixture at three landing times. The room ends lower the longer
    // the seek takes, because the target falls further behind the room before it
    // lands — which is the shape of the bound: the damage is "how stale is the
    // target", not "the peer announces 0". A frozen element would have announced
    // 0 at every one of these and the bound would not exist.
    const seen: { landMs: number; roomPos: number; elections: number }[] = []
    for (const landMs of [1200, 2000, 8000]) {
      room = await createTwoPeerRoom({ position: 600, paused: false })
      await room.seat({ username: 'hostuser', position: 600, paused: false, delayMs: DELAY_MS })
      const joiner = await room.seat({
        username: 'joinuser',
        position: 0,
        paused: false,
        delayMs: DELAY_MS,
        seekLandMs: landMs
      })
      await room.advance(8)
      // Never 0, at any latency: the announced floor is the target.
      expect(room.server.wireOf('joinuser').every((f) => f.position >= 601 - 0.01)).toBe(true)
      expect(joiner.el.seekWrites).toHaveLength(1)
      seen.push({
        landMs,
        roomPos: room.server.roomState().position,
        elections: room.server.electionsSetBy('joinuser').length
      })
      room.dispose()
    }

    expect(seen.map((s) => s.elections)).toEqual([4, 4, 4])
    expect(seen[0].roomPos).toBeCloseTo(605.75, 2)
    expect(seen[1].roomPos).toBeCloseTo(604.95, 2)
    expect(seen[2].roomPos).toBeCloseTo(602, 2)
    // Monotone in the latency, which is what "bounded by the target" means.
    expect(seen[0].roomPos).toBeGreaterThan(seen[1].roomPos)
    expect(seen[1].roomPos).toBeGreaterThan(seen[2].roomPos)
  })

  it('reports the target from the write until the landing, then the walking playhead', () => {
    // The element-level statement of the same correction, without a room around
    // it: the reading follows the target for the whole flight and `seeking` is
    // true for exactly that window. Every one of these read 100 before #368.
    const el = new HarnessVideo({ position: 100, paused: false, seekLandMs: 4000 })
    expect(el.seeking).toBe(false)

    el.currentTime = 900
    expect(el.currentTime).toBeCloseTo(900, 6)
    expect(el.seeking).toBe(true)

    vi.advanceTimersByTime(3999)
    expect(el.currentTime).toBeCloseTo(900, 6)
    expect(el.seeking).toBe(true)

    // The landing: `seeking` clears with the `seeked` and the playhead walks on
    // from the target rather than jumping anywhere.
    vi.advanceTimersByTime(1)
    expect(el.tick()).toEqual(['seeked'])
    expect(el.seeking).toBe(false)
    expect(el.currentTime).toBeCloseTo(900, 6)
    vi.advanceTimersByTime(2000)
    expect(el.currentTime).toBeCloseTo(902, 6)
  })

  it('never reports seeking on an element whose write lands immediately', () => {
    // The other side of the same getter, and the one the bare `pending !== null`
    // reading got wrong: `pending` is armed unconditionally by the setter, so a
    // `seekLandMs: 0` element holds one from the write until the clearing
    // `tick()` even though the setter has already re-anchored it onto the
    // target. Without the `seekLandMs > 0` conjunct every read below is `true`,
    // which would call a landed element mid-seek for the whole slice after any
    // write — the four `seekLandMs: 0` files included. The mid-slice
    // `currentTime` read is the other direction: that getter deliberately has
    // no such conjunct, so it still reads the target `300` against a `live()`
    // of `300.05`. Giving it one as a tidy-up reds this line and nothing else
    // in the suite — the four `seekLandMs: 0` files stay green through it for
    // the reason the setter records: `pending.target` and `live()` are
    // bit-identical inside a slice on the fake clock. Without the read below
    // the tidy-up is invisible.
    const el = new HarnessVideo({ position: 100, paused: false, seekLandMs: 0 })
    expect(el.seeking).toBe(false)

    el.currentTime = 300
    expect(el.currentTime).toBeCloseTo(300, 6)
    expect(el.seeking).toBe(false)

    vi.advanceTimersByTime(50)
    expect(el.seeking).toBe(false)
    expect(el.currentTime).toBeCloseTo(300, 6)

    expect(el.tick()).toEqual(['seeked'])
    expect(el.seeking).toBe(false)
    expect(el.currentTime).toBeCloseTo(300.05, 6)
  })

  it('clamps the reported target the way a real seek clamps to the seekable range', () => {
    // #281's out-of-file arm reads downstream of this getter, so the in-flight
    // reading has to be the **clamped** target: Chromium clamps before setting
    // the official position. `seekWrites` still keeps the raw value, so "our
    // code wrote X" stays separable from "the element landed on X".
    const el = new HarnessVideo({ position: 10, duration: 500, paused: true, seekLandMs: 2000 })
    el.currentTime = 9000
    expect(el.seekWrites).toEqual([9000])
    expect(el.currentTime).toBe(500)

    el.currentTime = -40
    expect(el.seekWrites).toEqual([9000, -40])
    expect(el.currentTime).toBe(0)
  })
})
