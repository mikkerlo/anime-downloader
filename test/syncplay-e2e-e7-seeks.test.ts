// `e7SeekVerdict` (`e2e-syncplay/helpers/score.ts`), E7's seek-count term
// (#532). Before it, E7 asserted one seek from A on every run, so an even run
// where B's countdown won the race (CI run 40092148184, shard 1, E7 i=0: B's
// countdown fired ~11 ms ahead of A's, every behavioural term passed, both
// peers on ep 2 at ~12 s playing) scored as bad.
//
// E7b's staging misses (#552) are pinned at the end: `e7bMissReason`, the
// per-lag top-up (`e7bNextLag`, `e7bTally`) and the room-state corrections
// that undo the staging (`corrected`).

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  E7B_TOPUP_CAP,
  RowScorer,
  e7SeekVerdict,
  e7bMissReason,
  e7bNextLag,
  e7bTally,
  corrected,
  type E7bRun
} from '../e2e-syncplay/helpers/score'
import { TRACE_DIR } from '../e2e-syncplay/helpers/paths'

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

// E7b's bands, as `episode.spec.ts`'s `E7B_LAGS` writes them.
const LAG2: [number, number] = [1, 2.5]
const LAG10: [number, number] = [8.5, 11.5]
const LAGS = [2, 10.5]
const staged = { setupOk: true, rewound: true, endPauseOver: 0 }

describe('e7bMissReason: why an E7b run did not stage #533 (#552)', () => {
  // CI run 40195588263 (PR #551, shard 1): E7b n=4 scoreable=2 bad=0, and the
  // shard failed on `no scoreable run at a 10.5 s lag`. The rewind landed and
  // A was pulled back to it, so B paused ~0.2 s short with the end pause at
  // its duration.
  it.each([
    [0, 2, LAG2, 1.723, null],
    [1, 10.5, LAG10, 0.171, 'gap-below-band'],
    [2, 2, LAG2, 1.727, null],
    [3, 10.5, LAG10, 0.19, 'gap-below-band']
  ] as const)(
    'CI run 40195588263 i=%i (lag %s s, band %j): gap %s is %s',
    (_, __, band, gap, reason) => {
      expect(e7bMissReason({ ...staged, gap }, band)).toBe(reason)
    }
  )

  it('names each miss', () => {
    expect(e7bMissReason({ ...staged, setupOk: false, gap: 10 }, LAG10)).toBe('setup')
    expect(e7bMissReason({ ...staged, rewound: false, gap: 0.3 }, LAG10)).toBe('setup')
    expect(e7bMissReason({ ...staged, endPauseOver: null, gap: 10 }, LAG10)).toBe('setup')
    expect(e7bMissReason({ ...staged, gap: null }, LAG10)).toBe('no-gap')
    expect(e7bMissReason({ ...staged, gap: 11.6 }, LAG10)).toBe('gap-above-band')
    expect(e7bMissReason({ ...staged, gap: 10, endPauseOver: -0.4 }, LAG10)).toBe(
      'end-pause-in-file'
    )
  })

  it('takes the first miss that applies: setup, the gap, then the end pause', () => {
    expect(e7bMissReason({ ...staged, rewound: false, gap: null }, LAG10)).toBe('setup')
    expect(e7bMissReason({ ...staged, gap: null, endPauseOver: -1 }, LAG10)).toBe('no-gap')
    expect(e7bMissReason({ ...staged, gap: 0.2, endPauseOver: -1 }, LAG10)).toBe('gap-below-band')
  })

  it('keeps the band and the end-pause term inclusive', () => {
    for (const gap of [8.5, 10, 11.5]) expect(e7bMissReason({ ...staged, gap }, LAG10)).toBeNull()
    expect(e7bMissReason({ ...staged, gap: 8.499 }, LAG10)).toBe('gap-below-band')
    expect(e7bMissReason({ ...staged, gap: 10, endPauseOver: -0.001 }, LAG10)).toBe(
      'end-pause-in-file'
    )
  })

  it('is scoreable exactly when the pre-#552 predicate was: nothing is loosened', () => {
    const old = (r: {
      setupOk: boolean
      rewound: boolean
      gap: number | null
      endPauseOver: number | null
    }): boolean =>
      r.setupOk &&
      r.rewound &&
      r.gap !== null &&
      r.gap >= LAG10[0] &&
      r.gap <= LAG10[1] &&
      r.endPauseOver !== null &&
      r.endPauseOver >= 0
    let n = 0
    for (const setupOk of [true, false])
      for (const rewound of [true, false])
        for (const gap of [null, 0, 0.171, 8.49, 8.5, 10, 11.5, 11.51, 20])
          for (const endPauseOver of [null, -1, -0.001, 0, 0.5]) {
            const r = { setupOk, rewound, gap, endPauseOver }
            expect(e7bMissReason(r, LAG10) === null, JSON.stringify(r)).toBe(old(r))
            n++
          }
    expect(n).toBe(180)
  })
})

