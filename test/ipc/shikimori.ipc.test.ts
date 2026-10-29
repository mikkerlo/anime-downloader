// Behavior of the Shikimori IPC router around an expired OAuth session (#244).
//
// The reported bug lives here: `SHIKIMORI_UPDATE_RATE` calls `ensureFreshToken`
// inside its `try`, so a dead refresh token surfaced as an opaque
// `ShikiApiError: Shikimori API error: 400` *and* discarded the edit the user
// had just made — the queue-and-optimistically-update branch only accepted
// network errors.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const ensureFreshToken = vi.fn()
const getUserRate = vi.fn()
const createUserRate = vi.fn()
const updateUserRate = vi.fn()
const getUser = vi.fn()
const exchangeCode = vi.fn()
const getUserAnimeRates = vi.fn()

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
    getUser: (...args: unknown[]) => getUser(...args),
    exchangeCode: (...args: unknown[]) => exchangeCode(...args),
    getUserAnimeRates: (...args: unknown[]) => getUserAnimeRates(...args)
  }
})

import { register } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { ShikiApiError, ShikiAuthError, SESSION_EXPIRED_MESSAGE } from '../../src/main/shikimori'
import type { ShikiUser } from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'

type SyncStub = {
  broadcastSyncStatus: Mock
  startSyncTimer: Mock
  stopSyncTimer: Mock
  syncShikimoriQueue: Mock
  invalidateCalendarCache: Mock
  clearOfflineSnapshots: Mock
  abortPrefetch: Mock
  setOnDetailsPrefetched: Mock
  prefetchShikimoriDetails: Mock
  getSyncStatus: Mock
  fetchAndCacheRates: ReturnType<typeof createShikimoriSyncService>['fetchAndCacheRates']
  refreshRates: ReturnType<typeof createShikimoriSyncService>['refreshRates']
  invalidateRecommendations: () => void
}

/**
 * `shikimori.ipc.ts` reaches for five `AppDeps` members; only the store is real.
 * The sync service is a spy surface — the assertions below are about *which*
 * signals the router emits, not about what the drain then does with them.
 */
function registerRouter(initial: Record<string, unknown> = {}): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  store: InMemoryStorage
  broadcast: Mock
  sync: SyncStub
  funnels: ReturnType<typeof register>
} {
  const store = new InMemoryStorage({
    shikimoriUser: { id: 7, nickname: 'me' },
    shikimoriUserRates: [],
    shikimoriUpdateQueue: [],
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [],
    ...initial
  })
  const broadcast = vi.fn()
  const getSyncStatus = vi.fn(() => ({
    state: 'idle' as const,
    queueLength: (store.get('shikimoriUpdateQueue') as unknown[]).length,
    lastSyncAt: 0,
    lastSyncError: null,
    // Mirrors the real service, which reads the flag back from the store — the
    // point being that the router must *emit* a status at all here.
    sessionExpired: Boolean(store.get('shikimoriSessionExpired'))
  }))
  const sync: SyncStub = {
    broadcastSyncStatus: vi.fn(() =>
      broadcast(EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS, getSyncStatus())
    ),
    startSyncTimer: vi.fn(),
    stopSyncTimer: vi.fn(),
    syncShikimoriQueue: vi.fn(async () => undefined),
    invalidateCalendarCache: vi.fn(),
    clearOfflineSnapshots: vi.fn(),
    abortPrefetch: vi.fn(),
    setOnDetailsPrefetched: vi.fn(),
    prefetchShikimoriDetails: vi.fn(async () => undefined),
    getSyncStatus,
    // The rate refresh moved into the service (#592): the real one, on this store.
    ...(() => {
      const real = createShikimoriSyncService({
        store,
        broadcast,
        syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
        offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
        rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
        animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED
      } as unknown as Parameters<typeof createShikimoriSyncService>[0])
      return {
        fetchAndCacheRates: real.fetchAndCacheRates,
        refreshRates: real.refreshRates,
        invalidateRecommendations: real.invalidateRecommendations
      }
    })()
  }
  const funnels = register({
    store,
    shikimoriSyncService: sync,
    lookupByMalIds: vi.fn(async () => new Map()),
    maybeBroadcastCleanupPrompt: vi.fn(async () => undefined),
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast
  } as unknown as AppDeps)

  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel, ...args) => handlers.get(channel)!({}, ...args),
    store,
    broadcast,
    sync,
    funnels
  }
}

function cachedRate(malId: number): unknown {
  return {
    rate: { id: 900 + malId, target_id: malId, episodes: 3, status: 'watching', score: 7 },
    shikiAnime: { id: malId },
    smotretAnime: null
  }
}

/** `update-rate(malId, episodes, status, score, rewatches)`. */
function updateRate(invoke: (c: string, ...a: unknown[]) => Promise<unknown>): Promise<unknown> {
  return invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 42, 4, 'watching', 7, 0)
}

beforeEach(() => {
  vi.clearAllMocks()
  ensureFreshToken.mockResolvedValue('access-token')
  getUserRate.mockReset()
  createUserRate.mockReset()
  updateUserRate.mockReset()
  getUserAnimeRates.mockReset()
  getUserAnimeRates.mockResolvedValue([])
})

