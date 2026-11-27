// The AniList drain (#703) through `createTrackerSyncService` with the real
// AniList provider, client and limiter against a stateful fixture account
// (`createAniListWorld`): changed-fields writes, the cold id map, an expired
// token, the API-down 403, and the score formats' round trips.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  ALICE,
  anilistFixture,
  createAniListWorld,
  createTestAniList,
  type AniListWorld,
  type WorldEntry
} from '../helpers/anilist-server'
import { createAniListSyncService } from '../../src/main/trackers/anilist/sync'
import type { TrackerItemSettled } from '../../src/main/services/trackers/sync'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import type { AnilistScoreFormat } from '../../src/main/trackers/scores'
import type { IdMapRecord } from '../../src/main/trackers/anilist/id-map'
import type { AniListCachedRow } from '../../src/main/trackers/anilist/provider'

let world: AniListWorld | null = null
afterEach(() => {
  world?.server.restore()
  world = null
})

const v = (
  episodes: number,
  score: number,
  status: RateValues['status'] = 'watching',
  rewatches = 0
): RateValues => ({ episodes, status, score, rewatches })

const queued = (
  malId: number,
  before: RateValues,
  after: RateValues,
  extra: Partial<QueuedTrackerUpdate> = {}
): QueuedTrackerUpdate => ({ malId, rateId: null, before, after, queuedAt: malId, ...extra })

const ENTRY: WorldEntry = {
  id: 9001,
  mediaId: 101,
  idMal: 1,
  status: 'CURRENT',
  score: 85,
  progress: 7,
  repeat: 0,
  updatedAt: 1
}

async function drainRig(opts: {
  entries?: WorldEntry[]
  media?: Record<number, number[]>
  queue?: QueuedTrackerUpdate[]
  scoreFormat?: AnilistScoreFormat
  provider?: NonNullable<Parameters<typeof createTestAniList>[0]>['provider']
}) {
  world = createAniListWorld({
    entries: opts.entries ?? [ENTRY],
    media: opts.media,
    scoreFormat: opts.scoreFormat
  })
  const t = await createTestAniList({
    user: { ...ALICE, scoreFormat: opts.scoreFormat ?? 'POINT_100' },
    seed: { anilistUpdateQueue: opts.queue ?? [] },
    provider: opts.provider
  })
  const broadcast = vi.fn()
  const sync = createAniListSyncService(t.provider, {
    store: t.store as never,
    broadcast,
    syncStatusChannel: 'status',
    offlineQueueChangedChannel: 'queue',
    rateUpdatedChannel: 'rate',
    ratesRefreshedChannel: 'refreshed'
  })
  const settled: TrackerItemSettled<unknown>[] = []
  sync.onItemSettled((e) => settled.push(e as TrackerItemSettled<unknown>))
  return { t, sync, broadcast, settled, world: world! }
}

describe('changed-fields writes', () => {
  it('an AniList POINT_100 85 is never rewritten by an episode bump', async () => {
    const r = await drainRig({ queue: [queued(1, v(7, 9), v(8, 9), { rateId: 9001 })] })
    await r.sync.drainNow()
    expect(r.world.saves()).toEqual([{ mediaId: 101, progress: 8 }])
    expect(r.world.saves()[0]).not.toHaveProperty('score')
    expect(r.world.saves()[0]).not.toHaveProperty('scoreRaw')
    expect(r.world.entries.get(101)).toMatchObject({ score: 85, progress: 8 })
    expect(r.t.store.get('anilistUpdateQueue')).toEqual([])
  })

  it('a changed score sends scoreRaw = appScore × 10', async () => {
    const r = await drainRig({ queue: [queued(1, v(7, 9), v(7, 6), { rateId: 9001 })] })
    await r.sync.drainNow()
    expect(r.world.saves()).toEqual([{ mediaId: 101, scoreRaw: 60 }])
  })

  it('the cache adopts what SaveMediaListEntry returns: its POINT_100 score and its id', async () => {
    const r = await drainRig({ queue: [] })
    await r.sync.refreshRates({ keepQueued: false })
    r.t.store.set('anilistUpdateQueue', [queued(1, v(7, 9), v(7, 5), { rateId: 9001 })])
    r.world.scoreFormat = 'POINT_10'
    // The server stores 50 and answers with a new list-entry id.
    r.world.entries.get(101)!.id = 9555
    await r.sync.drainNow()
    const row = (r.t.store.get('anilistUserRates') as AniListCachedRow[])[0]
    expect(row.entry).toMatchObject({ id: 9555, score: 50 })
    expect(r.broadcast.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['rate', 'queue'])
    )
    // The rate broadcast lands before the queue broadcast (#697's overlay).
    const names = r.broadcast.mock.calls
      .map((c) => c[0])
      .filter((n) => n === 'rate' || n === 'queue')
    expect(names.indexOf('rate')).toBeLessThan(names.lastIndexOf('queue'))
  })
})

