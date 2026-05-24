import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Listener<T> = (data: T) => void

type Captured = {
  rateUpdated: Listener<ShikiAnimeRateEntry>[]
  ratesRefreshed: Listener<ShikiAnimeRateEntry[]>[]
  detailsUpdated: Listener<{ malId: number; details: ShikiAnimeDetails }>[]
  offlineQueue: Listener<{ length: number }>[]
  syncStatus: Listener<unknown>[]
  getUser: ReturnType<typeof vi.fn>
  getRates: ReturnType<typeof vi.fn>
  getSyncStatus: ReturnType<typeof vi.fn>
  getOfflineQueueLength: ReturnType<typeof vi.fn>
  triggerSync: ReturnType<typeof vi.fn>
}

let captured: Captured

function installApi(): void {
  captured = {
    rateUpdated: [],
    ratesRefreshed: [],
    detailsUpdated: [],
    offlineQueue: [],
    syncStatus: [],
    getUser: vi.fn(async () => null),
    getRates: vi.fn(async () => []),
    getSyncStatus: vi.fn(async () => ({
      state: 'idle',
      queueLength: 4,
      lastSyncAt: 1234,
      lastSyncError: null
    })),
    getOfflineQueueLength: vi.fn(async () => 7),
    triggerSync: vi.fn(async () => undefined)
  }
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      onShikimoriRateUpdated: (cb: Listener<ShikiAnimeRateEntry>) => {
        captured.rateUpdated.push(cb)
        return () => {}
      },
      onShikimoriRatesRefreshed: (cb: Listener<ShikiAnimeRateEntry[]>) => {
        captured.ratesRefreshed.push(cb)
        return () => {}
      },
      onShikimoriAnimeDetailsUpdated: (
        cb: Listener<{ malId: number; details: ShikiAnimeDetails }>
      ) => {
        captured.detailsUpdated.push(cb)
        return () => {}
      },
      onShikimoriOfflineQueueChanged: (cb: Listener<{ length: number }>) => {
        captured.offlineQueue.push(cb)
        return () => {}
      },
      onShikimoriSyncStatus: (cb: Listener<unknown>) => {
        captured.syncStatus.push(cb)
        return () => {}
      },
      shikimoriGetUser: captured.getUser,
      shikimoriGetAnimeRates: captured.getRates,
      shikimoriGetSyncStatus: captured.getSyncStatus,
      shikimoriGetOfflineQueueLength: captured.getOfflineQueueLength,
      shikimoriTriggerSync: captured.triggerSync
    }
  }
}

function mkRate(malId: number, episodes: number): ShikiAnimeRateEntry {
  return {
    rate: { id: 1, target_id: malId, episodes, status: 'watching', score: 0 },
    shikiAnime: { id: malId },
    smotretAnime: null
  } as unknown as ShikiAnimeRateEntry
}

beforeEach(() => {
  installApi()
  setActivePinia(createPinia())
  vi.resetModules()
})

describe('useShikimoriStore', () => {
  it('subscribes to all five broadcasts at construction', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    useShikimoriStore()
    expect(captured.rateUpdated.length).toBe(1)
    expect(captured.ratesRefreshed.length).toBe(1)
    expect(captured.detailsUpdated.length).toBe(1)
    expect(captured.offlineQueue.length).toBe(1)
    expect(captured.syncStatus.length).toBe(1)
  })

  it('loggedIn is false until refreshUser populates user', async () => {
    captured = { ...captured }
    captured.getUser.mockResolvedValueOnce({ id: 42, nickname: 'alice' } as ShikiUser)
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.loggedIn).toBe(false)
    await store.refreshUser()
    expect(store.user).toEqual({ id: 42, nickname: 'alice' })
    expect(store.loggedIn).toBe(true)
  })

  it('upserts a new rate when onShikimoriRateUpdated fires for an unknown malId', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.rates).toEqual([])
    captured.rateUpdated[0](mkRate(100, 3))
    expect(store.rates.length).toBe(1)
    expect(store.rateByMalId(100)?.rate.episodes).toBe(3)
  })

  it('replaces the matching rate when onShikimoriRateUpdated fires for a known malId', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    captured.rateUpdated[0](mkRate(100, 3))
    captured.rateUpdated[0](mkRate(100, 7))
    expect(store.rates.length).toBe(1)
    expect(store.rateByMalId(100)?.rate.episodes).toBe(7)
  })

  it('replaces rates wholesale on onShikimoriRatesRefreshed', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    captured.rateUpdated[0](mkRate(1, 1))
    captured.ratesRefreshed[0]([mkRate(50, 5), mkRate(60, 6)])
    expect(store.rates.length).toBe(2)
    expect(store.rateByMalId(1)).toBeNull()
    expect(store.rateByMalId(50)?.rate.episodes).toBe(5)
  })

  it('upserts into animeDetails on onShikimoriAnimeDetailsUpdated', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.animeDetailsByMalId(99)).toBeNull()
    captured.detailsUpdated[0]({
      malId: 99,
      details: { id: 99, name: 'X' } as unknown as ShikiAnimeDetails
    })
    expect(store.animeDetailsByMalId(99)?.id).toBe(99)
  })

  it('updates offlineQueueLength on onShikimoriOfflineQueueChanged', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.offlineQueueLength).toBe(0)
    captured.offlineQueue[0]({ length: 11 })
    expect(store.offlineQueueLength).toBe(11)
  })

  it('refreshSyncStatus pulls IPC + mirrors queueLength to offlineQueueLength', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    await store.refreshSyncStatus()
    expect(store.syncStatus.queueLength).toBe(4)
    expect(store.offlineQueueLength).toBe(4)
  })

  it('triggerSync forwards to the IPC bridge', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    await store.triggerSync()
    expect(captured.triggerSync).toHaveBeenCalledTimes(1)
  })

  it('rateByMalId returns null for a falsy malId', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    captured.rateUpdated[0](mkRate(100, 1))
    expect(store.rateByMalId(0)).toBeNull()
  })
})
