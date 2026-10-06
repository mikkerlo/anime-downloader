// E1 / E6's #486 verdict with #497's saved-progress flash split out (#514),
// pinned without the two-instance rig.
//
// The follower lands on the new episode at 0, seeks to its saved progress for
// it 2–7 ms after `loadedmetadata` with a "Resumed at …" toast, and the room
// pulls it back 60–300 ms later. `staleOutcome`'s `maxCtFirst4s > 9` reads a
// 200 ms sample inside that flash as #486's stale seek. A ±15 s window around
// the old position cannot split them on E6: E1 run 2k and E6 run 2k+1 share a
// press band, so the saved position usually sits inside the window. The
// traces below are the five CI failures' B sides, reduced to the records the
// scorer reads (times relative to A's press).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RESUME_PAIR_MS,
  resumeSplit,
  resumeToastSeconds,
  staleOutcome
} from '../e2e-syncplay/helpers/score'

const OLD = 'file:///anime-dl-e2e/syncplay-fixtures/ep2.mp4'.slice(-40)
const NEW = 'file:///anime-dl-e2e/syncplay-fixtures/ep1.mp4'.slice(-40)
type Ev = { at: number; t: string; ct: number; src: string }
type Smp = { at: number; ct: number; src: string }
type Toast = { at: number; cls: string; txt: string }
interface Trace {
  ev: Ev[]
  smp: Smp[]
  toasts: Toast[]
}

const seek = (at: number, ct: number, src = NEW): Ev => ({ at, t: 'seeking', ct, src })
const resumed = (at: number, txt: string, cls = 'resume-toast'): Toast => ({ at, cls, txt })

/** A follower that loads the new episode at `lmAt` at 0 and plays from there,
 *  with `seeks` applied in order (each a jump to `ct` at `at`) and a 200 ms
 *  sampler whose first post-metadata sample lands `phase` ms after it. */
function follower(o: {
  old: number
  lmAt: number
  lmCt?: number
  phase: number
  seeks?: Ev[]
  toasts?: Toast[]
}): Trace {
  const seeks = o.seeks ?? []
  const lmCt = o.lmCt ?? 0
  const ctAt = (at: number): number => {
    let base = { at: o.lmAt, ct: lmCt }
    for (const s of seeks) if (s.at <= at && s.at >= base.at) base = { at: s.at, ct: s.ct }
    return +(base.ct + (at - base.at) / 1000).toFixed(2)
  }
  const smp: Smp[] = [{ at: -2, ct: o.old, src: OLD }]
  for (let at = o.lmAt + o.phase; at <= o.lmAt + 12_000; at += 200)
    smp.push({ at, ct: ctAt(at), src: NEW })
  return {
    ev: [
      { at: o.lmAt - 400, t: 'loadstart', ct: 0, src: NEW },
      { at: o.lmAt, t: 'loadedmetadata', ct: lmCt, src: NEW },
      ...seeks
    ],
    smp,
    toasts: o.toasts ?? []
  }
}

const score = (d: Trace, old: number): ReturnType<typeof resumeSplit> =>
  resumeSplit(d, { ct: old, src: OLD }, staleOutcome(d, OLD))

// The five bad runs' B sides, from each job's `syncplay-traces/<row>.jsonl`
// (trace clock − 3000, so times are from A's press). `old` is B's last sample
// before the press; `phase` puts the first post-metadata sample where it fell.
const CI = {
  // E6 i=0, t=39: the #497 target 45.62 s sits 2.7 s from the old position.
  j111567293208: {
    old: 42.92,
    d: follower({
      old: 42.92,
      lmAt: 703,
      phase: 124,
      seeks: [seek(708, 45.62), seek(903, 0.89)],
      toasts: [resumed(707, 'Resumed at 0:45')]
    })
  },
  // E6 i=2, t=1228.
  j111568568092: {
    old: 1231.55,
    d: follower({
      old: 1231.55,
      lmAt: 638,
      phase: 49,
      seeks: [seek(642, 1214.75), seek(936, 0.93)],
      toasts: [resumed(641, 'Resumed at 20:14')]
    })
  },
  // E1 i=2, t=1220.
  j111563640561: {
    old: 1224.39,
    d: follower({
      old: 1224.39,
      lmAt: 939,
      phase: 4,
      seeks: [seek(941, 616.05), seek(1003, 0.99)],
      toasts: [resumed(941, 'Resumed at 10:16')]
    })
  },
  // E1 i=1, t=612.
  j111558717497: {
    old: 615.11,
    d: follower({
      old: 615.11,
      lmAt: 712,
      phase: 197,
      seeks: [seek(716, 51.48), seek(947, 0.94)],
      toasts: [resumed(716, 'Resumed at 0:51')]
    })
  },
  // E6 i=0, t=38: the #497 target 47.61 s sits 6.7 s from the old position.
  j112092742779: {
    old: 40.93,
    d: follower({
      old: 40.93,
      lmAt: 735,
      phase: 65,
      seeks: [seek(742, 47.61), seek(837, 1)],
      toasts: [resumed(741, 'Resumed at 0:47')]
    })
  }
}

