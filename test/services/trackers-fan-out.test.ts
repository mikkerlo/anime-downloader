// The fan-out writer (#692): `applyChange` with Shikimori's real primary
// branch against `fake-shikimori.ts`, and AniList / MyAnimeList mirrors from
// `fake-tracker.ts` behind the generic sync service.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { register } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { ShikiApiError } from '../../src/main/shikimori'
import { T0, fakeApi, iso, server } from '../helpers/fake-shikimori'
import { createFakeTracker, UNMAPPED_MAL_ID, type FakeTracker } from '../helpers/fake-tracker'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import {
  createTrackerSyncService,
  type TrackerSyncService
} from '../../src/main/services/trackers/sync'
import { createTrackerFanOut, type PrimaryWriter } from '../../src/main/services/trackers/fan-out'
import { createShikimoriPrimary } from '../../src/main/services/trackers/shikimori-primary'
import { ANILIST_KEYS, MYANIMELIST_KEYS } from '../../src/main/trackers/keys'
import { testRateCodec } from '../helpers/test-rate-codec'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { trackerAccounts } from '../helpers/tracker-fan-out'
import { NO_RATE_BEFORE, type RateValues } from '../../src/main/lib/shikimori-rate'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'

const T = Date.UTC(2026, 10, 1)
const SHIKI_USER = { id: 7, nickname: 'me' }

const rv = (
  episodes: number,
  score = 7,
  status: RateValues['status'] = 'watching',
  rewatches = 0
): RateValues => ({ episodes, status, score, rewatches })

/** The rate cache the AniList and MAL personalities use here; T6/T7 bring the real ones. */
const testCodec = testRateCodec()

const shikiRow = (malId: number, v: RateValues) => ({
  rate: { id: malId * 10, target_id: malId, ...v, updated_at: iso(T0) },
  shikiAnime: { id: malId, name: `#${malId}` },
  smotretAnime: null
})

type Svc = TrackerSyncService<unknown, unknown>

function rig() {
  const store = new InMemoryStorage({
    installId: 'pc',
    shikimoriUser: SHIKI_USER,
    shikimoriCredentials: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' },
    shikimoriUserRates: [],
    shikimoriUpdateQueue: [],
    shikimoriParkedQueues: {},
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [{ malId: 99 }],
    anilistCredentials: { v: 1, enc: 'plain', data: 'blob' },
    anilistUser: { id: 1, nickname: 'al', avatar: null },
    anilistUserRates: [],
    anilistUpdateQueue: [],
    anilistParkedQueues: {},
    myanimelistCredentials: null,
    myanimelistUser: null,
    myanimelistUserRates: [],
    myanimelistUpdateQueue: [],
    myanimelistParkedQueues: {},
    trackerPrimary: 'shikimori',
    trackerMirror: {},
    syncMeta: { titles: {}, rates: {} }
  })
  const events: unknown[][] = []
  const broadcast = (channel: string, ...args: unknown[]) => events.push([channel, ...args])
  const offline = { shikimori: false, anilist: true, mal: true }
  const shiki = createShikimoriSyncService({
    store: store as never,
    broadcast,
    syncStatusChannel: 'shiki:status',
    offlineQueueChangedChannel: 'shiki:queue',
    rateUpdatedChannel: 'shiki:rate',
    animeDetailsUpdatedChannel: 'shiki:details',
    ratesRefreshedChannel: 'shiki:refreshed',
    isOffline: () => offline.shikimori
  })
  function generic<P extends 'anilist' | 'mal'>(id: P, fake: FakeTracker<P>): Svc {
    return createTrackerSyncService(
      {
        ...fake.provider,
        rateCache: testCodec,
        isSessionGone: () => false,
        hasTitle: (malId: number) => malId !== UNMAPPED_MAL_ID
      } as never,
      id === 'anilist' ? ANILIST_KEYS : MYANIMELIST_KEYS,
      {
        store: store as never,
        broadcast,
        syncStatusChannel: `${id}:status`,
        offlineQueueChangedChannel: `${id}:queue`,
        rateUpdatedChannel: `${id}:rate`,
        ratesRefreshedChannel: `${id}:refreshed`,
        isOffline: () => offline[id],
        onRateUpdated: (trackerId, malId) => events.push(['hook', trackerId, malId])
      }
    ) as Svc
  }
  const alFake = createFakeTracker('anilist')
  const malFake = createFakeTracker('mal')
  const anilist = generic('anilist', alFake)
  const mal = generic('mal', malFake)
  const cleanup = vi.fn(async () => {})
  const refresh = vi.fn()
  const primary = createShikimoriPrimary({
    store: store as never,
    sync: shiki,
    broadcast,
    rateUpdatedChannel: 'shiki:rate',
    offlineQueueChangedChannel: 'shiki:queue',
    maybeBroadcastCleanupPrompt: cleanup,
    invalidateRecommendations: () => shiki.invalidateRecommendations(),
    refreshRatesInBackground: refresh
  })
  // AniList's primary branch is T7's; a queued unscoped user entry stands in.
  const anilistPrimary: PrimaryWriter = async (malId, change) => {
    if (change.kind !== 'set') throw new Error('set only')
    const cached = anilist.cachedRate(malId)
    const basis = cached?.values ?? NO_RATE_BEFORE
    anilist.enqueue({
      malId,
      rateId: cached?.remoteId ?? null,
      before: basis,
      after: change.values,
      queuedAt: Date.now()
    })
    return { result: null, basis, after: change.values }
  }
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [
      { sync: shiki.tracker as Svc },
      { sync: anilist, writePrimary: anilistPrimary },
      { sync: mal }
    ],
    log: { warn: () => {} }
  })
  fan.setPrimaryWriter('shikimori', primary.write)

  const set = (target: TrackerId, malId: number, values: RateValues) =>
    fan.applyChange(malId, { kind: 'set', values }, { target, cause: 'user' })
  const mark = (malId: number, episode: number) =>
    fan.applyChange(
      malId,
      { kind: 'mark-watched', episode },
      { target: 'shikimori', cause: 'user' }
    )
  const queueOf = (id: TrackerId) =>
    store.get(
      id === 'shikimori'
        ? 'shikimoriUpdateQueue'
        : id === 'anilist'
          ? ANILIST_KEYS.updateQueue
          : MYANIMELIST_KEYS.updateQueue
    ) as QueuedTrackerUpdate[]
  const cacheOf = (id: 'shikimori' | 'anilist', malId: number) =>
    (id === 'shikimori' ? (shiki.tracker as Svc) : anilist).cachedRate(malId)?.values
  return {
    store,
    events,
    offline,
    shiki,
    shikiSvc: shiki.tracker as Svc,
    anilist,
    mal,
    alFake,
    malFake,
    fan,
    cleanup,
    refresh,
    set,
    mark,
    queueOf,
    cacheOf,
    shikiCache(...rows: [number, RateValues][]) {
      store.set(
        'shikimoriUserRates',
        rows.map(([m, v]) => shikiRow(m, v))
      )
    },
    alCache(...rows: [number, RateValues][]) {
      store.set(
        ANILIST_KEYS.userRates,
        rows.map(([malId, values]) => ({
          malId,
          remoteId: malId * 1000,
          values,
          updated_at: 'listed'
        }))
      )
    },
    primary: (id: TrackerId) => store.set('trackerPrimary', id),
    rateKeys: () => Object.keys((store.get('syncMeta') as SyncMeta).rates)
  }
}