describe('shikimori IPC — update-rate against an expired session', () => {
  it('retains the edit in the offline queue instead of throwing it away', async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    const result = await updateRate(invoke)

    const queue = store.get('shikimoriUpdateQueue') as { malId: number; after: unknown }[]
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ malId: 42, after: { episodes: 4, status: 'watching' } })
    expect(result).toMatchObject({ episodes: 4 })
  })

  it('optimistically updates the cached rate so the panel keeps the new count', async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    await updateRate(invoke)

    const cached = store.get('shikimoriUserRates') as { rate: { episodes: number } }[]
    expect(cached[0].rate.episodes).toBe(4)
  })

  it('broadcasts a sync status carrying sessionExpired so the banner appears', async () => {
    // The delivery half of the fix: this branch used to broadcast only the
    // queue length, and the renderer polls sync status from one view (#244 §6).
    const { invoke, broadcast, store } = registerRouter({
      shikimoriUserRates: [cachedRate(42)],
      shikimoriSessionExpired: true
    })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    await updateRate(invoke)

    expect(store.get('shikimoriSessionExpired')).toBe(true)
    expect(broadcast).toHaveBeenCalledWith(
      EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
      expect.objectContaining({ sessionExpired: true })
    )
  })

  it('does not start the sync timer — the drain cannot run without credentials', async () => {
    const { invoke, sync } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    await updateRate(invoke)

    expect(sync.startSyncTimer).not.toHaveBeenCalled()
  })
})

describe('shikimori IPC — update-rate against a genuine API error', () => {
  it('still rethrows a 422 from user_rates rather than queueing it', async () => {
    // The guard on the widened predicate: queueing validation failures would
    // jam the drain on one malformed entry forever (#244 §2).
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockRejectedValue(new ShikiApiError('Shikimori API error: 422 (bad score)', 422))

    await expect(updateRate(invoke)).rejects.toThrow(/422/)
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(0)
  })

  it('still rethrows a plain 400 from user_rates', async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockResolvedValue({ id: 1 })
    updateUserRate.mockRejectedValue(new ShikiApiError('Shikimori API error: 400', 400))

    await expect(updateRate(invoke)).rejects.toThrow(/400/)
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(0)
  })

  it('still rethrows offline for a title with no cached entry (mark-watched is the path that queues it)', async () => {
    const { invoke, store } = registerRouter()
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    await expect(updateRate(invoke)).rejects.toThrow(/fetch failed/)
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(0)
  })
})

type QueueEntry = {
  malId: number
  rateId: number | null
  before: { episodes: number; status: string; score: number; rewatches: number }
  after: { episodes: number; status: string; score: number; rewatches: number }
}

/** `mark-episode-watched(malId, epNum)`. */
function markWatched(
  invoke: (c: string, ...a: unknown[]) => Promise<unknown>,
  epNum: number,
  malId = 42
): Promise<unknown> {
  return invoke(CHANNELS.SHIKIMORI_MARK_EPISODE_WATCHED, malId, epNum)
}

/**
 * As `PlayerView` calls it: a throw is caught and only warned about, so it
 * loses the mark exactly like a silent no-op. The hole tests therefore assert
 * the queue, not whether the call rejected.
 */
function markAsPlayer(
  invoke: (c: string, ...a: unknown[]) => Promise<unknown>,
  epNum: number
): Promise<unknown> {
  return markWatched(invoke, epNum).catch((err: unknown) => err)
}

function queueOf(store: InMemoryStorage): QueueEntry[] {
  return store.get('shikimoriUpdateQueue') as QueueEntry[]
}

// get-rate used to be network-only, so the detail page lost the user's status
// whenever the read failed, although the whole list is cached (#570).
describe('shikimori IPC — get-rate falls back to the cached list (#570)', () => {
  const STALE_42 = {
    id: 942,
    score: 7,
    status: 'watching',
    episodes: 3,
    rewatches: 0,
    target_id: 42,
    target_type: 'Anime',
    stale: true
  }

  it("a fetch that rejects TypeError('fetch failed') returns the cached entry, stale", async () => {
    const { invoke } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))
    expect(await invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).toEqual(STALE_42)
  })

  it('an expired session answers from the cache too', async () => {
    const { invoke } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))
    expect(await invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).toEqual(STALE_42)
    expect(getUserRate).not.toHaveBeenCalled()
  })

  it('matches an older entry without target_id by shikiAnime.id', async () => {
    const legacy = {
      rate: { id: 5, episodes: 1, status: 'planned', score: 0 },
      shikiAnime: { id: 42 },
      smotretAnime: null
    }
    const { invoke } = registerRouter({ shikimoriUserRates: [legacy] })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))
    expect(await invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).toMatchObject({
      id: 5,
      target_id: 42,
      stale: true
    })
  })

  it('a title missing from a non-empty cache returns null', async () => {
    const { invoke } = registerRouter({ shikimoriUserRates: [cachedRate(7)] })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))
    expect(await invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).toBeNull()
  })

  it('an empty (never loaded) cache rethrows', async () => {
    const { invoke } = registerRouter({ shikimoriUserRates: [] })
    const err = new TypeError('fetch failed')
    getUserRate.mockRejectedValue(err)
    await expect(invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).rejects.toBe(err)
  })

  it('a ShikiApiError(422) still rethrows', async () => {
    const { invoke } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    const err = new ShikiApiError('Shikimori API error: 422', 422)
    getUserRate.mockRejectedValue(err)
    await expect(invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).rejects.toBe(err)
  })

  it('a successful read returns the live rate, without stale', async () => {
    const { invoke } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    const live = { id: 942, score: 9, status: 'completed', episodes: 12, rewatches: 0 }
    getUserRate.mockResolvedValue(live)
    expect(await invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).toEqual(live)
  })

  it("an account switch during the read rethrows rather than serve the new account's list", async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    const err = new TypeError('fetch failed')
    getUserRate.mockImplementation(async () => {
      store.set('shikimoriUser', { id: 8, nickname: 'other' })
      throw err
    })
    await expect(invoke(CHANNELS.SHIKIMORI_GET_RATE, 42)).rejects.toBe(err)
  })
})