describe("E1 / E6's five #497 flashes (#514)", () => {
  for (const [job, { old, d }] of Object.entries(CI)) {
    it(`${job}: staleOutcome alone scores it #486; resumeSplit scores it #497`, () => {
      const o = staleOutcome(d, OLD)
      expect(o.stale).toBe(true)
      expect(o.staleEarly).toBe(false)
      expect(o.maxCtFirst4s).toBeGreaterThan(9)
      expect(score(d, old)).toEqual({ stale: false, foreignSeek: true, old: false, excused: true })
    })
  }

  it('111567293208: the #497 target is inside ±15 s of the old position, so only the pairing keeps it out of `old`', () => {
    const { old, d } = CI.j111567293208
    expect(Math.abs(45.62 - old)).toBeLessThanOrEqual(15)
    // The same trace without its toast is a seek near the old position: #486.
    expect(score({ ...d, toasts: [] }, old)).toEqual({
      stale: true,
      foreignSeek: false,
      old: true,
      excused: false
    })
  })

  it('112092742779: 47.61 s pairs with "0:47" because formatTime floors (a rounding pairing reads 0:48)', () => {
    const { old, d } = CI.j112092742779
    expect(Math.abs(47.61 - old)).toBeLessThanOrEqual(15)
    expect(Math.round(47.61)).toBe(48)
    expect(resumeToastSeconds('Resumed at 0:47')).toBe(47)
    expect(score(d, old).foreignSeek).toBe(true)
    expect(score(d, old).stale).toBe(false)
  })
})

describe('resumeSplit keeps #486', () => {
  const old = 42
  const flash = [seek(645, 45.6), seek(840, 0.2)]
  const toast = [resumed(644, 'Resumed at 0:45')]

  it('a genuine stale seek to the old position, no toast', () => {
    const d = follower({
      old,
      lmAt: 640,
      phase: 50,
      seeks: [seek(645, 42.3), seek(900, 0.3)]
    })
    expect(score(d, old)).toEqual({ stale: true, foreignSeek: false, old: true, excused: false })
  })

  it('a toast and its seek, plus another seek within ±15 s of the old position in the window', () => {
    const d = follower({
      old,
      lmAt: 640,
      phase: 50,
      seeks: [...flash, seek(1500, 42.4), seek(1700, 1)],
      toasts: toast
    })
    expect(staleOutcome(d, OLD).maxCtFirst4s).toBeGreaterThan(42)
    expect(score(d, old)).toEqual({ stale: true, foreignSeek: true, old: true, excused: false })
  })

  it('a toast and its seek, plus an unpaired seek to old + 40 s in the window', () => {
    const d = follower({
      old,
      lmAt: 640,
      phase: 50,
      seeks: [...flash, seek(1500, old + 40), seek(1700, 1)],
      toasts: toast
    })
    expect(score(d, old)).toEqual({ stale: true, foreignSeek: true, old: false, excused: false })
  })

  it('`lm.ct > 5`, even with a paired toast seek', () => {
    const d = follower({ old, lmAt: 640, lmCt: 42, phase: 50, seeks: flash, toasts: toast })
    const o = staleOutcome(d, OLD)
    expect(o.ctLm).toBe(42)
    expect(o.staleEarly).toBe(true)
    expect(score(d, old)).toMatchObject({ stale: true, foreignSeek: true, excused: true })
  })

  it('`ct2 > 7`, even with a paired toast seek', () => {
    // The pull-back never comes: still at the saved position two seconds on.
    const d = follower({ old, lmAt: 640, phase: 50, seeks: [seek(645, 45.6)], toasts: toast })
    const o = staleOutcome(d, OLD)
    expect(o.ctLm).toBe(0)
    expect(o.ct2).toBeGreaterThan(7)
    expect(score(d, old)).toMatchObject({ stale: true, foreignSeek: true, excused: true })
  })

  it("the MSE branch's toast with no seek of its own excuses nothing", () => {
    const d = follower({
      old,
      lmAt: 640,
      phase: 50,
      seeks: [seek(645, 60), seek(840, 0.2)],
      toasts: toast
    })
    expect(score(d, old)).toEqual({ stale: true, foreignSeek: false, old: false, excused: false })
  })
})

