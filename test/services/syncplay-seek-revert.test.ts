// @vitest-environment happy-dom
//
// A user seek still in flight when the next room frame lands, swept over both
// roles × landing time × heartbeat phase (#489 Tier 1, rows S1 / S2 / S9).
//
// **This file pins a known-broken behaviour (#488 ✗).** Every table below is
// what current `main` does, cell for cell, and the fix for #488 is expected to
// turn it red. That is the contract: the fix PR rewrites the tables (the
// `other` role's `UNDONE_UNANNOUNCED` cells go empty) rather than deleting the
// file, so the sweep that proved the bug is the sweep that proves the fix.
//
// The mechanism, as #488 traces it: a user seek is a bare `currentTime` write
// and reaches the room only when its own `seeked` fires
// (`onVideoSeeked`, `src/renderer/src/composables/use-syncplay-client.ts:1962`).
// While it is in flight the 1 Hz push carries the target with `doSeek: false`
// and loses the server's `min()` election, and the next foreign frame reaches
// the apply with `diff > 3.0` (`use-syncplay-client.ts:1411`), which writes the
// room's old position back. That write aborts the user's seek, the only
// `seeked` left is the apply's own, and the user's target is never announced.
//
// ── Why this is a separate file ──────────────────────────────────────────────
//
// Two existing files sit next to S1 / S2, and neither measures this:
//
//  - `syncplay-two-peer-inflight-seek.test.ts` (#368) is about what a mid-seek
//    element **announces into the election**: its in-flight write is the
//    app's own adoption apply, never a user seek, and its claim is that the
//    *room* is dragged down onto a target the element has not reached. Its
//    subject is the room; this file's subject is the seeker's own element and
//    whether its user's seek **survives and reaches the room at all**. The
//    seek in that file is never undone — it is the room that moves.
//  - `syncplay-seek-crossfire.test.ts` (#278 / #368) is a single-cell
//    characterisation of the `setBy` role at a 6 s landing, a post-agreement
//    re-election. It never sweeps the non-`setBy` role, which is the role #488
//    exposes at every landing time; that is the gap this file closes, and the
//    reason the crossfire file stays a characterisation rather than growing a
//    role axis it would then have to explain twice.
//
// PR #491 (the #488 fix, open when this landed) carries its own regression
// sweep, `syncplay-two-peer-seek-revert.test.ts`, written against the fixed
// code. Whichever of the two merges second reconciles: if #491 lands after
// this, it flips the tables here; if before, this file's tables are re-measured
// on the fixed tree.
//
// ── What a cell is ───────────────────────────────────────────────────────────
//
// Two peers in a playing room at `ROOM_START`, 50 ms each way. After four
// seconds plus `phaseMs` (the drag's position in the 1 Hz frame cycle) the
// seeker drags to `SEEK_TO`, a bare write that takes `landMs` to land. The cell
// is read eight seconds later. `role` names which peer drags: `setBy` is the
// peer the room is currently set by (asserted at the drag, not assumed), and
// `other` is the one handed the room's foreign frames.
//
// A cell is **bad** when any S1 / S2 pass condition fails: the seeker did not
// end within 20 s of its target, or it put other than exactly one `doSeek`
// frame on the wire, or the other peer did not end within 20 s of the seeker.
// `UNDONE_UNANNOUNCED` is the narrower #488 signature: undone **and** no
// `doSeek` ever left. A false toast (S9) is a "<peer> seeked …" toast on the
// seeker naming the other peer, who never touched anything.
//
// The `setBy` role's scattered single-phase cells at short landings are not
// #488: there the seek is announced, sticks, and the *other* peer ends back near
// the start. They are the crossing case — the other peer's heartbeat, carrying
// the old position, crosses our `doSeek` on the wire and is re-elected — and they
// are pinned here because a pass condition fails on them, not because this file
// claims to explain them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { watch } from 'vue'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
/** Far from anything main can hold as `lastAppliedRemotePosition`, so the
 *  echo-seek guard cannot be what drops a frame here. */
const SEEK_TO = 600
const DELAY_MS = 50
/** Every value a whole number of the harness's 50 ms slices. */
const LANDINGS_MS = [100, 250, 400, 650, 900, 1500, 3000] as const
const PHASES_MS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]
const READ_AFTER_S = 8
const NEAR_S = 20

type Role = 'setBy' | 'other'
type Landing = (typeof LANDINGS_MS)[number]
type Table = Record<Landing, number[]>

interface Cell {
  phaseMs: number
  undone: boolean
  doSeeks: number
  falseToast: boolean
  seekerEnd: number
  otherEnd: number
}

const isBad = (c: Cell): boolean =>
  c.undone || c.doSeeks !== 1 || Math.abs(c.otherEnd - c.seekerEnd) > NEAR_S

// ── Current-main tables (#488 ✗). The fix PR rewrites these. ─────────────────

const ALL = PHASES_MS

/** Undone and never announced — the #488 signature. Grows with the landing
 *  time on the `other` role (P ≈ landing / 1000 ms), and is empty on the
 *  `setBy` role until the landing outlasts the server's re-election. */
