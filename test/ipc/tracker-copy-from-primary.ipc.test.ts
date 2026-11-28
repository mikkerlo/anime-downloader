// "Copy from primary" and the per-title mirror signals (#705, T8b):
// `tracker:copy-from-primary` and `tracker:get-rate`'s `queued`, `unmapped`
// and `differs`. The real Shikimori sync service and primary branch run
// against `fake-shikimori.ts`; AniList and MyAnimeList run the generic sync
// service on `fake-tracker.ts`. AniList's `hasTitle` is the real id map's
// `known()` over `anilistIdMap`, as the provider's is (`trackers/anilist/provider.ts`).
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { T0, fakeApi, iso, server } from '../helpers/fake-shikimori'
import { createFakeTracker } from '../helpers/fake-tracker'
import { testRateCodec, type TestRow } from '../helpers/test-rate-codec'
import { trackerAccounts } from '../helpers/tracker-fan-out'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import {
  createTrackerSyncService,
  type TrackerSyncService
} from '../../src/main/services/trackers/sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { createAniListIdMap } from '../../src/main/trackers/anilist/id-map'
import { ANILIST_KEYS, MYANIMELIST_KEYS, SHIKIMORI_KEYS } from '../../src/main/trackers/keys'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { NO_RATE_BEFORE, type RateValues } from '../../src/main/lib/shikimori-rate'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
import type { AnilistScoreFormat } from '../../src/main/trackers/scores'

type Svc = TrackerSyncService<unknown, unknown>

const SHIKI_USER = { id: 7, nickname: 'me', avatar: '' }
const AL_USER = { id: 1, nickname: 'al', avatar: null }
const MAL_USER = { id: 3, nickname: 'mal', avatar: null }
const MAL = 1
const OTHER = 2

const rv = (over: Partial<RateValues> = {}): RateValues => ({
  episodes: 9,
  status: 'watching',
  score: 8,
  rewatches: 0,
  ...over
})

/** The red case's primary: Shikimori at watching / 9 / 8 / 0. */
const PRIMARY = rv()
/** The red case's AniList mirror: episodes 7, and a POINT_100 84 that reads as the app's 8. */
const MIRROR = rv({ episodes: 7 })
const MIRROR_RAW = 84

const shikiRow = (malId: number, v: RateValues) => ({
  rate: { id: malId * 10, target_id: malId, ...v, updated_at: iso(T0) },
  shikiAnime: { id: malId, name: `#${malId}` },
  smotretAnime: null
})

const plainRow = (malId: number, v: RateValues): TestRow => ({
  malId,
  remoteId: malId * 1000,
  values: v,
  updated_at: iso(T0)
})

const KEYS = { shikimori: SHIKIMORI_KEYS, anilist: ANILIST_KEYS, mal: MYANIMELIST_KEYS }