/** One drain run, with the inter-item delays played out. */
async function drain(svc: { syncQueue(): Promise<void> }): Promise<void> {
  const run = svc.syncQueue()
  await vi.advanceTimersByTimeAsync(5_000)
  await run
}

const offlineOnce = () =>
  fakeApi.ensureFreshToken.mockRejectedValueOnce(new TypeError('fetch failed'))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T)
  server.reset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mirror entries send only what the user changed', () => {
  it('AniList at POINT_100 85 and episodes 7: a Shikimori episode bump sends episodes only, and 85 stays 85', async () => {
    const r = rig()
    server.set(1, { episodes: 7, score: 9 })
    r.shikiCache([1, rv(7, 9)])
    r.alFake.set(1, { episodes: 7, status: 'watching', score: 9 }, { scoreRaw: 85 })
    r.alCache([1, rv(7, 9)])

    await r.set('shikimori', 1, rv(8, 9))

    expect(server.get(1)!.episodes).toBe(8)
    expect(r.queueOf('anilist')).toMatchObject([
      { malId: 1, fields: ['episodes'], via: 'mirror', before: rv(7, 9), after: rv(8, 9) }
    ])
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.upserts.map((u) => u.changedFields)).toEqual([['episodes']])
    expect(r.alFake.rows.get(1)!.scoreRaw).toBe(85)
    expect(r.queueOf('anilist')).toEqual([])
  })

  it('an empty changedFields makes no call and queues nothing: the mirror already has the value', async () => {
    const r = rig()
    server.set(1, { episodes: 7 })
    r.shikiCache([1, rv(7)])
    r.alCache([1, rv(8)])
    r.alFake.set(1, rv(8))

    await r.set('shikimori', 1, rv(8))

    expect(r.queueOf('anilist')).toEqual([])
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.upserts).toEqual([])
  })

  it('a title that is not on the mirror, a mirror toggled off, and an unconnected tracker get nothing', async () => {
    const r = rig()
    server.set(UNMAPPED_MAL_ID, { episodes: 1 })
    server.set(2, { episodes: 1 })
    r.store.set('trackerMirror', { anilist: false })
    await r.set('shikimori', 2, rv(2))
    r.store.set('trackerMirror', {})
    await r.set('shikimori', UNMAPPED_MAL_ID, rv(2))
    expect(r.queueOf('anilist')).toEqual([])
    expect(r.queueOf('mal')).toEqual([])
  })

  it('the mirror toggle is read after the primary’s request: switched off mid-request, no entry', async () => {
    const r = rig()
    server.set(1, { episodes: 7 })
    r.alCache([1, rv(7)])
    fakeApi.getUserRate.mockImplementationOnce(async () => {
      r.store.set('trackerMirror', { anilist: false })
      return { id: 10, target_id: 1, target_type: 'Anime', ...rv(7) } as never
    })
    await r.set('shikimori', 1, rv(8))
    expect(server.get(1)!.episodes).toBe(8)
    expect(r.queueOf('anilist')).toEqual([])
  })
})

