// The engine table (#584): (base, A, B) → result | conflict for every rule of
// S4 (#572)'s frozen field table, through `merge3`.
import { describe, it, expect } from 'vitest'
import { merge3 } from '../../../src/main/lib/sync-merge/merge3'
import {
  FIELD_TABLE,
  decideWatched,
  type Decision,
  type FieldRule
} from '../../../src/main/lib/sync-state/field-table'
import { F, doc, rate, watch } from '../../helpers/sync-merge'

const NOW = 10_000_000
const run = (
  base: SyncDoc | null,
  a: SyncDoc,
  b: SyncDoc,
  table: readonly FieldRule[] = FIELD_TABLE,
  scope: string[] = ['1']
) => merge3(base, a, b, table, { now: NOW, scope })

const t = (title: SyncTitleState): SyncDoc => doc({ '1': title })

describe('rule 1: watch[ep].position', () => {
  const pos = (p: number, at: number) => ({ '1': { ...watch(false, at, p) } })
  it('one side changed: applied to the other', () => {
    const m = run(
      t({ watch: pos(10, 100) }),
      t({ watch: pos(10, 100) }),
      t({ watch: pos(600, 200) })
    )
    expect(m.result.titles['1'].watch!['1'].position.value.position).toBe(600)
    expect(m.changesA).toContain('titles.1.watch.1.position')
    expect(m.changesB).not.toContain('titles.1.watch.1.position')
  })
  it('both changed the same way: unchanged on either side', () => {
    const m = run(
      t({ watch: pos(10, 100) }),
      t({ watch: pos(600, 300) }),
      t({ watch: pos(600, 200) })
    )
    expect(m.changesA).toEqual([])
    expect(m.changesB).toEqual([])
  })
  it('both changed differently: the later position.at wins', () => {
    const m = run(
      t({ watch: pos(10, 100) }),
      t({ watch: pos(300, 400) }),
      t({ watch: pos(600, 200) })
    )
    expect(m.remote.titles['1'].watch!['1'].position.value.position).toBe(300)
    expect(m.conflicts).toEqual([])
  })
  it('a tie goes to side A', () => {
    const m = run(
      t({ watch: pos(10, 100) }),
      t({ watch: pos(300, 200) }),
      t({ watch: pos(600, 200) })
    )
    expect(m.remote.titles['1'].watch!['1'].position.value.position).toBe(300)
  })
  it('a clamped future `at` loses to a real newer edit', () => {
    const a = t({ watch: pos(300, NOW + 100_000) })
    const b = t({ watch: pos(600, NOW + 1_000_000_000) })
    const m = run(t({ watch: pos(10, 100) }), a, b)
    // B's position and watched clocks; A's +100 s is within the 120 s skew.
    expect(m.clamped.map((c) => [c.side, c.path, c.clampedTo])).toEqual([
      ['b', 'titles.1.watch.1.position', NOW],
      ['b', 'titles.1.watch.1.watched', NOW]
    ])
    expect(m.remote.titles['1'].watch!['1'].position.value.position).toBe(300)
  })
})

describe('rule 2: watch[ep].watched', () => {
  it('an unwatch on one side is applied', () => {
    const m = run(
      t({ watch: { '1': watch(true, 100) } }),
      t({ watch: { '1': watch(true, 100) } }),
      t({ watch: { '1': watch(false, 200) } })
    )
    expect(m.result.titles['1'].watch!['1'].watched.value).toBe(false)
    expect(m.result.titles['1'].watch!['1'].watchedAt).toBeNull()
  })
  it('unwatched on one side, re-watched on the other: a conflict, unapplied on both sides', () => {
    const base = t({ watch: { '1': watch(true, 100) } })
    const m = run(
      base,
      t({ watch: { '1': watch(true, 300) } }),
      t({ watch: { '1': watch(false, 200) } })
    )
    expect(m.conflicts).toHaveLength(1)
    expect(m.conflicts[0]).toMatchObject({ animeId: '1', fieldPath: 'watch.1.watched' })
    expect(m.result.titles['1'].watch!['1'].watched.value).toBe(true)
    expect(m.remote.titles['1'].watch!['1'].watched.value).toBe(false)
    expect(m.nextBase.titles['1'].watch!['1'].watched).toEqual(base.titles['1'].watch!['1'].watched)
  })
})

