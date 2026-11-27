// `tracker:get-details` and `tracker:details-updated` (#706): a non-Shikimori
// tracker's details cache, read through its provider's `cachedDetails` with no
// network call, and the generic sync service's `broadcastDetails`, the one
// emitter #702's and #703's details writers call. AniList and MyAnimeList run
// the generic sync service over the fake-tracker personalities. The real
// AniList provider's writes are `test/api-clients/anilist.test.ts`'s.
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createGenericTracker } from '../helpers/generic-tracker'
import { createFakeTracker } from '../helpers/fake-tracker'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { TRACKER_KEYS } from '../../src/main/trackers/keys'

const DETAILS: TrackerDetails = {
  description: 'A plain-text synopsis.',
  genres: ['Action', 'Drama'],
  status: 'ongoing',
  episodes: 12,
  episodesAired: 6,
  kind: 'tv'
}

function rig(opts: { seed?: Record<string, unknown> } = {}) {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    ...opts.seed
  })
  const offline = { value: false }
  const broadcast = vi.fn()
  const prefetch = { anilist: vi.fn(), mal: vi.fn() }
  const generic = (id: 'anilist' | 'mal') =>
    createGenericTracker(id, store as never, {
      isOffline: () => offline.value,
      deps: {
        broadcast,
        detailsUpdatedChannel: EVENT_CHANNELS.TRACKER_DETAILS_UPDATED,
        prefetchDetails: prefetch[id]
      }
    })
  const anilist = generic('anilist')
  const mal = generic('mal')
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [{ sync: anilist.sync }, { sync: mal.sync }],
    primary: () => null,
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({
    store: store as never,
    trackers: fan,
    isOffline: () => offline.value
  })

  ;(ipcMain.handle as unknown as Mock).mockClear()
  registerTrackers({ store, trackerRates } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const getDetails = async (...args: unknown[]): Promise<TrackerDetails | null> =>
    (await handlers.get(CHANNELS.TRACKER_GET_DETAILS)!({}, ...args)) as TrackerDetails | null
  const signIn = (id: TrackerId): void =>
    store.set(TRACKER_KEYS[id].user, { id: 1, nickname: id, avatar: null })
  return { store, offline, broadcast, prefetch, anilist, mal, getDetails, signIn }
}