function rig(
  opts: {
    initial?: Record<string, unknown>
    scoreFormat?: AnilistScoreFormat
    mal?: boolean
  } = {}
) {
  const store = new InMemoryStorage({
    installId: 'pc',
    shikimoriUser: SHIKI_USER,
    shikimoriCredentials: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' },
    shikimoriUserRates: [],
    shikimoriUpdateQueue: [],
    shikimoriParkedQueues: {},
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [],
    shikimoriSessionExpired: false,
    anilistCredentials: { v: 1, enc: 'plain', data: 'blob' },
    anilistUser: { ...AL_USER, scoreFormat: opts.scoreFormat ?? 'POINT_100' },
    anilistUserRates: [],
    anilistUpdateQueue: [],
    anilistParkedQueues: {},
    anilistSessionExpired: false,
    anilistIdMap: {},
    myanimelistCredentials: opts.mal ? { v: 1, enc: 'plain', data: 'blob' } : null,
    myanimelistUser: opts.mal ? MAL_USER : null,
    myanimelistUserRates: [],
    myanimelistUpdateQueue: [],
    myanimelistParkedQueues: {},
    myanimelistSessionExpired: false,
    trackerPrimary: 'shikimori',
    trackerMirror: {},
    syncMeta: { titles: {}, rates: {} },
    ...opts.initial
  })
  const broadcast = vi.fn()
  const offline = { value: false }
  const isOffline = () => offline.value
  const shiki = createShikimoriSyncService({
    store: store as never,
    broadcast,
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED,
    isOffline
  })
  const idMap = createAniListIdMap({ store: store as never, client: {} as never })
  const generic = (id: 'anilist' | 'mal', fake: ReturnType<typeof createFakeTracker>) =>
    createTrackerSyncService(
      {
        ...fake.provider,
        rateCache: testRateCodec(id),
        isSessionGone: (err: unknown) => err instanceof TrackerApiError && err.status === 401,
        ...(id === 'anilist' ? { hasTitle: (malId: number) => idMap.known(malId) !== null } : {})
      } as never,
      KEYS[id],
      {
        store: store as never,
        broadcast,
        syncStatusChannel: `${id}:status`,
        offlineQueueChangedChannel: `${id}:queue`,
        rateUpdatedChannel: `${id}:rate`,
        ratesRefreshedChannel: `${id}:refreshed`,
        isOffline
      }
    ) as Svc
  const alFake = createFakeTracker('anilist')
  const malFake = createFakeTracker('mal')
  const anilist = generic('anilist', alFake)
  const mal = generic('mal', malFake)
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [{ sync: shiki.tracker as Svc }, { sync: anilist }, { sync: mal }],
    log: { warn: () => {} }
  })
  const rates = createTrackerRates({ store: store as never, trackers: fan, isOffline })
  ;(ipcMain.handle as unknown as Mock).mockClear()
  const maybeBroadcastCleanupPrompt = vi.fn(async () => {})
  const deps = {
    store,
    shikimoriSyncService: shiki,
    trackers: fan,
    trackerRates: rates,
    ...trackerAccounts(store as never, rates, isOffline),
    lookupByMalIds: vi.fn(async () => ({})),
    maybeBroadcastCleanupPrompt,
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast,
    offlineService: { isOffline }
  } as unknown as AppDeps
  registerShikimori(deps)
  registerTrackers(deps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  const queueOf = (id: TrackerId) => store.get(KEYS[id].updateQueue) as QueuedTrackerUpdate[]
  return {
    store,
    broadcast,
    maybeBroadcastCleanupPrompt,
    offline,
    shiki,
    anilist,
    mal,
    alFake,
    malFake,
    fan,
    invoke,
    queueOf,
    copy: (id: unknown, malId: unknown = MAL) =>
      invoke(CHANNELS.TRACKER_COPY_FROM_PRIMARY, id, malId),
    getRate: (id: TrackerId, malId = MAL) =>
      invoke(CHANNELS.TRACKER_GET_RATE, id, malId) as Promise<TrackerRateResult>,
    cacheShiki: (...rows: [number, RateValues][]) =>
      store.set(
        SHIKIMORI_KEYS.userRates,
        rows.map(([m, v]) => shikiRow(m, v))
      ),
    cache: (id: 'anilist' | 'mal', ...rows: [number, RateValues][]) =>
      store.set(
        KEYS[id].userRates,
        rows.map(([m, v]) => plainRow(m, v))
      ),
    stopTimers() {
      for (const t of fan.syncServices()) t.stopSyncTimer()
    }
  }
}

type Rig = ReturnType<typeof rig>

/** The red case's setup, offline so nothing drains until the test says so. */
function redSetup(r: Rig): void {
  r.cacheShiki([MAL, PRIMARY])
  server.set(MAL, PRIMARY)
  r.cache('anilist', [MAL, MIRROR])
  r.alFake.set(MAL, MIRROR, { scoreRaw: MIRROR_RAW })
  r.offline.value = true
}

