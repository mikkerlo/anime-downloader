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
// This file pins the other shape, and it is a test that the bug **survives**.
//
// The peer that scrubs is the peer with the unbuffered element, which is the
// role assignment the #368 capture forced: its big forward seek is *accepted*,
// the room agrees for one tick, and then its own 1 Hz snapshot goes out
// carrying the seek **target** — 645, the position a real element reports the
// moment `currentTime` is assigned and for the whole of the flight, with
// nothing buffered within hundreds of seconds of it. On that `doSeek: false`
// periodic `Room.getPosition()`'s `min()` over watchers (`server.py:597-604`)
// elects the *buffered* peer instead, genuinely down at ~105, and the losing
// frame comes back and drags the scrubber off its own target — measured here as
// `t=7050 host <- 104.99 setBy=joinuser doSeek=false el=645`, a 540 s backwards
// jump on the peer that was scrubbing.
//
// The victim is therefore the scrubber, not the laggard. Before #368 this file
// modelled it the other way round — a joiner frozen at its pre-write position
// dragging the host down — and that had the sign of the error backwards: a
// mid-seek element announces too *high*, not too low, so it loses the election
// rather than winning it.
//
// No intent-keyed rule reaches it, and the reason is stronger than a lifetime
// argument. The scrubber's `seekIntent` is **never armed at all** — zero armed
// samples across the run, on any frame. Its element fires exactly one `seeked`,
// at t=13050 and on 104.99, which is the *apply's* target and not the user's
// 645: the yank replaced the in-flight write before it came due, and an
// interrupted seek fires none of its own. That surviving `seeked` matches a
// registered `value` seek operation, so `onVideoSeeked` returns inside
// `consumeSeekOp` (`use-syncplay-client.ts:1963`) without ever reaching
// `sendSyncplayLocalState('seek')`. The user's 645 never gets a `seeked` of its
// own, so it never arms an intent, so there is no lifetime for a rule of this
// shape to extend. #278's rewrite is keyed on exactly that value.
//
// This is deliberately a characterisation, not a regression test. It is
// expected to start failing, and to be rewritten rather than deleted, when
// either of its two real causes lands:
//
//  - **#284** — which has already **shipped**, and is not the fix for this
//    shape. What it added is a readiness term on the two outbound doors for a
//    reloading `HAVE_NOTHING` element (`docs/syncplay.md:121`), and that is
//    correct for what it covers. What this header used to claim it would do —
//    push the element's `seeking` *target* rather than its stalled
//    `currentTime` — is backwards twice over: `sendSyncplayLocalState()`
//    already sends `position: v.currentTime`, and on a mid-seek element
//    `v.currentTime` **is** the target. Pushing the target is the cause here,
//    not the cure. The door it leaves through is `hasAnnounceablePosition()`'s
//    `readyState >= 1` (`use-syncplay-client.ts:770`), which admits an element
//    sitting at exactly HAVE_METADATA with no data at the position it is
//    announcing. Widening that door is a production change and is out of scope
//    for #368.
//  - **#279** — the room's position ratcheting backwards under a mirror
//    `min()`; a `doSeek: false` frame should not be allowed to move the room
//    backwards by minutes at all. On the #368 capture this is the framing that
//    matches: it is precisely and only what would have prevented the jump
//    measured above.
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
// drag — a bare `currentTime` write, which on this unbuffered host queues no
// `seeked` for the composable to classify at all — instead of a direct
// `sendLocalState` call.
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
/** How long the **host's** unbuffered seek takes to land. Deliberately not
 *  labelled "what an MKV/MSE respawn takes", which is what this used to claim
 *  and what #368 retired: a real single scrub off a warm local file landed in
 *  ~283 ms, so 6000 is a worst case — a slow disk, a network share — rather
 *  than a typical cost. It is kept at 6000 by sweep rather than by default. The
 *  yank reproduces at 6000 / 12000 / 20000 and is absent at 300 / 600 / 1200 /
 *  2000 / 3000, so 6000 is the smallest swept value that still produces the
 *  captured shape, and the value carries that provenance here the way the
 *  constants in `vitest.config.ts` carry theirs. */
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

  it('yanks a host whose seek the room accepted, with no seekIntent ever armed', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })

    // Both elements start converged on the room and both clients adopt: this is
    // an ordinary two-watcher session, not #277's unadopted mirror. The roles
    // are the way round the #368 capture forced: the **host** is the scrubber
    // and the unbuffered one, so its writes take LAND_MS and it reports the
    // seek target the whole time; the joiner is buffered, lands on the spot,
    // performs no UI action at all, and is the peer that wins the election
    // honestly.
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: LAND_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: 0
    })

    await room.advance(4)
    expect(host.status().playbackAdopted).toBe(true)
    expect(joiner.status().playbackAdopted).toBe(true)

    // t=4000: the user drags the host's scrubber 545 s forward. With the host
    // seated unbuffered at `seekLandMs: LAND_MS` above, the drag queues no
    // `seeked` at all — `userSeek` only assigns `currentTime` — so nothing
    // leaves through `sendLocalState('seek')` and no `seek` frame is ever
    // written for this target. What reaches the wire is the ordinary 1 Hz
    // snapshot, now carrying the in-flight target because the element reports
    // it, and that is the whole difference: the room is told 645 by a peer that
    // has no data there, without a single frame marked as a seek.
    const seekedAt = Date.now()
    host.frames.length = 0
    host.userSeek(SEEK_TO)
    await room.advance(0.05)
    // And the intent is **not** armed, here or ever. Before the #368 role swap
    // this line read `not.toBeNull()`: the scrubber was the buffered peer, its
    // write landed on the spot, and the `seeked` that landing fired was
    // classified as the user's and armed an intent. With the scrubber
    // unbuffered the write is still in flight, no `seeked` has fired, and none
    // ever will for this target — the yank replaces it before it comes due. The
    // header explains why that is the stronger version of the same point.
    expect(host.seekIntent()).toBeNull()

    await room.advance(15.95)

    // The frame that is the whole point: the host's element reports 645 — its
    // own in-flight seek target — and it is handed the room's collapsed ~105 on
    // a `doSeek: false` periodic. Re-measured on the swapped fixture:
    // `t=7050 host <- 104.99999995231629 setBy=joinuser doSeek=false el=645`,
    // with the room never returning above ~110 by t=20000. That is the shape of
    // the #368 capture — a scrubber announcing a forward position it has no
    // data for, losing `min()` to a peer genuinely behind it, and being seeked
    // backwards by the difference — at a tenth of the capture's 1171.97 s
    // because this room starts at 100 rather than at 20.
    //
    // The numbers moved from the pre-#368 fixture (`t=6050 … 104.15 … el
    // 647.05`) for two reasons worth keeping apart: the roles are swapped, so
    // the element under the yank is the other one, and the element no longer
    // freezes, so the position it announces is the target rather than a walked
    // pre-write reading.
    const yank = host.frames.find(
      (f) => f.element > SEEK_TO - 5 && f.state.position < SEEK_TO - 100
    )
    expect(yank, 'the host was never yanked — the fixture stopped reproducing').toBeDefined()

    // 1. The room genuinely moved. This is not a read-side timing artefact:
    //    the server's own `_position` is down there too.
    expect(room.server.roomState().position).toBeLessThan(SEEK_TO - 100)

    // 2. **The intent is null when it lands — because it was never armed.**
    //    Not, as this file said before #368, because the server's reflected
    //    forced update (`syncplay.ts:2143-2148`, drift ≈ 0) retired it one round
    //    trip after the seek. That retirement path is real and still reachable,
    //    but it is not what happens here: with the scrubber unbuffered there is
    //    no `seeked` for the user's 645 to arm an intent from in the first
    //    place, so there is nothing to retire. Either way #278's rewrite is
    //    keyed on exactly this value and cannot fire, and the "never armed"
    //    version is the stronger statement — it holds however long the window
    //    is held open *and* however the server replies.
    expect(yank!.intent).toBeNull()
    expect(yank!.at).toBeGreaterThan(seekedAt - t0)

    // 3. And so the frame goes to the renderer unrewritten, at the room's
    //    position rather than ours, far enough out that the renderer applies it
    //    — and this is now the *shipped* apply rule saying so, not a copy of it:
    //    the host's element is dragged back off 645.
    expect(Math.abs(yank!.element - yank!.state.position)).toBeGreaterThan(ADOPT_TOLERANCE_S)
    expect(yank!.state.doSeek).toBe(false)
    expect(host.el.seekWrites.some((w) => w < SEEK_TO - 100)).toBe(true)

    // The cross-check below still says the applies and the over-tolerance
    // frames are the same set, but this file no longer pins the **tolerance
    // literal**, and that has to be said out loud because it used to.
    //
    // Before the #368 role swap this run produced two applies against two
    // qualifying frames, so mutating the `3.0` at
    // `src/renderer/src/composables/use-syncplay-client.ts:1411` moved the two
    // sides apart and red this file. On the swapped fixture both sides are 1,
    // so the cross-check agrees with itself under a `3.0` → `4.0` mutation and
    // stops being the thing that catches it. The file still reds under that
    // mutation, on `expect(host.frames).toHaveLength(5)` reading 2 — a frame
    // census reacting to the widened tolerance, which says nothing about what
    // the literal is. Re-deriving the window here does not work either: after the
    // yank the swapped run reaches a fixed point at a drift of exactly 1.9500 s
    // and holds it — both peers free-run at 1 s/s with a constant link and
    // election offset, so the drift never accumulates — and extending the run
    // to 60 s, 180 s and 600 s leaves `maxDrift` at 1.9500 and the apply count
    // at 1. No run length puts a frame on the widened edge.
    //
    // **The pin is not lost; it moved.**
    // `use-syncplay-client.test.ts:5085 ("expect(v.currentTime).toBe(604)")`
    // pins the same half-open `[3.0, 4.0)` window and pins it more tightly, on
    // a fake element parked at 600 handed seven 1 Hz frames at 601…607: the
    // first frame clearing the literal is 604 for any tolerance in `[3.0,
    // 4.0)`, 605 at `4.0` and 606 under `2.0`. The two files are a pair, and
    // anyone trimming either should know it. Note that the surviving site lives
    // outside `test/services/`, so `npx vitest run test/services/` cannot see
    // the mutation control at all — run the whole suite.
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
    // One, not the pre-#368 two: `[104.99999995231629]`. The second write in
    // the old fixture was a re-seek at t=10050 off accumulated free-running
    // drift, and the swapped run never accumulates any — see the fixed point
    // described above.
    expect(appliedWrites).toHaveLength(1)

    // 4. **Neither peer ever holds an intent, so an unbounded window would
    //    protect neither.** This used to be argued through the joiner: it was
    //    the laggard, it was yanked too at t≈14050, and it had never seeked, so
    //    there was nothing on its side for an intent-keyed rule to reach. The
    //    #368 swap takes that assertion's subject away — the joiner is the
    //    *buffered* peer now, it sits between ~100 and ~110 for the whole run,
    //    and it is never dragged anywhere at all.
    //
    //    The argument survives on the victim instead, and in a stronger form.
    //    The host is the peer that scrubbed, it is the peer that gets yanked,
    //    and its intent is null on **every** frame of the run rather than
    //    merely retired by the time the yank lands. So the question is closed
    //    rather than bounded, and it is closed on both sides at once.
    expect(host.frames.every((f) => f.intent === null)).toBe(true)
    expect(joiner.frames.every((f) => f.intent === null)).toBe(true)
    // Counted, not sampled, on both sides: an `every()` over a set that turned
    // out empty would report green while asserting nothing.
    expect(host.frames).toHaveLength(5)
    expect(joiner.frames).toHaveLength(14)
    // And the joiner's non-participation is a fact about the run rather than a
    // filter that happened to miss: it never reported a position within 100 s
    // of the scrubber's target, which is what "it was never the victim" means
    // here.
    expect(joiner.frames.every((f) => f.element < SEEK_TO - 100)).toBe(true)
  })
})