// The player's auto-mark used to be a renderer-side get-rate then update-rate.
// The get threw first on all three failures below, so the mark never reached
// update-rate's queue and was lost for good (#565). Each test is one hole; on
// the old sequence each leaves the queue at length 0.
describe('shikimori IPC — mark-episode-watched queues instead of losing the mark (#565)', () => {
  it('hole 1, offline: queues the next rate computed from the cached entry', async () => {
    const { invoke, store, sync } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    const result = await markAsPlayer(invoke, 4)

    expect(queueOf(store)).toHaveLength(1)
    expect(queueOf(store)[0]).toMatchObject({
      malId: 42,
      rateId: 942,
      before: { episodes: 3, status: 'watching', score: 7, rewatches: 0 },
      after: { episodes: 4, status: 'watching', score: 7, rewatches: 0 }
    })
    expect(result).toMatchObject({ id: 942, episodes: 4, status: 'watching' })
    const cached = store.get('shikimoriUserRates') as { rate: { episodes: number } }[]
    expect(cached[0].rate.episodes).toBe(4)
    expect(sync.startSyncTimer).toHaveBeenCalledTimes(1)
  })

  it('hole 2, expired session: queues it, and leaves the timer off like update-rate does', async () => {
    const { invoke, store, sync, broadcast } = registerRouter({
      shikimoriUserRates: [cachedRate(42)],
      shikimoriSessionExpired: true
    })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    await markAsPlayer(invoke, 4)

    expect(queueOf(store)).toHaveLength(1)
    expect(queueOf(store)[0]).toMatchObject({ malId: 42, rateId: 942, after: { episodes: 4 } })
    expect(getUserRate).not.toHaveBeenCalled()
    expect(sync.startSyncTimer).not.toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith(
      EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
      expect.objectContaining({ sessionExpired: true, queueLength: 1 })
    )
  })

  it('hole 3, a title not on the list yet: queues rateId null with an empty planned before', async () => {
    const { invoke, store, broadcast } = registerRouter()
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    const result = await markAsPlayer(invoke, 1)

    expect(queueOf(store)).toHaveLength(1)
    expect(queueOf(store)[0]).toMatchObject({
      malId: 42,
      rateId: null,
      before: { episodes: 0, status: 'planned', score: 0, rewatches: 0 },
      after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
    })
    expect(result).toMatchObject({ id: -1, episodes: 1, status: 'watching' })
    expect(store.get('shikimoriUserRates')).toEqual([])
    expect(broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, {
      length: 1
    })
  })

  it('hole 3 also holds for an expired session', async () => {
    const { invoke, store } = registerRouter()
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    await markAsPlayer(invoke, 1)

    expect(queueOf(store)).toHaveLength(1)
    expect(queueOf(store)[0]).toMatchObject({ rateId: null, after: { episodes: 1 } })
  })

  it('the drain creates the rate a hole-3 entry stands for', async () => {
    const { invoke, store } = registerRouter({
      shikimoriCredentials: { access_token: 't', refresh_token: 'r' }
    })
    getUserRate.mockRejectedValueOnce(new TypeError('fetch failed'))
    await markWatched(invoke, 1)

    getUserRate.mockResolvedValue(null)
    createUserRate.mockResolvedValue({
      id: 5001,
      target_id: 42,
      episodes: 1,
      status: 'watching',
      score: 0,
      rewatches: 0
    })
    const drain = createShikimoriSyncService({
      store,
      broadcast: vi.fn(),
      syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
      offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
      rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
      animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED
    } as unknown as Parameters<typeof createShikimoriSyncService>[0])
    await drain.syncShikimoriQueue()

    expect(createUserRate).toHaveBeenCalledWith('access-token', 7, 42, 1, 'watching', 0, 0)
    expect(queueOf(store)).toHaveLength(0)
  })
})