describe('mark-watched decides on each tracker’s own rate (primary at watching 4, episode 5)', () => {
  it('a mirror at completed starts a rewatch from its own count', async () => {
    const r = rig()
    server.set(1, { episodes: 4 })
    r.alCache([1, rv(12, 7, 'completed', 1)])
    await r.mark(1, 5)
    expect(server.get(1)!.episodes).toBe(5)
    expect(r.queueOf('anilist')).toMatchObject([
      {
        before: rv(12, 7, 'completed', 1),
        after: rv(5, 7, 'rewatching', 2),
        fields: ['episodes', 'status', 'rewatches'],
        via: 'mirror'
      }
    ])
  })

  it('a mirror already past the episode gets nothing', async () => {
    const r = rig()
    server.set(1, { episodes: 4 })
    r.alCache([1, rv(9)])
    await r.mark(1, 5)
    expect(server.get(1)!.episodes).toBe(5)
    expect(r.queueOf('anilist')).toEqual([])
  })

  it('a mirror with no row creates at watching, episode N, from nextWatchedRate(NO_RATE_BEFORE, N)', async () => {
    const r = rig()
    server.set(1, { episodes: 4 })
    await r.mark(1, 5)
    expect(r.queueOf('anilist')).toMatchObject([
      {
        before: NO_RATE_BEFORE,
        after: rv(5, 0, 'watching'),
        fields: ['episodes', 'status'],
        via: 'mirror'
      }
    ])
  })
})

describe('no mirror entry when the primary refuses (§ 1)', () => {
  function expectNoMirror(r: ReturnType<typeof rig>) {
    expect(r.queueOf('anilist')).toEqual([])
    expect(r.rateKeys().filter((k) => k.startsWith('anilist:'))).toEqual([])
  }

  it('UPDATE_RATE: a non-queueable error is rethrown', async () => {
    const r = rig()
    r.shikiCache([1, rv(7)])
    r.alCache([1, rv(7)])
    fakeApi.getUserRate.mockRejectedValueOnce(new ShikiApiError('bad', 422))
    await expect(r.set('shikimori', 1, rv(8))).rejects.toThrow('bad')
    expectNoMirror(r)
  })

  it('UPDATE_RATE: a queueable error with no cached entry is rethrown', async () => {
    const r = rig()
    r.alCache([1, rv(7)])
    offlineOnce()
    await expect(r.set('shikimori', 1, rv(8))).rejects.toThrow('fetch failed')
    expectNoMirror(r)
  })

  it('UPDATE_RATE: not logged in', async () => {
    const r = rig()
    r.store.set('shikimoriUser', null)
    r.alCache([1, rv(7)])
    await expect(r.set('shikimori', 1, rv(8))).rejects.toThrow('Not logged in to Shikimori')
    expectNoMirror(r)
  })

  it('mark-watched: a non-queueable error on the read, and on the send', async () => {
    const r = rig()
    server.set(1, { episodes: 4 })
    r.alCache([1, rv(4)])
    fakeApi.getUserRate.mockRejectedValueOnce(new ShikiApiError('read', 422))
    await expect(r.mark(1, 5)).rejects.toThrow('read')
    server.writeError = new ShikiApiError('write', 422)
    await expect(r.mark(1, 5)).rejects.toThrow('write')
    expectNoMirror(r)
  })

  it('mark-watched: nextWatchedRate null offline, and an invalid episode', async () => {
    const r = rig()
    r.shikiCache([1, rv(10)])
    r.alCache([1, rv(12, 7, 'completed')])
    offlineOnce()
    expect(await r.mark(1, 5)).toEqual({ kind: 'primary', result: null })
    expect(await r.mark(1, 0)).toEqual({ kind: 'primary', result: null })
    expectNoMirror(r)
  })

  it('mark-watched online null: the primary at watching 10 re-marks 5; a completed mirror starts no rewatch', async () => {
    const r = rig()
    server.set(1, { episodes: 10 })
    r.alCache([1, rv(12, 7, 'completed')])
    expect(await r.mark(1, 5)).toEqual({ kind: 'primary', result: null })
    expectNoMirror(r)
  })
})

