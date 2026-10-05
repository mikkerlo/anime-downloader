// E5's #486 / #497 split (#499), pinned without the two-instance rig.
//
// E5 counts a seek on the new element within ±15 s of the old position as
// #486's stale seek and anything else past 5 s as #497's saved-progress seek.
// #497 seeks to wherever the previous run left the episode, so with both runs
// drawn from one 300–600 s band about 1 in 10 #497 seeks landed in the window
// and E5 went red with a #486 label. The fix keeps the classifier as is and
// draws consecutive runs from disjoint bands instead: a timing rule ("a
// snap-back to 0 means #497") would hide a real #486 hit, which can snap back
// too (Tier 1's E5 position half walks its residual back).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { e5Position, e5Split } from '../e2e-syncplay/helpers/score'

const OLD = 'file:///fixtures/ep1.mp4'
const NEW = 'file:///fixtures/ep2.mp4'
type Ev = { at: number; t: string; ct: number; src: string }
const seek = (at: number, ct: number, src = NEW): Ev => ({ at, t: 'seeking', ct, src })
const NOT_STALE = { stale: false }

// The grid covers both ends of `rand`'s range; 1 - 1e-9 stands in for the
// supremum Math.random() never returns.
const RANDS = [...Array.from({ length: 101 }, (_, k) => k / 100).slice(0, 100), 1 - 1e-9]
// Play between positioning and the pause (a 2 s sleep plus the pause landing)
// moves both the old position and the saved progress past the draw.
const DRIFTS = [0, 2, 5, 8]
const SHARED_BAND = (_i: number, rand: number): number => 300 + rand * 300

describe('e5Position (#499)', () => {
  it('keeps every pair of consecutive runs more than 30 s apart over the whole rand range', () => {
    let pairs = 0
    let minGap = Infinity
    for (let i = 1; i < 6; i++)
      for (const r0 of RANDS)
        for (const r1 of RANDS) {
          const gap = Math.abs(e5Position(i, r1) - e5Position(i - 1, r0))
          minGap = Math.min(minGap, gap)
          pairs++
        }
    expect(pairs).toBe(5 * RANDS.length * RANDS.length)
    expect(minGap).toBeGreaterThan(30)
    expect(minGap).toBeCloseTo(60, 6)
  })

  it('stays inside the 300–600 s the row has always used', () => {
    for (let i = 0; i < 6; i++)
      for (const r of RANDS) {
        expect(e5Position(i, r)).toBeGreaterThanOrEqual(300)
        expect(e5Position(i, r)).toBeLessThan(600)
      }
  })

  it('is a property the shared 300–600 s draw does not have: consecutive runs can sit inside ±15 s', () => {
    expect(Math.abs(SHARED_BAND(1, 0.11) - SHARED_BAND(0, 0.1))).toBeLessThanOrEqual(15)
  })
})

describe('e5Split', () => {
  const before = { ct: 330, src: OLD }

  it('counts a stale seek to the old position that stays there as #486', () => {
    expect(e5Split({ ev: [seek(400, 331)] }, before, { stale: true })).toEqual({
      old: true,
      foreign: false
    })
  })

  it('still counts it as #486 when it snaps back to 0 a moment later', () => {
    expect(e5Split({ ev: [seek(400, 330.9), seek(700, 0)] }, before, { stale: true })).toEqual({
      old: true,
      foreign: false
    })
  })

  it("counts a far saved-progress seek as #497's, snap-back and all, and the stale reading it explains with it", () => {
    expect(e5Split({ ev: [seek(400, 591), seek(700, 0)] }, before, { stale: true })).toEqual({
      old: false,
      foreign: true
    })
  })

  it('counts a stale reading with no seek as #486', () => {
    expect(e5Split({ ev: [] }, before, { stale: true })).toEqual({ old: true, foreign: false })
  })

  it('ignores seeks before the press and seeks on the old element', () => {
    const ev = [seek(-200, 330), seek(400, 330, OLD.slice(-40))]
    expect(e5Split({ ev }, before, NOT_STALE)).toEqual({ old: false, foreign: false })
  })
})

describe('the E5 row', () => {
  // Nothing in a PR runs E5, so its wiring to the two helpers is pinned here.
  const spec = readFileSync(join(__dirname, '..', 'e2e-syncplay', 'episode.spec.ts'), 'utf8')
  const e5 = spec.slice(spec.indexOf("test('E5"))

  it('positions with e5Position and classifies with e5Split, both instances', () => {
    expect(e5).toContain('positionBoth(A, B, e5Position(i, Math.random()))')
    expect(e5).toContain('e5Split(da, pa, r.a)')
    expect(e5).toContain('e5Split(db, pb, r.b)')
    expect(e5).not.toContain('Math.random() * 300')
  })
})

describe('E5 never counts a #497 seek as #486 (#499)', () => {
  // Run i-1 left the episode run i lands on at its own (drifted) position, and
  // #497 seeks the new element there; run i's old position is its own draw.
  const classify = (
    draw: (i: number, rand: number) => number,
    i: number,
    rPrev: number,
    rCur: number,
    dPrev: number,
    dCur: number
  ): { old: boolean; foreign: boolean } =>
    e5Split(
      { ev: [seek(350, draw(i - 1, rPrev) + dPrev), seek(650, 0)] },
      { ct: draw(i, rCur) + dCur, src: OLD },
      NOT_STALE
    )

  it('was miscounted under the shared band', () => {
    expect(classify(SHARED_BAND, 1, 0.1, 0.11, 3, 2)).toEqual({ old: true, foreign: false })
  })

  it('is always foreign under the disjoint bands', () => {
    let traces = 0
    const miscounted: string[] = []
    for (let i = 1; i < 4; i++)
      for (const rPrev of RANDS)
        for (const rCur of RANDS)
          for (const dPrev of DRIFTS)
            for (const dCur of DRIFTS) {
              const s = classify(e5Position, i, rPrev, rCur, dPrev, dCur)
              if (s.old || !s.foreign) miscounted.push(`${i} ${rPrev} ${rCur} ${dPrev} ${dCur}`)
              traces++
            }
    expect(traces).toBe(3 * RANDS.length * RANDS.length * DRIFTS.length * DRIFTS.length)
    expect(miscounted).toEqual([])
  })
})