const serverReads = (r: ReturnType<typeof rig>) => [
  ...r.anilist.fake.serverReads,
  ...r.mal.fake.serverReads
]

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('broadcastDetails and cachedDetails', () => {
  it('broadcasts { trackerId, malId, details } on the configured channel, once per call', () => {
    const r = rig()
    r.anilist.sync.broadcastDetails(1, DETAILS)
    expect(r.broadcast).toHaveBeenCalledTimes(1)
    expect(r.broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.TRACKER_DETAILS_UPDATED, {
      trackerId: 'anilist',
      malId: 1,
      details: DETAILS
    })
    r.mal.sync.broadcastDetails(2, DETAILS)
    expect(r.broadcast).toHaveBeenLastCalledWith(EVENT_CHANNELS.TRACKER_DETAILS_UPDATED, {
      trackerId: 'mal',
      malId: 2,
      details: DETAILS
    })
  })

  it('cachedDetails is the provider’s own, per tracker; a provider without one has none', () => {
    const r = rig()
    r.anilist.fake.detailsCache.set(1, DETAILS)
    r.mal.fake.detailsCache.set(1, { ...DETAILS, description: 'MAL' })
    expect(r.anilist.sync.cachedDetails(1)).toEqual(DETAILS)
    expect(r.anilist.sync.cachedDetails(2)).toBeNull()
    expect(r.mal.sync.cachedDetails(1)?.description).toBe('MAL')
    const fake = createFakeTracker('anilist')
    fake.detailsCache.set(1, DETAILS)
    delete (fake.provider as { cachedDetails?: unknown }).cachedDetails
    const bare = createGenericTracker('anilist', new InMemoryStorage({}) as never, { fake })
    expect(bare.sync.cachedDetails(1)).toBeNull()
  })

  it('a construction without the channel (Shikimori’s) broadcasts nothing', () => {
    const store = new InMemoryStorage({})
    const broadcast = vi.fn()
    const { sync } = createGenericTracker('anilist', store as never, { deps: { broadcast } })
    sync.broadcastDetails(1, DETAILS)
    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('tracker:get-details', () => {
  it('a cache hit answers from the cache: no prefetch and no server read', async () => {
    const r = rig()
    r.anilist.fake.detailsCache.set(1, DETAILS)
    expect(await r.getDetails(1, 'anilist')).toEqual(DETAILS)
    expect(r.prefetch.anilist).not.toHaveBeenCalled()
    expect(serverReads(r)).toEqual([])
  })

  it('a miss is null, kicks that tracker’s prefetch and makes no network call', async () => {
    const r = rig()
    r.anilist.fake.details.set(2, DETAILS)
    expect(await r.getDetails(2, 'anilist')).toBeNull()
    expect(r.prefetch.anilist).toHaveBeenCalledWith(2)
    expect(r.prefetch.mal).not.toHaveBeenCalled()
    expect(serverReads(r)).toEqual([])
  })

  it('while offline a miss kicks no prefetch', async () => {
    const r = rig()
    r.offline.value = true
    expect(await r.getDetails(2, 'mal')).toBeNull()
    expect(r.prefetch.mal).not.toHaveBeenCalled()
  })

  it('without a trackerId it reads the details source', async () => {
    const r = rig()
    r.mal.fake.detailsCache.set(1, { ...DETAILS, description: 'from MAL' })
    r.anilist.fake.detailsCache.set(1, DETAILS)
    // No account: no source.
    expect(await r.getDetails(1)).toBeNull()
    r.signIn('mal')
    expect((await r.getDetails(1))?.description).toBe('from MAL')
    r.signIn('anilist')
    expect(await r.getDetails(1)).toEqual(DETAILS)
    r.store.set('trackerFeatureSource', { details: 'mal' })
    expect((await r.getDetails(1))?.description).toBe('from MAL')
  })

  it('Shikimori, as the source or by name, is null: its details stay on shikimori:get-anime-details', async () => {
    const r = rig()
    r.signIn('shikimori')
    r.signIn('anilist')
    r.anilist.fake.detailsCache.set(1, DETAILS)
    expect(await r.getDetails(1)).toBeNull()
    expect(await r.getDetails(1, 'shikimori')).toBeNull()
    expect(r.prefetch.anilist).not.toHaveBeenCalled()
  })

  it('rejects a bad MAL id or tracker', async () => {
    const r = rig()
    await expect(r.getDetails(0, 'anilist')).rejects.toThrow(/Invalid MAL id/)
    await expect(r.getDetails(1, 'nope')).rejects.toThrow(/Unknown tracker/)
  })
})

describe("the 'rates-refreshed' tick", () => {
  it('a Shikimori background refresh still ticks once, from the Shikimori router', () => {
    const hooks = new Map<TrackerId, { afterBackgroundRefresh?: () => void }>()
    const runAutoDownloadTick = vi.fn(async () => ({}))
    // Every collaborator the router only wires at registration is a no-op.
    const inert: object = new Proxy({}, { get: () => () => {} })
    const sync: Record<string, unknown> = {
      syncShikimoriQueue: vi.fn(async () => {}),
      prefetchShikimoriDetails: vi.fn(async () => {})
    }
    const given: Record<string, unknown> = {
      store: new InMemoryStorage(),
      shikimoriSyncService: new Proxy(sync, { get: (t, k: string) => (k in t ? t[k] : () => {}) }),
      trackerRates: { setRefreshHooks: (id: TrackerId, h: object) => hooks.set(id, h) },
      runAutoDownloadTick
    }
    registerShikimori(
      new Proxy(given, { get: (t, k: string) => (k in t ? t[k] : inert) }) as unknown as AppDeps
    )
    hooks.get('shikimori')!.afterBackgroundRefresh!()
    expect(runAutoDownloadTick).toHaveBeenCalledTimes(1)
    expect(runAutoDownloadTick).toHaveBeenCalledWith('rates-refreshed')
  })
})