describe('rule 2: a re-watch is a clock-only change the merge carries (#645)', () => {
  const P = 'titles.1.watch.1.watched'
  // A completed re-watch keeps `watchedAt` (watch-progress.ipc.ts), so it stays at 100.
  const rewatch = (at: number, origin: string) =>
    t({ watch: { '1': watch(true, at, 0, origin, 100) } })
  const unwatch = (at: number) => t({ watch: { '1': watch(false, at, 0, 'pc-a', null) } })
  const base = t({ watch: { '1': watch(true, 100) } })
  const untouched = t({ watch: { '1': watch(true, 100) } })

  it('row 1: re-watched on B only: A and the base take B’s clock', () => {
    const m = run(base, untouched, rewatch(300, 'pc-b'))
    expect(m.result.titles['1'].watch!['1'].watched).toEqual({
      value: true,
      at: 300,
      origin: 'pc-b'
    })
    expect(m.nextBase.titles['1'].watch!['1'].watched.at).toBe(300)
    expect(m.changesA).toEqual([P])
    expect(m.changesB).toEqual([])
  })
  it('row 2: re-watched on A only: the drive takes A’s clock, a write', () => {
    const m = run(base, rewatch(300, 'pc-a'), untouched)
    expect(m.remote.titles['1'].watch!['1'].watched).toEqual({
      value: true,
      at: 300,
      origin: 'pc-a'
    })
    expect(m.changesA).toEqual([])
    expect(m.changesB).toEqual([P])
  })
  it('row 3: two PCs: the carried clock makes the other PC’s later unwatch a conflict', () => {
    // PC B's merge (side A is B's re-watch, side B the untouched drive). The
    // drive is written only when changesB is non-empty, as the runner does.
    const mb = run(base, rewatch(300, 'pc-b'), untouched)
    const drive = mb.changesB.length > 0 ? mb.remote : untouched
    const ma = run(base, unwatch(400), drive)
    expect(ma.conflicts.map((c) => c.fieldPath)).toEqual(['watch.1.watched'])
  })
  it('row 4: re-watched on both sides: the later clock, no conflict', () => {
    const m = run(base, rewatch(300, 'pc-a'), rewatch(250, 'pc-b'))
    expect(m.conflicts).toEqual([])
    expect(m.remote.titles['1'].watch!['1'].watched.at).toBe(300)
    expect(m.changesB).toEqual([P])
  })
  it('row 5: a future drive clock is clamped and written back once; the next merge is quiet', () => {
    const drive0 = rewatch(NOW + 1e9, 'pc-skew')
    const m1 = run(base, untouched, drive0)
    expect(m1.changesB).toContain(P)
    const drive1 = m1.changesB.length > 0 ? m1.remote : drive0
    const m2 = merge3(m1.nextBase, m1.result, drive1, FIELD_TABLE, {
      now: NOW + 60_000,
      scope: ['1']
    })
    expect(m2.changesA).toEqual([])
    expect(m2.changesB).toEqual([])
  })
  it('row 5: a clamped drive clock that A’s later re-watch already replaces is listed once', () => {
    const m = run(base, rewatch(NOW + 100_000, 'pc-a'), rewatch(NOW + 1e9, 'pc-skew'))
    expect(m.clamped.map((c) => [c.side, c.path])).toContainEqual(['b', P])
    expect(m.remote.titles['1'].watch!['1'].watched.at).toBe(NOW + 100_000)
    expect(m.changesB).toEqual([P])
  })
  it('row 5: a clamped drive clock held in a conflict is not written back', () => {
    const m = run(base, unwatch(400), rewatch(NOW + 1e9, 'pc-skew'))
    expect(m.conflicts.map((c) => c.fieldPath)).toEqual(['watch.1.watched'])
    expect(m.changesB).toEqual([])
  })
  it('row 5, out of scope: a future drive clock on another title is never written back', () => {
    const drive = doc({
      '1': untouched.titles['1'],
      '2': { watch: { '1': watch(true, NOW + 1e9, 0, 'pc-skew', 100) } }
    })
    const m1 = run(base, untouched, drive)
    expect(m1.clamped.map((c) => c.path)).toContain('titles.2.watch.1.watched')
    expect(m1.changesB).toEqual([])
    const m2 = merge3(m1.nextBase, m1.result, drive, FIELD_TABLE, {
      now: NOW + 60_000,
      scope: ['1']
    })
    expect(m2.changesB).toEqual([])
  })
  it('row 6: no base, equal values, different clocks: unchanged, and the base keeps the later clock', () => {
    const drive = rewatch(300, 'pc-other')
    const m1 = run(null, untouched, drive)
    expect(m1.changesA).toEqual([])
    expect(m1.changesB).toEqual([])
    expect(m1.nextBase.titles['1'].watch!['1'].watched.at).toBe(300)
    const m2 = run(m1.nextBase, m1.result, drive)
    expect(m2.changesA).toEqual([])
    expect(m2.changesB).toEqual([])
    const m3 = run(m1.nextBase, unwatch(400), drive)
    expect(m3.conflicts).toEqual([])
    expect(m3.remote.titles['1'].watch!['1'].watched.value).toBe(false)
  })
  it.each([
    ['both unwatched with different clocks', t({ watch: { '1': watch(true, 100) } }), false],
    [
      'both watched from false with different clocks',
      t({ watch: { '1': watch(false, 100) } }),
      true
    ]
  ])('%s: a value change only, so no clock-only change on either side', (_n, from, to) => {
    const side = (at: number, origin: string) =>
      t({ watch: { '1': watch(to, at, 0, origin, to ? 100 : null) } })
    const m = run(from, side(200, 'pc-a'), side(300, 'pc-b'))
    expect(m.conflicts).toEqual([])
    expect(m.changesA).toEqual([])
    expect(m.changesB).toEqual([])
  })
  it('a pre-fix PC (main’s rule 2) keeps a carried drive clock when it writes', () => {
    // Main's (e005812) `decideWatched` differs from today's only where base, A
    // and B are all `true`: no conflict is possible, values are equal, so
    // `decideClocked` returns `unchanged`. Everywhere else the two agree.
    const preFix = (
      b0: SyncField<boolean> | undefined,
      a: SyncField<boolean> | undefined,
      b: SyncField<boolean> | undefined
    ): Decision<SyncField<boolean>> =>
      b0?.value && a?.value && b?.value ? { kind: 'unchanged' } : decideWatched(b0, a, b)
    const table = FIELD_TABLE.map((r) =>
      r.rule === 2 ? { ...r, decide: preFix as FieldRule['decide'] } : r
    )
    const m = run(base, untouched, rewatch(300, 'pc-b'), table)
    expect(m.remote.titles['1'].watch!['1'].watched).toEqual({
      value: true,
      at: 300,
      origin: 'pc-b'
    })
    expect(m.changesB).toEqual([])
  })
})