function negativeEntry(r: Rig, at = Date.now()): void {
  r.store.set('anilistIdMap', { [String(MAL)]: { anilistId: null, at } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0 + 5_000_000)
  server.reset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('tracker:copy-from-primary: the red case', () => {
  it('queues one field-scoped via: copy entry on AniList alone, and the drain sends episodes only', async () => {
    const r = rig()
    redSetup(r)
    const shikiQueue = JSON.stringify(r.queueOf('shikimori'))

    expect(await r.copy('anilist')).toEqual(rv({ episodes: 9 }))

    const queue = r.queueOf('anilist')
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({
      malId: MAL,
      fields: ['episodes'],
      before: MIRROR,
      after: { ...MIRROR, episodes: 9 },
      via: 'copy'
    })
    expect(JSON.stringify(r.queueOf('shikimori'))).toBe(shikiQueue)
    // Only AniList's rate clock: `anilist:<user>:<malId>`, never Shikimori's `<user>:<malId>`.
    const clocks = (r.store.get('syncMeta') as { rates: Record<string, unknown> }).rates
    expect(Object.keys(clocks)).toEqual([`anilist:${AL_USER.id}:${MAL}`])
    expect(r.maybeBroadcastCleanupPrompt).not.toHaveBeenCalled()
    expect(r.broadcast.mock.calls.map(([c]) => c)).not.toContain(EVENT_CHANNELS.CLEANUP_PROMPT)

    r.offline.value = false
    await r.anilist.syncQueue()

    expect(r.alFake.upserts).toHaveLength(1)
    expect(r.alFake.upserts[0].changedFields).toEqual(['episodes'])
    expect(r.alFake.upserts[0].values.episodes).toBe(9)
    // The stored raw is untouched: no score was written.
    expect(r.alFake.rows.get(MAL)!.scoreRaw).toBe(MIRROR_RAW)
    expect(r.queueOf('anilist')).toEqual([])
    expect(fakeApi.updateUserRate).not.toHaveBeenCalled()
    r.stopTimers()
  })

  it("tracker:get-rate's differs is ['episodes'] for that setup, the fields the copy then queues", async () => {
    const r = rig()
    redSetup(r)
    const before = await r.getRate('anilist')
    expect(before).toMatchObject({ queued: false, unmapped: false, differs: ['episodes'] })

    await r.copy('anilist')

    expect(r.queueOf('anilist')[0].fields).toEqual(before.differs)
    expect(await r.getRate('anilist')).toMatchObject({ queued: true, differs: [] })
    r.stopTimers()
  })
})

describe('tracker:copy-from-primary: the writer path', () => {
  it('the create branch: a mirror with no row gets every field, from NO_RATE_BEFORE', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [OTHER, MIRROR])
    r.offline.value = true

    await r.copy('anilist')

    expect(r.queueOf('anilist')).toMatchObject([
      {
        malId: MAL,
        rateId: null,
        before: NO_RATE_BEFORE,
        after: PRIMARY,
        fields: ['episodes', 'status', 'score', 'rewatches'],
        via: 'copy'
      }
    ])
    r.offline.value = false
    await r.anilist.syncQueue()
    expect(r.alFake.upserts).toMatchObject([
      { values: PRIMARY, changedFields: ['episodes', 'status', 'score', 'rewatches'] }
    ])
    r.stopTimers()
  })

  it('an already-equal pair makes no applyChange call and queues nothing', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [MAL, PRIMARY])
    r.offline.value = true
    const apply = vi.spyOn(r.fan, 'applyChange')

    expect(await r.copy('anilist')).toEqual(PRIMARY)

    expect(apply).not.toHaveBeenCalled()
    expect(r.queueOf('anilist')).toEqual([])
  })

  it('a POINT_5 step pair with nothing else different makes no call either', async () => {
    const r = rig({ scoreFormat: 'POINT_5' })
    r.cacheShiki([MAL, rv({ score: 7 })])
    // The app's 7, written to a POINT_5 account, reads back as 8.
    r.cache('anilist', [MAL, rv({ score: 8 })])
    r.offline.value = true
    const apply = vi.spyOn(r.fan, 'applyChange')

    expect(await r.getRate('anilist')).toMatchObject({ differs: [] })
    await r.copy('anilist')

    expect(apply).not.toHaveBeenCalled()
    expect(r.queueOf('anilist')).toEqual([])
  })

  it("a stale renderer: the copy takes the primary's queued 10 over its cached 9", async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.store.set(SHIKIMORI_KEYS.updateQueue, [
      {
        malId: MAL,
        rateId: MAL * 10,
        before: PRIMARY,
        after: rv({ episodes: 10 }),
        queuedAt: T0
      }
    ])
    r.cache('anilist', [MAL, MIRROR])
    r.offline.value = true

    await r.copy('anilist')

    expect(r.queueOf('anilist')).toMatchObject([{ fields: ['episodes'], after: { episodes: 10 } }])
    r.stopTimers()
  })

  it('the primary as the target is refused', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    const apply = vi.spyOn(r.fan, 'applyChange')
    await expect(r.copy('shikimori')).rejects.toThrow('Shikimori is the primary')
    expect(apply).not.toHaveBeenCalled()
    expect(r.queueOf('shikimori')).toEqual([])
  })

  it('a malformed tracker or MAL id is refused at the boundary', async () => {
    const r = rig()
    await expect(r.copy('bogus')).rejects.toThrow('Unknown tracker')
    await expect(r.copy('anilist', 0)).rejects.toThrow('Invalid MAL id')
  })

  it('a tracker that is not connected is refused', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    await expect(r.copy('mal')).rejects.toThrow('Not logged in to MyAnimeList')
    expect(r.queueOf('mal')).toEqual([])
  })

  it('reaches only the named target with three trackers connected', async () => {
    const r = rig({ mal: true })
    redSetup(r)
    r.cache('mal', [MAL, MIRROR])

    await r.copy('anilist')

    expect(r.queueOf('anilist')).toHaveLength(1)
    expect(r.queueOf('mal')).toEqual([])
    expect(r.queueOf('shikimori')).toEqual([])
    expect(await r.getRate('mal')).toMatchObject({ queued: false, differs: ['episodes'] })
    r.stopTimers()
  })

  it('discardQueue(that mirror) keeps the copy and drops the real mirror entry beside it', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [MAL, MIRROR])
    // A pending mirror write for the status, from an earlier primary edit.
    r.store.set(ANILIST_KEYS.updateQueue, [
      {
        malId: MAL,
        rateId: MAL * 1000,
        before: MIRROR,
        after: { ...MIRROR, status: 'on_hold' },
        queuedAt: T0,
        fields: ['status'],
        via: 'mirror'
      }
    ])
    r.offline.value = true

    await r.copy('anilist')
    expect(r.queueOf('anilist').map((q) => q.via)).toEqual(['mirror', 'copy'])

    expect(await r.fan.discardQueue('anilist')).toBe(1)
    expect(r.queueOf('anilist')).toMatchObject([{ via: 'copy', after: { episodes: 9 } }])
    r.stopTimers()
  })

  it('a mirror whose session expired still queues the copy, and the primary still drains', async () => {
    const r = rig({ initial: { anilistCredentials: null, anilistSessionExpired: true } })
    r.alFake.fail('auth', { times: 99 })
    r.cacheShiki([MAL, PRIMARY])
    server.set(MAL, PRIMARY)
    r.cache('anilist', [MAL, MIRROR])

    await r.copy('anilist')
    expect(r.queueOf('anilist')).toMatchObject([{ via: 'copy', fields: ['episodes'] }])

    r.store.set(SHIKIMORI_KEYS.updateQueue, [
      { malId: MAL, rateId: MAL * 10, before: PRIMARY, after: rv({ episodes: 11 }), queuedAt: T0 }
    ])
    await r.shiki.tracker.syncQueue()
    expect(server.get(MAL)!.episodes).toBe(11)
    expect(r.queueOf('shikimori')).toEqual([])
    expect(r.queueOf('anilist')).toHaveLength(1)
    expect(await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'anilist')).toMatchObject({
      sessionExpired: true,
      queueLength: 1
    })
    r.stopTimers()
  })
})