describe('shikimori IPC — mark-episode-watched next-rate rule', () => {
  function remote(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 942,
      target_id: 42,
      target_type: 'Anime',
      episodes: 3,
      status: 'watching',
      score: 7,
      rewatches: 0,
      ...over
    }
  }

  it('online: decides from the live rate and writes forward progress', async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockResolvedValue(remote())
    updateUserRate.mockResolvedValue(remote({ episodes: 4 }))

    await markWatched(invoke, 4)

    expect(updateUserRate).toHaveBeenCalledWith('access-token', 942, 4, 'watching', 7, 0)
    expect(queueOf(store)).toHaveLength(0)
  })

  it('online: never lowers a count the live rate already has past the stale cache', async () => {
    // The cache says 3; shikimori.one moved it to 7. Watching episode 4 must not
    // send 4, which is what deciding from the cache online would do.
    const { invoke } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockResolvedValue(remote({ episodes: 7 }))

    expect(await markWatched(invoke, 4)).toBeNull()
    expect(updateUserRate).not.toHaveBeenCalled()
  })

  it('online: creates the rate when the title is not on the list', async () => {
    const { invoke } = registerRouter()
    getUserRate.mockResolvedValue(null)
    createUserRate.mockResolvedValue(remote({ episodes: 1, score: 0 }))

    await markWatched(invoke, 1)

    expect(createUserRate).toHaveBeenCalledWith('access-token', 7, 42, 1, 'watching', 0, 0)
  })

  it('online: a completed title starts a rewatch from the episode with rewatches + 1', async () => {
    const { invoke } = registerRouter()
    getUserRate.mockResolvedValue(remote({ episodes: 12, status: 'completed', rewatches: 1 }))
    updateUserRate.mockResolvedValue(remote())

    await markWatched(invoke, 1)

    expect(updateUserRate).toHaveBeenCalledWith('access-token', 942, 1, 'rewatching', 7, 2)
  })

  it('online: queues against the live rate when the write itself fails offline', async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockResolvedValue(remote({ episodes: 5 }))
    updateUserRate.mockRejectedValue(new TypeError('fetch failed'))

    await markWatched(invoke, 6)

    expect(queueOf(store)).toHaveLength(1)
    expect(queueOf(store)[0]).toMatchObject({
      rateId: 942,
      before: { episodes: 5, status: 'watching' },
      after: { episodes: 6, status: 'watching' }
    })
  })

  it('offline: a completed cache entry flips to rewatching once, not on every episode', async () => {
    const completed = {
      rate: { id: 942, target_id: 42, episodes: 12, status: 'completed', score: 9, rewatches: 0 },
      shikiAnime: { id: 42 },
      smotretAnime: null
    }
    const { invoke, store } = registerRouter({ shikimoriUserRates: [completed] })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    await markWatched(invoke, 1)
    await markWatched(invoke, 2)

    expect(queueOf(store).map((e) => e.after)).toEqual([
      { episodes: 1, status: 'rewatching', score: 9, rewatches: 1 },
      { episodes: 2, status: 'watching', score: 9, rewatches: 1 }
    ])
  })

  it('offline: an episode at or below the cached count queues nothing', async () => {
    const { invoke, store, broadcast } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    expect(await markWatched(invoke, 3)).toBeNull()
    expect(queueOf(store)).toHaveLength(0)
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('still rethrows a 422 rather than queueing it', async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockRejectedValue(new ShikiApiError('Shikimori API error: 422 (bad score)', 422))

    await expect(markWatched(invoke, 4)).rejects.toThrow(/422/)
    expect(queueOf(store)).toHaveLength(0)
  })

  it('signed out: does nothing and queues nothing', async () => {
    const { invoke, store } = registerRouter({ shikimoriUser: null })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError('not connected'))

    expect(await markWatched(invoke, 4)).toBeNull()
    expect(ensureFreshToken).not.toHaveBeenCalled()
    expect(queueOf(store)).toHaveLength(0)
  })
})

describe('shikimori IPC — session lifecycle', () => {
  it('exchange-code clears the expiry flag, restarts the timer and kicks a drain', async () => {
    const { invoke, store, sync, broadcast } = registerRouter({ shikimoriSessionExpired: true })
    exchangeCode.mockResolvedValue({
      access_token: 'fake-access-token-new',
      refresh_token: 'fake-refresh-token-new',
      created_at: 1,
      expires_in: 86_400
    })
    getUser.mockResolvedValue({ id: 7, nickname: 'me' })

    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')

    expect(store.get('shikimoriSessionExpired')).toBe(false)
    expect(sync.startSyncTimer).toHaveBeenCalled()
    expect(sync.syncShikimoriQueue).toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith(
      EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
      expect.objectContaining({ sessionExpired: false })
    )
  })

  it('logout clears the expiry flag, so disconnecting while expired is not sticky', async () => {
    const { invoke, store } = registerRouter({ shikimoriSessionExpired: true })

    await invoke(CHANNELS.SHIKIMORI_LOGOUT)

    expect(store.get('shikimoriSessionExpired')).toBe(false)
    expect(store.get('shikimoriUser')).toBeNull()
    // An empty queue parks nothing: no empty bucket for the kept-changes row.
    expect(store.get('shikimoriParkedQueues') ?? {}).toEqual({})

    const seeded = registerRouter({ shikimoriSessionExpired: true, shikimoriUpdateQueue: seed() })
    await seeded.invoke(CHANNELS.SHIKIMORI_LOGOUT)
    expect(parkedOf(seeded.store)['7'].entries).toEqual(seed())
  })
})

type Entry = QueueEntry & { queuedAt: number }

/**
 * Three entries owned by user 7. The middle one is S0's (#566) shape for a
 * title with no rate yet: `rateId: null` and the synthetic empty-`planned`
 * `before`.
 */
function seed(): Entry[] {
  return [
    {
      malId: 42,
      rateId: 942,
      before: { episodes: 3, status: 'watching', score: 7, rewatches: 0 },
      after: { episodes: 4, status: 'watching', score: 7, rewatches: 0 },
      queuedAt: 100
    },
    {
      malId: 43,
      rateId: null,
      before: { episodes: 0, status: 'planned', score: 0, rewatches: 0 },
      after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 },
      queuedAt: 200
    },
    {
      malId: 44,
      rateId: 944,
      before: { episodes: 10, status: 'watching', score: 0, rewatches: 0 },
      after: { episodes: 12, status: 'completed', score: 8, rewatches: 0 },
      queuedAt: 300
    }
  ]
}

type Bucket = { nickname: string; entries: Entry[]; parkedAt: number }

function parkedOf(store: InMemoryStorage): Record<string, Bucket> {
  return (store.get('shikimoriParkedQueues') as Record<string, Bucket> | undefined) ?? {}
}