/** Runs E7b's loop against a staging that scores `scores(lag, attempt)`. */
const play = (n: number, scores: (lag: number, attempt: number) => boolean): E7bRun[] => {
  const runs: E7bRun[] = []
  for (let next = e7bNextLag(runs, LAGS, n); next; next = e7bNextLag(runs, LAGS, n)) {
    const lag = LAGS[next.k]
    const attempt = runs.filter((r) => r.lag === lag).length
    runs.push({ lag, setupOk: scores(lag, attempt), topup: next.topup })
  }
  return runs
}
const shape = (runs: E7bRun[]): string =>
  runs.map((r) => `${r.lag}${r.topup ? '+' : ''}${r.setupOk ? '' : 'x'}`).join(' ')

describe('e7bNextLag: the per-lag top-up (#552)', () => {
  it('deals N round-robin and stops when every lag scored', () => {
    expect(shape(play(4, () => true))).toBe('2 10.5 2 10.5')
  })

  it("tops up the CI run's empty 10.5 s bucket until it scores", () => {
    // Run 40195588263's four, then a top-up that stages.
    const runs = play(4, (lag, attempt) => lag === 2 || attempt >= 3)
    expect(shape(runs)).toBe('2 10.5x 2 10.5x 10.5+x 10.5+')
  })

  it(`stops a lag that never scores at ${E7B_TOPUP_CAP} top-ups, and the row then fails`, () => {
    const runs = play(4, (lag) => lag === 2)
    expect(shape(runs)).toBe('2 10.5x 2 10.5x 10.5+x 10.5+x 10.5+x 10.5+x')
    expect(runs.filter((r) => r.topup)).toHaveLength(E7B_TOPUP_CAP)
    expect(runs.some((r) => r.lag === 10.5 && r.setupOk)).toBe(false)
  })

  it('tops up every empty lag, the first lag first, each against its own cap', () => {
    const runs = play(2, (_, attempt) => attempt >= 2)
    expect(shape(runs)).toBe('2x 10.5x 2+x 2+ 10.5+x 10.5+')
    expect(e7bNextLag([], LAGS, 0, 0)).toBeNull()
  })

  it('spends no top-up on a lag that has a scoreable run, however many it missed', () => {
    const runs = play(6, (lag, attempt) => lag === 2 || attempt === 2)
    expect(shape(runs)).toBe('2 10.5x 2 10.5x 2 10.5')
  })

  it('reaches a lag the round-robin never dealt', () => {
    expect(shape(play(1, () => true))).toBe('2 10.5+')
  })
})

describe('e7bTally: the top-ups on the summary line (#552)', () => {
  it('shows the top-ups against the cap, per lag', () => {
    const runs = play(4, (lag, attempt) => lag === 2 || attempt >= 5)
    const t = e7bTally(runs, LAGS)
    expect(t.line).toBe(
      'topups=4 (2 s: 2/2 scoreable, 0/4 top-ups; 10.5 s: 1/6 scoreable, 4/4 top-ups)'
    )
    expect(t.fields).toEqual({
      topups: 4,
      cap: 4,
      byLag: [
        { lag: 2, runs: 2, scoreable: 2, topups: 0 },
        { lag: 10.5, runs: 6, scoreable: 1, topups: 4 }
      ]
    })
  })

  describe('RowScorer.score puts it on the row summary', () => {
    const row = '__vitest-552'
    const file = join(TRACE_DIR, `${row}.jsonl`)
    afterAll(() => rmSync(file, { force: true }))

    it('appends the line after n / scoreable / bad, and the fields to the JSONL summary', () => {
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        const s = new RowScorer(row)
        s.add({ setupOk: true, bad: false, lag: 2 })
        s.add({ setupOk: false, bad: false, lag: 10.5 })
        s.score(e7bTally([{ lag: 2, setupOk: true, topup: false }], LAGS))
        expect(out).toHaveBeenCalledWith(
          `[syncplay-e2e] ${row}: n=2 scoreable=1 bad=0 topups=0 ` +
            '(2 s: 1/1 scoreable, 0/4 top-ups; 10.5 s: 0/0 scoreable, 0/4 top-ups)\n'
        )
      } finally {
        out.mockRestore()
      }
      expect(existsSync(file)).toBe(true)
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      expect(JSON.parse(lines[lines.length - 1]).summary).toMatchObject({
        n: 2,
        scoreable: 1,
        bad: 0,
        topups: 0,
        cap: 4
      })
    })
  })
})