describe('rule 3: watch[ep].watchedAt', () => {
  it('the earliest non-null of the sides where watched is true', () => {
    const m = run(
      t({ watch: { '1': watch(false, 50) } }),
      t({ watch: { '1': watch(true, 300, 0, 'pc-a', 300) } }),
      t({ watch: { '1': watch(true, 200, 0, 'pc-b', 200) } })
    )
    expect(m.result.titles['1'].watch!['1'].watchedAt).toBe(200)
    expect(m.remote.titles['1'].watch!['1'].watchedAt).toBe(200)
  })
})

describe('rules 4–7: rate fields', () => {
  const r = (v: Parameters<typeof rate>[0], at = 100) => t({ rate: rate(v, at) })
  it('rule 4: one side changed is applied', () => {
    const m = run(r({ episodes: 3 }), r({ episodes: 3 }), r({ episodes: 5 }, 200))
    expect(m.result.titles['1'].rate!.episodes.value).toBe(5)
  })
  it('rule 4: both rose takes the max', () => {
    const m = run(r({ episodes: 3 }), r({ episodes: 7 }), r({ episodes: 5 }))
    expect(m.result.titles['1'].rate!.episodes.value).toBe(7)
    expect(m.remote.titles['1'].rate!.episodes.value).toBe(7)
    expect(m.conflicts).toEqual([])
  })
  const loweredVsRose = (table: readonly FieldRule[]) => {
    const m = run(r({ episodes: 5 }), r({ episodes: 3 }), r({ episodes: 8 }), table)
    expect(m.conflicts.map((c) => c.fieldPath)).toEqual(['rate.episodes'])
    expect(m.result.titles['1'].rate!.episodes.value).toBe(3)
    expect(m.remote.titles['1'].rate!.episodes.value).toBe(8)
    expect(m.nextBase.titles['1'].rate!.episodes.value).toBe(5)
  }
  it('rule 4: lowered vs rose is a conflict', () => loweredVsRose(FIELD_TABLE))
  it('mutation: a table whose rule 4 lowers silently fails the lowered-vs-rose row', () => {
    const silent = FIELD_TABLE.map((rule) =>
      rule.rule === 4
        ? {
            ...rule,
            decide: ((_b: unknown, a: SyncField<number>, b: SyncField<number>) => ({
              kind: 'merge',
              value: a.value >= b.value ? a : b
            })) as FieldRule['decide']
          }
        : rule
    )
    expect(() => loweredVsRose(silent)).toThrow()
  })
  it('rule 4: both lowered to different values is a conflict', () => {
    const m = run(r({ episodes: 9 }), r({ episodes: 3 }), r({ episodes: 5 }))
    expect(m.conflicts[0]).toMatchObject({
      fieldPath: 'rate.episodes',
      reason: 'lowered on both sides, to different values'
    })
  })
  it('rule 4: both lowered to the same value is applied', () => {
    const m = run(r({ episodes: 9 }), r({ episodes: 3 }, 200), r({ episodes: 3 }, 300))
    expect(m.conflicts).toEqual([])
    expect(m.changesA).toEqual([])
  })
  it('rules 5 and 6: both changed differently is a conflict; the same way is applied', () => {
    const m = run(
      r({ score: 6, status: 'watching' }),
      r({ score: 7, status: 'completed' }),
      r({ score: 8, status: 'completed' })
    )
    expect(m.conflicts.map((c) => c.fieldPath)).toEqual(['rate.score'])
  })
  it('rule 7: 2 → 3 on both sides is a conflict with no suggestion (decision 6)', () => {
    const m = run(r({ rewatches: 2 }), r({ rewatches: 3 }, 200), r({ rewatches: 3 }, 300))
    expect(m.conflicts).toHaveLength(1)
    expect(m.conflicts[0]).toMatchObject({ fieldPath: 'rate.rewatches', noSuggestion: true })
  })
  it('rule 7: both lowered to the same value is applied', () => {
    const m = run(r({ rewatches: 4 }), r({ rewatches: 2 }), r({ rewatches: 2 }))
    expect(m.conflicts).toEqual([])
  })
  it('"changed" is a value difference: equal values with different clocks are unchanged', () => {
    const m = run(r({ score: 6 }, 1), r({ score: 6 }, 0), r({ score: 6 }, 999))
    expect(m.changesA).toEqual([])
    expect(m.changesB).toEqual([])
  })
})

