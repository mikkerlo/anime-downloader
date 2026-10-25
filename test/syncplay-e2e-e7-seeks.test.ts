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

describe('the E7 / E7s / E7b / E7c re-pause term (#549)', () => {
  // Nothing in a PR runs these rows either. Each is sliced to the next row's
  // `test(`, and E7c, the last test in the file, to its end.
  const spec = readFileSync(join(__dirname, '..', 'e2e-syncplay', 'episode.spec.ts'), 'utf8')
  const names = ['E7', 'E7s', 'E7b', 'E7c'] as const
  const heads = names.map((n) => `test('${n} `)
  const rows = heads.map((head, k) => {
    const start = spec.indexOf(head)
    const next = heads[k + 1]
    return { head, start, body: spec.slice(start, next ? spec.indexOf(next, start) : undefined) }
  })

  it('finds each row once, in order, with E7c running to the end of the file', () => {
    for (const r of rows) expect(spec.split(r.head).length - 1, r.head).toBe(1)
    const starts = rows.map((r) => r.start)
    expect(starts[0]).toBeGreaterThan(0)
    expect(starts).toEqual([...starts].sort((x, y) => x - y))
    expect(spec.indexOf("\ntest('", starts[3] + 1)).toBe(-1)
    expect(rows.map((r) => r.body.match(/RowScorer\('(\w+)'\)/)?.[1])).toEqual([...names])
  })

  it.each(names.map((n, k) => [n, k] as const))(
    '%s counts re-pauses with rePausesAfterSeek, not after the first seek',
    (_, k) => {
      const { body } = rows[k]
      expect(body).toContain('const re = rePausesAfterSeek(da.wire, db.wire)')
      expect(body).toContain('const rePauses = re.a + re.b')
      expect(body).toMatch(/rePauses > 0( \|\||\s*&&)/)
      expect(body).not.toContain('w.at > firstSeekAt && w.ps?.paused === true')
    }
  )

  it.each(names.map((n, k) => [n, k] as const))(
    '%s records which peer re-paused, and the room re-pause only for triage',
    (_, k) => {
      const { body } = rows[k]
      expect(body).toContain('rePausesA: re.a,')
      expect(body).toContain('rePausesB: re.b,')
      expect(body).toContain('roomRePaused: re.roomRePaused,')
      expect(body.replace('roomRePaused: re.roomRePaused,', '')).not.toContain('roomRePaused')
    }
  )
})
