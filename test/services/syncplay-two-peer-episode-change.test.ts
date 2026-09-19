// @vitest-environment happy-dom
//
// The non-switching peer's playhead across an episode change (#360).
//
// **Every assertion in this file is a characterisation pin of behaviour that is
// believed to be wrong.** Nothing here is a desired invariant, nothing here is
// a regression guard, and a change that makes one of these cases go red has not
// necessarily broken anything — it may well have fixed #360. The analysis lives
// in #360; read it before touching a number below, and when a fix lands, invert
// the case and say in the diff which of #360's mechanisms closed. Do **not**
// "repair" a red here by re-pinning it to whatever the tree then says.
//
// What is pinned, and why it needed pinning. One peer presses next episode; the
// other peer presses nothing and never changes file. At the bind gap the
// shipped app actually runs — `bindGapMs: 500`, which is what
// `syncplay-two-peer-adoption.test.ts` seats — the innocent peer is left alone,
// and that is the only regime the suite had ever seen. Above it the peer is
// dragged backwards — but **the gap axis is not monotone and there is not one
// threshold**, so "above the shipped gap" is not a safe summary of it.
//
// One named constant indexes the whole axis: `k = ceil(gap / HEARTBEAT_MS)`,
// against `src/main/syncplay.ts:19` ("const HEARTBEAT_MS = 1000"). Swept at
// **1 ms** resolution with everything except the gap held at the values
// `seatPair` seats, reading the non-switching peer at a 20 s window: `k = 1` is
// clean, `k = 2` through `k = 5` drag, and from `k = 6` up the axis is an
// **alternating comb** — it drags iff `k` is odd. Every edge measured is **one
// millisecond wide**, not a sample boundary: 1000 clean against 1001 dragging,
// 5000 dragging against 5001 clean, and the same at 6000/6001, 7000/7001,
// 8000/8001 and 11000/11001.
//
// So "two disjoint drag bands separated by a ~1 s clean corridor" is withdrawn,
// and so is anything of the shape "clean above 7000". The comb does not stop,
// every cell here read at 20 s: `[]` at 7001-8000 and at 10000, then `[312.00]`
// at 8001-9000, `[314.00]` at 10001-11000, `[316.00]` at 13000 and `[318.00]` at
// 15000. What survives of the old map is only the cells it sampled — 7001 to
// 8000 really are clean — never the conclusion that the axis ended there.
//
// The dragged value is not one number either, every figure in this sentence a
// 20 s read: 304.00 at the onset, 303.05 from 2000 through 5000, 310.00 across
// `k = 7`, and **+2.00 s per dragging run** above that.
// `PLAYBACK_STALE_MS` (`src/main/syncplay.ts:66` ("const
// PLAYBACK_STALE_MS = 5000")) is the lower run's top edge exactly — 5000 drags,
// 5001 is clean, and the operator that puts 5000 *inside* the horizon rather
// than at the bottom of the next run is the `<=` at
// `src/main/syncplay.ts:2341` ("return this.lastSnapshotAt > 0 && Date.now() -
// this.lastSnapshotAt <= PLAYBACK_STALE_MS") — and it is the only edge on the
// **drag** axis that lands on a named constant. That qualifier is load-bearing,
// not pedantry: this header measures two axes, and the other one has an edge on
// the same millisecond — the mirror width's 3 → 4 step is exactly (5000, 5001]
// as well, per the width walk below — so the unqualified "the only edge on this
// axis" was false the moment the second axis was measured, and it is withdrawn
// on that ground rather than softened. The 1001 onset and every comb edge above
// `k = 6` land on nothing this header has identified. **Do not read a threshold
// out of the three dragging cells pinned below** — they are one cell from each of
// three runs, and every cell between and beyond them is described in this header
// only, never asserted. What the pins do establish, each at the window its case
// names: at a 3 s gap the element is written to 303.05 and ends a 20 s window
// ~4.95 s behind where the same window leaves it in the control; at a 6.5 s gap
// it is written to 310.00 by the 14 s read; and at an 8.5 s gap to 312.00 by the
// 14 s read, while a 7.5 s gap one heartbeat below it leaves the element
// untouched through the same 20 s. The drag is shipped, unflagged and unarmed,
// and it costs playback on a peer that made no input at all.
//
// The four cases are one sweep over one knob — five rows of it, because the last
// case seats two gaps rather than one: the assertion it carries *is* the
// difference between them, and splitting it would let either half be deleted with
// the other still green. `bindGapMs` (the harness's bind gap:
// `test/helpers/syncplay-two-peer.ts:393` arms `metadataDueAt` from it inside
// `reload()`) is the gap between the media load algorithm's synchronous
// reset and the `loadedmetadata` task, i.e. how long the switcher's new element
// sits at `HAVE_NOTHING` reading ~0 while the room walks on. Everything else is
// held at `syncplay-two-peer-adoption.test.ts`'s own values — room at 300, both
// peers seated there, `advance(4)` of agreement first — so the control case
// below reproduces that file's numbers exactly and every other row differs from
// it in the gap and in nothing else.
//
// Two mechanisms, not one, which is why 3 s and 6.5 s are separate cases rather
// than two rows of a table. At 3 s the seat de-adopts on the file change
// (`src/main/syncplay.ts:789`) and then **re-latches before the next push, on
// the previous episode's snapshot**: `src/main/syncplay.ts:2596` subtracts the
// projected room from `this.snapshot.position`, and while a reloading element
// announces nothing both terms are still the old episode's number, so the drift
// is 0 and `src/main/syncplay.ts:2597` adopts a seat whose element reads ~0. The
// latched seat then asserts the inbound write's 302 — #360 itself — and wins
// `min()`. At 6.5 s a second path runs: the gap outlives `PLAYBACK_STALE_MS`
// (`src/main/syncplay.ts:66`), so by the first post-bind push
// `src/main/syncplay.ts:902` finds no live playback and
// `src/main/syncplay.ts:903` de-adopts a second time, and there it is the
// inbound write that closes the drift and re-latches us one episode's timestamp
// later.
//
// What that second path does **not** account for is the shape of the axis it
// sits on. Outliving `PLAYBACK_STALE_MS` is monotone in the gap; the comb is not,
// and a monotone entry condition cannot produce a parity alternation — the cells
// at `k = 8`, `k = 10` and `k = 12` outlive that horizon by seconds and are
// clean, while 7001 is clean and carries a *wider* mirror than dragging 7000
// does. So the paragraph above accounts for the path this one cell enters by and
// for nothing wider: what selects odd `k` from even is **not identified** here —
// the arm-frame census below rules the seek gate out as the selector without
// naming what replaces it — which is why the 6.5 s case below is named for what it
// writes rather than for the path it takes. It is, since the 7.5/8.5 s pair, at
// least *pinned*: that case is the only thing in the suite a change collapsing
// this axis back to one threshold above 5000 would have to go red on.
//
// The mirror's *width* is neither of those two paths. `buildPlaystate()` is
// `canAssertSnapshot() && isAdopted()` with the snapshot timer first, so during
// the bind gap — when no push arrives at all — `PLAYBACK_ASSERT_STALE_MS` (2 s,
// `src/main/syncplay.ts:2369`) is what silences us, and the adoption latch does
// not even run inside that window. That is the whole of "withholds our playstate
// entirely" on this path: one frame at 3 s, five at 6.5 s, none at 500 ms. Width
// is monotone non-decreasing in the gap — 28 cells swept, non-decreasing at
// every one of them and at every window read — while the drag is not, which
// means it cannot select the regime: the mirror is **zero frames wide at 500 and
// 1000 ms, both clean, and still zero at 1500 and 2500, which drag**, and it rises
// straight through every edge above that (counted at 20 s: four frames at 5500
// and 6000, both clean; five at 6500 and 7000, both dragging; six at 7500 and
// 8000, both clean again; seven at 8500, dragging).
//
// The strongest case *for* the width hypothesis is worth stating before it is
// disposed of, because it is a measured coincidence and not a straw man: at
// 5000 → 5001 the width steps 3 → 4 and the drag flips dragging → clean, on the
// same millisecond, and a reader who sampled only that pair would have a
// width-selects-the-drag story that fits perfectly. **The pair that settles it
// is 6000 → 6250**: there the width steps 4 → 5 and the drag flips the *other*
// way, clean → dragging. Width only ever moves up, so the two flips cannot both
// be it reading its own threshold — a monotone quantity cannot reverse the sign
// of what it is supposed to select. The 5000/5001 coincidence is the drag axis
// landing on `PLAYBACK_STALE_MS` and the width axis landing on it too, which is
// the paragraph above, not one selecting the other. The count is window-relative
// in its own right — 7500 and 8500 both read four frames at 6 s and part company
// only after it — so no reader should take a mirror count as a proxy for whether
// the peer is dragged.
//
// **3000 and 6500 ms — and why the reason this used to give for skipping 5000
// does not hold.** The old text said the observable crossing "sits somewhere in
// (4000, 5000]" and that 3000 and 7000 "sit clear of it on both sides". Both are
// withdrawn. There is no single crossing to sit clear of, because the axis is a
// comb; and 7000 — which this file pinned until the comb was measured — is the top
// edge of the `k = 7` run, clear on the low side only, since 7001 is already clean.
// 6500 replaces it: same run, same written value, mid-run rather than on an edge.
//
// **Every "clean" in this header means "clean at the window named".** The read
// window is a second axis and it manufactures clean cells of its own. Read at a
// 6 s window instead of 20 s, the drag is absent from 4000, 4500 and 5000 — and
// equally absent from 6500 and 7000 — and at 1 ms resolution that crossing is
// **(3950, 3951]**, one millisecond wide: `[303.05]` at 3950 and `[]` at 3951,
// over two byte-identical runs. It cuts across the comb rather than following it,
// it lands on no constant this header has identified, and no mechanism is claimed
// for it. The same axis bites at the other end: from `k = 11` up the dragging
// cells arrive **between the 14 s and the 20 s read**, so 10001, 11000, 13000 and
// 15000 all read `[]` at 14 s and drag at 20 s. A 20 s window is already marginal
// there, and a shorter one would have reported those cells as clean.
//
// So "the same run answers the question both ways depending on where the window
// ends" is just as true of the 6500 cell this file does pin, where the 6 s window
// reads `[]` and the 14 s and 20 s windows read `[310.00]` — asserted below in
// both windows, on purpose — and of the 8500 cell, `[]` at 6 s against `[312.00]`
// at 14 s and 20 s, asserted the same way. It therefore cannot have been the
// reason 5000 was left out.
//
// What the cells are, measured, each at a 20 s read unless another window is
// named. 3000 is mid-run and window-stable: the drag is already there at a 6 s
// window. 5000 is the lower run's **top edge** (5001 is clean) and
// window-dependent. 6500 is mid-run in the `k = 7` run, and is the cell this file
// pins; 7000 was pinned first, is that run's **top edge**, and was withdrawn for
// exactly that reason — a change moving the edge by one millisecond flipped the
// case, which is a fact about where the pin sat rather than about the tree. The
// value did not move with the pin, because the run's *value* is stable where its
// *position* is not: every cell from 6001 to 7000 writes the same 310.00. The
// `k = 8`/`k = 9` pair is chosen the same way. 7500 and 8500 are both mid-run;
// 8000 and 8001 are the two sides of a 1 ms edge and would have pinned the edge's
// position where what is wanted is the parity.
//
// The control is not decoration. `seekWrites` staying `[]` at gap 500 is the
// only thing that makes the drag rows mean anything — without it they would
// be consistent with a harness that drags the peer on every switch — and it is
// a *near miss* rather than a clean pass: the switcher holds the room 2.45 s
// under the innocent peer's element for the whole 20 s window, and the renderer's
// seek gate needs 3.0. 0.55 s of headroom nobody chose, which is pinned here as a
// number rather than left as a passing boolean.
//
// **That gate has two arms, and every account below is scoped to one of them.**
// `src/renderer/src/composables/use-syncplay-client.ts:1411` ("const wouldSeek
// = state.doSeek || diff > 3.0") fires on an inbound `doSeek` flag *or* on the
// difference computed at
// `src/renderer/src/composables/use-syncplay-client.ts:1403` ("const diff =
// Math.abs(v.currentTime - state.position)"), and a `doSeek: true` state seeks
// whatever `diff` reads. Censused across 63 cells — gap 1000, 1001 through 1060,
// and the 8000/8001 pair, chosen to straddle two crossings rather than to sample
// the axis — `doSeek` is false on every frame the innocent peer applies and never
// true on the wire in either direction. The innocent peer writes in 61 of the 63
// and is clean in 2, 1000 and 8000; all 61 writes are attributed to the `diff`
// arm, and 60 of them are the single 0.05 s step from 1001 to 1060, so the count
// is a property of where the cells were placed and not of the axis. So in this
// scenario the `doSeek` arm is **inert**, and every drag described here is a pure
// `diff > 3.0` crossing — which is a measured property of these rows, not a
// property of the gate, and the second arm is named so no reader takes the
// account for a one-armed one. The instrument was calibrated positive against the
// suite's own scrub fixture, where it does see a `doSeek: true`, so the zero is a
// real zero rather than a blind probe.
//
// Both anchors above carry their path, and that spelling is a hand-held
// convention rather than a gate-enforced one. Line 1411 is live in
// `src/main/syncplay.ts` too, so an anchor written without its path reads as the
// wrong file — and `scripts/check-line-citations.mjs`, which does scan comments,
// puts a pathless anchor in its *uncheckable* class: counted against a pin, never
// resolved to a file. Nothing here would go red for naming the wrong one.
//
// How little headroom that is, measured rather than argued. At a 1000 ms gap —
// still clean, `seekWrites` still `[]`, and with **no arming frame at all in the
// 20 frames it runs** — the same deficit is **2.95 s against the same 3.0, which
// is 0.05 s of headroom**, unchanged from the 6 s read out to a 60 s one, and
// 1001 drags. That is not a coincidence, and the onset is worth stating as cause:
// 1001 reaches a `diff` of exactly 3.000 in decimal on the fourth frame after the
// switch and seeks on that same frame, clearing a strict `>` on **float residue
// alone**.
//
// **That account is the whole of every crossing on this axis and selects none of
// them.** Arm-frame census over `k = 6` through `k = 15` — gaps 6000, 6500, 7500,
// 8500, 9500, 10500, 11500, 12500, 13500 and 14500, thirty frames each, reading
// the composable's own expression at frame-delivery time. Every dragging cell
// arms on a `diff` of 3.0000000953674544, with the frame before it at
// 2.950000095367443 and `doSeek` false on both: bit-for-bit the pair 1001 crosses
// on, so the residue reading is not special to the onset. Every clean cell's
// `diff` **never exceeds 2.0000000953674544** in those thirty frames, and the
// standing deficit at a 60 s read is **2.00 s at every clean `k` from 6 to 15 and
// 1.00 s at every dragging one**. So the gate is the **trigger** on every cell
// that drags and says **nothing** about which cells reach it: 8000 does not miss
// 3.0 by 9.5e-8, it misses it by a full second at steady state, and whatever
// selects odd `k` from even sits upstream of
// `src/renderer/src/composables/use-syncplay-client.ts:1411` rather than in it.
// The knife edge at the 1001 onset is the edge of the `k = 1` clean cell, whose
// headroom really is 0.05 s; above `k = 6` the clean side has a second of room,
// and no edge of the comb is a near miss at the gate.
//
// **Name the quantity before quoting the residue, because the figure moves with
// it.** Sampling `el.currentTime - roomState().position` on 1 s boundaries reads
// 3.000000047683727, about 4.8e-8 over; computing the composable's own expression
// at frame-delivery time reads 3.0000000953674544, about 9.5e-8 over. Both are
// residue on a difference that is exactly 3.000 in decimal, and the three things
// that matter agree across both probes: the crossing gap (1001), the step
// boundary (1051) and the written value. A bare figure here belongs to whichever
// probe produced it and to nothing else.
//
// The onset is therefore a knife edge, and a wide one: 1001 through 1050 are
// **identical** cells, and 1051 steps to the next 0.05 s of `diff` and writes
// 303.95 where they write 304.00. `diff` moves in a 0.05 s quantum because that
// is the harness's own timer slice (`test/helpers/syncplay-two-peer.ts:750` ("const DEFAULT_STEP_MS = 50")),
// so this axis is a **step function rather than
// a line** — a linear fit such as `1.95 + gap/1000` puts the crossing in the
// wrong place. Rounding the other way would not nudge the onset; it would move it
// to 1051, the first cell on the next step. None of that is pinned and no case
// below sits near it; what the figure rules out is reading the 500 ms control as
// a comfortable margin.
//
// This file asserts against the model server, which is legitimate for these
// four cases and would not be for an assertion-side fixture: every row here is
// a *playing* room, and the divergence #360 records between
// `test/helpers/syncplay-min-election-server.ts` and a real 1.7.6 server is on a
// **paused** minimum, which no case below produces (each asserts the room stays
// unpaused, so a case that drifted into that regime goes red rather than quietly
// measuring the model).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { WireFrame } from '../helpers/syncplay-min-election-server'