describe('resumeSplit pairing', () => {
  const old = 600
  const run = (seekAt: number, toast: Toast): ReturnType<typeof resumeSplit> =>
    score(
      follower({
        old,
        lmAt: 640,
        phase: 50,
        seeks: [seek(seekAt, 45.6), seek(840, 0.2)],
        toasts: [toast]
      }),
      old
    )

  it(`pairs within ${RESUME_PAIR_MS} ms on either side of the toast`, () => {
    expect(run(645, resumed(644, 'Resumed at 0:45')).excused).toBe(true)
    expect(run(645, resumed(646, 'Resumed at 0:45')).excused).toBe(true)
    expect(run(645, resumed(645 - RESUME_PAIR_MS, 'Resumed at 0:45')).excused).toBe(true)
    expect(run(645, resumed(645 + RESUME_PAIR_MS, 'Resumed at 0:45')).excused).toBe(true)
  })

  it(`does not pair past ${RESUME_PAIR_MS} ms, on a different m:ss, before the press or on another toast`, () => {
    expect(run(645, resumed(645 - RESUME_PAIR_MS - 1, 'Resumed at 0:45')).stale).toBe(true)
    expect(run(645, resumed(645 + RESUME_PAIR_MS + 1, 'Resumed at 0:45')).stale).toBe(true)
    expect(run(645, resumed(644, 'Resumed at 0:46')).stale).toBe(true)
    expect(run(645, resumed(644, 'Resumed at 0:45', 'syncplay-toast')).stale).toBe(true)
  })

  it('ignores a toast from before the press', () => {
    const d = (toastAt: number): Trace =>
      follower({
        old,
        lmAt: 5,
        phase: 50,
        seeks: [seek(10, 45.6), seek(200, 0.2)],
        toasts: [resumed(toastAt, 'Resumed at 0:45')]
      })
    expect(score(d(9), old).excused).toBe(true)
    expect(score(d(-1), old).stale).toBe(true)
  })

  it('a late correction seek near a low old position is recorded as `old` but leaves the window alone', () => {
    const d = follower({
      old: 42,
      lmAt: 640,
      phase: 50,
      seeks: [seek(645, 45.6), seek(840, 0.2), seek(640 + 9000, 30)],
      toasts: [resumed(644, 'Resumed at 0:45')]
    })
    expect(score(d, 42)).toEqual({ stale: false, foreignSeek: true, old: true, excused: true })
  })

  it('reads m:ss and h:mm:ss, and nothing else', () => {
    expect(resumeToastSeconds('Resumed at 20:14')).toBe(1214)
    expect(resumeToastSeconds('Resumed at 1:02:03')).toBe(3723)
    expect(resumeToastSeconds('Already switching')).toBeNull()
  })

  it('a clean follow is neither', () => {
    const d = follower({ old: 42, lmAt: 640, phase: 50 })
    expect(score(d, 42)).toEqual({ stale: false, foreignSeek: false, old: false, excused: false })
  })
})

describe('the E1 / E6 row', () => {
  // Nothing in a PR runs E1 / E6, so its wiring to resumeSplit is pinned here.
  const spec = readFileSync(join(__dirname, '..', 'e2e-syncplay', 'episode.spec.ts'), 'utf8')
  const transition = spec.slice(
    spec.indexOf('async function transition('),
    spec.indexOf("test('E1")
  )
  const e1 = spec.slice(spec.indexOf("test('E1"), spec.indexOf('test("E2'))

  it('slices out the E1 / E6 test alone', () => {
    expect(e1.length).toBeGreaterThan(500)
    expect(e1).toContain("new RowScorer('E6')")
    expect(e1).not.toContain("new RowScorer('E2')")
  })

  it('transition() measures each old position before the press and returns it', () => {
    const measure = transition.indexOf('const [sa, sb] = await Promise.all([A.state(), B.state()])')
    expect(measure).toBeGreaterThan(-1)
    expect(measure).toBeLessThan(transition.indexOf('const pressAt = Date.now()'))
    expect(transition).toMatch(/\n {4}sa,\n {4}sb,\n {4}da,\n {4}db,\n/)
  })

  it('scores both instances with resumeSplit on the measured position and records foreignSeek', () => {
    expect(e1).toContain('resumeSplit(r.da, r.sa, r.a)')
    expect(e1).toContain('resumeSplit(r.db, r.sb, r.b)')
    expect(e1).toContain('bad: stale,')
    expect(e1).toContain('foreignSeek,')
    expect(e1).not.toContain('bad: r.a.stale')
    expect(e1).not.toMatch(/ct: t\b/)
    expect(e1).toContain('expect(s1.bad).toBe(0)')
    expect(e1).toContain('expect(s6.bad).toBe(0)')
    expect(e1).not.toMatch(/expect\([^)]*foreignSeek/)
  })
})