describe('clocks, the prompt and failure isolation', () => {
  it('each target tracker’s clock is stamped, and the cleanup prompt fires once', async () => {
    const r = rig()
    server.set(1, { episodes: 7 })
    r.shikiCache([1, rv(7)])
    r.alCache([1, rv(7)])
    await r.set('shikimori', 1, rv(8))
    expect(r.rateKeys().sort()).toEqual(['7:1', 'anilist:1:1'])
    expect(r.cleanup).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['auth', 'anilist'],
    ['network', 'anilist'],
    ['config', 'mal']
  ] as const)(
    'a mirror whose upsertEntry throws %s: the primary returns its result and the mirror keeps its entry',
    async (reply, id) => {
      const r = rig()
      if (id === 'mal') {
        r.store.set('myanimelistCredentials', { v: 1, enc: 'plain', data: 'blob' })
        r.store.set('myanimelistUser', { id: 1, nickname: 'm', avatar: null })
        r.store.set('trackerMirror', { anilist: false })
      }
      const fake = id === 'mal' ? r.malFake : r.alFake
      const svc = id === 'mal' ? r.mal : r.anilist
      fake.set(1, rv(7))
      r.store.set(id === 'mal' ? MYANIMELIST_KEYS.userRates : ANILIST_KEYS.userRates, [
        { malId: 1, remoteId: 1, values: rv(7), updated_at: 'listed' }
      ])
      server.set(1, { episodes: 7 })
      fake.fail(reply as never, { member: 'upsertEntry' })
      r.offline[id] = false

      // The enqueue kicks the mirror's drain, which meets the failure.
      const result = await r.set('shikimori', 1, rv(8))
      await vi.advanceTimersByTimeAsync(5_000)

      expect(result).toMatchObject({
        kind: 'primary',
        result: { id: 10, target_id: 1, episodes: 8 }
      })
      expect(server.get(1)!.episodes).toBe(8)
      expect(r.queueOf(id)).toHaveLength(1)
      expect(fake.upserts).toHaveLength(1)
      svc.stopSyncTimer()
    }
  )

  it("a mirror write is never mirrored again: a settled mirror item, and 'mirror' and 'reconcile' changes, write nothing elsewhere", async () => {
    const r = rig()
    server.set(1, { episodes: 7 })
    r.shikiCache([1, rv(7)])
    r.alFake.set(1, rv(7))
    r.alCache([1, rv(7)])
    await r.set('shikimori', 1, rv(8))
    const writes = fakeApi.updateUserRate.mock.calls.length
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.rows.get(1)!.values.episodes).toBe(8)
    r.offline.anilist = true
    await r.fan.applyChange(
      1,
      { kind: 'set', values: rv(9) },
      { target: 'anilist', cause: 'mirror' }
    )
    await r.fan.applyChange(
      1,
      { kind: 'set', values: rv(10) },
      { target: 'anilist', cause: 'reconcile' }
    )
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.rows.get(1)!.values.episodes).toBe(10)
    expect(fakeApi.updateUserRate.mock.calls.length).toBe(writes)
    expect(r.queueOf('shikimori')).toEqual([])
    r.anilist.stopSyncTimer()
  })

  it("a 'mirror' change keeps a carried provenance: via 'mirror', no resolvedFields, no clock", async () => {
    const r = rig()
    r.alCache([1, rv(5)])
    const origin = { kind: 'sync-merge' as const, provenance: { episodes: { libraryId: 'K' } } }
    await r.fan.applyChange(
      1,
      { kind: 'set', values: rv(6), fields: ['episodes'], origin },
      { target: 'anilist', cause: 'mirror' }
    )
    const [entry] = r.queueOf('anilist')
    expect(entry).toMatchObject({ fields: ['episodes'], origin, via: 'mirror' })
    expect('resolvedFields' in entry).toBe(false)
    expect(r.rateKeys()).toEqual([])
  })

  it("a 'merge' change is refused: the merge leg keeps writing through mergeQueues", async () => {
    const r = rig()
    await expect(
      r.fan.applyChange(1, { kind: 'set', values: rv(6) }, { target: 'shikimori', cause: 'merge' })
    ).rejects.toThrow(/merge leg/)
  })
})