const CREDS_B = {
  access_token: 'access-b',
  refresh_token: 'refresh-b',
  created_at: 1,
  expires_in: 86_400
}
const CREDS_A = { ...CREDS_B, access_token: 'access-a', refresh_token: 'refresh-a' }

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('shikimori IPC — unsynced changes on logout and account switch (#588)', () => {
  it.each([
    ['{ pending: keep }', { pending: 'keep' }],
    ['no argument', undefined]
  ])('logout with %s keeps the queue for its owner', async (_label, opts) => {
    const { invoke, store, broadcast } = registerRouter({ shikimoriUpdateQueue: seed() })

    await invoke(CHANNELS.SHIKIMORI_LOGOUT, opts)

    const kept = Object.values(parkedOf(store)).flatMap((b) => b.entries)
    expect(queueOf(store).length + kept.length).toBe(3)
    expect(queueOf(store)).toHaveLength(0)
    expect(parkedOf(store)['7'].entries).toEqual(seed())
    expect(parkedOf(store)['7'].nickname).toBe('me')
    expect(broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, {
      length: 0
    })
  })

  it('logout with { pending: discard } drops the queue and parks nothing', async () => {
    const { invoke, store } = registerRouter({ shikimoriUpdateQueue: seed() })

    await invoke(CHANNELS.SHIKIMORI_LOGOUT, { pending: 'discard' })

    expect(queueOf(store)).toHaveLength(0)
    expect(parkedOf(store)).toEqual({})
  })

  it('a switch parks the old queue, resets the user caches and refreshes the views', async () => {
    const { invoke, store, broadcast, sync } = registerRouter({
      shikimoriSessionExpired: true,
      shikimoriUpdateQueue: seed(),
      shikimoriUserRates: [cachedRate(42)],
      shikimoriProfile: { id: 7 },
      shikimoriFriends: [{ id: 1 }]
    })
    exchangeCode.mockResolvedValue(CREDS_B)
    getUser.mockResolvedValue({ id: 8, nickname: 'other' })

    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')

    expect(store.get('shikimoriUser')).toEqual({ id: 8, nickname: 'other' })
    expect(queueOf(store)).toHaveLength(0)
    expect(parkedOf(store)['7'].entries).toEqual(seed())
    expect(store.get('shikimoriUserRates')).toEqual([])
    expect(store.get('shikimoriProfile')).toBeNull()
    expect(store.get('shikimoriFriends')).toEqual([])
    expect(sync.abortPrefetch).toHaveBeenCalled()
    expect(sync.clearOfflineSnapshots).toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, {
      length: 0
    })

    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED, [])
    )
  })

  it('the switch window: nothing is saved until getUser resolves, then credentials and user land together', async () => {
    const { invoke, store } = registerRouter({
      shikimoriSessionExpired: true,
      shikimoriCredentials: null,
      shikimoriUpdateQueue: seed()
    })
    exchangeCode.mockResolvedValue(CREDS_B)
    const user = deferred<{ id: number; nickname: string }>()
    getUser.mockReturnValue(user.promise)

    const pending = invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
    await vi.waitFor(() => expect(getUser).toHaveBeenCalled())

    expect(store.get('shikimoriCredentials')).toBeNull()
    expect(store.get('shikimoriUser')).toEqual({ id: 7, nickname: 'me' })

    // Whatever runs next after the credentials write (a drain tick, say) must
    // already see the new user: the two writes share one synchronous block.
    const userNextTick: unknown[] = []
    const set = store.set.bind(store)
    vi.spyOn(store, 'set').mockImplementation((key: string, value: unknown) => {
      set(key, value)
      if (key === 'shikimoriCredentials') {
        queueMicrotask(() => userNextTick.push(store.get('shikimoriUser')))
      }
    })
    user.resolve({ id: 8, nickname: 'other' })
    await pending

    expect(store.get('shikimoriCredentials')).toEqual(CREDS_B)
    expect(userNextTick).toEqual([{ id: 8, nickname: 'other' }])
  })

  it('a real 7→7 reconnect parks nothing and keeps the caches', async () => {
    const live = seed().slice(0, 2)
    const { invoke, store, sync } = registerRouter({
      shikimoriSessionExpired: true,
      shikimoriUpdateQueue: live,
      shikimoriUserRates: [cachedRate(42)]
    })
    exchangeCode.mockResolvedValue(CREDS_A)
    getUser.mockResolvedValue({ id: 7, nickname: 'me' })

    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')

    expect(queueOf(store)).toEqual(live)
    expect(store.get('shikimoriUserRates')).toEqual([cachedRate(42)])
    expect(parkedOf(store)).toEqual({})
    expect(sync.abortPrefetch).not.toHaveBeenCalled()
    expect(sync.clearOfflineSnapshots).not.toHaveBeenCalled()
  })

  it('the same user signing back in gets their kept changes back verbatim', async () => {
    const shuffled = [seed()[2], seed()[0], seed()[1]]
    const { invoke, store, broadcast, sync } = registerRouter({
      shikimoriUser: null,
      shikimoriParkedQueues: { '7': { nickname: 'me', entries: shuffled, parkedAt: 1 } }
    })
    exchangeCode.mockResolvedValue(CREDS_A)
    getUser.mockResolvedValue({ id: 7, nickname: 'me' })

    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')

    expect(queueOf(store)).toEqual(seed())
    expect(parkedOf(store)).toEqual({})
    expect(broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, {
      length: 3
    })
    expect(sync.syncShikimoriQueue).toHaveBeenCalled()
  })

  it('ownerless entries go to the unknown bucket, not to whoever signs in', async () => {
    const { invoke, store } = registerRouter({
      shikimoriUser: null,
      shikimoriUpdateQueue: seed().slice(0, 2)
    })
    exchangeCode.mockResolvedValue(CREDS_B)
    getUser.mockResolvedValue({ id: 8, nickname: 'other' })

    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')

    expect(queueOf(store)).toHaveLength(0)
    expect(parkedOf(store).unknown.entries).toEqual(seed().slice(0, 2))
    expect(parkedOf(store)['8']).toBeUndefined()
  })

  it('an edit whose owner was switched away during its await is kept for that owner', async () => {
    const { invoke, store, broadcast } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    const token = deferred<string>()
    ensureFreshToken.mockReturnValueOnce(token.promise)
    exchangeCode.mockResolvedValue(CREDS_B)
    getUser.mockResolvedValue({ id: 8, nickname: 'other' })
    getUserAnimeRates.mockReturnValue(new Promise(() => {}))

    const edit = updateRate(invoke)
    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
    // B's own list, as the switch's background refresh would cache it: the
    // same title at B's values, which must not become A's `before`.
    const bobsEntry = {
      rate: { id: 5042, target_id: 42, episodes: 9, status: 'completed', score: 2 },
      shikiAnime: { id: 42 },
      smotretAnime: null
    }
    store.set('shikimoriUserRates', [bobsEntry])
    broadcast.mockClear()
    token.reject(new TypeError('fetch failed'))
    await edit

    expect(queueOf(store)).toHaveLength(0)
    expect(store.get('shikimoriUserRates')).toEqual([bobsEntry])
    // Connectors reloads its kept-changes rows on this broadcast.
    expect(broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, {
      length: 0
    })
    expect(broadcast).not.toHaveBeenCalledWith(
      EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
      expect.anything()
    )
    expect(parkedOf(store)['7'].entries).toEqual([
      expect.objectContaining({
        malId: 42,
        rateId: 942,
        before: { episodes: 3, status: 'watching', score: 7, rewatches: 0 },
        after: { episodes: 4, status: 'watching', score: 7, rewatches: 0 }
      })
    ])
  })

  it('lists kept queues and discards one bucket at a time', async () => {
    const { invoke, store } = registerRouter({
      shikimoriParkedQueues: {
        '9': { nickname: 'nine', entries: seed(), parkedAt: 5 },
        '10': { nickname: 'ten', entries: seed().slice(0, 1), parkedAt: 6 },
        unknown: { nickname: '', entries: seed().slice(0, 2), parkedAt: 7 }
      }
    })

    expect(await invoke(CHANNELS.SHIKIMORI_GET_PARKED_QUEUES)).toEqual(
      expect.arrayContaining([
        { ownerId: 9, nickname: 'nine', count: 3, parkedAt: 5 },
        { ownerId: 10, nickname: 'ten', count: 1, parkedAt: 6 },
        { ownerId: null, nickname: '', count: 2, parkedAt: 7 }
      ])
    )

    await invoke(CHANNELS.SHIKIMORI_DISCARD_PARKED_QUEUE, 9)
    expect(Object.keys(parkedOf(store)).sort()).toEqual(['10', 'unknown'])

    await invoke(CHANNELS.SHIKIMORI_DISCARD_PARKED_QUEUE, null)
    expect(Object.keys(parkedOf(store))).toEqual(['10'])
  })
})

