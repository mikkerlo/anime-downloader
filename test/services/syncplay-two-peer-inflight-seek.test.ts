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
// Measured with the in-flight reading reverted — the `pending.target` branch of
// the `currentTime` getter taken out, so it walks where the pre-#368 one froze
// — the same fixture gives `electionsJoiner 0`, `roomPos 606.95 setBy hostuser`,
// eight writes `[600, 601, 601.05, 602, 603, 604, 605, 606]`, and a
// `currentTime` of 7.95 — the joiner's un-honoured playhead, not its target:
// the uncorrected peer never adopts, so it mirrors the room back and wins
// nothing. On the corrected harness it takes one write and wins six elections.
// That is the whole difference and it is the reason this file exists.
//
// The counterfactual is stated as that mutation rather than as "the stock
// harness" on purpose. The pre-#368 harness is no longer in the tree, so its
// figures cannot be re-measured; the getter revert can be, and the reverted
// figures in the paragraph above were re-measured under it at this tip.
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
    // parked on the target it was handed rather than on 0. With the in-flight
    // reading reverted this read the un-honoured playhead with eight writes
    // behind it.
    //
    // The target is the room position the joiner was *first told*, and the
    // reference hands that over in its `Hello` reply rather than at the first
    // periodic second — so it is 600, the room's seed, and not the 601 the
    // t=1000 election would have written. A fixture that omitted the join-time
    // `State` measured 601 here.
    expect(joiner.el.seekWrites).toHaveLength(1)
    expect(joiner.el.seekWrites[0]).toBeCloseTo(600, 2)
    expect(joiner.el.currentTime).toBeCloseTo(600, 2)
    expect(joiner.el.seeking).toBe(true)

    // Readiness is what lags, not the position — which is exactly why the
    // outbound door lets this out. `hasAnnounceablePosition()` tests
    // `readyState >= 1` (`use-syncplay-client.ts:813`) and the element is at 1
    // throughout, with no data anywhere near the position it is announcing.
    expect(joiner.el.readyState).toBe(1)
    expect(joiner.el.readyStates).toEqual([1])

    // Because it *looks* converged at write time, it adopts — and an adopted
    // peer asserts rather than mirroring. Every frame it put on the wire is an
    // assertion, counted rather than sampled.
    expect(joiner.status().playbackAdopted).toBe(true)
    const wire = room.server.wireOf('joinuser')
    // Eight, not seven: adopting a second earlier starts the 1 Hz assertion a
    // second earlier, so there is one more of them inside the same 8 s window.
    expect(wire).toHaveLength(8)
    expect(asserting(wire)).toHaveLength(8)
    expect(mirroring(wire)).toHaveLength(0)

    // And every one of those assertions carries the target, not the element's
    // real progress and not 0: eight frames all at 600. The room they are
    // announced into reads 601 for every one of them — the joiner has had it
    // pinned there since its third second — where an undragged room would have
    // reached 606.95.
    expect(wire.every((f) => Math.abs(f.position - 600) < 0.5)).toBe(true)
    expect(wire.every((f) => Math.abs(f.room - 601) < 0.5)).toBe(true)

    // The claim: it wins the election with that position, six times, and drags
    // the room back onto it. With the in-flight reading reverted the joiner won
    // none of them and the room ended at 606.95 under the host.
    expect(room.server.electionsSetBy('joinuser')).toHaveLength(6)
    expect(room.server.roomState().setBy).toBe('joinuser')
    expect(room.server.roomState().position).toBeCloseTo(601, 2)

    // The host is dragged with it — it is the peer that had done nothing wrong.
    // 607.95 is where it ends when nothing drags it, measured on the same
    // fixture at a latency the joiner never wins from.
    expect(host.el.currentTime).toBeLessThan(607.95)
  })

  it('is bounded by the seek target rather than by 0, and the bound moves with the latency', async () => {
    // The same fixture at three landing times. The room ends lower the longer
    // the seek takes, because the target falls further behind the room before it
    // lands — which is the shape of the bound: the damage is "how stale is the
    // target", not "the peer announces 0". A frozen element would have announced
    // 0 at every one of these and the bound would not exist.
    const seen: {
      landMs: number
      roomPos: number
      elections: number
      setBy: string | null
    }[] = []
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
      //
      // Three lines rather than one, because the one-sided bound alone stopped
      // discriminating once it was renumbered from 601 down to 600 — 601 clears
      // a floor of 600, so a fixture that withholds the join-time `State` passes
      // it too. The exact floor is what holds the value, and the third line ties
      // it to the write, so it cannot drift away from the target it is supposed
      // to be without one of the two saying so.
      const wire = room.server.wireOf('joinuser')
      const floor = Math.min(...wire.map((f) => f.position))
      expect(wire.every((f) => f.position >= 600 - 0.01)).toBe(true)
      expect(joiner.el.seekWrites).toHaveLength(1)
      expect(floor).toBeCloseTo(600, 2)
      expect(floor).toBeCloseTo(joiner.el.seekWrites[0], 2)
      seen.push({
        landMs,
        roomPos: room.server.roomState().position,
        elections: room.server.electionsSetBy('joinuser').length,
        setBy: room.server.roomState().setBy
      })
      room.dispose()
    }

    // Not the flat `[4, 4, 4]` this read against a fixture that withheld the
    // join-time `State`, and the difference is a regime and not a renumber. The
    // takeover is still latency-independent — the joiner becomes the `min()` at
    // t=3 s in all three runs — but the *release* is not, so the triple is
    // asserted together with who owns the room at the end:
    //
    //  - 1200 ms: the host never corrects, so the joiner holds the room for six
    //    consecutive elections and still owns it at the end.
    //  - 2000 ms: the joiner's takeover is now early enough that the host's own
    //    corrective seek fires, and it lands *below* the by-then-walking joiner
    //    — a write of 602.0, putting the host at 603 against the joiner's 603.95
    //    at t=7 s. That hands the `min()` back for the
    //    last two seconds, so the joiner wins four and the host, not the joiner,
    //    is who the room ends under. Withholding the join-time `State` hid this
    //    band entirely: at 2000 ms the host issued no corrective seek at all.
    //  - 8000 ms: the seek never lands, so the joiner is pinned below the
    //    corrected host for the whole window and wins six.
    expect(seen.map((s) => s.elections)).toEqual([6, 4, 6])
    expect(seen.map((s) => s.setBy)).toEqual(['joinuser', 'hostuser', 'joinuser'])
    expect(seen[0].roomPos).toBeCloseTo(605.75, 2)
    expect(seen[1].roomPos).toBeCloseTo(603.95, 2)
    expect(seen[2].roomPos).toBeCloseTo(601, 2)
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