describe('the cold id map', () => {
  it('an unmapped title, after a successful lookup that omits it, drops as item and records a negative entry', async () => {
    const r = await drainRig({ queue: [queued(2, v(0, 0, 'planned'), v(1, 0))] })
    await r.sync.drainNow()
    expect(r.t.store.get('anilistUpdateQueue')).toEqual([])
    expect(r.settled.map((e) => [e.malId, e.outcome])).toEqual([[2, 'dropped']])
    expect((r.t.store.get('anilistIdMap') as IdMapRecord)['2']).toMatchObject({ anilistId: null })
    expect(r.world.saves()).toEqual([])
  })

  it('the counterpart: a lookup that fails with network leaves the item queued and records no negative entry', async () => {
    const q = [queued(2, v(0, 0, 'planned'), v(1, 0))]
    const r = await drainRig({ queue: q })
    r.world.inject('IdMap', { throws: new TypeError('fetch failed') })
    await r.sync.drainNow()
    expect(r.t.store.get('anilistUpdateQueue')).toEqual(q)
    expect(r.settled).toEqual([])
    expect(r.t.store.get('anilistIdMap')).toEqual({})
  })

  it('a lookup that fails with a 5xx keeps it too, with no negative entry', async () => {
    const q = [queued(2, v(0, 0, 'planned'), v(1, 0))]
    const r = await drainRig({ queue: q })
    r.world.inject('IdMap', { status: 503, body: {} })
    await r.sync.drainNow()
    // Kept under the `server` policy (stamped for its 24 h window), not dropped.
    expect(
      (r.t.store.get('anilistUpdateQueue') as QueuedTrackerUpdate[]).map((e) => e.malId)
    ).toEqual([2])
    expect(r.settled).toEqual([])
    expect(r.t.store.get('anilistIdMap')).toEqual({})
  })
})

describe('an expired token', () => {
  it('stops the drain and keeps the queue; the session expires and later drains send nothing', async () => {
    const q = [
      queued(1, v(7, 9), v(8, 9), { rateId: 9001 }),
      queued(3, v(0, 0, 'planned'), v(1, 0))
    ]
    const r = await drainRig({
      entries: [ENTRY, { ...ENTRY, id: 9003, mediaId: 103, idMal: 3 }],
      queue: q
    })
    r.world.inject('MediaList', { status: 401, body: anilistFixture('invalid-token-401') })
    await r.sync.drainNow()
    expect(r.t.store.get('anilistUpdateQueue')).toEqual(q)
    expect(r.world.server.of('MediaList')).toHaveLength(1)
    await vi.waitFor(() => expect(r.t.store.get('anilistCredentials')).toBeNull())
    expect(r.t.store.get('anilistSessionExpired')).toBe(true)
    expect(r.sync.getSyncStatus()).toMatchObject({ sessionExpired: true, queueLength: 2 })
    const before = r.world.server.calls.length
    await r.sync.drainNow()
    expect(r.world.server.calls.length).toBe(before)
  })
})

describe('the API is down (403)', () => {
  it('aborts and keeps every entry: three queued, the first MediaList answered 403', async () => {
    const entries = [1, 2, 3].map((n) => ({ ...ENTRY, id: 9000 + n, mediaId: 100 + n, idMal: n }))
    const q = [1, 2, 3].map((n) => queued(n, v(7, 9), v(8, 9), { rateId: 9000 + n }))
    const r = await drainRig({ entries, queue: q })
    r.world.inject('MediaList', { status: 403, body: anilistFixture('api-down-403') })
    await r.sync.drainNow()
    expect(r.t.store.get('anilistUpdateQueue')).toHaveLength(3)
    expect(r.settled.filter((e) => e.outcome === 'dropped')).toEqual([])
    // Nothing else was sent: no other item's read, and no write.
    expect(r.world.server.of('MediaList')).toHaveLength(1)
    expect(r.world.saves()).toEqual([])
    expect(r.sync.getSyncStatus().lastSyncError).toBe('AniList rate limit — will retry')
  })
})

describe('score formats: every read is POINT_100, the format only sets the precision', () => {
  // A stored raw on each format's own step, and the app score it reads as.
  const CASES: [AnilistScoreFormat, number, number][] = [
    ['POINT_100', 85, 9],
    ['POINT_10_DECIMAL', 85, 9],
    ['POINT_10', 80, 8],
    ['POINT_5', 80, 8],
    ['POINT_3', 85, 9]
  ]

  for (const [format, raw, app] of CASES) {
    it(`${format}: an unchanged app score is no change — a mirror item sends nothing, an episode bump sends progress only`, async () => {
      const r = await drainRig({
        scoreFormat: format,
        entries: [{ ...ENTRY, score: raw }],
        queue: [
          queued(1, v(7, app), v(7, app), { rateId: 9001, via: 'mirror', fields: ['score'] }),
          queued(1, v(7, app), v(8, app), { rateId: 9001, queuedAt: 10 })
        ]
      })
      await r.sync.drainNow()
      expect(r.world.saves()).toEqual([{ mediaId: 101, progress: 8 }])
      expect(r.world.entries.get(101)!.score).toBe(raw)
    })
  }

  for (const [format, stored] of [
    ['POINT_5', 80],
    ['POINT_3', 85]
  ] as const) {
    it(`${format}: a lossy write reads back at the scale’s step, the cache holds it, and a second drain sends nothing`, async () => {
      const r = await drainRig({ scoreFormat: format, entries: [{ ...ENTRY, score: 60 }] })
      await r.sync.refreshRates({ keepQueued: false })
      r.t.store.set('anilistUpdateQueue', [
        queued(1, v(7, 6), v(7, 7), { rateId: 9001, fields: ['score'] })
      ])
      await r.sync.drainNow()
      expect(r.world.saves()).toEqual([{ mediaId: 101, scoreRaw: 70 }])
      expect(r.world.entries.get(101)!.score).toBe(stored)
      const read = r.sync.cachedRate(1)!
      expect(read.values.score).toBe(Math.round(stored / 10))
      expect((r.t.store.get('anilistUserRates') as AniListCachedRow[])[0].entry.score).toBe(stored)
      await r.sync.drainNow()
      expect(r.world.saves()).toHaveLength(1)
    })
  }
})