describe('tracker:copy-from-primary: the id map', () => {
  it('a negative anilistIdMap entry is refused and queues nothing', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    negativeEntry(r)
    const apply = vi.spyOn(r.fan, 'applyChange')

    await expect(r.copy('anilist')).rejects.toThrow('not on AniList')

    expect(apply).not.toHaveBeenCalled()
    expect(r.queueOf('anilist')).toEqual([])
  })

  it('a cold map (no entry) queues the copy keyed by MAL id', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.offline.value = true

    await r.copy('anilist')

    expect(r.queueOf('anilist')).toMatchObject([{ malId: MAL, rateId: null, via: 'copy' }])
    r.stopTimers()
  })
})

describe('tracker:copy-from-primary: the primary has no row', () => {
  it("get-rate's differs is [] for the mirror, and the copy is refused, queueing nothing", async () => {
    const r = rig()
    r.cacheShiki([OTHER, PRIMARY])
    r.cache('anilist', [MAL, MIRROR])
    r.offline.value = true
    const apply = vi.spyOn(r.fan, 'applyChange')

    expect(await r.getRate('anilist')).toMatchObject({ values: MIRROR, differs: [] })
    await expect(r.copy('anilist')).rejects.toThrow('Shikimori has no entry')

    expect(apply).not.toHaveBeenCalled()
    expect(r.queueOf('anilist')).toEqual([])
  })
})

