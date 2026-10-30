// The frozen field table of #572 §6, table-driven over the rule data. S9
// (#584) reuses these cases for its engine suite: each row is one rule, one
// situation, and the decision the table says it gets.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import {
  FIELD_TABLE,
  decideDismissed,
  decideEpisodes,
  decideMembership,
  decidePosition,
  decidePriorityOrder,
  decideRewatches,
  decideScore,
  decideSkip,
  decideStatus,
  decideWatched,
  decideWatchedAt,
  enforcePriorityInvariant,
  membershipOf,
  sameValue,
  type Decision,
  type Membership
} from '../../../src/main/lib/sync-state/field-table'
import { projectSyncDoc } from '../../../src/main/lib/sync-state/project'
import { CHANNELS } from '../../../src/shared/ipc/channels'
import { InMemoryStorage } from '../../helpers/in-memory-storage'
import { register } from '../../../src/main/ipc/watch-progress.ipc'
import type { AppDeps } from '../../../src/main/ipc/index'

const f = <T>(value: T, at: number, origin = 'pc-a'): SyncField<T> => ({ value, at, origin })
const m = (present: boolean, at: number, origin = 'pc-a'): Membership => ({ present, at, origin })
const pos = (position: number, translationId = 77): SyncWatchPosition => ({
  position,
  duration: 1420,
  translationId
})

function valueOf(d: Decision<unknown>): unknown {
  return d.kind === 'take' || d.kind === 'merge' ? d.value : undefined
}