describe('rules 8 and 9: starred and priority', () => {
  it('a tombstone against an unchanged side is applied', () => {
    const base = t({ starred: F(true as const, 100) })
    const a = doc(
      {},
      { tombstones: { '1': { starred: { deleted: true, at: 300, origin: 'pc-a' } } } }
    )
    const m = run(base, a, t({ starred: F(true as const, 100) }))
    expect(m.remote.titles['1']?.starred).toBeUndefined()
    expect(m.remote.tombstones['1'].starred).toMatchObject({ deleted: true, at: 300 })
    expect(m.changesB).toContain('titles.1.starred')
  })
  it('both changed: the later at wins, tombstones included', () => {
    const a = t({ starred: F(true as const, 100) })
    const b = doc(
      {},
      { tombstones: { '1': { starred: { deleted: true, at: 200, origin: 'pc-b' } } } }
    )
    const m = run(null, a, b)
    expect(m.result.titles['1']?.starred).toBeUndefined()
    expect(m.result.tombstones['1'].starred!.at).toBe(200)
  })
  it('the priority ⇒ starred invariant: an unstar on one side drops priority', () => {
    const base = t({ starred: F(true as const, 100), priority: F(true as const, 100) })
    const b = doc(
      {},
      { tombstones: { '1': { starred: { deleted: true, at: 300, origin: 'pc-b' } } } }
    )
    // B's projection of a prioritised title it later unstarred: priority listed, star gone.
    const bLive = doc(
      { '1': { priority: F(true as const, 100) } },
      { tombstones: { '1': { starred: { deleted: true, at: 300, origin: 'pc-b' } } } }
    )
    for (const side of [b, bLive]) {
      const m = run(base, base, side)
      expect(m.result.titles['1']?.starred).toBeUndefined()
      expect(m.result.titles['1']?.priority).toBeUndefined()
      expect(m.remote.titles['1']?.priority).toBeUndefined()
    }
  })
})