describe('tracker:copy-from-primary: a mirror that drifted on its own site', () => {
  it('writes nothing for the drifted field, the cache takes the server value, and differs comes back', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [MAL, MIRROR])
    // The user moved AniList to 8 on the site; the cache still says 7.
    r.alFake.set(MAL, { ...MIRROR, episodes: 8 }, { scoreRaw: MIRROR_RAW })
    r.offline.value = true

    await r.copy('anilist')
    expect(r.queueOf('anilist')).toMatchObject([
      { fields: ['episodes'], before: { episodes: 7 }, after: { episodes: 9 } }
    ])

    r.offline.value = false
    await r.anilist.syncQueue()

    expect(r.alFake.rows.get(MAL)!.values.episodes).toBe(8)
    expect(r.alFake.upserts).toEqual([])
    expect(r.anilist.cachedRate(MAL)!.values.episodes).toBe(8)
    expect(r.queueOf('anilist')).toEqual([])
    expect(await r.getRate('anilist')).toMatchObject({ queued: false, differs: ['episodes'] })
    r.stopTimers()
  })
})

describe("tracker:get-rate's per-title signals", () => {
  it('queued is true exactly while the queue holds an entry for the title', async () => {
    const r = rig()
    redSetup(r)
    expect(await r.getRate('anilist')).toMatchObject({ queued: false })
    await r.copy('anilist')
    expect(await r.getRate('anilist')).toMatchObject({ queued: true })
    expect(await r.getRate('anilist', OTHER)).toMatchObject({ queued: false })

    r.offline.value = false
    await r.anilist.syncQueue()
    expect(await r.getRate('anilist')).toMatchObject({ queued: false })
    r.stopTimers()
  })

  it('unmapped is true for a negative entry, with no row and no differs', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [OTHER, MIRROR])
    negativeEntry(r)
    r.offline.value = true

    expect(await r.getRate('anilist')).toEqual({
      values: null,
      stale: true,
      queued: false,
      unmapped: true,
      differs: []
    })
  })

  it('unmapped is false for a cold map, and the missing row differs in every field', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [OTHER, MIRROR])
    r.offline.value = true

    expect(await r.getRate('anilist')).toEqual({
      values: null,
      stale: true,
      queued: false,
      unmapped: false,
      differs: ['episodes', 'status', 'score', 'rewatches']
    })
  })

  it('unmapped is false again once the negative entry is past its TTL', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [OTHER, MIRROR])
    negativeEntry(r, Date.now() - 8 * 24 * 60 * 60 * 1000)
    r.offline.value = true

    expect(await r.getRate('anilist')).toMatchObject({ unmapped: false })
  })

  it('differs is [] for the 84 / 8 rounding pair and for the primary itself', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [MAL, PRIMARY])
    r.offline.value = true

    expect(await r.getRate('anilist')).toMatchObject({ differs: [] })
    expect(await r.getRate('shikimori')).toEqual({
      values: PRIMARY,
      stale: true,
      queued: false,
      unmapped: false,
      differs: []
    })
  })

  it('an in-flight mirror write that already matches the primary: queued, and no differs', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    r.cache('anilist', [MAL, MIRROR])
    r.store.set(ANILIST_KEYS.updateQueue, [
      {
        malId: MAL,
        rateId: MAL * 1000,
        before: MIRROR,
        after: PRIMARY,
        queuedAt: T0,
        fields: ['episodes'],
        via: 'mirror'
      }
    ])
    r.offline.value = true

    expect(await r.getRate('anilist')).toMatchObject({ queued: true, differs: [] })
  })
})

// #752: `readRate` writes a live entry that differs from the cached row back
// into the cache, with the server's clock, so the panel (the live read), the
// chips' `differs` and the copy (the projection) read one snapshot.

const SHIKI_RATE_UPDATED = EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED
const OTHER_SHIKI_USER = { id: 8, nickname: 'other', avatar: '' }

const sent = (r: Rig, channel: string) => r.broadcast.mock.calls.filter(([c]) => c === channel)

/** The cached Shikimori row's `rate`, both clocks included. */
const shikiRate = (r: Rig) =>
  (r.store.get(SHIKIMORI_KEYS.userRates) as { rate: Record<string, unknown> }[]).find(
    (e) => e.rate.target_id === MAL
  )!.rate

/** A live Shikimori rate as `/api/v2/user_rates` sends it. */
const liveShiki = (v: RateValues, at = T0 + 2_000_000) => ({
  id: MAL * 10,
  target_id: MAL,
  target_type: 'Anime',
  ...v,
  updated_at: iso(at)
})

/** Holds the next Shikimori single-entry read until `resolve`. */
function holdShikiRead(): { resolve: (rate: unknown) => void } {
  let resolve!: (rate: unknown) => void
  const held = new Promise<unknown>((r) => (resolve = r))
  fakeApi.getUserRate.mockImplementationOnce((() => held) as never)
  return { resolve }
}

