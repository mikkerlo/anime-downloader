// @vitest-environment happy-dom
//
// The boundary of #278's read-side rule, made executable.
//
// #278 fixes symptom 1 — "two quick arrow presses revert to the first" — by
// having `handleState()` hand the renderer *our* position instead of the room's
// while a local seek intent is live. That rule reaches exactly the shape where
// **the room never took our seek**, so the intent is still live when the
// contradicting periodic lands.
//
// This file pins the other shape, and it is a test that the bug **survives**:
// the host's big forward seek is *accepted*, the room agrees for one tick, and
// then `Room.getPosition()`'s `min()` over watchers (`server.py:597-604`)
// re-elects the room onto a joiner whose element has not landed yet and is
// still reporting its stalled `currentTime`. By the time that frame arrives the
// host's `seekIntent` has already been retired by the server's own reflected
// forced update — "the recovery fired" and "the intent exists" go false on the
// *same* tick — so no intent-keyed rule can reach it, whatever its lifetime.
//
// This is deliberately a characterisation, not a regression test. It is
// expected to start failing, and to be rewritten rather than deleted, when
// either of its two real causes lands:
//
//  - **#284** — pushing the snapshot from the element's `seeking` *target*
//    rather than its stalled `currentTime`, which is what keeps a mid-seek
//    laggard out of the `min()` election in the first place. Symptom 2's
//    primary fix.
//  - **#279** — the room's position ratcheting backwards under a mirror
//    `min()`; a `doSeek: false` frame should not be allowed to move the room
//    backwards by minutes at all.
//
// ── Why this runs on the two-peer harness (#361 step 3) ───────────────────────
//
// It used to carry a `LaggyElement` whose `apply()` was commented "the
// renderer's apply rule, verbatim" and was a hand-copied `Math.abs(…) <= 3`.
// The shipped rule is a separate literal in `use-syncplay-client.ts`, so the
// copy could drift from it and nothing would notice — the assertion that "the
// renderer applies it" was being made against the copy. Both peers now run the
// real composable over the real preload bridge and the real IPC router
// (`test/helpers/syncplay-two-peer.ts`), so the rule under test is the one that
// ships: mutating the `3.0` at `src/renderer/src/composables/use-syncplay-client.ts:1411`
// reds this file.
//
// The three things `LaggyElement` did are still done, by the harness rather
// than by hand: the laggy landing is `HarnessVideo`'s `seekLandMs`, the 1 Hz
// snapshot push is the composable's own interval instead of the fixture's
// manual `updateSnapshot`, and the seek that starts the crossfire is a scrubber
// drag — a bare `currentTime` write whose `seeked` the composable classifies as
// the user's — instead of a direct `sendLocalState` call.
//
// Still driven by `test/helpers/syncplay-min-election-server.ts` (landed on #282
// for #277), because "who the server says set the room" is the *result* here
// rather than an input — of the election, of the link delay, and of what each
// client last asserted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ADOPT_TOLERANCE_S } from '../../src/main/syncplay'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const SEEK_TO = 645
const DELAY_MS = 50
/** How long the joiner's unbuffered seek takes to land — an MKV/MSE respawn. */
const LAND_MS = 6000