describe('the projection (§ 3)', () => {
  it('two offline edits to an AniList mirror (episode 8, then score 9) both arrive', async () => {
    const r = rig()
    server.set(1, { episodes: 7, score: 8 })
    r.shikiCache([1, rv(7, 8)])
    r.alFake.set(1, rv(7, 8), { scoreRaw: 75 })
    r.alCache([1, rv(7, 8)])

    await r.set('shikimori', 1, rv(8, 8))
    // A keepQueued: false refresh puts the cached row back to the server's.
    r.alCache([1, rv(7, 8)])
    await r.set('shikimori', 1, rv(8, 9))

    expect(r.queueOf('anilist').map((q) => [q.fields, q.before, q.after])).toEqual([
      [['episodes'], rv(7, 8), rv(8, 8)],
      [['score'], rv(8, 8), rv(8, 9)]
    ])
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.rows.get(1)!.values.episodes).toBe(8)
    expect(r.alFake.rows.get(1)!.scoreRaw).toBe(90)
  })

  it('does not see a refreshed-over value: a copy, a refresh to score 9, then a primary score edit lands', async () => {
    const r = rig()
    server.set(1, { episodes: 8, score: 7 })
    r.shikiCache([1, rv(8, 7)])
    r.alCache([1, rv(5, 7)])
    await r.set('anilist', 1, rv(8, 7))
    // A list refresh caches the site's score 9; the fake has 5 / 9.
    r.alFake.set(1, rv(5, 9))
    r.alCache([1, rv(5, 9)])
    await r.set('shikimori', 1, rv(8, 10))
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.rows.get(1)!.values).toMatchObject({ episodes: 8, score: 10 })
  })

  it('a mirror with no row gets the primary’s four values on a set', async () => {
    const r = rig()
    server.set(1, { episodes: 12, status: 'completed', score: 7 })
    r.shikiCache([1, rv(12, 7, 'completed')])
    await r.set('shikimori', 1, rv(12, 8, 'completed'))
    expect(r.queueOf('anilist')).toMatchObject([
      {
        before: NO_RATE_BEFORE,
        after: rv(12, 8, 'completed'),
        fields: ['episodes', 'status', 'score', 'rewatches'],
        via: 'mirror'
      }
    ])
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.rows.get(1)!.values).toEqual(rv(12, 8, 'completed'))
  })

  it('the same entry does not overwrite a row the projection missed', async () => {
    const r = rig()
    server.set(1, { episodes: 12, status: 'completed', score: 7 })
    r.shikiCache([1, rv(12, 7, 'completed')])
    r.alFake.set(1, rv(5, 7, 'watching'))
    await r.set('shikimori', 1, rv(12, 8, 'completed'))
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.rows.get(1)!.values).toEqual(rv(5, 7, 'watching'))
  })
})

describe('via items on the drain', () => {
  it('a leftover via entry on a tracker that became primary drains first, then the user entry; settles report their own via', async () => {
    const r = rig()
    server.set(1, { episodes: 5 })
    r.shikiCache([1, rv(5)])
    r.alFake.set(1, rv(5))
    r.alCache([1, rv(5)])
    await r.set('shikimori', 1, rv(6))
    r.primary('anilist')
    await r.set('anilist', 1, rv(8))
    expect(r.queueOf('anilist').map((q) => [q.via, q.fields])).toEqual([
      ['mirror', ['episodes']],
      [undefined, undefined]
    ])
    const settled: { via?: string; malId: number }[] = []
    r.anilist.onItemSettled((e) => settled.push(e))
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.upserts.map((u) => u.values.episodes)).toEqual([6, 8])
    expect(settled.map((e) => e.via)).toEqual(['mirror', undefined])
    expect(r.alFake.rows.get(1)!.values.episodes).toBe(8)
  })

  it('variant: the primary edit is already on the server (8); the leftover via entry’s scoped drift check keeps 8', async () => {
    const r = rig()
    server.set(1, { episodes: 5 })
    r.shikiCache([1, rv(5)])
    r.alCache([1, rv(5)])
    await r.set('shikimori', 1, rv(6))
    r.alFake.set(1, rv(8))
    r.offline.anilist = false
    await drain(r.anilist)
    expect(r.alFake.rows.get(1)!.values.episodes).toBe(8)
    expect(r.queueOf('anilist')).toEqual([])
  })
})

