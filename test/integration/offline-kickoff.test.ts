// The online edge of #567 against the real sync service, after S0b (#588)
// split unsynced changes into the signed-in user's live queue and per-user
// parked buckets: coming back online drains the live queue only, and parked
// buckets stay parked. After #600, a 429 during that drain stops it and keeps
// the queue.
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
    ensureFreshToken: (...args: unknown[]) => ensureFreshToken(...args),
    getUserRate: (...args: unknown[]) => getUserRate(...args),
    createUserRate: (...args: unknown[]) => createUserRate(...args),
    updateUserRate: (...args: unknown[]) => updateUserRate(...args)
  }
})

import { ShikiApiError } from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createOfflineService } from '../../src/main/services/offline'
import { createOfflineKickoff } from '../../src/main/services/offline/kickoff'

function entry(malId: number, queuedAt: number) {
  return {
    malId,
    rateId: null,
    queuedAt,
    before: { episodes: 0, status: 'watching', score: 0, rewatches: 0 },
    after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
  }
}

const serverRate = (malId: number) => ({
  id: 900 + malId,
  target_id: malId,
  episodes: 0,
  status: 'watching',
  score: 0,
  rewatches: 0
})

const PARKED = {
  '2': { nickname: 'other', entries: [entry(50, 3)], parkedAt: 9 },
  unknown: { nickname: null, entries: [entry(60, 4)], parkedAt: 9 }
}

function boot(): {
  store: InMemoryStorage
  goOnline: () => void
} {
  const store = new InMemoryStorage({
    workOffline: true,
    shikimoriCredentials: { access_token: 'tok', refresh_token: 'r' },
    shikimoriUser: { id: 1, nickname: 'me' },
    shikimoriUpdateQueue: [entry(10, 1), entry(11, 2)],
    shikimoriParkedQueues: structuredClone(PARKED),
    shikimoriUserRates: [],
    shikimoriAnimeDetails: {}
  })
  // `offline` is read through a late binding, as `index.ts` does.
  const ref: { isOffline: () => boolean } = { isOffline: () => true }
  const sync = createShikimoriSyncService({
    store,
    broadcast: vi.fn(),
    syncStatusChannel: 's',
    offlineQueueChangedChannel: 'q',
    rateUpdatedChannel: 'r',
    animeDetailsUpdatedChannel: 'd',
    isOffline: () => ref.isOffline()
  })
  const kickoff = createOfflineKickoff({
    syncShikimoriQueue: () => sync.syncShikimoriQueue(),
    suspendDownloads: vi.fn(),
    resumeDownloads: vi.fn(),
    suspendSyncplay: vi.fn(),
    resumeSyncplay: vi.fn(),
    retryBinaries: vi.fn(),
    runAutoDownloadTick: vi.fn(),
    prefetchShikimoriDetails: vi.fn()
  })
  const offline = createOfflineService({
    store,
    probeUrls: () => [],
    onOnline: kickoff.onOnline,
    onOffline: kickoff.onOffline
  })
  ref.isOffline = offline.isOffline
  return { store, goOnline: () => offline.setManual(false) }
}

/** The drain sleeps 250 ms between items. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000)
}

beforeEach(() => {
  vi.useFakeTimers()
  ensureFreshToken.mockReset().mockResolvedValue('access-token')
  getUserRate.mockReset().mockImplementation(async (_t, _u, malId: number) => serverRate(malId))
  createUserRate.mockReset()
  updateUserRate.mockReset().mockImplementation(async (_t, rateId: number) => ({
    ...serverRate(rateId - 900),
    episodes: 1
  }))
})

describe('the online edge drains the live queue only (#567 × #588)', () => {
  it('sends the signed-in user’s entries and leaves every parked bucket alone', async () => {
    const { store, goOnline } = boot()
    goOnline()
    await settle()

    const drained = getUserRate.mock.calls.map((c) => c[2])
    expect(drained.sort()).toEqual([10, 11])
    expect(getUserRate.mock.calls.every((c) => c[1] === 1)).toBe(true)
    expect(store.get('shikimoriUpdateQueue')).toEqual([])
    expect(store.get('shikimoriParkedQueues')).toEqual(PARKED)
  })

  it('nothing drains while still offline', async () => {
    const { store } = boot()
    await settle()
    expect(getUserRate).not.toHaveBeenCalled()
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(2)
  })

  it('a 429 during the online drain stops it and keeps the queue (#600)', async () => {
    getUserRate.mockReset().mockRejectedValue(new ShikiApiError('Shikimori API error: 429', 429))
    const { store, goOnline } = boot()
    goOnline()
    await settle()
    expect(getUserRate).toHaveBeenCalledTimes(1)
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(2)
    expect(store.get('shikimoriParkedQueues')).toEqual(PARKED)
  })
})