describe('corrected: a room state undoing the E7b staging (#552 `aCorrected` / `bCorrected`)', () => {
  const EP1 = '/media/ep1-720.mp4'
  const EP2 = '/media/ep2-720.mp4'
  const tail = (s: string): string => s.slice(-40)
  // A playing into its end at 1430 s; B's rewind is at 0 ms.
  const smp = [
    [-400, 1429],
    [-200, 1429.2],
    [0, 1429.4],
    [200, 1429.6]
  ].map(([at, ct]) => ({ at, ct, src: tail(EP1) }))
  const ev = (at: number, t: string, ct: number, src = EP1): (typeof smp)[0] & { t: string } => ({
    at,
    t,
    ct,
    src: tail(src)
  })

  it('is true for A pulled more than 3 s back between the rewind and its `pause` / `ended`', () => {
    const d = {
      smp,
      ev: [ev(300, 'seeking', 1419.1), ev(10_400, 'pause', 1430), ev(10_400, 'ended', 1430)]
    }
    expect(corrected(d, EP1, 0, 'back')).toBe(true)
    expect(corrected(d, EP1, 0, 'forward')).toBe(false)
  })

  it('is false when A ran into its end', () => {
    const d = { smp, ev: [ev(600, 'pause', 1430), ev(600, 'ended', 1430)] }
    expect(corrected(d, EP1, 0, 'back')).toBe(false)
  })

  it('needs more than 3 s', () => {
    expect(corrected({ smp, ev: [ev(300, 'seeking', 1429.6 - 3)] }, EP1, 0, 'back')).toBe(false)
    expect(corrected({ smp, ev: [ev(300, 'seeking', 1429.6 - 3.01)] }, EP1, 0, 'back')).toBe(true)
    expect(corrected({ smp, ev: [ev(300, 'seeking', 1429.6 + 3)] }, EP1, 0, 'forward')).toBe(false)
    expect(corrected({ smp, ev: [ev(300, 'seeking', 1429.6 + 3.01)] }, EP1, 0, 'forward')).toBe(
      true
    )
  })

  it('ignores seeks before the rewind, after the first `pause` and on the next episode', () => {
    const d = {
      smp,
      ev: [
        ev(-300, 'seeking', 1420),
        ev(600, 'pause', 1430),
        ev(800, 'seeking', 1418),
        ev(900, 'seeking', 0, EP2)
      ]
    }
    expect(corrected(d, EP1, 0, 'back')).toBe(false)
  })

  it('stops at `ended` when no `pause` was captured', () => {
    const d = { smp, ev: [ev(600, 'ended', 1430), ev(800, 'seeking', 1418)] }
    expect(corrected(d, EP1, 0, 'back')).toBe(false)
  })

  it('never counts a seek on another file, even with no `pause` / `ended` captured', () => {
    const d = { smp, ev: [ev(950, 'seeking', 0, EP2)] }
    expect(corrected(d, EP1, 0, 'back')).toBe(false)
  })

  // A local real-server E7b run (#552, the "before" N=20 measurement, i=1,
  // lag 10.5): B was rewound at 11207 ms, and 498 ms later the room's position
  // pulled it forward to A, which ran into its own end at 11844. B paused
  // 0.441 s short, `gap-below-band`. Media events and 200 ms samples, ms
  // relative to the run's start.
  const SRC = 'http://127.0.0.1:41588/tr/1011/720.mp4'
  const real = (
    evs: [number, string, number][],
    smps: [number, number][]
  ): Parameters<typeof corrected>[0] => ({
    ev: evs.map(([at, t, ct]) => ({ at, t, ct, src: tail(SRC) })),
    smp: smps.map(([at, ct]) => ({ at, ct, src: tail(SRC) }))
  })
  const B = real(
    [
      [11207, 'seeking', 1409.20304],
      [11214, 'playing', 1409.204028],
      [11705, 'seeking', 1419.468665],
      [11709, 'seeked', 1419.469426],
      [11709, 'playing', 1419.469448],
      [11846, 'pause', 1419.558849]
    ],
    [
      [10812, 1419.31],
      [11012, 1419.51],
      [11212, 1409.2],
      [11412, 1409.36],
      [11612, 1409.56],
      [11812, 1419.52]
    ]
  )
  const A = real(
    [
      [11844, 'pause', 1420],
      [11844, 'ended', 1420]
    ],
    [
      [10852, 1419.07],
      [11053, 1419.27],
      [11253, 1419.47],
      [11452, 1419.67],
      [11653, 1419.87],
      [11852, 1420]
    ]
  )

  it('reads that run as B pulled forward, not A pulled back, and B’s rewind as neither', () => {
    expect(corrected(B, SRC, 11207, 'forward')).toBe(true)
    expect(corrected(A, SRC, 11207, 'back')).toBe(false)
    expect(corrected(B, SRC, 11207, 'back')).toBe(true)
    const rewindOnly = real([[11207, 'seeking', 1409.20304]], [[11012, 1419.51]])
    expect(corrected(rewindOnly, SRC, 11207, 'forward')).toBe(false)
  })
})

