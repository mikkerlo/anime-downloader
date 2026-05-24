import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const ensureFreshToken = vi.fn()
const getUserRate = vi.fn()
const createUserRate = vi.fn()
const updateUserRate = vi.fn()
const getAnimeDetails = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...args: unknown[]) => ensureFreshToken(...args),
    getUserRate: (...args: unknown[]) => getUserRate(...args),
    createUserRate: (...args: unknown[]) => createUserRate(...args),
    updateUserRate: (...args: unknown[]) => updateUserRate(...args),
    getAnimeDetails: (...args: unknown[]) => getAnimeDetails(...args)
  }
})

import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { ShikiApiError } from '../../src/main/shikimori'

const CHANNELS = {
  syncStatus: 'shikimori:sync-status',
  offlineQueueChanged: 'shikimori:offline-queue-changed',
  rateUpdated: 'shikimori:rate-updated',
  animeDetailsUpdated: 'shikimori:anime-details-updated'
}

type Broadcast = ReturnType<typeof vi.fn>

function emptyRate(target_id: number) {
  return {
    rate: { id: target_id, target_id, episodes: 0, status: 'watching' as const, score: 0 },
    shikiAnime: { id: target_id, name: 'X' },
    smotretAnime: null
  }
}

function makeService(initial: Record<string, unknown> = {}): {
  store: InMemoryStorage
  broadcast: Broadcast
  svc: ReturnType<typeof createShikimoriSyncService>
} {
  const store = new InMemoryStorage({
    shikimoriUpdateQueue: [],
    shikimoriCredentials: { access_token: 'tok', refresh_token: 'r', token_type: 'Bearer' },
    shikimoriUser: { id: 1, nickname: 'a' },
    shikimoriUserRates: [],
    shikimoriAnimeDetails: {},
    ...initial
  })
  const broadcast = vi.fn()
  const svc = createShikimoriSyncService({
    store: store as unknown as Parameters<typeof createShikimoriSyncService>[0]['store'],
    broadcast,
    syncStatusChannel: CHANNELS.syncStatus,
    offlineQueueChangedChannel: CHANNELS.offlineQueueChanged,
    rateUpdatedChannel: CHANNELS.rateUpdated,
    animeDetailsUpdatedChannel: CHANNELS.animeDetailsUpdated
  })
  return { store, broadcast, svc }
}

beforeEach(() => {
  ensureFreshToken.mockReset()
  getUserRate.mockReset()
  createUserRate.mockReset()
  updateUserRate.mockReset()
  getAnimeDetails.mockReset()
  ensureFreshToken.mockResolvedValue('access-token')
})

describe('ShikimoriSyncService — sync status accessors', () => {
  it('reports zero queue when empty', () => {
    const { svc } = makeService()
    expect(svc.getQueueLength()).toBe(0)
    expect(svc.getSyncStatus()).toEqual({
      state: 'idle',
      queueLength: 0,
      lastSyncAt: 0,
      lastSyncError: null
    })
  })

  it('reports the queue length from store', () => {
    const { svc } = makeService({
      shikimoriUpdateQueue: [
        { malId: 1, queuedAt: 1, before: {}, after: {} },
        { malId: 2, queuedAt: 2, before: {}, after: {} }
      ]
    })
    expect(svc.getQueueLength()).toBe(2)
  })

  it('broadcastSyncStatus emits on the sync-status channel', () => {
    const { svc, broadcast } = makeService()
    svc.broadcastSyncStatus()
    expect(broadcast).toHaveBeenCalledWith(
      CHANNELS.syncStatus,
      expect.objectContaining({ state: 'idle', queueLength: 0 })
    )
  })
})

