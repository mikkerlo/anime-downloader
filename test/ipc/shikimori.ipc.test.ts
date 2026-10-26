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
    exchangeCode: (...args: unknown[]) => exchangeCode(...args)
  }
})

import { register } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { ShikiApiError, ShikiAuthError, SESSION_EXPIRED_MESSAGE } from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'

type SyncStub = {
  broadcastSyncStatus: Mock
  startSyncTimer: Mock
  stopSyncTimer: Mock
  syncShikimoriQueue: Mock
  invalidateCalendarCache: Mock
  abortPrefetch: Mock
  setOnDetailsPrefetched: Mock
  prefetchShikimoriDetails: Mock
  getSyncStatus: Mock
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
    abortPrefetch: vi.fn(),
    setOnDetailsPrefetched: vi.fn(),
    prefetchShikimoriDetails: vi.fn(async () => undefined),
    getSyncStatus
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

    expect(queueOf(store)).toHaveLength(1)
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
      7,
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
