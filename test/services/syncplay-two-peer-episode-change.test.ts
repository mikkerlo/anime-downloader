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
// shipped app actually runs — `metadataMs: 500`, which is what
// `syncplay-two-peer-adoption.test.ts` seats — the innocent peer is left alone,
// and that is the only regime the suite had ever seen. Above it, it is dragged
// backwards: at a 3 s gap its element is written to 303.05 and ends a 20 s
// window ~4.95 s behind where the same window leaves it in the control, and at
// a 7 s gap it is written to 310.00 through a different path. The drag is
// shipped, unflagged and unarmed, and it costs playback on a peer that made no
// input at all.
//
// The three cases are one sweep over one knob. `metadataMs` (the harness's bind
// gap: `test/helpers/syncplay-two-peer.ts:369` arms `metadataDueAt` from it
// inside `reload()`) is the gap between the media load algorithm's synchronous
// reset and the `loadedmetadata` task, i.e. how long the switcher's new element
// sits at `HAVE_NOTHING` reading ~0 while the room walks on. Everything else is
// held at `syncplay-two-peer-adoption.test.ts`'s own values — room at 300, both
// peers seated there, `advance(4)` of agreement first — so the control case
// below reproduces that file's numbers exactly and the two drag cases differ
// from it in the gap and in nothing else.
//
// Two mechanisms, not one, which is why 3 s and 7 s are separate cases rather
// than two rows of a table. At 3 s the seat de-adopts on the file change
// (`src/main/syncplay.ts:789`) and then **re-latches before the next push, on
// the previous episode's snapshot**: `src/main/syncplay.ts:2596` subtracts the
// projected room from `this.snapshot.position`, and while a reloading element
// announces nothing both terms are still the old episode's number, so the drift
// is 0 and `src/main/syncplay.ts:2597` adopts a seat whose element reads ~0. The
// latched seat then asserts the inbound write's 302 — #360 itself — and wins
// `min()`. At 7 s a second path runs: the gap outlives `PLAYBACK_STALE_MS`
// (`src/main/syncplay.ts:66`), so by the first post-bind push
// `src/main/syncplay.ts:902` finds no live playback and
// `src/main/syncplay.ts:903` de-adopts a second time, and there it is the
// inbound write that closes the drift and re-latches us one episode's timestamp
// later.
//
// The mirror's *width* is neither of those. `buildPlaystate()` is
// `canAssertSnapshot() && isAdopted()` with the snapshot timer first, so during
// the bind gap — when no push arrives at all — `PLAYBACK_ASSERT_STALE_MS` (2 s,
// `src/main/syncplay.ts:2369`) is what silences us, and the adoption latch does
// not even run inside that window. That is the whole of "withholds our playstate
// entirely" on this path: one frame at 3 s, five at 7 s, none at 500 ms.
//
// **3000 and 7000 ms, and deliberately not 5000.** The deciding quantity is
// elapsed time from the old episode's last push to the new element's first
// push, quantised to the renderer's 1 Hz cadence, so the observable crossing
// sits somewhere in (4000, 5000] depending on where the switch falls against
// the push boundary. A cell written at 5000 ms is phase-dependent: measured on
// this tree it reports no drag at a 6 s window and `[303.05]` at 14 s, i.e. the
// same run answers the question both ways depending on where the window ends.
// 3000 and 7000 sit clear of it on both sides.
//
// The control is not decoration. `seekWrites` staying `[]` at gap 500 is the
// only thing that makes the two drag rows mean anything — without it they would
// be consistent with a harness that drags the peer on every switch — and it is
// a *near miss* rather than a clean pass: the switcher holds the room 2.45 s
// under the innocent peer's element for the whole window, and the renderer's
// seek gate needs 3.0 (`src/renderer/src/composables/use-syncplay-client.ts:1411`,
// `const wouldSeek = state.doSeek || diff > 3.0`, over the
// `Math.abs(v.currentTime - state.position)` at
// `src/renderer/src/composables/use-syncplay-client.ts:1403`). 0.55 s of
// headroom nobody chose, which is pinned here as a number rather than left as a
// passing boolean.
//
// This file asserts against the model server, which is legitimate for these
// three cases and would not be for an assertion-side fixture: every row here is
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
      metadataMs: bindGapMs
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

  it('drags the non-switching peer later, through the staleness path, at a 7 s bind gap', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG. Same outcome as the 3 s case and a
    // different cause: the gap outlives `PLAYBACK_STALE_MS`
    // (`src/main/syncplay.ts:66`), so `src/main/syncplay.ts:903` de-adopts on a
    // real drift rather than the file change, the mirror survives five frames,
    // and the write that closes it is the inbound one. #360 has the chain. When
    // #360 is fixed, this case inverts.
    const { switcher, innocent, wireBefore } = await seatPair(7000)
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
})