// The previous account's network results must not land in the new account's
// cache once a switch has reset it (#588 review). Each case resolves A's
// request only after B has signed in and B's own list is cached.
describe('shikimori IPC — stale-account results after a switch (#588)', () => {
  const USER_B = { id: 8, nickname: 'other' }
  const bobsEntry = {
    rate: { id: 5042, target_id: 42, episodes: 9, status: 'completed', score: 2 },
    shikiAnime: { id: 42 },
    smotretAnime: null
  }

  function animeRate(malId: number, episodes: number) {
    return {
      id: 900 + malId,
      score: 0,
      status: 'watching',
      episodes,
      rewatches: 0,
      updated_at: '2026-01-01T00:00:00Z',
      anime: { id: malId }
    }
  }

  async function switchToB(invoke: (c: string, ...a: unknown[]) => Promise<unknown>) {
    exchangeCode.mockResolvedValue(CREDS_B)
    getUser.mockResolvedValue(USER_B)
    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
  }

  it("a slow refresh of A's list resolving after B signs in leaves B's cache alone", async () => {
    const { invoke, store, broadcast } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    const alicesList = deferred<unknown[]>()
    getUserAnimeRates.mockImplementation((_token: string, userId: number) =>
      userId === 7 ? alicesList.promise : Promise.resolve([animeRate(42, 9)])
    )

    // Cache-first read: serves A's cache and refreshes it in the background.
    await invoke(CHANNELS.SHIKIMORI_GET_ANIME_RATES)
    await vi.waitFor(() =>
      expect(getUserAnimeRates).toHaveBeenCalledWith('access-token', 7, undefined)
    )
    await switchToB(invoke)
    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith(
        EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED,
        expect.anything()
      )
    )
    const bobsCache = structuredClone(store.get('shikimoriUserRates'))
    broadcast.mockClear()

    alicesList.resolve([animeRate(42, 3), animeRate(55, 1)])
    await new Promise((r) => setTimeout(r, 0))

    expect(store.get('shikimoriUserRates')).toEqual(bobsCache)
    expect(broadcast).not.toHaveBeenCalledWith(
      EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED,
      expect.anything()
    )
  })

  it("an update that lands on A's account after B signs in leaves B's cache alone", async () => {
    const { invoke, store, broadcast } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserAnimeRates.mockReturnValue(new Promise(() => {}))
    getUserRate.mockResolvedValue({
      id: 942,
      target_id: 42,
      episodes: 3,
      status: 'watching',
      score: 7
    })
    const written = deferred<unknown>()
    updateUserRate.mockReturnValue(written.promise)

    const edit = updateRate(invoke)
    await vi.waitFor(() => expect(updateUserRate).toHaveBeenCalled())
    await switchToB(invoke)
    store.set('shikimoriUserRates', [bobsEntry])
    broadcast.mockClear()

    written.resolve({
      id: 942,
      target_id: 42,
      episodes: 4,
      status: 'watching',
      score: 7,
      rewatches: 0
    })
    await edit

    expect(store.get('shikimoriUserRates')).toEqual([bobsEntry])
    expect(broadcast).not.toHaveBeenCalledWith(
      EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
      expect.anything()
    )
  })

  it('a mark-watched whose owner was switched away during getUserRate is kept for that owner', async () => {
    const { invoke, store } = registerRouter({ shikimoriUserRates: [cachedRate(42)] })
    getUserAnimeRates.mockReturnValue(new Promise(() => {}))
    const lookup = deferred<unknown>()
    getUserRate.mockReturnValueOnce(lookup.promise)

    const mark = markWatched(invoke, 4)
    await vi.waitFor(() => expect(getUserRate).toHaveBeenCalled())
    await switchToB(invoke)
    store.set('shikimoriUserRates', [bobsEntry])
    lookup.reject(new TypeError('fetch failed'))
    await mark

    expect(queueOf(store)).toHaveLength(0)
    expect(store.get('shikimoriUserRates')).toEqual([bobsEntry])
    expect(parkedOf(store)['7'].entries).toEqual([
      expect.objectContaining({
        malId: 42,
        rateId: 942,
        before: { episodes: 3, status: 'watching', score: 7, rewatches: 0 },
        after: { episodes: 4, status: 'watching', score: 7, rewatches: 0 }
      })
    ])
  })
})