describe('SyncplayClient — the post-agreement re-election #278 does not reach', () => {
  let room: TwoPeerRoom
  let t0 = 0

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    t0 = Date.now()
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  it('yanks a host whose seek the room accepted, with no seekIntent left to key on', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })

    // Both elements start converged on the room and both clients adopt: this is
    // an ordinary two-watcher session, not #277's unadopted mirror. The host's
    // element is buffered and lands its writes on the spot; the joiner's takes
    // LAND_MS and reports its stalled position the whole time.
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: 0
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: LAND_MS
    })

    await room.advance(4)
    expect(host.status().playbackAdopted).toBe(true)
    expect(joiner.status().playbackAdopted).toBe(true)

    // t=4000: the user drags the host's scrubber 545 s forward. No programmatic
    // operation is armed, so the `seeked` the element queues is classified as
    // the user's and leaves through `sendLocalState('seek')` — the same door the
    // shipped player uses.
    const seekedAt = Date.now()
    host.frames.length = 0
    host.userSeek(SEEK_TO)
    await room.advance(0.05)
    expect(host.seekIntent()).not.toBeNull()

    await room.advance(15.95)

    // The frame that is the whole point: the host's element is at ~645 and it is
    // handed the room's collapsed ~104 on a `doSeek: false` periodic. Measured
    // on this fixture — `t=6050 host <- 104.15 setBy=joinuser doSeek=false
    // el=647.05`, and the room never returning above ~114 by t=20000, which is
    // the trace in #278's Motivation on the instant and on the element to two
    // decimal places. The room position it carries is the one number the port
    // moved: 104.15 where the hand-rolled fixture read 105.52, because the
    // snapshot that wins the election is now the composable's own 1 Hz push off
    // a stalled `HarnessVideo` rather than a manual `updateSnapshot` on a
    // 50 ms fixture step, and the two land one slice apart.
    const yank = host.frames.find(
      (f) => f.element > SEEK_TO - 5 && f.state.position < SEEK_TO - 100
    )
    expect(yank, 'the host was never yanked — the fixture stopped reproducing').toBeDefined()

    // 1. The room genuinely moved. This is not a read-side timing artefact:
    //    the server's own `_position` is down there too.
    expect(room.server.roomState().position).toBeLessThan(SEEK_TO - 100)

    // 2. **The intent is already null when it lands.** It was retired by the
    //    server's own reflected forced update (`syncplay.ts:2143-2148`, drift ≈
    //    0) one round trip after the seek — i.e. "the recovery fired" and "the
    //    intent exists" go false on the same tick. #278's rewrite is keyed on
    //    exactly this value, so it cannot fire here however long the window is
    //    held open.
    expect(yank!.intent).toBeNull()
    expect(yank!.at).toBeGreaterThan(seekedAt - t0)

    // 3. And so the frame goes to the renderer unrewritten, at the room's
    //    position rather than ours, far enough out that the renderer applies it
    //    — and this is now the *shipped* apply rule saying so, not a copy of it:
    //    the host's element is dragged back off 645.
    expect(Math.abs(yank!.element - yank!.state.position)).toBeGreaterThan(ADOPT_TOLERANCE_S)
    expect(yank!.state.doSeek).toBe(false)
    expect(host.el.seekWrites.some((w) => w < SEEK_TO - 100)).toBe(true)

    // The tolerance itself, pinned — and this is the line that makes the file a
    // test of the shipped rule rather than of a copy of it.
    //
    // The `3.0` below is not a reimplementation of the apply rule the way
    // `LaggyElement.apply()` was; it is an assertion *about* it, from outside.
    // Every frame here is `doSeek: false` and well inside the file, so the rule
    // reduces to "diff > the literal", and the element's write history says which
    // frames cleared it. Over this run that is two — the yank at t=6050
    // (diff ≈ 543) and one re-seek at t=10050 when free-running drift reached
    // 4.0 s — out of eight periodics, the other six sitting at 1–3 and moving
    // nothing. Mutating the literal at
    // `src/renderer/src/composables/use-syncplay-client.ts:1411` reds this in
    // both directions, and the three checked are worth naming because the
    // failure is a different one each time. `4.0` leaves the t=10050 frame at
    // exactly the tolerance, so it stops qualifying, the element is not
    // re-seeked, and the run free-runs further apart: 2 applied writes against
    // 3 frames this filter counts — `to have a length of 3 but got 2`. `2.0`
    // applies frames this filter skips and the run stays converged: 3 applied
    // writes against 1 — `to have a length of 1 but got 3`. `1000.0` refuses
    // the yank itself and the room never comes back down, so it is assertion 1
    // that goes first — `expected 654.00… to be less than 545`.
    const overTolerance = host.frames.filter(
      (f) => !f.state.doSeek && Math.abs(f.element - f.state.position) > 3.0
    )
    // Separated by *position in the history*, not by value. The drag is write
    // #0 — `seekWrites` is empty until it, as the opening `advance(4)` leaves
    // the host's element free-running — so everything after it is an apply. A
    // value filter would drop an apply that happened to write exactly `SEEK_TO`,
    // and since this count is one of the two sides of the cross-check below it
    // would fail *open*: one fewer applied write, quietly agreeing with a
    // narrowed literal.
    const appliedWrites = host.el.seekWrites.slice(1)
    expect(appliedWrites).toHaveLength(overTolerance.length)
    expect(appliedWrites).toHaveLength(2)

    // 4. The joiner is yanked too — at t≈14050, once the room's `setBy` swings
    //    back to the host and its self-guard stops eating the periodics — and it
    //    **never seeked at all**. It holds no intent at any point in the run, so
    //    there is no lifetime on its side for any rule of this shape to key to.
    //    That is the fact that closes the question rather than merely bounding
    //    it: even an unbounded window would protect the host and leave the
    //    joiner exactly as it is today.
    const joinerYank = joiner.frames.find(
      (f) => f.at > seekedAt - t0 && f.state.position < SEEK_TO - 100 && f.element > SEEK_TO - 5
    )
    expect(
      joinerYank,
      'the joiner was never yanked — the fixture stopped reproducing'
    ).toBeDefined()
    expect(joinerYank!.intent).toBeNull()
    expect(joiner.frames.every((f) => f.intent === null)).toBe(true)
  })
})