const DELAY_MS = 50

/** A mirror omits the `paused` key entirely, so `undefined` is the
 *  discriminator — the same test the sibling adoption file uses, spelled again
 *  here rather than exported, because it is two lines and the two files are read
 *  separately. */
const mirroring = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.paused === undefined)

describe('SyncplayClient — the non-switching peer across an episode change (#360)', () => {
  let room: TwoPeerRoom | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  /**
   * Seat the switcher and the innocent peer at the same position with the room,
   * let them agree for four seconds, and hand back both plus the length of the
   * switcher's wire at that instant so a caller can slice the post-switch frames
   * out of it.
   *
   * `bindGapMs` lands on the switcher only. The innocent peer never reloads, so
   * a gap on it would be dead configuration that reads like a variable.
   */
  const seatPair = async (
    bindGapMs: number
  ): Promise<{ switcher: Peer; innocent: Peer; wireBefore: number }> => {
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const switcher = await room.seat({
      username: 'hostuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS,
      bindGapMs
    })
    const innocent = await room.seat({
      username: 'joinuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    // Measured at all three gaps: neither element is written to before the
    // switch. So nothing below clears `seekWrites`, and every list this file
    // asserts is the switch's whole footprint rather than a window of it — which
    // is the difference between "one write, to 302" and "one write since we
    // stopped looking".
    expect(switcher.el.seekWrites).toEqual([])
    expect(innocent.el.seekWrites).toEqual([])

    return { switcher, innocent, wireBefore: room.server.wireOf('hostuser').length }
  }

  it('leaves the non-switching peer where it is at the shipped 500 ms bind gap — the control', async () => {
    // PINS CURRENT BEHAVIOUR. The `[]` here is the outcome #360 wants at every
    // gap, so this case alone reads as a desired invariant — but the *margin* it
    // holds by does not, and the two cases below are the same code failing. See
    // #360.
    const { switcher, innocent, wireBefore } = await seatPair(500)
    const server = room!.server

    switcher.goToEpisode('8')
    await room!.advance(6)

    // The switcher's own element takes #360's write: one seek, to the previous
    // episode's timestamp, on a file that has no such position. That is the
    // defect this issue is titled after, and it is present in all three cases.
    expect(switcher.el.seekWrites).toHaveLength(1)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(302, 2)

    // And it reaches the wire with no spectator mirror in front of it at all.
    // Not "a short mirror" — zero frames: the seat is de-adopted at
    // `src/main/syncplay.ts:789` and re-latched before the next push, so the
    // switcher asserts continuously straight through the switch.
    expect(mirroring(server.wireOf('hostuser').slice(wireBefore))).toEqual([])

    // The innocent peer is not moved, and the room is the sibling adoption
    // file's 306.5 — which is the switcher's dragged value, 2.45 s under the
    // innocent peer's own element, not the 308.95 six more seconds of playback
    // would have left.
    expect(innocent.el.seekWrites).toEqual([])
    expect(innocent.el.paused).toBe(false)
    expect(server.roomState().position).toBeCloseTo(306.5, 1)
    expect(server.roomState().paused).toBe(false)
    expect(innocent.el.currentTime).toBeCloseTo(308.95, 2)

    await room!.advance(8)
    expect(innocent.el.seekWrites).toEqual([])
    expect(server.roomState().position).toBeCloseTo(314.5, 1)
    expect(innocent.el.currentTime).toBeCloseTo(316.95, 2)

    await room!.advance(6)
    expect(innocent.el.seekWrites).toEqual([])
    expect(server.roomState().position).toBeCloseTo(320.5, 1)
    expect(innocent.el.currentTime).toBeCloseTo(322.95, 2)

    // The near miss, as a number. The gate at
    // `src/renderer/src/composables/use-syncplay-client.ts:1411` needs the
    // element-against-state difference to exceed 3.0, and this is what it is:
    // 2.45, constant from the switch out to 20 s. The deficit does not close and
    // it does not grow — it is a standing 2.45 s error that survives because it
    // is 0.55 s short of being acted on.
    expect(Math.abs(innocent.el.currentTime - server.roomState().position)).toBeCloseTo(2.45, 2)
  })

  it('drags the non-switching peer backwards at a 3 s bind gap', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG. A peer that pressed nothing has
    // its playhead written backwards and loses ~5 s of playback. The analysis —
    // the de-adopt at `src/main/syncplay.ts:789`, the stale re-latch at
    // `src/main/syncplay.ts:2597`, and why #360's own inbound write is upstream
    // of both the room drag and this one — is in #360. This is not a guard: when
    // #360 is fixed, this case inverts.
    const { switcher, innocent, wireBefore } = await seatPair(3000)
    const server = room!.server

    switcher.goToEpisode('8')
    await room!.advance(6)

    expect(switcher.el.seekWrites).toHaveLength(1)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(302, 2)

    // The innocent peer is seeked, once, to 303.05 — backwards from the 308.95
    // the control leaves it at over the same six seconds.
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(innocent.el.seekWrites[0]).toBeCloseTo(303.05, 2)
    expect(innocent.el.currentTime).toBeCloseTo(304, 2)
    expect(server.roomState().paused).toBe(false)

    // The room went with it: 304.00 against the control's 306.5.
    expect(server.roomState().position).toBeCloseTo(304, 1)

    // The mirror exists here and lasts exactly one frame. This is the whole of
    // `docs/syncplay.md`'s "withholds our playstate entirely" on this path — one
    // push — and the frame after it is the seat asserting 302.00 into a room
    // that read 305.95, which is the election that drags the room.
    const post = server.wireOf('hostuser').slice(wireBefore)
    expect(mirroring(post)).toHaveLength(1)
    const mirrorAt = post.findIndex((f) => f.paused === undefined)
    expect(mirrorAt).toBe(2)
    expect(post[mirrorAt].position).toBeCloseTo(304.95, 2)
    expect(post[mirrorAt + 1].paused).toBe(false)
    expect(post[mirrorAt + 1].position).toBeCloseTo(302, 2)
    expect(post[mirrorAt + 1].room).toBeCloseTo(305.95, 2)
    // …and the next frame reads the room back at the asserted value: 305.95 →
    // 303.00, a backwards step of ~2.95 s in the room itself.
    expect(post[mirrorAt + 2].room).toBeCloseTo(303, 2)

    // The drag is not deferred and not repaired. Both later windows are past the
    // bind gap's release *and* past `PLAYBACK_STALE_MS`, and the peer stays one
    // write down and ~4.95 s behind the control for the rest of the session.
    await room!.advance(8)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(server.roomState().position).toBeCloseTo(311, 1)
    expect(innocent.el.currentTime).toBeCloseTo(312, 2)

    await room!.advance(6)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(server.roomState().position).toBeCloseTo(317, 1)
    expect(innocent.el.currentTime).toBeCloseTo(318, 2)
    expect(server.roomState().paused).toBe(false)
  })

  it('drags the non-switching peer later at a 6.5 s bind gap, writing it to 310.00 by the 14 s read', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG. Same outcome as the 3 s case by a
    // different route: the gap outlives `PLAYBACK_STALE_MS`
    // (`src/main/syncplay.ts:66`), so `src/main/syncplay.ts:903` de-adopts on a
    // real drift rather than the file change, the mirror survives five frames,
    // and the write that closes it is the inbound one. #360 has the chain. That
    // is the route this cell enters by and not an account of the axis it sits on
    // — the header says why a monotone horizon cannot produce the comb — so this
    // name states what the case pins rather than the path it takes. When #360 is
    // fixed, this case inverts.
    //
    // The gap is 6500 rather than the 7000 this case was first written at, and
    // that is the only thing that moved: 7000 is the **top edge** of the
    // 6001-7000 run, so a change shifting that edge by one millisecond flipped
    // the case for a reason that was about the pin's placement and not about the
    // tree. 6500 is mid-run. Every assertion below is byte-identical at both
    // gaps, because the run's written value is stable where its edges are not —
    // every cell from 6001 to 7000 writes the same 310.00.
    const { switcher, innocent, wireBefore } = await seatPair(6500)
    const server = room!.server

    switcher.goToEpisode('8')
    await room!.advance(6)

    // Six seconds in, the switcher's element is still at `HAVE_NOTHING` reading
    // ~0 with nothing written to it yet, and *nobody* has been dragged. This is
    // the window a fixture that stopped at the bind gap's release would call a
    // pass.
    expect(switcher.el.seekWrites).toEqual([])
    expect(switcher.el.currentTime).toBeCloseTo(0.05, 2)
    expect(innocent.el.seekWrites).toEqual([])
    expect(server.roomState().position).toBeCloseTo(307.95, 1)
    expect(innocent.el.currentTime).toBeCloseTo(308.95, 2)

    await room!.advance(8)

    // Past the gap, the switcher is placed at the previous episode's 302 and then
    // at 308, and the innocent peer is written to 310.00 — backwards from the
    // 316.95 the control has it at over the same fourteen seconds.
    expect(switcher.el.seekWrites).toHaveLength(2)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(302, 2)
    expect(switcher.el.seekWrites[1]).toBeCloseTo(308, 2)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(innocent.el.seekWrites[0]).toBeCloseTo(310, 2)
    expect(server.roomState().position).toBeCloseTo(312.95, 1)
    expect(innocent.el.currentTime).toBeCloseTo(313.95, 2)
    expect(server.roomState().paused).toBe(false)

    // Five mirror frames, against one at 3 s: the two de-adoption paths are
    // distinguishable from the wire alone, which is the only reason this case is
    // not a second row of the 3 s one.
    expect(mirroring(server.wireOf('hostuser').slice(wireBefore))).toHaveLength(5)

    await room!.advance(6)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(server.roomState().position).toBeCloseTo(318.95, 1)
    expect(innocent.el.currentTime).toBeCloseTo(319.95, 2)
    expect(innocent.el.paused).toBe(false)
    expect(server.roomState().paused).toBe(false)
  })

  it('alternates by the parity of k above k = 5 — clean at a 7.5 s bind gap, dragged to 312.00 at 8.5 s', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG, in the dragging half — and the
    // clean half is not the desired invariant either, it is the *other* value of
    // a parity nobody chose. When #360 is fixed the 8.5 s half inverts; the 7.5 s
    // half is expected to stay `[]` and to stop being a coincidence.
    //
    // This is the only case in the suite that pins the comb's **shape** rather
    // than one of its cells. The three cases above all sit at `k <= 7`, so a
    // change collapsing the axis back to a single threshold above 5000 — every
    // gap past `PLAYBACK_STALE_MS` drags — would leave all three green with only
    // the header wrong. The 7.5 s row is what goes red on it: `k = 8` outlives
    // that horizon by 2.5 s and is clean anyway.
    //
    // Both windows are named because "clean" is window-relative throughout this
    // file. Read at 6 s the two gaps are **indistinguishable** — same room, same
    // untouched elements, same four mirror frames — and they part company at the
    // 14 s read, which is also where the switcher's own footprint turns out to be
    // identical across the pair (`[302, 310]` at both). So the difference the
    // parity makes is not visible in what the switcher does, and is not visible
    // at all until the second window.
    //
    // Two gaps in one case on purpose. The assertion here *is* the difference
    // between them, and as two cases either half could be deleted with the other
    // still green — which is exactly the mutation this case exists to catch. The
    // second room's numbers were measured both inside this case and in isolation
    // and are byte-identical, so the shared fake clock carries nothing across.
    //
    // 7500 and 8500 rather than the 8000/8001 pair the header's census
    // straddles: those two are the two sides of a 1 ms edge, and pinning them
    // would pin that edge's position. These two are mid-run in their respective
    // runs, so what they pin is the parity.

    // ── `k = 8`, clean ──────────────────────────────────────────────────────
    const even = await seatPair(7500)
    const evenServer = room!.server

    even.switcher.goToEpisode('8')
    await room!.advance(6)

    expect(even.switcher.el.seekWrites).toEqual([])
    expect(even.switcher.el.currentTime).toBeCloseTo(0.05, 2)
    expect(even.innocent.el.seekWrites).toEqual([])
    expect(evenServer.roomState().position).toBeCloseTo(307.95, 1)
    expect(even.innocent.el.currentTime).toBeCloseTo(308.95, 2)
    expect(mirroring(evenServer.wireOf('hostuser').slice(even.wireBefore))).toHaveLength(4)

    await room!.advance(8)

    // The switcher takes both of #360's writes here exactly as it does at 8.5 s,
    // and the innocent peer is left where fourteen seconds of playback put it —
    // the control's own 316.95.
    expect(even.switcher.el.seekWrites).toHaveLength(2)
    expect(even.switcher.el.seekWrites[0]).toBeCloseTo(302, 2)
    expect(even.switcher.el.seekWrites[1]).toBeCloseTo(310, 2)
    expect(even.innocent.el.seekWrites).toEqual([])
    expect(evenServer.roomState().position).toBeCloseTo(314.95, 1)
    expect(even.innocent.el.currentTime).toBeCloseTo(316.95, 2)
    expect(mirroring(evenServer.wireOf('hostuser').slice(even.wireBefore))).toHaveLength(6)

    await room!.advance(6)
    expect(even.innocent.el.seekWrites).toEqual([])
    expect(evenServer.roomState().position).toBeCloseTo(320.95, 1)
    expect(even.innocent.el.currentTime).toBeCloseTo(322.95, 2)
    expect(even.innocent.el.paused).toBe(false)
    expect(evenServer.roomState().paused).toBe(false)

    // The standing deficit that makes this a clean cell rather than a near miss:
    // 2.00 s against the gate's 3.0, a full second of room where the 500 ms
    // control has 0.55 and a 1000 ms gap has 0.05. No edge of the comb is a near
    // miss at the gate — see the arm-frame census in the header.
    expect(Math.abs(even.innocent.el.currentTime - evenServer.roomState().position)).toBeCloseTo(
      2,
      2
    )

    // ── `k = 9`, dragged ────────────────────────────────────────────────────
    room!.dispose()
    room = undefined

    const odd = await seatPair(8500)
    const oddServer = room!.server

    odd.switcher.goToEpisode('8')
    await room!.advance(6)

    // Indistinguishable from the `k = 8` row at this window, down to the mirror
    // count. A fixture that read only here would report the comb as flat.
    expect(odd.switcher.el.seekWrites).toEqual([])
    expect(odd.switcher.el.currentTime).toBeCloseTo(0.05, 2)
    expect(odd.innocent.el.seekWrites).toEqual([])
    expect(oddServer.roomState().position).toBeCloseTo(307.95, 1)
    expect(odd.innocent.el.currentTime).toBeCloseTo(308.95, 2)
    expect(mirroring(oddServer.wireOf('hostuser').slice(odd.wireBefore))).toHaveLength(4)

    await room!.advance(8)

    // One heartbeat of bind gap later, and the peer that pressed nothing is
    // written to 312.00 — two seconds up from the 6.5 s run's 310.00, which is
    // the `+2.00 s per dragging run` the header describes, and 4.95 s behind the
    // 316.95 the `k = 8` row above leaves it at over the same fourteen seconds.
    // The switcher's writes are the same two.
    expect(odd.switcher.el.seekWrites).toHaveLength(2)
    expect(odd.switcher.el.seekWrites[0]).toBeCloseTo(302, 2)
    expect(odd.switcher.el.seekWrites[1]).toBeCloseTo(310, 2)
    expect(odd.innocent.el.seekWrites).toHaveLength(1)
    expect(odd.innocent.el.seekWrites[0]).toBeCloseTo(312, 2)
    expect(oddServer.roomState().position).toBeCloseTo(313, 1)
    expect(odd.innocent.el.currentTime).toBeCloseTo(313.95, 2)
    expect(oddServer.roomState().paused).toBe(false)
    expect(mirroring(oddServer.wireOf('hostuser').slice(odd.wireBefore))).toHaveLength(7)

    await room!.advance(6)
    expect(odd.innocent.el.seekWrites).toHaveLength(1)
    expect(oddServer.roomState().position).toBeCloseTo(318.95, 1)
    expect(odd.innocent.el.currentTime).toBeCloseTo(319.95, 2)
    expect(odd.innocent.el.paused).toBe(false)
    expect(oddServer.roomState().paused).toBe(false)

    // And the deficit the drag leaves behind is 1.00 s, against the clean row's
    // 2.00 — the two steady states the header's 60 s census reports, here at the
    // 20 s read the rest of this file uses.
    expect(Math.abs(odd.innocent.el.currentTime - oddServer.roomState().position)).toBeCloseTo(1, 2)
  })
})