// #572: both rate writers go through `sendRate` / `queueRate`, which stamp a
// `{ value, at, origin }` clock in `syncMeta.rates["<owner>:<malId>"]` for each
// field whose value changed. `syncMeta` is not a Shikimori cache, so logout
// leaves it alone.
describe('shikimori IPC — rate clocks', () => {
  const NOW = Date.UTC(2026, 9, 27, 12)
  const SERVER_AT = '2026-01-01T00:00:00.000Z'
  const clock = (value: number | string): SyncRateFieldClock => ({
    value,
    at: NOW,
    origin: 'install-a'
  })

  function remote(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 942,
      target_id: 42,
      target_type: 'Anime',
      episodes: 3,
      status: 'watching',
      score: 7,
      rewatches: 0,
      ...over
    }
  }

  function cachedWithServerAt(): unknown {
    const entry = cachedRate(42) as { rate: Record<string, unknown> }
    return {
      ...entry,
      rate: { ...entry.rate, rewatches: 0, updated_at: SERVER_AT, serverUpdatedAt: SERVER_AT }
    }
  }

  function rateClocks(store: InMemoryStorage): SyncMeta['rates'] | undefined {
    return (store.get('syncMeta') as SyncMeta | undefined)?.rates
  }

  function cachedRateOf(store: InMemoryStorage): Record<string, unknown> {
    return (store.get('shikimoriUserRates') as { rate: Record<string, unknown> }[])[0].rate
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mark-episode-watched online stamps episodes through sendRate', async () => {
    const { invoke, store } = registerRouter({
      installId: 'install-a',
      shikimoriUserRates: [cachedRate(42)]
    })
    getUserRate.mockResolvedValue(remote())
    updateUserRate.mockResolvedValue(remote({ episodes: 4 }))

    await markWatched(invoke, 4)

    expect(rateClocks(store)).toEqual({ '7:42': { episodes: clock(4) } })
  })

  it('mark-episode-watched offline stamps episodes through queueRate', async () => {
    const { invoke, store } = registerRouter({
      installId: 'install-a',
      shikimoriUserRates: [cachedRate(42)]
    })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    await markWatched(invoke, 4)

    expect(queueOf(store)).toHaveLength(1)
    expect(rateClocks(store)).toEqual({ '7:42': { episodes: clock(4) } })
  })

  it('the no-cache-entry case stamps episodes and status against the empty planned before', async () => {
    const { invoke, store } = registerRouter({ installId: 'install-a' })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    await markWatched(invoke, 1)

    expect(rateClocks(store)).toEqual({
      '7:42': { episodes: clock(1), status: clock('watching') }
    })
  })

  it('the rewatch flip stamps status and rewatches too, never the unchanged score', async () => {
    const { invoke, store } = registerRouter({ installId: 'install-a' })
    getUserRate.mockResolvedValue(remote({ episodes: 12, status: 'completed', rewatches: 1 }))
    updateUserRate.mockResolvedValue(remote())

    await markWatched(invoke, 1)

    expect(rateClocks(store)).toEqual({
      '7:42': { episodes: clock(1), status: clock('rewatching'), rewatches: clock(2) }
    })
  })

  it('update-rate stamps only the field the panel changed, online and queued', async () => {
    const online = registerRouter({ installId: 'install-a', shikimoriUserRates: [cachedRate(42)] })
    getUserRate.mockResolvedValue(remote())
    updateUserRate.mockResolvedValue(remote({ score: 9 }))
    await online.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 42, 3, 'watching', 9, 0)
    expect(rateClocks(online.store)).toEqual({ '7:42': { score: clock(9) } })

    vi.clearAllMocks()
    const queued = registerRouter({ installId: 'install-a', shikimoriUserRates: [cachedRate(42)] })
    ensureFreshToken.mockRejectedValue(new TypeError('fetch failed'))
    await queued.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, 42, 3, 'on_hold', 7, 0)
    expect(queueOf(queued.store)).toHaveLength(1)
    expect(rateClocks(queued.store)).toEqual({ '7:42': { status: clock('on_hold') } })
  })

  it('a queued clock keys by the user the request captured, even if the account switched meanwhile', async () => {
    const { invoke, store } = registerRouter({
      installId: 'install-a',
      shikimoriUserRates: [cachedRate(42)]
    })
    // The switch lands during the awaited `getUserRate`, which then fails offline.
    getUserRate.mockImplementation(async () => {
      store.set('shikimoriUser', { id: 8, nickname: 'other' })
      throw new TypeError('fetch failed')
    })

    await markWatched(invoke, 4)

    // #588 parks the entry for user 7, and its clock is keyed to 7 as well.
    expect(queueOf(store)).toHaveLength(0)
    expect(parkedOf(store)['7'].entries).toHaveLength(1)
    expect(rateClocks(store)).toEqual({ '7:42': { episodes: clock(4) } })
  })

  it('stamp: false writes the rate but stamps nothing, in both funnels', async () => {
    const { store, funnels } = registerRouter({
      installId: 'install-a',
      shikimoriUserRates: [cachedRate(42)]
    })
    updateUserRate.mockResolvedValue(remote({ episodes: 4 }))
    const before = { episodes: 3, status: 'watching' as const, score: 7, rewatches: 0 }

    await funnels.sendRate(
      'access-token',
      7,
      42,
      remote() as never,
      { ...before, episodes: 4 },
      false
    )
    funnels.queueRate(
      { id: 7, nickname: 'me' } as ShikiUser,
      42,
      { rateId: 942, before },
      { ...before, episodes: 5 },
      new TypeError(),
      false
    )

    expect(updateUserRate).toHaveBeenCalledTimes(1)
    expect(queueOf(store)).toHaveLength(1)
    expect(store.get('syncMeta')).toBeUndefined()
  })

  it('sendRate keeps serverUpdatedAt while it moves updated_at to the local clock', async () => {
    const { invoke, store } = registerRouter({
      installId: 'install-a',
      shikimoriUserRates: [cachedWithServerAt()]
    })
    getUserRate.mockResolvedValue(remote())
    updateUserRate.mockResolvedValue(remote({ episodes: 4 }))

    await markWatched(invoke, 4)

    expect(cachedRateOf(store)).toMatchObject({
      episodes: 4,
      updated_at: new Date(NOW).toISOString(),
      serverUpdatedAt: SERVER_AT
    })
  })

  it("queueRate's optimistic patch moves updated_at but not serverUpdatedAt", async () => {
    const { invoke, store } = registerRouter({
      installId: 'install-a',
      shikimoriUserRates: [cachedWithServerAt()]
    })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))

    await markWatched(invoke, 4)

    expect(cachedRateOf(store)).toMatchObject({
      episodes: 4,
      updated_at: new Date(NOW).toISOString(),
      serverUpdatedAt: SERVER_AT
    })
  })

  it('rate clocks survive logout', async () => {
    const { invoke, store } = registerRouter({
      installId: 'install-a',
      shikimoriUserRates: [cachedRate(42)]
    })
    getUserRate.mockRejectedValue(new TypeError('fetch failed'))
    await markWatched(invoke, 4)

    await invoke(CHANNELS.SHIKIMORI_LOGOUT)

    expect(store.get('shikimoriUserRates')).toEqual([])
    expect(rateClocks(store)).toEqual({ '7:42': { episodes: clock(4) } })
  })
})

