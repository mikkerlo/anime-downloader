// @vitest-environment happy-dom
//
// Catalog rows of #489 that the two-peer model can express and no other file
// covers: P2 (pause/unpause crossfire), P3 (rapid toggling) and M8 (S1 with
// asymmetric latency). Each row is a small sweep pinned cell for cell, the way
// the rest of `test/services/syncplay-two-peer-*` pins its numbers.
//
// The rows the catalog lists that are *already* covered elsewhere are not
// re-done here: P1 is `syncplay-two-peer-playpause.test.ts`, P5 / M1 are the
// adoption and join cases of `syncplay-two-peer-adoption.test.ts` and
// `syncplay-two-peer-playpause.test.ts`, M3 is `syncplay-frozen-snapshot.test.ts`,
// and the latency seam M8 leans on is `syncplay-two-peer-rtt.test.ts`. P12 is
// not here because the two-peer model cannot stage it: during a held pause the
// pauser is handed no foreign periodic at all, so a badge mutation that
// repaints from any paused frame stays green on this harness. The #350 block of
// `test/renderer/composables/use-syncplay-client.test.ts` hand-feeds that frame
// and is where P12's pin lives. The row-to-file map is in `docs/testing.md`.
//
// **P2 carries a pin of behaviour believed to be wrong.** At a crossfire gap of
// 850–900 ms the room never settles: one peer's element flaps between playing
// and paused on a 1.5 s period for the whole read-out window. The catalog's
// pass condition is "both agree; no flapping after 3 s", so those cells are
// pinned as the failing cells they are, and a fix that settles them turns this
// red on purpose.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50

describe('SyncplayClient — two-peer interaction rows (#489 Tier 1)', () => {
  let room: TwoPeerRoom | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  const seatBoth = async (
    paused = false,
    hostDelayMs = DELAY_MS,
    joinDelayMs = DELAY_MS,
    joinLandMs = 0
  ): Promise<[Peer, Peer]> => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    room = await createTwoPeerRoom({ position: ROOM_START, paused })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused,
      delayMs: hostDelayMs
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused,
      delayMs: joinDelayMs,
      seekLandMs: joinLandMs
    })
    await room.advance(4)
    return [host, joiner]
  }

  const done = (): void => {
    room?.dispose()
    room = undefined
  }

  /** `P`/`p` per element (A, B) and for the room: paused / playing. */
  const pp = (b: boolean): string => (b ? 'P' : 'p')

  describe('P2 — B pauses and A unpauses within 0–1.5 s of each other', () => {
    // The room starts paused by A. A unpauses; `gap` ms later B presses pause.
    // Below 150 ms B's press lands on an element that is still paused (A's
    // unpause has not reached it), so it is a no-op and the room plays — the
    // later press is lost, but nothing flaps. From 150 ms the press is real
    // and the room ends paused.
    const runCell = async (gap: number): Promise<{ end: string; flapping: boolean }> => {
      const [a, b] = await seatBoth()
      a.userPause()
      await room!.advance(2)
      a.userPlay()
      if (gap) await room!.advance(gap / 1000)
      b.userPause()
      await room!.advance(3)
      const end = `${pp(a.el.paused)}${pp(b.el.paused)}${pp(room!.server.roomState().paused)}`
      const samples: string[] = []
      for (let i = 0; i < 12; i++) {
        await room!.advance(0.5)
        samples.push(`${pp(a.el.paused)}${pp(b.el.paused)}`)
      }
      done()
      return { end, flapping: samples.some((s) => s !== samples[0]) }
    }

    it('settles everywhere except an 850–900 ms band, where one element flaps for good (✗)', async () => {
      const ends: Record<number, string> = {}
      const flapping: number[] = []
      for (let gap = 0; gap <= 1500; gap += 50) {
        const c = await runCell(gap)
        ends[gap] = c.end
        if (c.flapping) flapping.push(gap)
      }
      expect(flapping).toEqual([850, 900])
      for (let gap = 0; gap <= 1500; gap += 50) {
        // A and the room paused, B's element caught playing mid-flap.
        if (gap === 850 || gap === 900) expect(ends[gap]).toBe('PpP')
        else if (gap < 150) expect(ends[gap]).toBe('ppp')
        else expect(ends[gap]).toBe('PPP')
      }
    }, 60_000)
  })

  describe('P3 — space pressed rapidly on one peer', () => {
    it.each([
      [5, true],
      [6, false]
    ])(
      'ends in the state of the last of %i presses on both peers, with no echo loop',
      async (presses, lastPaused) => {
        const [a, b] = await seatBoth()
        for (let i = 0; i < presses; i++) {
          if (a.el.paused) a.userPlay()
          else a.userPause()
          await room!.advance(0.35)
        }
        expect(a.el.paused).toBe(lastPaused)
        await room!.advance(5)
        expect(a.el.paused).toBe(lastPaused)
        expect(b.el.paused).toBe(lastPaused)
        expect(room!.server.roomState().paused).toBe(lastPaused)
        // One discrete send per press on A, none at all on B: B followed every
        // toggle without answering one, which is what "no echo loop" means.
        expect(a.counters().clientIgnoreCounter).toBe(presses)
        expect(b.counters().clientIgnoreCounter).toBe(0)
        done()
      }
    )
  })

  describe('M8 — S1 with the seeker on a slow leg', () => {
    // The non-setBy seeker's undone-and-unannounced count per landing time
    // (ten heartbeat phases each), at 50 ms each way on both legs and with the
    // seeker's leg at 150 ms. The catalog's M8 asks for "the same pass
    // conditions as without latency". Before #491 S1 was itself ✗ (#488) and
    // the symmetric counts were [1, 4, 9, 10]; the slow leg spared the joiner
    // only by moving it into the room's `setBy` role (measured at every drag),
    // so it was not handed foreign frames at 1 Hz. Since #491 both sweeps read
    // zero, and the role split stays pinned so a change in who is exposed
    // still reds.
    const sweep = async (joinDelayMs: number): Promise<{ counts: number[]; setBy: string[] }> => {
      const counts: number[] = []
      const setBy = new Set<string>()
      for (const landMs of [100, 400, 900, 1500]) {
        let n = 0
        for (let phase = 0; phase < 1000; phase += 100) {
          const [, joiner] = await seatBoth(false, DELAY_MS, joinDelayMs, landMs)
          await room!.advance(phase / 1000)
          setBy.add(String(room!.server.roomState().setBy))
          const wireBefore = room!.server.wireOf('joinuser').length
          joiner.userSeek(600)
          await room!.advance(8)
          const announced = room!.server
            .wireOf('joinuser')
            .slice(wireBefore)
            .some((f) => f.doSeek === true)
          if (Math.abs(joiner.el.currentTime - 600) > 20 && !announced) n++
          done()
        }
        counts.push(n)
      }
      return { counts, setBy: [...setBy].sort() }
    }

    it('keeps the joiner’s seek on both legs, the slow one still moving it into the setBy role (#488, fixed by #491)', async () => {
      const symmetric = await sweep(DELAY_MS)
      const slow = await sweep(150)
      expect(symmetric).toEqual({ counts: SYMMETRIC, setBy: SYMMETRIC_SETBY })
      expect(slow).toEqual({ counts: SLOW, setBy: SLOW_SETBY })
    }, 60_000)
  })
})

const SYMMETRIC = [0, 0, 0, 0]
const SLOW = [0, 0, 0, 0]
const SYMMETRIC_SETBY = ['hostuser']
const SLOW_SETBY = ['joinuser']