const UNDONE_UNANNOUNCED: Record<Role, Table> = {
  other: {
    100: [0],
    250: [0, 800, 900],
    400: [0, 700, 800, 900],
    650: [0, 400, 500, 600, 700, 800, 900],
    900: [0, 200, 300, 400, 500, 600, 700, 800, 900],
    1500: ALL,
    3000: ALL
  },
  setBy: {
    100: [],
    250: [],
    400: [],
    650: [],
    900: [],
    1500: [],
    3000: [100, 200, 300, 400, 500, 600, 700, 800, 900]
  }
}

/** Any S1 / S2 pass condition failed. */
const BAD: Record<Role, Table> = {
  other: {
    100: [0, 800],
    250: [0, 700, 800, 900],
    400: [0, 500, 700, 800, 900],
    650: [0, 300, 400, 500, 600, 700, 800, 900],
    900: [0, 200, 300, 400, 500, 600, 700, 800, 900],
    1500: ALL,
    3000: ALL
  },
  setBy: {
    100: [800],
    250: [700],
    400: [500],
    650: [300],
    900: [],
    1500: [400],
    3000: [100, 200, 300, 400, 500, 600, 700, 800, 900]
  }
}

/** S9: a "<peer> seeked" toast on the seeker, naming a peer who did nothing. */
const FALSE_TOAST: Record<Role, Table> = {
  other: {
    100: [0, 800],
    250: [0, 700, 800, 900],
    400: [0, 500, 700, 800, 900],
    650: [0, 300, 400, 500, 600, 700, 800, 900],
    900: [0, 200, 300, 400, 500, 600, 700, 800, 900],
    1500: ALL,
    3000: ALL
  },
  setBy: {
    100: [800],
    250: [700],
    400: [500],
    650: [300],
    900: [0],
    1500: [400],
    3000: [100, 200, 300, 400, 500, 600, 700, 800, 900]
  }
}

describe('SyncplayClient — a user seek in flight vs the next room frame, both roles (#488 ✗)', () => {
  let room: TwoPeerRoom | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = null
    vi.useRealTimers()
  })

  async function runCell(role: Role, landMs: number, phaseMs: number): Promise<Cell> {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: role === 'setBy' ? landMs : 0
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: role === 'other' ? landMs : 0
    })
    await room.advance(4 + phaseMs / 1000)
    // The role is a fact about the room at the drag, not a seat order: the host
    // must be the room's `setBy` here, or every `other` cell below would be
    // measuring the `setBy` role and pass on the wrong subject.
    expect(room.server.roomState().setBy).toBe('hostuser')
    const seeker = role === 'setBy' ? host : joiner
    const other = role === 'setBy' ? joiner : host
    const wireBefore = room.server.wireOf(seeker.username).length
    const toasts: string[] = []
    const stop = watch(seeker.ui.syncplayToast, (t) => t && toasts.push(t), { flush: 'sync' })
    seeker.userSeek(SEEK_TO)
    await room.advance(READ_AFTER_S)
    stop()
    const cell: Cell = {
      phaseMs,
      undone: Math.abs(seeker.el.currentTime - SEEK_TO) > NEAR_S,
      doSeeks: room.server
        .wireOf(seeker.username)
        .slice(wireBefore)
        .filter((f) => f.doSeek === true).length,
      falseToast: toasts.some((t) => t.includes(other.username) && /seek/i.test(t)),
      seekerEnd: seeker.el.currentTime,
      otherEnd: other.el.currentTime
    }
    room.dispose()
    room = null
    return cell
  }

  async function sweep(
    role: Role
  ): Promise<Record<'undoneUnannounced' | 'bad' | 'falseToast', Table>> {
    const out = { undoneUnannounced: {}, bad: {}, falseToast: {} } as Record<
      'undoneUnannounced' | 'bad' | 'falseToast',
      Table
    >
    for (const landMs of LANDINGS_MS) {
      const cells: Cell[] = []
      for (const phaseMs of PHASES_MS) cells.push(await runCell(role, landMs, phaseMs))
      const phases = (f: (c: Cell) => boolean): number[] => cells.filter(f).map((c) => c.phaseMs)
      out.undoneUnannounced[landMs] = phases((c) => c.undone && c.doSeeks === 0)
      out.bad[landMs] = phases(isBad)
      out.falseToast[landMs] = phases((c) => c.falseToast)
    }
    return out
  }

  it('undoes the non-setBy peer’s seek in proportion to its landing time, and never announces it (S1)', async () => {
    const got = await sweep('other')
    expect(got.undoneUnannounced).toEqual(UNDONE_UNANNOUNCED.other)
    expect(got.bad).toEqual(BAD.other)
    expect(got.falseToast).toEqual(FALSE_TOAST.other)
    // The proportionality #488 predicts (P ≈ landing / 1000 ms), as a count:
    // monotone non-decreasing over the landing axis, saturated from 1500 ms.
    const counts = LANDINGS_MS.map((l) => got.undoneUnannounced[l].length)
    expect(counts).toEqual([1, 3, 4, 7, 9, 10, 10])
  }, 60_000)

  it('spares the setBy peer until its landing outlasts the re-election (S2)', async () => {
    const got = await sweep('setBy')
    expect(got.undoneUnannounced).toEqual(UNDONE_UNANNOUNCED.setBy)
    expect(got.bad).toEqual(BAD.setBy)
    expect(got.falseToast).toEqual(FALSE_TOAST.setBy)
  }, 60_000)
})