describe('the E7b row (#552)', () => {
  // Nothing in a PR runs E7b, so its wiring to the helpers is pinned here.
  const spec = readFileSync(join(__dirname, '..', 'e2e-syncplay', 'episode.spec.ts'), 'utf8')
  const start = spec.indexOf("test('E7b ")
  const e7b = spec.slice(start, spec.indexOf("test('E7c ", start))

  it('is found, and ends before E7c', () => {
    expect(start).toBeGreaterThan(0)
    expect(e7b).toContain("row = new RowScorer('E7b')")
    expect(e7b).not.toContain("RowScorer('E7c')")
  })

  it('stages with the narrowed window: the rewind 0.1 s from B’s end after a 500 ms burst', () => {
    // At 0.3 s and 1000 ms the window measured 631–639 ms; at these, 276–288 ms.
    expect(spec).toContain('const E7B_REWIND_AT_S = 0.1\n')
    expect(spec).toContain('const E7B_BURST_MS = 500\n')
    const stage = spec.slice(spec.indexOf('async function stageBehind('), start)
    expect(stage).toContain('if (!(v.duration - v.currentTime < atS)) return')
    expect(stage).toContain('setTimeout(() => (v.playbackRate = 1), burstMs)')
    expect(stage).toContain('[lagS, E7B_REWIND_AT_S, E7B_BURST_MS] as const')
  })

  it('runs the round-robin plus top-ups, and puts the tally on the summary line', () => {
    expect(e7b).toContain(
      'for (let next = e7bNextLag(runs, lags, N); next; next = e7bNextLag(runs, lags, N))'
    )
    expect(e7b).toContain('runs.push({ lag, setupOk: scoreable, topup })')
    expect(e7b).toContain('row.score(e7bTally(runs, lags))')
    expect(e7b).not.toMatch(/for \(let i = 0; i < N; i\+\+\)/)
  })

  it('scores on e7bMissReason and records it, with no predicate of its own', () => {
    expect(e7b).toMatch(
      /e7bMissReason\(\s*\{ setupOk: setupOk && cancelledA, rewound, gap, endPauseOver \},\s*band\s*\)/
    )
    expect(e7b).toContain('const scoreable = missReason === null\n')
    expect(e7b).toContain('setupOk: scoreable,')
    expect(e7b).toContain('missReason,')
    expect(e7b).not.toContain('gap >= lo')
  })

  it('records either correction from B’s rewind, and keeps an unscoreable run’s trace', () => {
    expect(e7b).toContain(
      "const aCorrected = rewindAt === null ? null : corrected(da, sa.src, rewindAt, 'back')"
    )
    expect(e7b).toContain(
      "const bCorrected = rewindAt === null ? null : corrected(db, sb.src, rewindAt, 'forward')"
    )
    expect(e7b).toContain('aCorrected,')
    expect(e7b).toContain('bCorrected,')
    expect(e7b).toContain('rewindLeadMs,')
    expect(e7b).toMatch(/bad \|\| !scoreable\s*\?\s*\{ A: await A\.collect/)
  })
})
