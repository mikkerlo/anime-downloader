// "Work offline stops all fetches" (#567), per foreground handler. With the
// real OfflineService in `offline-manual` installed as `net.ts`'s offline
// check, every handler below reaches `fetchWithTimeout`, which refuses with
// `OfflineError` before `globalThis.fetch` is called. Writes keep queueing,
// because `isNetworkError` classifies the refusal.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import { register as registerOffline } from '../../src/main/ipc/offline.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { SmotretApi } from '../../src/main/smotret-api'
import * as shikimori from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createOfflineService, type OfflineService } from '../../src/main/services/offline'
import { setOfflineCheck } from '../../src/main/lib/net'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const NOW_S = () => Math.floor(Date.now() / 1000)

function creds(expiresInS: number): shikimori.ShikiCredentials {
  return {
    access_token: 'fake-access',
    refresh_token: 'fake-refresh',
    created_at: NOW_S(),
    expires_in: expiresInS
  }
}

function cachedRate(malId: number): unknown {
  return {
    rate: { id: 900 + malId, target_id: malId, episodes: 3, status: 'watching', score: 7 },
    shikiAnime: { id: malId },
    smotretAnime: null
  }
}

interface Harness {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  store: InMemoryStorage
  offline: OfflineService
  broadcast: Mock
}

function harness(initial: Record<string, unknown> = {}): Harness {
  const store = new InMemoryStorage({
    shikimoriCredentials: creds(86_400),
    shikimoriUser: { id: 7, nickname: 'me' },
    shikimoriUserRates: [],
    shikimoriUpdateQueue: [],
    shikimoriParkedQueues: {},
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [],
    shikimoriSessionExpired: false,
    ...initial
  })
  const broadcast = vi.fn()
  const offline = createOfflineService({
    store,
    probeUrls: () => [],
    onOnline: vi.fn(),
    onOffline: vi.fn()
  })
  const sync = createShikimoriSyncService({
    store,
    broadcast,
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    isOffline: offline.isOffline
  })
  const deps = {
    store,
    smotretApi: new SmotretApi(() => 'tok'),
    animeCacheService: { getEntry: () => undefined, updateAnimeDetail: vi.fn() },
    rememberAnimeMeta: vi.fn(),
    shikimoriSyncService: sync,
    lookupByMalIds: vi.fn(async () => ({})),
    maybeBroadcastCleanupPrompt: vi.fn(async () => undefined),
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast,
    offlineService: offline
  } as unknown as AppDeps
  registerAnime(deps)
  registerShikimori(deps)
  registerOffline(deps)
  setOfflineCheck(offline.isOffline)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel, ...args) => handlers.get(channel)!({}, ...args),
    store,
    offline,
    broadcast
  }
}

let fetchSpy: Mock
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  realFetch = globalThis.fetch
  fetchSpy = vi.fn(async () => new Response('{"data":[]}', { status: 200 }))
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  shikimori.__resetRefreshStateForTests()
})

afterEach(() => {
  globalThis.fetch = realFetch
  setOfflineCheck(null)
  vi.restoreAllMocks()
})