/** Lets the reads started so far reach `getUserRate`. */
async function untilReads(n: number): Promise<void> {
  for (let i = 0; i < 50 && fakeApi.getUserRate.mock.calls.length < n; i++) await Promise.resolve()
  expect(fakeApi.getUserRate).toHaveBeenCalledTimes(n)
}

/** #751's check A: both trackers at episode 2, then the user moves Shikimori to 3 on its site. */
const CACHED = rv({ episodes: 2 })
const SITE = rv({ episodes: 3 })
function siteEditSetup(r: Rig): void {
  r.cacheShiki([MAL, CACHED])
  server.set(MAL, SITE)
  r.cache('anilist', [MAL, CACHED])
  r.alFake.set(MAL, CACHED)
}

describe('tracker:get-rate: a live read that differs from the cache', () => {
  it("#751's check A: after a site edit the panel's read patches the primary's cache, so the chip's differs agrees with the panel", async () => {
    const r = rig()
    siteEditSetup(r)

    // The panel reads 3 on the base too: the live read.
    expect(await r.getRate('shikimori')).toMatchObject({ values: SITE, stale: false, differs: [] })
    // The chip shows AniList's 2 under the panel's 3. On the base its differs is [].
    expect(await r.getRate('anilist')).toMatchObject({
      values: CACHED,
      stale: false,
      differs: ['episodes']
    })
    expect(r.shiki.tracker.cachedRate(MAL)!.values).toEqual(SITE)
    expect(r.fan.projection('shikimori', MAL)).toEqual(SITE)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(1)
  })

  it("the read-patched Shikimori row carries the server's updated_at as both clocks", async () => {
    const r = rig()
    siteEditSetup(r)
    expect(shikiRate(r).serverUpdatedAt).toBeUndefined()

    await r.getRate('shikimori')

    const served = server.get(MAL)!.updated_at
    expect(shikiRate(r)).toMatchObject({ episodes: 3, updated_at: served, serverUpdatedAt: served })
  })

  it('the backwards copy: a mirror already at the live value is offered no copy, and keeps it', async () => {
    const r = rig()
    const AT_10 = rv({ episodes: 10 })
    r.cacheShiki([MAL, PRIMARY])
    server.set(MAL, AT_10)
    r.cache('anilist', [MAL, AT_10])
    r.alFake.set(MAL, AT_10)

    await r.getRate('shikimori')
    expect(await r.getRate('anilist')).toMatchObject({ differs: [] })
    const apply = vi.spyOn(r.fan, 'applyChange')

    expect(await r.copy('anilist')).toEqual(AT_10)

    expect(apply).not.toHaveBeenCalled()
    expect(r.queueOf('anilist')).toEqual([])
    await r.anilist.syncQueue()
    expect(r.alFake.upserts).toEqual([])
    expect(r.alFake.rows.get(MAL)!.values.episodes).toBe(10)
  })

  it("the mirror's own lag: AniList's live read patches its cache and broadcasts the row once", async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    server.set(MAL, PRIMARY)
    r.cache('anilist', [MAL, MIRROR])
    r.alFake.set(MAL, { ...MIRROR, episodes: 8 }, { scoreRaw: MIRROR_RAW })

    expect(await r.getRate('anilist')).toMatchObject({ values: { episodes: 8 }, stale: false })

    expect(r.anilist.cachedRate(MAL)!.values).toEqual({ ...MIRROR, episodes: 8 })
    const updates = sent(r, 'anilist:rate')
    expect(updates).toHaveLength(1)
    // What the store's `rateFor('anilist', MAL)` upserts.
    expect(testRateCodec('anilist').entryOf(updates[0][1] as TestRow).values.episodes).toBe(8)
  })

  it('equal values never patch: a second read of the same live value broadcasts nothing more', async () => {
    const r = rig()
    siteEditSetup(r)
    await r.getRate('shikimori')
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(1)

    await r.getRate('shikimori')
    await r.getRate('anilist')

    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(1)
    expect(sent(r, 'anilist:rate')).toHaveLength(0)
  })

  it('a queued title is not patched: its projection already overlays the queue', async () => {
    const r = rig()
    siteEditSetup(r)
    r.store.set(SHIKIMORI_KEYS.updateQueue, [
      {
        malId: MAL,
        rateId: MAL * 10,
        before: CACHED,
        after: rv({ episodes: 2, score: 9 }),
        queuedAt: T0
      }
    ])

    expect(await r.getRate('shikimori')).toMatchObject({ values: SITE, stale: false })

    expect(r.shiki.tracker.cachedRate(MAL)!.values).toEqual(CACHED)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(0)
  })

  it('a stale read never patches: offline, or a live read that fails the way a queued write survives', async () => {
    const r = rig()
    siteEditSetup(r)
    r.offline.value = true
    expect(await r.getRate('shikimori')).toMatchObject({ values: CACHED, stale: true })

    r.offline.value = false
    fakeApi.ensureFreshToken.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await r.getRate('shikimori')).toMatchObject({ values: CACHED, stale: true })

    expect(r.shiki.tracker.cachedRate(MAL)!.values).toEqual(CACHED)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(0)
  })

  it('an account switch during the read: the owner guard drops the patch, and nothing is kicked', async () => {
    const r = rig()
    siteEditSetup(r)
    const refresh = vi.spyOn(r.shiki.tracker, 'refreshRates').mockResolvedValue(null)
    const held = holdShikiRead()
    const read = r.getRate('shikimori')
    await untilReads(1)

    r.store.set('shikimoriUser', OTHER_SHIKI_USER)
    held.resolve(liveShiki(SITE))
    await read

    expect(r.shiki.tracker.cachedRate(MAL)!.values).toEqual(CACHED)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(0)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('tracker:get-rate: the in-flight guard', () => {
  it('the drain race: a read the server answered before the POST landed never puts the old value back', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    server.set(MAL, PRIMARY)
    const held = holdShikiRead()
    const read = r.getRate('shikimori')
    await untilReads(1)

    // The edit path: the enqueue patches the cache to 10, then the drain writes and settles it.
    r.shiki.tracker.enqueue({
      malId: MAL,
      rateId: MAL * 10,
      before: PRIMARY,
      after: rv({ episodes: 10 }),
      queuedAt: T0
    })
    await r.shiki.tracker.syncQueue()
    expect(server.get(MAL)!.episodes).toBe(10)
    expect(r.queueOf('shikimori')).toEqual([])
    expect(r.shiki.tracker.cachedRate(MAL)!.values.episodes).toBe(10)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(2)

    held.resolve(liveShiki(PRIMARY))
    expect(await read).toMatchObject({ values: PRIMARY, stale: false })

    expect(r.shiki.tracker.cachedRate(MAL)!.values.episodes).toBe(10)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(2)
    r.stopTimers()
  })

  it('two overlapping reads resolving out of order: the newer patches, the older stands down', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    server.set(MAL, rv({ episodes: 10 }))
    const a = holdShikiRead()
    const readA = r.getRate('shikimori')
    await untilReads(1)
    server.set(MAL, rv({ episodes: 11 }))
    const b = holdShikiRead()
    const readB = r.getRate('shikimori')
    await untilReads(2)

    b.resolve(liveShiki(rv({ episodes: 11 }), T0 + 3_000_000))
    await readB
    expect(r.shiki.tracker.cachedRate(MAL)!.values.episodes).toBe(11)
    a.resolve(liveShiki(rv({ episodes: 10 })))
    await readA

    expect(r.shiki.tracker.cachedRate(MAL)!.values.episodes).toBe(11)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(1)
  })

  it('two overlapping reads resolving in order: the later one stands down, and the next read heals the row', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    server.set(MAL, rv({ episodes: 10 }))
    const a = holdShikiRead()
    const readA = r.getRate('shikimori')
    await untilReads(1)
    server.set(MAL, rv({ episodes: 11 }))
    const b = holdShikiRead()
    const readB = r.getRate('shikimori')
    await untilReads(2)

    a.resolve(liveShiki(rv({ episodes: 10 })))
    await readA
    expect(r.shiki.tracker.cachedRate(MAL)!.values.episodes).toBe(10)
    b.resolve(liveShiki(rv({ episodes: 11 }), T0 + 3_000_000))
    await readB
    // B snapshotted 9, and A moved the row: B stands down though the server holds 11.
    expect(r.shiki.tracker.cachedRate(MAL)!.values.episodes).toBe(10)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(1)

    // A's rate-updated makes the store refetch the held title; that read patches.
    expect(await r.getRate('shikimori')).toMatchObject({ values: rv({ episodes: 11 }) })
    expect(r.shiki.tracker.cachedRate(MAL)!.values.episodes).toBe(11)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(2)
  })

  it('an entry queued while the read was in flight: no read-patch', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    server.set(MAL, rv({ episodes: 10 }))
    const held = holdShikiRead()
    const read = r.getRate('shikimori')
    await untilReads(1)

    // Its `after` is the cached values, so the row reads unchanged and only the queue check sees it.
    r.shiki.tracker.enqueue({
      malId: MAL,
      rateId: MAL * 10,
      before: PRIMARY,
      after: PRIMARY,
      queuedAt: T0
    })
    expect(r.shiki.tracker.cachedRate(MAL)).toEqual({ remoteId: MAL * 10, values: PRIMARY })
    const updates = sent(r, SHIKI_RATE_UPDATED).length

    held.resolve(liveShiki(rv({ episodes: 10 })))
    await read

    expect(r.shiki.tracker.cachedRate(MAL)!.values).toEqual(PRIMARY)
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(updates)
  })
})

