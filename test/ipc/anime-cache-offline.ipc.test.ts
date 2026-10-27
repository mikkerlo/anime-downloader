// The detail page offline (#568): `GET_ANIME_CACHE` drops its 24 h TTL and
// flags the entry `stale`, and `GET_ANIME` answers from the cache without
// calling the API. Online `GET_ANIME` behaves as before, and `GET_ANIME_CACHE`
// drops the TTL for cachable titles only (#570).
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import { register as registerCache } from '../../src/main/ipc/cache.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createAnimeCacheService } from '../../src/main/services/anime-cache'
import { createOfflineService, type OfflineService } from '../../src/main/services/offline'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const T0 = new Date('2026-10-27T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

const DETAIL = { id: 1, title: 'Cached title', episodes: [] }
const FRESH = { id: 1, title: 'API title', episodes: [] }

interface Harness {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  offline: OfflineService
  getAnime: Mock
  rememberAnimeMeta: Mock
}

function harness(cachedAt: number | null, cachable = true): Harness {
  const store = new InMemoryStorage({
    animeCache:
      cachedAt === null
        ? {}
        : {
            '1': {
              animeDetail: DETAIL,
              episodes: {},
              qualityProbes: {},
              cachedAt,
              posterCached: false
            }
          },
    library: { '1': {} }
  })
  const offline = createOfflineService({
    store,
    probeUrls: () => [],
    onOnline: vi.fn(),
    onOffline: vi.fn()
  })
  const animeCacheService = createAnimeCacheService({
    store,
    userDataDir: '/tmp/anime-cache-offline-test',
    fetchPoster: async () => null,
    isCachable: () => cachable
  })
  const getAnime = vi.fn(async () => ({ data: FRESH }))
  const rememberAnimeMeta = vi.fn()
  const deps = {
    smotretApi: { getAnime },
    animeCacheService,
    rememberAnimeMeta,
    offlineService: offline
  } as unknown as AppDeps
  ;(ipcMain.handle as Mock).mockClear()
  registerAnime(deps)
  registerCache(deps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel, ...args) => handlers.get(channel)!({}, ...args),
    offline,
    getAnime,
    rememberAnimeMeta
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET_ANIME_CACHE (#568)', () => {
  it('offline: a 3-day-old entry is returned with stale: true', async () => {
    const h = harness(T0 - 3 * DAY)
    h.offline.setManual(true)
    expect(await h.invoke(CHANNELS.GET_ANIME_CACHE, 1)).toEqual({
      data: DETAIL,
      cachedAt: T0 - 3 * DAY,
      stale: true
    })
  })

  it('offline: an entry inside the TTL is returned with stale: false', async () => {
    const h = harness(T0 - 60_000)
    h.offline.setManual(true)
    expect(await h.invoke(CHANNELS.GET_ANIME_CACHE, 1)).toMatchObject({ stale: false })
  })

  it('offline: no entry is still null', async () => {
    const h = harness(null)
    h.offline.setManual(true)
    expect(await h.invoke(CHANNELS.GET_ANIME_CACHE, 1)).toBeNull()
  })

  // #570: a cachable title (starred, downloaded or watched lately) skips the
  // TTL online too; the detail page paints it, then refreshes. Null on main.
  it('online: a 3-day-old entry for a cachable title is returned with stale: true', async () => {
    const h = harness(T0 - 3 * DAY)
    expect(await h.invoke(CHANNELS.GET_ANIME_CACHE, 1)).toEqual({
      data: DETAIL,
      cachedAt: T0 - 3 * DAY,
      stale: true
    })
  })

  it('online: a 3-day-old entry for a non-cachable title is still null', async () => {
    const h = harness(T0 - 3 * DAY, false)
    expect(await h.invoke(CHANNELS.GET_ANIME_CACHE, 1)).toBeNull()
  })

  it('offline: a 3-day-old entry for a non-cachable title is still returned stale', async () => {
    const h = harness(T0 - 3 * DAY, false)
    h.offline.setManual(true)
    expect(await h.invoke(CHANNELS.GET_ANIME_CACHE, 1)).toMatchObject({ stale: true })
  })

  it('online: an entry inside the TTL is returned, stale: false — today', async () => {
    const h = harness(T0 - 60_000)
    expect(await h.invoke(CHANNELS.GET_ANIME_CACHE, 1)).toEqual({
      data: DETAIL,
      cachedAt: T0 - 60_000,
      stale: false
    })
  })
})

describe('GET_ANIME (#568)', () => {
  it('offline: returns the cache entry without calling smotretApi.getAnime', async () => {
    const h = harness(T0 - 3 * DAY)
    h.offline.setManual(true)
    expect(await h.invoke(CHANNELS.GET_ANIME, 1)).toEqual({ data: DETAIL, source: 'cache' })
    expect(h.getAnime).not.toHaveBeenCalled()
  })

  it('offline with no entry: throws OfflineError without calling the API', async () => {
    const h = harness(null)
    h.offline.setManual(true)
    await expect(h.invoke(CHANNELS.GET_ANIME, 1)).rejects.toMatchObject({ name: 'OfflineError' })
    expect(h.getAnime).not.toHaveBeenCalled()
  })

  it('online: calls the API and returns source: api — today', async () => {
    const h = harness(T0 - 3 * DAY)
    expect(await h.invoke(CHANNELS.GET_ANIME, 1)).toMatchObject({ data: FRESH, source: 'api' })
    expect(h.getAnime).toHaveBeenCalledWith(1)
    expect(h.rememberAnimeMeta).toHaveBeenCalledWith(FRESH)
  })

  it('online: an API failure still falls back to the cache — today', async () => {
    const h = harness(T0 - 3 * DAY)
    h.getAnime.mockRejectedValue(new Error('500'))
    expect(await h.invoke(CHANNELS.GET_ANIME, 1)).toEqual({ data: DETAIL, source: 'cache' })
  })
})

describe('CACHE_GET_POSTER_IDS (#570)', () => {
  it('answers with the ids whose poster is on disk', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-ids-ipc-'))
    try {
      const store = new InMemoryStorage({ animeCache: {} })
      const animeCacheService = createAnimeCacheService({
        store,
        userDataDir,
        fetchPoster: async () => null,
        isCachable: () => true
      })
      fs.mkdirSync(animeCacheService.getPosterCacheDir())
      fs.writeFileSync(animeCacheService.getPosterCachePath(12), 'p')
      ;(ipcMain.handle as Mock).mockClear()
      registerCache({ animeCacheService } as unknown as AppDeps)
      const handler = (ipcMain.handle as Mock).mock.calls.find(
        ([channel]) => channel === CHANNELS.CACHE_GET_POSTER_IDS
      )![1]
      expect(await handler({})).toEqual([12])
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