describe('rule 10: priorityOrder', () => {
  it('in-scope ids only, the later side wins, out-of-scope ids never appear', () => {
    const titles = (ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [id, { starred: F(true as const), priority: F(true as const) }])
      )
    const base = doc(titles(['1', '2']), { priorityOrder: F(['1', '2'], 100) })
    const a = doc(titles(['1', '2']), { priorityOrder: F(['2', '1'], 300) })
    const b = doc(titles(['1', '2']), { priorityOrder: F(['1', '99', '2'], 200) })
    const m = run(base, a, b, FIELD_TABLE, ['1', '2'])
    expect(m.remote.priorityOrder.value).toEqual(['2', '1'])
    expect(m.result.priorityOrder.value).not.toContain('99')
  })
})

describe('rule 11: dismissed', () => {
  it('(base ∪ added) − removed', () => {
    const m = run(
      t({ dismissed: ['1', '2'] }),
      t({ dismissed: ['1', '2', '3'] }),
      t({ dismissed: ['2'] })
    )
    expect(m.result.titles['1'].dismissed).toEqual(['2', '3'])
    expect(m.remote.titles['1'].dismissed).toEqual(['2', '3'])
  })
})

describe('rule 12: skip', () => {
  const alg = {
    source: 'local',
    sampleRate: 11025,
    matchBitThreshold: 6,
    minRunSec: 18,
    windowSec: 6,
    refineBitThreshold: 4,
    refineSustainHashes: 5
  } as const
  const ep = (fileSize: number): SyncSkipEpisode => ({
    file: { translationId: 7, fileSize },
    episodeLabel: '1',
    durationSec: 1440,
    hashesPerSec: 8,
    op: null,
    ed: null
  })
  const skip = (perEpisode: Record<string, SyncSkipEpisode>): SyncSkipState => ({
    algorithm: alg,
    analyzedAt: 1,
    episodeCount: 2,
    perEpisode
  })
  it("takes the other side's entry only for the same file, and gives the drive this PC's", () => {
    const a = t({ skip: skip({ '1': ep(10) }) })
    const b = t({ skip: skip({ '2': ep(20), '3': ep(30) }) })
    const m = merge3(null, a, b, FIELD_TABLE, {
      now: NOW,
      scope: ['1'],
      skip: () => ({
        algorithm: alg,
        localFile: (e) =>
          e === '2'
            ? { translationId: 7, fileSize: 20 }
            : e === '3'
              ? { translationId: 7, fileSize: 99 }
              : null
      })
    })
    expect(Object.keys(m.result.titles['1'].skip!.perEpisode).sort()).toEqual(['1', '2'])
    expect(Object.keys(m.remote.titles['1'].skip!.perEpisode).sort()).toEqual(['1', '2', '3'])
    expect(m.conflicts).toEqual([])
  })
})

describe('scope and unknown fields', () => {
  it('only in-scope titles are returned', () => {
    const m = run(
      null,
      doc({ '1': { rate: rate() }, '2': { rate: rate() } }),
      doc({ '2': { rate: rate({ score: 9 }) } })
    )
    expect(Object.keys(m.result.titles)).toEqual(['1'])
    expect(m.changesA).toEqual([])
  })
  it("the library's plain unknown keys reach side A at the doc and title levels", () => {
    const b = { ...doc({ '1': { rate: rate(), futureTitle: { x: 1 } } }), futureDoc: 'kept' }
    const m = run(null, doc({ '1': { rate: rate() } }), b)
    expect((m.result as Record<string, unknown>).futureDoc).toBe('kept')
    expect(m.result.titles['1'].futureTitle).toEqual({ x: 1 })
  })
})