describe('field table data', () => {
  it('freezes rules 1–12, in order, with the conflict-capable ones exactly 2 and 4–7', () => {
    expect(FIELD_TABLE.map((r) => r.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(FIELD_TABLE.filter((r) => r.canConflict).map((r) => r.rule)).toEqual([2, 4, 5, 6, 7])
    expect(FIELD_TABLE.filter((r) => r.clockDecides).map((r) => r.rule)).toEqual([1, 2, 8, 9, 10])
  })
})

describe('rules 1, 4–7 — one side, both the same, both different', () => {
  type Row = [
    rule: string,
    decide: (b: SyncField<never>, x: SyncField<never>, y: SyncField<never>) => Decision<unknown>,
    base: SyncField<unknown>,
    a: SyncField<unknown>,
    b: SyncField<unknown>,
    expected: { kind: Decision<unknown>['kind']; value?: unknown }
  ]
  const rows: Row[] = [
    [
      '1: neither changed',
      decidePosition as never,
      f(pos(600), 1),
      f(pos(600), 1),
      f(pos(600), 2),
      { kind: 'unchanged' }
    ],
    [
      '1: A changed',
      decidePosition as never,
      f(pos(600), 1),
      f(pos(900), 5),
      f(pos(600), 1),
      { kind: 'take', value: f(pos(900), 5) }
    ],
    [
      '1: B changed',
      decidePosition as never,
      f(pos(600), 1),
      f(pos(600), 1),
      f(pos(900), 5, 'pc-b'),
      { kind: 'take', value: f(pos(900), 5, 'pc-b') }
    ],
    [
      '1: both changed, later at wins',
      decidePosition as never,
      f(pos(600), 1),
      f(pos(900), 5),
      f(pos(1000), 6, 'pc-b'),
      { kind: 'merge', value: f(pos(1000), 6, 'pc-b') }
    ],
    [
      '1: both changed, equal at goes to A',
      decidePosition as never,
      f(pos(600), 1),
      f(pos(900), 6),
      f(pos(1000), 6, 'pc-b'),
      { kind: 'merge', value: f(pos(900), 6) }
    ],
    [
      '4: one side rose',
      decideEpisodes as never,
      f(3, 1),
      f(5, 2),
      f(3, 1),
      { kind: 'take', value: f(5, 2) }
    ],
    [
      '4: one side lowered',
      decideEpisodes as never,
      f(3, 1),
      f(3, 1),
      f(1, 2, 'pc-b'),
      { kind: 'take', value: f(1, 2, 'pc-b') }
    ],
    [
      '4: both rose: max',
      decideEpisodes as never,
      f(3, 1),
      f(5, 9),
      f(7, 2, 'pc-b'),
      { kind: 'merge', value: f(7, 2, 'pc-b') }
    ],
    [
      '4: both to the same value',
      decideEpisodes as never,
      f(3, 1),
      f(5, 2),
      f(5, 9, 'pc-b'),
      { kind: 'merge', value: f(5, 9, 'pc-b') }
    ],
    [
      '4: both lowered to the same value',
      decideEpisodes as never,
      f(6, 1),
      f(2, 2),
      f(2, 3, 'pc-b'),
      { kind: 'merge', value: f(2, 3, 'pc-b') }
    ],
    [
      '4: lowered vs rose',
      decideEpisodes as never,
      f(6, 1),
      f(2, 2),
      f(8, 3, 'pc-b'),
      { kind: 'conflict' }
    ],
    [
      '4: both lowered, to different values',
      decideEpisodes as never,
      f(6, 1),
      f(2, 2),
      f(4, 3, 'pc-b'),
      { kind: 'conflict' }
    ],
    [
      '5: one side',
      decideStatus as never,
      f('watching', 1),
      f('completed', 2),
      f('watching', 1),
      { kind: 'take', value: f('completed', 2) }
    ],
    [
      '5: both the same',
      decideStatus as never,
      f('watching', 1),
      f('completed', 2),
      f('completed', 3, 'pc-b'),
      { kind: 'merge', value: f('completed', 3, 'pc-b') }
    ],
    [
      '5: both different',
      decideStatus as never,
      f('watching', 1),
      f('completed', 2),
      f('dropped', 3, 'pc-b'),
      { kind: 'conflict' }
    ],
    [
      '6: one side',
      decideScore as never,
      f(7, 1),
      f(7, 1),
      f(9, 2, 'pc-b'),
      { kind: 'take', value: f(9, 2, 'pc-b') }
    ],
    [
      '6: both the same',
      decideScore as never,
      f(7, 1),
      f(9, 2),
      f(9, 3, 'pc-b'),
      { kind: 'merge', value: f(9, 3, 'pc-b') }
    ],
    [
      '6: both different',
      decideScore as never,
      f(7, 1),
      f(8, 2),
      f(9, 3, 'pc-b'),
      { kind: 'conflict' }
    ],
    [
      '7: one side rose',
      decideRewatches as never,
      f(2, 1),
      f(3, 2),
      f(2, 1),
      { kind: 'take', value: f(3, 2) }
    ],
    [
      '7: both rose to the same value (decision 6)',
      decideRewatches as never,
      f(2, 1),
      f(3, 2),
      f(3, 3, 'pc-b'),
      { kind: 'conflict' }
    ],
    [
      '7: both lowered to the same value',
      decideRewatches as never,
      f(2, 1),
      f(1, 2),
      f(1, 3, 'pc-b'),
      { kind: 'merge', value: f(1, 3, 'pc-b') }
    ],
    [
      '7: both changed to different values',
      decideRewatches as never,
      f(2, 1),
      f(1, 2),
      f(4, 3, 'pc-b'),
      { kind: 'conflict' }
    ]
  ]
  it.each(rows)('%s', (_name, decide, base, a, b, expected) => {
    const d = decide(base as never, a as never, b as never)
    expect(d.kind).toBe(expected.kind)
    if ('value' in expected) expect(valueOf(d)).toEqual(expected.value)
  })

  // Rules 4–7 never decide on `at` (#572 §2), so a rate clock can't win a
  // merge on its own: swapping every clock leaves each decision's value as it was.
  it.each(rows.filter(([name]) => /^[4-7]:/.test(name)))(
    "%s — the outcome doesn't depend on the clocks",
    (_name, decide, base, a, b) => {
      const shuffle = (x: SyncField<unknown>, at: number): SyncField<unknown> => ({ ...x, at })
      const plain = decide(base as never, a as never, b as never)
      const swapped = decide(
        shuffle(base, 99) as never,
        shuffle(a, 1) as never,
        shuffle(b, 500) as never
      )
      expect(swapped.kind).toBe(plain.kind)
      expect((valueOf(swapped) as SyncField<unknown> | undefined)?.value).toEqual(
        (valueOf(plain) as SyncField<unknown> | undefined)?.value
      )
    }
  )
})

describe('rule 2 — watched', () => {
  const base = f(true, 100)
  it('applies a one-side unwatch against an untouched true', () => {
    expect(decideWatched(base, f(false, 200), f(true, 100, 'pc-b'))).toEqual({
      kind: 'take',
      from: 'a',
      value: f(false, 200)
    })
  })
  it('conflicts on an unwatch against a re-watch (same value, newer watched.at)', () => {
    expect(decideWatched(base, f(false, 200), f(true, 150, 'pc-b')).kind).toBe('conflict')
    expect(decideWatched(base, f(true, 150), f(false, 200, 'pc-b')).kind).toBe('conflict')
  })
  it('takes a re-watch on one side against an untouched true: the other side takes its clock (#645)', () => {
    expect(decideWatched(base, f(true, 100), f(true, 300, 'pc-b'))).toEqual({
      kind: 'take',
      from: 'b',
      value: f(true, 300, 'pc-b')
    })
    expect(decideWatched(base, f(true, 300), f(true, 100, 'pc-b'))).toEqual({
      kind: 'take',
      from: 'a',
      value: f(true, 300)
    })
  })
  it('merges a re-watch on both sides to the later clock, a tie to side A (#645)', () => {
    expect(decideWatched(base, f(true, 250), f(true, 300, 'pc-b'))).toEqual({
      kind: 'merge',
      value: f(true, 300, 'pc-b')
    })
    expect(decideWatched(base, f(true, 300), f(true, 300, 'pc-b'))).toEqual({
      kind: 'merge',
      value: f(true, 300)
    })
  })
  it('applies a first watch from one side', () => {
    expect(decideWatched(f(false, 1), f(false, 1), f(true, 5, 'pc-b'))).toMatchObject({
      kind: 'take',
      from: 'b'
    })
  })
  it('with no base, true wins', () => {
    expect(valueOf(decideWatched(undefined, f(false, 9), f(true, 1, 'pc-b')))).toEqual(
      f(true, 1, 'pc-b')
    )
  })
})

describe('rule 3 — watchedAt', () => {
  it('takes the earliest non-null of the watched sides', () => {
    const d = decideWatchedAt(
      undefined,
      { watched: true, watchedAt: 500 },
      { watched: true, watchedAt: 300 },
      { mergedWatched: true }
    )
    expect(d).toEqual({ kind: 'merge', value: 300 })
  })
  it('ignores a side that is not watched, and is null once the merge unwatches', () => {
    const a = { watched: true, watchedAt: 500 }
    const b = { watched: false, watchedAt: 100 }
    expect(decideWatchedAt(undefined, a, b, { mergedWatched: true })).toEqual({
      kind: 'merge',
      value: 500
    })
    expect(valueOf(decideWatchedAt(undefined, a, b, { mergedWatched: false }))).toBeNull()
  })
})

describe('rules 8 and 9 — membership', () => {
  it('applies a one-side unstar (tombstone) against an untouched star', () => {
    expect(decideMembership(m(true, 10), m(false, 50), m(true, 10, 'pc-b'))).toMatchObject({
      kind: 'take',
      from: 'a'
    })
  })
  it('with no base, the later at wins, tombstones included', () => {
    expect(decideMembership(undefined, m(true, 10), m(false, 50, 'pc-b'))).toMatchObject({
      kind: 'take',
      from: 'b',
      value: { present: false }
    })
    expect(decideMembership(undefined, m(true, 60), m(false, 50, 'pc-b'))).toMatchObject({
      from: 'a'
    })
  })
  it('a never-starred side loses to a present one with no base', () => {
    const doc = {
      titles: {},
      tombstones: {}
    } as unknown as SyncDoc
    expect(
      decideMembership(undefined, membershipOf(doc, '7', 'starred'), m(true, 1, 'pc-b'))
    ).toMatchObject({
      from: 'b'
    })
  })
  it('rule 9: an unstarred title is not prioritised', () => {
    expect(enforcePriorityInvariant(m(false, 80), m(true, 20))).toEqual(m(false, 80))
    expect(enforcePriorityInvariant(m(true, 80), m(true, 20))).toEqual(m(true, 20))
  })
})

describe('rule 10 — priorityOrder', () => {
  it("both changed: the later side's order, with merged members it lacks appended in the other's order", () => {
    const d = decidePriorityOrder(
      f(['1', '2', '3'], 1),
      f(['3', '1', '2', '4'], 5),
      f(['2', '1', '5', '3'], 9, 'pc-b'),
      {
        members: ['1', '2', '3', '4', '5']
      }
    )
    expect(valueOf(d)).toEqual(f(['2', '1', '5', '3', '4'], 9, 'pc-b'))
  })
  it("one side changed: that side's order, filtered to the merged members", () => {
    const d = decidePriorityOrder(f(['1', '2'], 1), f(['2', '1'], 5), f(['1', '2'], 1, 'pc-b'), {
      members: ['1', '2']
    })
    expect(valueOf(d)).toEqual(f(['2', '1'], 5))
  })
})

describe('rule 11 — dismissed, a 3-way set merge', () => {
  it('a key pruned on A and untouched on B stays removed', () => {
    expect(decideDismissed(['1', '2'], ['2'], ['1', '2'])).toEqual({ kind: 'merge', value: ['2'] })
  })
  it('adds from both sides', () => {
    expect(decideDismissed(['1'], ['1', '3'], ['1', '4'])).toEqual({
      kind: 'merge',
      value: ['1', '3', '4']
    })
  })
})

describe('rule 12 — skip, a cache', () => {
  const algorithm = {
    source: 'local',
    sampleRate: 11025
  } as unknown as ShowSkipDetections['algorithm']
  const entry = (fileSize: number): SyncSkipEpisode => ({
    file: { translationId: 7, fileSize },
    episodeLabel: '1',
    durationSec: 1420,
    hashesPerSec: 8,
    op: { startSec: 60, endSec: 150, pairCount: 3 },
    ed: null
  })
  const show = (perEpisode: Record<string, SyncSkipEpisode>, algo = algorithm): SyncSkipState => ({
    algorithm: algo,
    analyzedAt: 1,
    episodeCount: 12,
    perEpisode
  })
  const ctx = {
    algorithm,
    localFile: (ep: string) =>
      ep === '1' || ep === '2' ? { translationId: 7, fileSize: 100 } : null
  }

  it('keeps the local entry, takes a matching drive entry, and drops a mismatching one', () => {
    const d = decideSkip(
      undefined,
      show({ '1': entry(100) }),
      show({ '1': entry(555), '2': entry(100), '3': entry(100) }),
      ctx
    )
    expect(d.kind).toBe('merge')
    expect(Object.keys((valueOf(d) as SyncSkipState).perEpisode).sort()).toEqual(['1', '2'])
    expect((valueOf(d) as SyncSkipState).perEpisode['1']).toEqual(entry(100))
  })
  it('takes nothing whose algorithm differs, and never conflicts', () => {
    const other = { ...algorithm, sampleRate: 8000 }
    expect(decideSkip(undefined, undefined, show({ '2': entry(100) }, other), ctx)).toEqual({
      kind: 'unchanged'
    })
  })
})

describe('"changed" is a value difference, never a clock difference', () => {
  it('a legacy row identical on both sides, with different updatedAt and no base, is unchanged', () => {
    // Legacy clocks come from `updatedAt`, so the two sides' clocks differ.
    const a = f(pos(600), 1_000, 'legacy')
    const b = f(pos(600), 9_000, 'legacy')
    expect(decidePosition(undefined, a, b)).toEqual({ kind: 'unchanged' })
    expect(decideWatched(undefined, f(true, 1_000, 'legacy'), f(true, 9_000, 'legacy'))).toEqual({
      kind: 'unchanged'
    })
  })
  it('sameValue ignores key order and undefined members', () => {
    expect(
      sameValue({ a: 1, b: undefined, c: [1, { x: 1, y: 2 }] }, { c: [1, { y: 2, x: 1 }], a: 1 })
    ).toBe(true)
  })
})

// The issue's "opening beats watching": side A is a watched row this PC only
// opened (the `persistSelectedTranslation` save, `'choice'`); side B watched to
// 1200 s on another PC at T1. Side A is produced by the real router and the
// real projection, so the clock it carries is whatever the save stamped.
describe('opening beats watching — rule data over the real router', () => {
  const T0 = Date.UTC(2026, 0, 1)
  const T1 = T0 + 60 * 60 * 1000
  const T2 = T1 + 60 * 60 * 1000

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => vi.useRealTimers())

  it("the watching side wins: an open is a 'choice' save that keeps the T0 clock", async () => {
    const base = f(pos(1300), T0, 'pc-a')
    const store = new InMemoryStorage({
      installId: 'pc-a',
      watchProgress: {
        '5:3': {
          position: 1300,
          duration: 1420,
          updatedAt: T0,
          watched: true,
          watchedAt: T0,
          translationId: 77,
          sync: { position: { at: T0, origin: 'pc-a' }, watched: { at: T0, origin: 'pc-a' } }
        }
      }
    })
    register({ store } as unknown as AppDeps)
    const save = (ipcMain.handle as Mock).mock.calls.find(
      ([c]) => c === CHANNELS.WATCH_PROGRESS_SAVE
    )![1]
    vi.setSystemTime(T2)
    await save({}, 5, '3', 0, 1420, true, 77, 'choice')

    const a = projectSyncDoc(store, [5], { resolveEpisodeFile: () => null }).titles['5'].watch!['3']
      .position
    const b = f(pos(1200), T1, 'pc-b')

    expect(a).toEqual(f(pos(0), T0, 'pc-a'))
    expect(decidePosition(base, a, b)).toEqual({ kind: 'merge', value: b })
  })
})