describe('Work offline stops every foreground fetch (#567)', () => {
  const cases: Array<[string, string, unknown[]]> = [
    ['SEARCH_ANIME', CHANNELS.SEARCH_ANIME, ['steins']],
    ['GET_ANIME', CHANNELS.GET_ANIME, [7]],
    ['SHIKIMORI_GET_RATE', CHANNELS.SHIKIMORI_GET_RATE, [42]],
    ['SHIKIMORI_UPDATE_RATE', CHANNELS.SHIKIMORI_UPDATE_RATE, [42, 4, 'watching', 7, 0]],
    ['SHIKIMORI_GET_FRIENDS_ACTIVITY', CHANNELS.SHIKIMORI_GET_FRIENDS_ACTIVITY, []],
    ['SHIKIMORI_GET_CALENDAR (no snapshot)', CHANNELS.SHIKIMORI_GET_CALENDAR, [true]]
  ]

  it.each(cases)('%s makes zero fetch calls', async (_name, channel, args) => {
    const h = harness()
    h.offline.setManual(true)
    const outcome = await h.invoke(channel, ...args).then(
      () => 'resolved',
      (err: unknown) => err
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    if (outcome !== 'resolved') expect(outcome).toMatchObject({ name: 'OfflineError' })
  })

  it('UPDATE_RATE with a cached entry queues the edit', async () => {
    const h = harness({ shikimoriUserRates: [cachedRate(42)] })
    h.offline.setManual(true)
    await h.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 42, 4, 'watching', 7, 0)
    expect(fetchSpy).not.toHaveBeenCalled()
    const queue = h.store.get('shikimoriUpdateQueue') as Array<{ malId: number }>
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ malId: 42 })
  })

  it('ensureFreshToken with an expiring token makes no fetch and keeps the session', async () => {
    const h = harness({ shikimoriCredentials: creds(30) })
    h.offline.setManual(true)
    const err = await shikimori
      .ensureFreshToken(h.store as unknown as Parameters<typeof shikimori.ensureFreshToken>[0])
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'OfflineError' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(h.store.get('shikimoriCredentials')).toMatchObject({ refresh_token: 'fake-refresh' })
    expect(h.store.get('shikimoriSessionExpired')).toBe(false)
  })

  it('a cache-first rates read does not start the background refresh while offline', async () => {
    const h = harness({ shikimoriUserRates: [cachedRate(42)] })
    h.offline.setManual(true)
    const rates = await h.invoke(CHANNELS.SHIKIMORI_GET_ANIME_RATES)
    expect(rates).toEqual([cachedRate(42)])
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchSpy).not.toHaveBeenCalled()
    // Not even a refused attempt: the refresh returns before it starts.
    expect(console.warn).not.toHaveBeenCalledWith(
      '[shikimori] background refresh failed:',
      expect.anything()
    )
  })

  it('the same handlers do reach fetch once Work offline is off (the control)', async () => {
    const h = harness()
    h.offline.setManual(true)
    h.offline.setManual(false)
    await h.invoke(CHANNELS.SEARCH_ANIME, 'steins').catch(() => {})
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('offline IPC router', () => {
  it('get-state, set-manual and retry go through the service, and changes broadcast', async () => {
    const h = harness()
    expect(await h.invoke(CHANNELS.OFFLINE_GET_STATE)).toMatchObject({ mode: 'online' })

    const manual = await h.invoke(CHANNELS.OFFLINE_SET_MANUAL, true)
    expect(manual).toMatchObject({ mode: 'offline-manual' })
    expect(h.store.get('workOffline')).toBe(true)
    expect(h.broadcast).toHaveBeenCalledWith(
      EVENT_CHANNELS.OFFLINE_STATE_CHANGED,
      expect.objectContaining({ mode: 'offline-manual' })
    )

    // Manual mode: retry is a no-op and never probes.
    expect(await h.invoke(CHANNELS.OFFLINE_RETRY)).toMatchObject({ mode: 'offline-manual' })
    expect(fetchSpy).not.toHaveBeenCalled()

    expect(await h.invoke(CHANNELS.OFFLINE_SET_MANUAL, false)).toMatchObject({ mode: 'online' })
    expect(h.store.get('workOffline')).toBe(false)
  })

  it('Prepare for offline (#592): start, cancel and get-state go to the service', async () => {
    const h = harness()
    // Without the service: an empty state, and Start refuses.
    expect(await h.invoke(CHANNELS.PREPARE_OFFLINE_GET_STATE)).toEqual({
      running: false,
      run: null,
      lastRun: null
    })
    expect(await h.invoke(CHANNELS.PREPARE_OFFLINE_CANCEL)).toBe(false)
    await expect(h.invoke(CHANNELS.PREPARE_OFFLINE_START)).rejects.toThrow(/not available/)

    const prepareOffline = {
      start: vi.fn(() => ({ runId: 'r1' })),
      cancel: vi.fn(() => true),
      getState: vi.fn(() => ({ running: true, run: null, lastRun: null }))
    }
    ;(ipcMain.handle as Mock).mockClear()
    registerOffline({
      offlineService: { onChange: () => () => {} },
      broadcast: vi.fn(),
      prepareOffline
    } as unknown as AppDeps)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    expect(await handlers.get(CHANNELS.PREPARE_OFFLINE_START)!({})).toEqual({ runId: 'r1' })
    expect(await handlers.get(CHANNELS.PREPARE_OFFLINE_CANCEL)!({})).toBe(true)
    expect(await handlers.get(CHANNELS.PREPARE_OFFLINE_GET_STATE)!({})).toMatchObject({
      running: true
    })
  })
})