describe('the enqueue cache patch (§ 3)', () => {
  it('stale basis after a switch: the mirror’s cache reads 6, so the score-only edit after the switch lands', async () => {
    const r = rig()
    r.primary('anilist')
    server.set(1, { episodes: 5, score: 7 })
    r.shikiCache([1, rv(5, 7)])
    r.alCache([1, rv(5, 7)])
    r.offline.shikimori = true
    await r.set('anilist', 1, rv(6, 7))
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(6, 7))

    r.primary('shikimori')
    offlineOnce()
    const episodes = r.cacheOf('shikimori', 1)!.episodes
    await r.set('shikimori', 1, rv(episodes, 9))
    r.offline.shikimori = false
    await drain(r.shiki.tracker as Svc)
    expect(server.get(1)).toMatchObject({ episodes: 6, score: 9 })
  })

  it('§ 3a patch: a copy to Shikimori is in its cache before any drain, and a score edit after the switch lands too', async () => {
    const r = rig()
    r.primary('anilist')
    server.set(1, { episodes: 5, score: 7 })
    r.shikiCache([1, rv(5, 7)])
    r.offline.shikimori = true
    await r.set('shikimori', 1, rv(8, 7))
    expect(r.queueOf('shikimori')).toMatchObject([{ via: 'copy', fields: ['episodes'] }])
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(8, 7))

    r.primary('shikimori')
    offlineOnce()
    await r.set('shikimori', 1, rv(r.cacheOf('shikimori', 1)!.episodes, 9))
    r.offline.shikimori = false
    await drain(r.shiki.tracker as Svc)
    expect(server.get(1)).toMatchObject({ episodes: 8, score: 9 })
  })

  it("a 'reconcile' winner patches the target's cached row", async () => {
    const r = rig()
    r.alCache([1, rv(5)])
    await r.fan.applyChange(
      1,
      { kind: 'set', values: rv(8) },
      { target: 'anilist', cause: 'reconcile' }
    )
    expect(r.queueOf('anilist')).toMatchObject([{ via: 'reconcile', fields: ['episodes'] }])
    expect(r.cacheOf('anilist', 1)).toEqual(rv(8))
  })

  it('the order: onRateUpdated, then the rate broadcast with the patched row, then the queue; no recommendations wipe, no prompt', async () => {
    const r = rig()
    r.alCache([1, rv(5)])
    r.shikiCache([2, rv(5)])
    r.primary('anilist')
    r.events.length = 0
    await r.fan.applyChange(
      1,
      { kind: 'set', values: rv(6) },
      { target: 'anilist', cause: 'mirror' }
    )
    expect(r.events.map((e) => e[0])).toEqual(['hook', 'anilist:rate', 'anilist:queue'])
    expect(r.events[0]).toEqual(['hook', 'anilist', 1])
    expect(r.events[1][1]).toMatchObject({ malId: 1, values: rv(6) })

    r.events.length = 0
    r.offline.shikimori = true
    await r.fan.applyChange(
      2,
      { kind: 'set', values: rv(6) },
      { target: 'shikimori', cause: 'mirror' }
    )
    expect(r.events.map((e) => e[0])).toEqual(['shiki:rate', 'shiki:queue'])
    expect(r.store.get('shikimoriRecommendations')).toEqual([{ malId: 99 }])
    expect(r.cleanup).not.toHaveBeenCalled()
  })
})

describe('the non-primary user change (§ 3a, "Copy from primary")', () => {
  it('queues only what differs from the target, as via copy, never live, with only the target’s clock', async () => {
    const r = rig()
    server.set(1, { episodes: 8, score: 9 })
    r.shikiCache([1, rv(8, 9)])
    r.alFake.set(1, rv(7, 9), { scoreRaw: 85 })
    r.alCache([1, rv(7, 9)])
    const shikiWrites = fakeApi.updateUserRate.mock.calls.length

    await r.set('anilist', 1, r.cacheOf('shikimori', 1)!)
    // Any request the change started would have reached the fake by now.
    await vi.advanceTimersByTimeAsync(0)

    expect(r.queueOf('anilist')).toHaveLength(1)
    expect(r.queueOf('anilist')[0]).toMatchObject({
      fields: ['episodes'],
      after: { episodes: 8 },
      via: 'copy'
    })
    expect(r.alFake.upserts).toEqual([])
    expect(r.queueOf('shikimori')).toEqual([])
    expect(fakeApi.updateUserRate.mock.calls.length).toBe(shikiWrites)
    expect(r.rateKeys()).toEqual(['anilist:1:1'])
    expect(r.cleanup).not.toHaveBeenCalled()
  })

  it('an equal copy queues nothing, stamps no clock and makes no call', async () => {
    const r = rig()
    r.shikiCache([1, rv(8, 9)])
    r.alCache([1, rv(8, 9)])
    expect(await r.set('anilist', 1, rv(8, 9))).toEqual({ kind: 'queued', entry: null })
    expect(r.queueOf('anilist')).toEqual([])
    expect(r.rateKeys()).toEqual([])
    expect(r.alFake.upserts).toEqual([])
  })

  it('a copy to a target with no row is the create branch: all four fields from NO_RATE_BEFORE', async () => {
    const r = rig()
    await r.set('anilist', 1, rv(8, 9))
    expect(r.queueOf('anilist')).toMatchObject([
      {
        before: NO_RATE_BEFORE,
        after: rv(8, 9),
        fields: ['episodes', 'status', 'score', 'rewatches']
      }
    ])
  })
})

