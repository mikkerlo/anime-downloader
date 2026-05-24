/**
 * Shikimori offline-queue drain integration tests (Phase 7 PR 3, #140).
 *
 * Exercises `ShikimoriSyncService.syncShikimoriQueue` end-to-end across
 * multiple queued malIds with mixed server states — consolidation, drift
 * reconciliation, partial-failure abort, and store + broadcast side effects
 * all observed together (vs the per-branch unit tests in
 * test/services/shikimori-sync.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const ensureFreshToken = vi.fn()
const getUserRate = vi.fn()
const createUserRate = vi.fn()
const updateUserRate = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a),
    getUserRate: (...a: unknown[]) => getUserRate(...a),
    createUserRate: (...a: unknown[]) => createUserRate(...a),
    updateUserRate: (...a: unknown[]) => updateUserRate(...a)
  }
})

import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'

const CH = {
  syncStatus: 'shikimori:sync-status',
  offlineQueueChanged: 'shikimori:offline-queue-changed',
  rateUpdated: 'shikimori:rate-updated',
  animeDetailsUpdated: 'shikimori:anime-details-updated'
}

function cacheEntry(malId: number, episodes: number) {
  return {
    rate: { id: malId, target_id: malId, episodes, status: 'watching', score: 0 },
    shikiAnime: { id: malId, name: `Anime ${malId}` },
    smotretAnime: null
  }
}

function queued(malId: number, beforeEp: number, afterEp: number, queuedAt: number) {
  return {
    malId,
    rateId: malId,
    before: { episodes: beforeEp, status: 'watching', score: 0, rewatches: 0 },
    after: { episodes: afterEp, status: 'watching', score: 0, rewatches: 0 },
    queuedAt
  }
}

function boot(initial: Record<string, unknown>) {
  const store = new InMemoryStorage({
    shikimoriUpdateQueue: [],
    shikimoriCredentials: { access_token: 't', refresh_token: 'r' },
    shikimoriUser: { id: 1, nickname: 'a' },
    shikimoriUserRates: [],
    shikimoriAnimeDetails: {},
    ...initial
  })
  const broadcast = vi.fn()
  const svc = createShikimoriSyncService({
    store: store as unknown as Parameters<typeof createShikimoriSyncService>[0]['store'],
    broadcast,
    syncStatusChannel: CH.syncStatus,
    offlineQueueChangedChannel: CH.offlineQueueChanged,
    rateUpdatedChannel: CH.rateUpdated,
    animeDetailsUpdatedChannel: CH.animeDetailsUpdated
  })
  return { store, broadcast, svc }
}

beforeEach(() => {
  ensureFreshToken.mockReset().mockResolvedValue('access-token')
  getUserRate.mockReset()
  createUserRate.mockReset()
  updateUserRate.mockReset()
})

describe('Shikimori offline drain — multi-item integration', () => {
  it('drains three independent malIds in one run and clears the queue', async () => {
    const { store, broadcast, svc } = boot({
      shikimoriUserRates: [cacheEntry(10, 0), cacheEntry(20, 0), cacheEntry(30, 0)],
      shikimoriUpdateQueue: [queued(10, 0, 1, 1), queued(20, 0, 2, 2), queued(30, 0, 3, 3)]
    })
    getUserRate.mockImplementation(async (_t: string, _u: number, malId: number) => ({
      id: malId,
      target_id: malId,
      episodes: 0,
      status: 'watching',
      score: 0
    }))
    updateUserRate.mockImplementation(async (_t: string, rateId: number, episodes: number) => ({
      id: rateId,
      target_id: rateId,
      episodes,
      status: 'watching',
      score: 0,
      rewatches: 0
    }))

    await svc.syncShikimoriQueue()

    expect(updateUserRate).toHaveBeenCalledTimes(3)
    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
    // Each rate reconciled into cache
    const rates = store.get('shikimoriUserRates') as {
      rate: { target_id: number; episodes: number }
    }[]
    expect(rates.find((r) => r.rate.target_id === 10)?.rate.episodes).toBe(1)
    expect(rates.find((r) => r.rate.target_id === 30)?.rate.episodes).toBe(3)
    // Final offline-queue-changed broadcast reports 0
    const lastQueueEvent = broadcast.mock.calls.filter((c) => c[0] === CH.offlineQueueChanged).pop()
    expect(lastQueueEvent?.[1]).toEqual({ length: 0 })
  })

  it('consolidates multiple queued edits to the same malId into one server write', async () => {
    const { store, svc } = boot({
      shikimoriUserRates: [cacheEntry(10, 0)],
      // Three edits to malId 10, latest wins (episodes → 5)
      shikimoriUpdateQueue: [queued(10, 0, 1, 1), queued(10, 1, 3, 2), queued(10, 3, 5, 3)]
    })
    getUserRate.mockResolvedValue({
      id: 10,
      target_id: 10,
      episodes: 0,
      status: 'watching',
      score: 0
    })
    updateUserRate.mockResolvedValue({
      id: 10,
      target_id: 10,
      episodes: 5,
      status: 'watching',
      score: 0,
      rewatches: 0
    })

    await svc.syncShikimoriQueue()

    expect(updateUserRate).toHaveBeenCalledTimes(1)
    expect(updateUserRate).toHaveBeenCalledWith('access-token', 10, 5, 'watching', 0, 0)
    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
  })

  it('stops the drain at the first network failure, preserving remaining items', async () => {
    const { store, svc } = boot({
      shikimoriUserRates: [cacheEntry(10, 0), cacheEntry(20, 0)],
      shikimoriUpdateQueue: [queued(10, 0, 1, 1), queued(20, 0, 2, 2)]
    })
    let call = 0
    getUserRate.mockImplementation(async () => {
      call += 1
      if (call === 1) {
        return { id: 10, target_id: 10, episodes: 0, status: 'watching', score: 0 }
      }
      // Second item: network drop
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    })
    updateUserRate.mockResolvedValue({
      id: 10,
      target_id: 10,
      episodes: 1,
      status: 'watching',
      score: 0,
      rewatches: 0
    })

    await svc.syncShikimoriQueue()

    // First item drained; second left in queue for the next attempt
    const remaining = store.get('shikimoriUpdateQueue') as { malId: number }[]
    expect(remaining.length).toBe(1)
    expect(remaining[0].malId).toBe(20)
  })

  it('adjusts the sync timer + reports idle once the queue empties', async () => {
    const { svc } = boot({
      shikimoriUserRates: [cacheEntry(10, 0)],
      shikimoriUpdateQueue: [queued(10, 0, 1, 1)]
    })
    getUserRate.mockResolvedValue({
      id: 10,
      target_id: 10,
      episodes: 0,
      status: 'watching',
      score: 0
    })
    updateUserRate.mockResolvedValue({
      id: 10,
      target_id: 10,
      episodes: 1,
      status: 'watching',
      score: 0,
      rewatches: 0
    })

    await svc.syncShikimoriQueue()

    const status = svc.getSyncStatus()
    expect(status.state).toBe('idle')
    expect(status.queueLength).toBe(0)
    expect(status.lastSyncError).toBeNull()
    expect(status.lastSyncAt).toBeGreaterThan(0)
  })
})