describe('shikimori IPC — the background rate refresh goes through refreshRates (#592)', () => {
  it('invalidates the recs and broadcasts SHIKIMORI_RATES_REFRESHED with the new entries', async () => {
    const { invoke, store, broadcast, sync } = registerRouter({
      shikimoriUserRates: [cachedRate(42)],
      shikimoriRecommendations: [{ malId: 1 }]
    })
    ensureFreshToken.mockResolvedValue('tok')
    getUserAnimeRates.mockResolvedValue([
      {
        id: 942,
        score: 9,
        status: 'completed',
        episodes: 12,
        rewatches: 0,
        updated_at: '2026-01-01T00:00:00Z',
        anime: { id: 42 }
      }
    ])
    // A cached list answers at once and refreshes in the background.
    await invoke(CHANNELS.SHIKIMORI_GET_ANIME_RATES)
    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED, [
        expect.objectContaining({ rate: expect.objectContaining({ target_id: 42, score: 9 }) })
      ])
    )
    expect(store.get('shikimoriRecommendations')).toEqual([])
    // Its own tail stays: the drain and the details prefetch.
    await vi.waitFor(() => expect(sync.syncShikimoriQueue).toHaveBeenCalled())
    expect(sync.prefetchShikimoriDetails).toHaveBeenCalled()
  })
})