describe('tracker:get-rate: a presence mismatch kicks one list refresh', () => {
  it('removed on the site: once per title, and once more for another account', async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    const refresh = vi.spyOn(r.shiki.tracker, 'refreshRates').mockResolvedValue(null)

    expect(await r.getRate('shikimori')).toMatchObject({ values: null, stale: false })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ keepQueued: false })
    await r.getRate('shikimori')
    expect(refresh).toHaveBeenCalledTimes(1)

    r.store.set('shikimoriUser', OTHER_SHIKI_USER)
    await r.getRate('shikimori')
    expect(refresh).toHaveBeenCalledTimes(2)
    // A single read can't remove the row: the refresh does.
    expect(r.shiki.tracker.cachedRate(MAL)).not.toBeNull()
    expect(sent(r, SHIKI_RATE_UPDATED)).toHaveLength(0)
  })

  it('added on the site: once per title, and once more for another account', async () => {
    const r = rig()
    r.cacheShiki([OTHER, PRIMARY])
    server.set(MAL, PRIMARY)
    const refresh = vi.spyOn(r.shiki.tracker, 'refreshRates').mockResolvedValue(null)

    expect(await r.getRate('shikimori')).toMatchObject({ values: PRIMARY, stale: false })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ keepQueued: false })
    await r.getRate('shikimori')
    expect(refresh).toHaveBeenCalledTimes(1)

    r.store.set('shikimoriUser', OTHER_SHIKI_USER)
    await r.getRate('shikimori')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("an in-app first add kicks too: the mirror's create drains, and neither its enqueue nor its settle can create the row", async () => {
    const r = rig()
    r.cacheShiki([OTHER, PRIMARY])
    r.cache('anilist', [OTHER, MIRROR])
    // The user adds the title from the panel: Shikimori writes it, AniList's mirror entry creates it.
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, PRIMARY)
    await r.anilist.drainNow()
    expect(r.alFake.rows.get(MAL)!.values).toEqual(PRIMARY)
    expect(r.queueOf('anilist')).toEqual([])
    expect(r.anilist.cachedRate(MAL)).toBeNull()
    const refresh = vi.spyOn(r.anilist, 'refreshRates').mockResolvedValue(null)

    expect(await r.getRate('anilist')).toMatchObject({ values: PRIMARY, stale: false })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ keepQueued: false })
    r.stopTimers()
  })

  it("an account switch during the read kicks nothing: the cache is the new account's by then", async () => {
    const r = rig()
    r.cacheShiki([MAL, PRIMARY])
    const refresh = vi.spyOn(r.shiki.tracker, 'refreshRates').mockResolvedValue(null)
    const held = holdShikiRead()
    const read = r.getRate('shikimori')
    await untilReads(1)

    r.store.set('shikimoriUser', OTHER_SHIKI_USER)
    held.resolve(null)
    expect(await read).toMatchObject({ values: null, stale: false })

    expect(refresh).not.toHaveBeenCalled()
  })

  it('the presence check reads the cache after the await: a refresh that wrote the row meanwhile is no mismatch', async () => {
    const r = rig()
    r.cacheShiki([OTHER, PRIMARY])
    server.set(MAL, PRIMARY)
    const held = holdShikiRead()
    const read = r.getRate('shikimori')
    await untilReads(1)

    await r.shiki.tracker.refreshRates({ keepQueued: false })
    expect(r.shiki.tracker.cachedRate(MAL)).not.toBeNull()
    const refresh = vi.spyOn(r.shiki.tracker, 'refreshRates').mockResolvedValue(null)
    held.resolve(liveShiki(PRIMARY))
    await read

    expect(refresh).not.toHaveBeenCalled()
  })
})
