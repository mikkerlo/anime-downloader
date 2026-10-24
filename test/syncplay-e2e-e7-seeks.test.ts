// `e7SeekVerdict` (`e2e-syncplay/helpers/score.ts`), E7's seek-count term
// (#532). Before it, E7 asserted one seek from A on every run, so an even run
// where B's countdown won the race (CI run 40092148184, shard 1, E7 i=0: B's
// countdown fired ~11 ms ahead of A's, every behavioural term passed, both
// peers on ep 2 at ~12 s playing) scored as bad.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { e7SeekVerdict } from '../e2e-syncplay/helpers/score'

const verdict = (
  cancelB: boolean,
  seeksA: number,
  seeksB: number
): ReturnType<typeof e7SeekVerdict> => e7SeekVerdict({ cancelB, seeksA, seeksB })

describe('e7SeekVerdict on even runs: both countdowns fire (#532)', () => {
  it.each([
    [1, 0, 'A'],
    [0, 1, 'B'],
    [1, 1, 'both']
  ] as const)('seeksA=%i, seeksB=%i is good (winner %s)', (a, b, winner) => {
    expect(verdict(false, a, b)).toEqual({ ok: true, winner })
  })

  it('B winning the race is good: the CI run 40092148184 outcome', () => {
    expect(verdict(false, 0, 1).ok).toBe(true)
  })

  it('no seek from either peer is bad', () => {
    expect(verdict(false, 0, 0)).toEqual({ ok: false, winner: null })
  })

  it.each([
    [2, 0],
    [0, 2],
    [2, 1],
    [1, 2],
    [2, 2]
  ])('seeksA=%i, seeksB=%i is bad: a peer at two seeks', (a, b) => {
    expect(verdict(false, a, b).ok).toBe(false)
  })
})

describe('e7SeekVerdict on Cancel runs: B cancels, A advances alone (#532)', () => {
  it('one seek from A and none from B is good', () => {
    expect(verdict(true, 1, 0)).toEqual({ ok: true, winner: 'A' })
  })

  it.each([
    [0, 1, 'B'],
    [1, 1, 'both'],
    [0, 0, null],
    [2, 0, 'A']
  ] as const)('seeksA=%i, seeksB=%i is bad (winner %s)', (a, b, winner) => {
    expect(verdict(true, a, b)).toEqual({ ok: false, winner })
  })
})

describe('the E7 row', () => {
  // Nothing in a PR runs E7, so its wiring to the helper is pinned here.
  const spec = readFileSync(join(__dirname, '..', 'e2e-syncplay', 'episode.spec.ts'), 'utf8')
  const start = spec.indexOf("test('E7 ")
  const e7 = spec.slice(start, spec.indexOf("test('E7s", start))

  it('is found, and ends before E7s', () => {
    expect(start).toBeGreaterThan(0)
    expect(e7).toContain("row = new RowScorer('E7')")
    expect(e7).not.toContain("RowScorer('E7s')")
  })

  it('scores the seek count with e7SeekVerdict, not a fixed seek from A', () => {
    expect(e7).toContain('e7SeekVerdict({ cancelB, seeksA: seeksA.length, seeksB: seeksB.length })')
    expect(e7).toContain('!seeks.ok ||')
    expect(e7).not.toContain('seeksA.length !== 1')
  })

  it("records the winner and both peers' outgoing-element residue", () => {
    expect(e7).toContain('seekWinner: seeks.winner')
    expect(e7).toContain('const oldPlayedA = playedOldFromZero(da, sa.src, firstSeekAt)')
    expect(e7).toContain('const oldPlayedB = playedOldFromZero(db, sb.src, firstSeekAt)')
  })
})