describe('discardQueue (§ 7)', () => {
  /** AniList primary, a Shikimori mirror cached at `start`, every queue offline. */
  function shikiMirror(start: RateValues, ...more: [number, RateValues][]) {
    const r = rig()
    r.primary('anilist')
    r.offline.shikimori = true
    server.set(1, start)
    r.shikiCache([1, start], ...more)
    r.alCache([1, start], ...more)
    return r
  }
  const bump = (r: ReturnType<typeof rig>, v: RateValues) => {
    r.alCache([1, r.cacheOf('anilist', 1) ?? v])
    return r.set('anilist', 1, v)
  }
  const copy = (r: ReturnType<typeof rig>, v: RateValues) => r.set('shikimori', 1, v)
  const winner = (r: ReturnType<typeof rig>, v: RateValues) =>
    r.fan.applyChange(1, { kind: 'set', values: v }, { target: 'shikimori', cause: 'reconcile' })
  const rateBroadcasts = (r: ReturnType<typeof rig>) =>
    r.events.filter((e) => e[0] === 'shiki:rate').length

  it('keeps owner-leg entries, copies, reconcile winners and parked queues; removes exactly the mirror entries', async () => {
    const r = shikiMirror(rv(5))
    const leg = {
      malId: 3,
      rateId: 30,
      before: rv(1),
      after: rv(2),
      queuedAt: 1,
      fields: ['episodes'],
      origin: { kind: 'sync-merge', provenance: { episodes: { libraryId: 'K' } } }
    }
    r.store.set('shikimoriUpdateQueue', [leg])
    const parked = { '9': { nickname: 'x', entries: [{ ...leg, via: 'mirror' }], parkedAt: 1 } }
    r.store.set('shikimoriParkedQueues', parked)
    await bump(r, rv(6))
    await copy(r, rv(6, 9))
    await winner(r, rv(7, 9))
    await bump(r, rv(8, 9))
    expect(r.fan.mirrorQueueCount('shikimori')).toBe(2)

    expect(await r.fan.discardQueue('shikimori')).toBe(2)

    expect(r.queueOf('shikimori').map((q) => q.via)).toEqual([undefined, 'copy', 'reconcile'])
    expect(r.queueOf('shikimori')[0]).toEqual(leg)
    expect(r.store.get('shikimoriParkedQueues')).toEqual(parked)
    expect(r.events.at(-1)).toEqual(['shiki:queue', { length: 3 }])
  })

  it('the cache goes back, locally: no refresh, one patch with its hook and broadcast', async () => {
    const r = shikiMirror(rv(5))
    await bump(r, rv(6))
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(6))
    r.shiki.setCachedCalendar([], SHIKI_USER.id)
    const before = rateBroadcasts(r)

    await r.fan.discardQueue('shikimori')

    expect(r.cacheOf('shikimori', 1)).toEqual(rv(5))
    expect(r.refresh).not.toHaveBeenCalled()
    expect(fakeApi.getUserAnimeRates).not.toHaveBeenCalled()
    expect(rateBroadcasts(r) - before).toBe(1)
    expect(r.shiki.getCachedCalendar()?.invalidated).toBe(true)
  })

  it('kept entries keep their patch: a second title’s copy still reads the copied values', async () => {
    const r = shikiMirror(rv(5), [2, rv(3)])
    server.set(2, rv(3))
    await bump(r, rv(6))
    await r.set('shikimori', 2, rv(4))
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 2)).toEqual(rv(4))
  })

  it('chained mirror entries 5 → 6 → 7, both dropped: the cache reads 5', async () => {
    const r = shikiMirror(rv(5))
    await bump(r, rv(6))
    await bump(r, rv(7))
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(5))
  })

  it('other fields survive the revert: episodes back to 5, the copy’s score 9 kept', async () => {
    const r = shikiMirror(rv(5, 7))
    await bump(r, rv(6, 7))
    await copy(r, rv(6, 9))
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(5, 9))
  })

  it('a surviving later copy wins, and drains 5 → 8 once online', async () => {
    const r = shikiMirror(rv(5))
    await bump(r, rv(6))
    await copy(r, rv(8))
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(8))
    r.offline.shikimori = false
    await drain(r.shikiSvc)
    expect(server.get(1)!.episodes).toBe(8)
  })

  it('a surviving later reconcile winner wins, and drains 5 → 8 once online', async () => {
    const r = shikiMirror(rv(5))
    await bump(r, rv(6))
    await winner(r, rv(8))
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(8))
    r.offline.shikimori = false
    await drain(r.shikiSvc)
    expect(server.get(1)!.episodes).toBe(8)
  })

  it('a surviving earlier copy wins: copy 5 → 7, mirror 7 → 8, the cache reads 7', async () => {
    const r = shikiMirror(rv(5))
    await copy(r, rv(7))
    await bump(r, rv(8))
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(7))
  })

  it('a survivor between two dropped entries (5 → 6, winner 6 → 7, 7 → 8): the cache reads 7, and the fake ends at 7', async () => {
    const r = shikiMirror(rv(5))
    await bump(r, rv(6))
    await winner(r, rv(7))
    await bump(r, rv(8))
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(7))
    r.offline.shikimori = false
    await drain(r.shikiSvc)
    expect(server.get(1)!.episodes).toBe(7)
  })

  it('no cached row: a queued no-row create is dropped and the cache is byte-identical', async () => {
    const r = rig()
    r.primary('anilist')
    r.offline.shikimori = true
    r.shikiCache([2, rv(3)])
    const bytes = JSON.stringify(r.store.get('shikimoriUserRates'))
    await r.set('anilist', 1, rv(4))
    expect(r.queueOf('shikimori')).toMatchObject([{ via: 'mirror', before: NO_RATE_BEFORE }])
    expect(await r.fan.discardQueue('shikimori')).toBe(1)
    expect(JSON.stringify(r.store.get('shikimoriUserRates'))).toBe(bytes)
  })

  it('a refresh after the drop target leaves the field alone (step 2): 9 stays, no patch', async () => {
    const r = shikiMirror(rv(5))
    await bump(r, rv(6))
    r.shikiCache([1, rv(9)])
    const before = rateBroadcasts(r)
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(9))
    expect(rateBroadcasts(r)).toBe(before)
  })

  it('a later survivor under drift is left alone (step 1): reset to 5, the cache reads 5', async () => {
    const r = shikiMirror(rv(5))
    await bump(r, rv(6))
    await copy(r, rv(8))
    r.shikiCache([1, rv(5)])
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(5))
  })

  it('an unscoped survivor counts as all four fields: the user’s episodes 6 and score stay', async () => {
    const r = shikiMirror(rv(5, 7))
    await bump(r, rv(6, 7))
    r.primary('shikimori')
    offlineOnce()
    await r.set('shikimori', 1, rv(r.cacheOf('shikimori', 1)!.episodes, 9))
    expect(r.queueOf('shikimori').map((q) => q.via)).toEqual(['mirror', undefined])
    await r.fan.discardQueue('shikimori')
    expect(r.cacheOf('shikimori', 1)).toEqual(rv(6, 9))
  })
})