describe('ShikimoriSyncService — syncShikimoriQueue happy path', () => {
  it('returns immediately when the queue is empty', async () => {
    const { svc } = makeService()
    await svc.syncShikimoriQueue()
    expect(ensureFreshToken).not.toHaveBeenCalled()
    expect(getUserRate).not.toHaveBeenCalled()
  })

  it('returns immediately when not logged in', async () => {
    const { svc } = makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'watching', score: 0 },
          after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
        }
      ],
      shikimoriCredentials: null
    })
    await svc.syncShikimoriQueue()
    expect(ensureFreshToken).not.toHaveBeenCalled()
  })

  it('updates an existing rate when drift matches the recorded before-state', async () => {
    const { svc, store } = makeService({
      shikimoriUserRates: [emptyRate(100)],
      shikimoriUpdateQueue: [
        {
          malId: 100,
          queuedAt: 1,
          before: { episodes: 0, status: 'watching', score: 0 },
          after: { episodes: 3, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    getUserRate.mockResolvedValue({
      id: 999,
      target_id: 100,
      episodes: 0,
      status: 'watching',
      score: 0
    })
    updateUserRate.mockResolvedValue({
      id: 999,
      target_id: 100,
      episodes: 3,
      status: 'watching',
      score: 0,
      rewatches: 0
    })
    await svc.syncShikimoriQueue()
    expect(updateUserRate).toHaveBeenCalledWith('access-token', 999, 3, 'watching', 0, 0)
    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
    expect(
      (store.get('shikimoriUserRates') as { rate: { episodes: number } }[])[0].rate.episodes
    ).toBe(3)
  })

  it('creates a new rate when the server has no record (getUserRate -> null)', async () => {
    const { svc, store } = makeService({
      shikimoriUserRates: [emptyRate(50)],
      shikimoriUpdateQueue: [
        {
          malId: 50,
          queuedAt: 1,
          before: { episodes: 0, status: 'planned', score: 0 },
          after: { episodes: 0, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    getUserRate.mockResolvedValue(null)
    createUserRate.mockResolvedValue({
      id: 555,
      target_id: 50,
      episodes: 0,
      status: 'watching',
      score: 0
    })
    await svc.syncShikimoriQueue()
    expect(createUserRate).toHaveBeenCalledWith('access-token', 1, 50, 0, 'watching', 0, 0)
    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
  })

  it('applies on drift when after-progress is strictly ahead and status rank ≥ current', async () => {
    const { svc } = makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'planned', score: 0 },
          after: { episodes: 5, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    // Server drifted forward (different before-state), but after still > current.episodes
    getUserRate.mockResolvedValue({
      id: 1,
      target_id: 1,
      episodes: 2,
      status: 'watching',
      score: 0
    })
    updateUserRate.mockResolvedValue({
      id: 1,
      target_id: 1,
      episodes: 5,
      status: 'watching',
      score: 0,
      rewatches: 0
    })
    await svc.syncShikimoriQueue()
    expect(updateUserRate).toHaveBeenCalled()
  })

  it('skips update on drift when server is already further ahead', async () => {
    const { svc } = makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'planned', score: 0 },
          after: { episodes: 3, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    getUserRate.mockResolvedValue({
      id: 1,
      target_id: 1,
      episodes: 10,
      status: 'watching',
      score: 0
    })
    await svc.syncShikimoriQueue()
    expect(updateUserRate).not.toHaveBeenCalled()
  })

  it('skips update on drift when server has progressed past the after-status rank', async () => {
    const { svc } = makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'watching', score: 0 },
          after: { episodes: 5, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    // current.status = 'completed' (rank 3) > after.status = 'watching' (rank 1)
    getUserRate.mockResolvedValue({
      id: 1,
      target_id: 1,
      episodes: 12,
      status: 'completed',
      score: 0
    })
    await svc.syncShikimoriQueue()
    expect(updateUserRate).not.toHaveBeenCalled()
  })

  it('aborts the drain on a network error without dropping the item', async () => {
    const { svc, store } = makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'watching', score: 0 },
          after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    const netErr = Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' })
    getUserRate.mockRejectedValue(netErr)
    await svc.syncShikimoriQueue()
    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(1)
  })

  it('aborts the drain on 401 ShikiApiError', async () => {
    const { svc, store } = makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'watching', score: 0 },
          after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    getUserRate.mockRejectedValue(new ShikiApiError('unauthorized', 401))
    await svc.syncShikimoriQueue()
    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(1)
    expect(svc.getSyncStatus().lastSyncError).toBe('unauthorized')
  })

  it('drops the item on a non-network, non-auth error and continues', async () => {
    const { svc, store } = makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'watching', score: 0 },
          after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
        }
      ]
    })
    getUserRate.mockRejectedValue(new Error('weird unparseable error'))
    await svc.syncShikimoriQueue()
    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
  })
})

describe('ShikimoriSyncService — calendar cache', () => {
  it('starts empty', () => {
    const { svc } = makeService()
    expect(svc.getCachedCalendar()).toBeNull()
  })

  it('returns cached data after setCachedCalendar', () => {
    const { svc } = makeService()
    svc.setCachedCalendar([
      {
        malId: 1,
        animeId: null,
        name: 'A',
        posterUrl: '',
        kind: 'tv',
        episodeInt: '1',
        nextEpisodeAt: '2026-01-01',
        userStatus: 'watching'
      }
    ])
    const cached = svc.getCachedCalendar()
    expect(cached?.data.length).toBe(1)
    expect(cached?.data[0].name).toBe('A')
  })

  it('invalidateCalendarCache clears it', () => {
    const { svc } = makeService()
    svc.setCachedCalendar([])
    svc.invalidateCalendarCache()
    expect(svc.getCachedCalendar()).toBeNull()
  })
})

describe('ShikimoriSyncService — refreshShikimoriDetailsForMalId', () => {
  it('returns null when not logged in', async () => {
    const { svc } = makeService({ shikimoriCredentials: null })
    const result = await svc.refreshShikimoriDetailsForMalId(1)
    expect(result).toBeNull()
    expect(getAnimeDetails).not.toHaveBeenCalled()
  })

  it('writes details into cache + broadcasts on success', async () => {
    const { svc, store, broadcast } = makeService()
    const details = { id: 99, name: 'Anime' }
    getAnimeDetails.mockResolvedValue(details)
    const result = await svc.refreshShikimoriDetailsForMalId(99)
    expect(result).toEqual(details)
    const cache = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: unknown; fetchedAt: number }
    >
    expect(cache['99'].details).toEqual(details)
    expect(broadcast).toHaveBeenCalledWith(
      CHANNELS.animeDetailsUpdated,
      expect.objectContaining({ malId: 99, details })
    )
  })

  it('returns null on a network error without throwing', async () => {
    const { svc } = makeService()
    getAnimeDetails.mockRejectedValue(Object.assign(new Error('net'), { code: 'ENOTFOUND' }))
    const result = await svc.refreshShikimoriDetailsForMalId(1)
    expect(result).toBeNull()
  })
})
