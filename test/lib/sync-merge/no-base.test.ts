// The first merge with no base (#584 §1): every row of the no-base table.
import { describe, it, expect } from 'vitest'
import { merge3 } from '../../../src/main/lib/sync-merge/merge3'
import { normalizeDoc, ratesOnly, shikimoriNoBase } from '../../../src/main/lib/sync-merge/no-base'
import { FIELD_TABLE } from '../../../src/main/lib/sync-state/field-table'
import { F, doc, rate, watch } from '../../helpers/sync-merge'

const first = (a: SyncDoc, b: SyncDoc, scope = ['1']) =>
  merge3(null, a, b, FIELD_TABLE, { now: 10_000_000, scope })
const t = (title: SyncTitleState, extra: Partial<SyncDoc> = {}): SyncDoc =>
  doc({ '1': title }, extra)

describe('merge3(null, …): the no-base table', () => {
  it('equal values on both sides: unchanged, whatever the clocks', () => {
    const m = first(t({ rate: rate({ score: 7 }, 1) }), t({ rate: rate({ score: 7 }, 999) }))
    expect(m.changesA).toEqual([])
    expect(m.changesB).toEqual([])
    expect(m.conflicts).toEqual([])
  })

  it('present on one side, absent on the other: the present value, silently, for every field', () => {
    const full: SyncTitleState = {
      watch: { '1': watch(true, 100, 300) },
      starred: F(true as const, 100),
      priority: F(true as const, 100),
      rate: rate({ episodes: 4, status: 'watching', score: 8, rewatches: 1 }),
      dismissed: ['3']
    }
    for (const [a, b] of [
      [t(full), doc()],
      [doc(), t(full)]
    ]) {
      const m = first(a, b)
      expect(m.conflicts).toEqual([])
      for (const side of [m.result, m.remote]) {
        expect(side.titles['1'].watch!['1'].watched.value).toBe(true)
        expect(side.titles['1'].starred).toBeDefined()
        expect(side.titles['1'].priority).toBeDefined()
        expect(side.titles['1'].rate!.score.value).toBe(8)
        expect(side.titles['1'].dismissed).toEqual(['3'])
      }
    }
  })

  it('position, starred, priority and priorityOrder: the later at wins; an equal at goes to side A', () => {
    const w = (p: number, at: number) => ({ '1': watch(false, at, p) })
    expect(
      first(t({ watch: w(10, 100) }), t({ watch: w(20, 200) })).result.titles['1'].watch!['1']
        .position.value.position
    ).toBe(20)
    expect(
      first(t({ watch: w(10, 200) }), t({ watch: w(20, 200) })).remote.titles['1'].watch!['1']
        .position.value.position
    ).toBe(10)
    const stone = {
      tombstones: { '1': { starred: { deleted: true as const, at: 300, origin: 'pc-b' } } }
    }
    expect(
      first(t({ starred: F(true as const, 200) }), doc({}, stone)).result.titles['1']?.starred
    ).toBeUndefined()
    expect(
      first(t({ starred: F(true as const, 300) }), doc({}, stone)).remote.titles['1'].starred
    ).toBeDefined()
    const p = (order: string[], at: number) =>
      doc(
        Object.fromEntries(
          ['1', '2'].map((id) => [id, { starred: F(true as const), priority: F(true as const) }])
        ),
        { priorityOrder: F(order, at) }
      )
    expect(
      merge3(null, p(['1', '2'], 100), p(['2', '1'], 200), FIELD_TABLE, {
        now: 1e7,
        scope: ['1', '2']
      }).result.priorityOrder.value
    ).toEqual(['2', '1'])
    expect(
      merge3(null, p(['1', '2'], 200), p(['2', '1'], 200), FIELD_TABLE, {
        now: 1e7,
        scope: ['1', '2']
      }).remote.priorityOrder.value
    ).toEqual(['1', '2'])
  })

  it('watched: true wins, so a first merge never unwatches', () => {
    for (const [a, b] of [
      [false, true],
      [true, false]
    ]) {
      const m = first(
        t({ watch: { '1': watch(a, a ? 100 : 500) } }),
        t({ watch: { '1': watch(b, b ? 100 : 500) } })
      )
      expect(m.result.titles['1'].watch!['1'].watched.value).toBe(true)
      expect(m.remote.titles['1'].watch!['1'].watched.value).toBe(true)
    }
  })

  it('watchedAt: the earliest non-null', () => {
    const m = first(
      t({ watch: { '1': watch(true, 300, 0, 'a', 300) } }),
      t({ watch: { '1': watch(true, 200, 0, 'b', 200) } })
    )
    expect(m.result.titles['1'].watch!['1'].watchedAt).toBe(200)
  })

  it('rate.episodes: the max, so a first merge never lowers', () => {
    const m = first(t({ rate: rate({ episodes: 9 }) }), t({ rate: rate({ episodes: 4 }, 900) }))
    expect(m.result.titles['1'].rate!.episodes.value).toBe(9)
    expect(m.remote.titles['1'].rate!.episodes.value).toBe(9)
    expect(m.conflicts).toEqual([])
  })

  it('status, score and rewatches that differ are conflicts: nothing says which side moved', () => {
    const m = first(
      t({ rate: rate({ status: 'watching', score: 6, rewatches: 1 }) }),
      t({ rate: rate({ status: 'completed', score: 8, rewatches: 2 }) })
    )
    expect(m.conflicts.map((c) => c.fieldPath).sort()).toEqual([
      'rate.rewatches',
      'rate.score',
      'rate.status'
    ])
    expect(m.result.titles['1'].rate!.score.value).toBe(6)
    expect(m.remote.titles['1'].rate!.score.value).toBe(8)
  })

  it('dismissed: a union', () => {
    const m = first(t({ dismissed: ['1', '2'] }), t({ dismissed: ['3'] }))
    expect(m.result.titles['1'].dismissed).toEqual(['1', '2', '3'])
  })

  it('an S5 empty-state library (stateGeneration: null): local values go to the drive, no conflict', () => {
    const local = t(
      {
        watch: { '1': watch(true, 100) },
        starred: F(true as const, 100),
        rate: rate({ score: 7 })
      },
      { priorityOrder: F([], 50) }
    )
    const m = first(local, normalizeDoc(null))
    expect(m.conflicts).toEqual([])
    expect(m.changesA).toEqual([])
    expect(m.remote.titles['1']).toEqual(local.titles['1'])
    expect(m.remote.priorityOrder.at).toBe(50)
  })

  it('the Shikimori leg with no base: the base is the Shikimori side, so only local differences move', () => {
    const shiki = t({ rate: rate({ episodes: 3, score: 6 }, 500, 'shikimori') })
    const local = t({ rate: rate({ episodes: 3, score: 8 }, 600) })
    const m = merge3(shikimoriNoBase(shiki), ratesOnly(local, ['1']), shiki, FIELD_TABLE, {
      now: 1e7,
      scope: ['1'],
      order: false
    })
    expect(m.conflicts).toEqual([])
    expect(m.changesB).toEqual(['titles.1.rate.score'])
    expect(m.changesA).toEqual([])
  })
})