describe('the Shikimori handlers own their reply shape (#692 review)', () => {
  /** The real router on the rig's store and fan-out; returns an invoker. */
  function router(r: ReturnType<typeof rig>) {
    ;(ipcMain.handle as unknown as Mock).mockClear()
    const trackerRates = createTrackerRates({ store: r.store as never, trackers: r.fan })
    register({
      store: r.store,
      shikimoriSyncService: r.shiki,
      trackers: r.fan,
      trackerRates,
      ...trackerAccounts(r.store as never, trackerRates),
      lookupByMalIds: vi.fn(async () => ({})),
      maybeBroadcastCleanupPrompt: r.cleanup,
      runAutoDownloadTick: vi.fn(async () => ({})),
      broadcast: () => {}
    } as unknown as AppDeps)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
    )
    return (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  }
  const rate = (episodes: number, score = 7) => ({
    id: 10,
    score,
    status: 'watching',
    episodes,
    rewatches: 0,
    target_id: 1,
    target_type: 'Anime'
  })

  it('update-rate on a non-primary Shikimori replies with the queued copy as a synthetic rate', async () => {
    const r = rig()
    r.primary('anilist')
    r.offline.shikimori = true
    r.shikiCache([1, rv(5)])
    const invoke = router(r)

    const reply = await invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 1, 8, 'watching', 7, 0)

    expect(r.queueOf('shikimori')).toMatchObject([{ via: 'copy', fields: ['episodes'] }])
    expect(reply).toEqual(rate(8))
  })

  it('an equal copy replies with the cached rate, never null', async () => {
    const r = rig()
    r.primary('anilist')
    r.offline.shikimori = true
    r.shikiCache([1, rv(5)])
    const invoke = router(r)

    expect(await invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 1, 5, 'watching', 7, 0)).toEqual(rate(5))
    expect(r.queueOf('shikimori')).toEqual([])
  })

  it('an equal copy over a refreshed-over queued copy replies with the values, not the stale cached row', async () => {
    const r = rig()
    r.primary('anilist')
    r.offline.shikimori = true
    r.shikiCache([1, rv(5)])
    const invoke = router(r)
    await invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 1, 8, 'watching', 7, 0)
    // A keepQueued: false refresh puts the server's 5 back; the copy stays queued.
    r.shikiCache([1, rv(5)])

    const reply = await invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 1, 8, 'watching', 7, 0)

    expect(r.queueOf('shikimori')).toHaveLength(1)
    expect(reply).toEqual(rate(8))
  })

  it('mark-episode-watched on a non-primary Shikimori replies null', async () => {
    const r = rig()
    r.primary('anilist')
    r.shikiCache([1, rv(5)])
    const invoke = router(r)
    expect(await invoke(CHANNELS.SHIKIMORI_MARK_EPISODE_WATCHED, 1, 6)).toBeNull()
  })

  it('as the primary, update-rate still replies with the rate Shikimori returned', async () => {
    const r = rig()
    server.set(1, { episodes: 5, score: 7 })
    r.shikiCache([1, rv(5)])
    const invoke = router(r)
    expect(await invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 1, 6, 'watching', 7, 0)).toEqual(rate(6))
  })
})
