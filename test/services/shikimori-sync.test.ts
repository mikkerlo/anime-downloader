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
import { ShikiApiError, ShikiAuthError, SESSION_EXPIRED_MESSAGE } from '../../src/main/shikimori'

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
      lastSyncError: null,
      sessionExpired: false
    })
  })

  it('reports sessionExpired from the store, so it survives a restart', () => {
    // Every other field is closure state and resets on launch. The reported
    // case is an app *starting* with two-month-dead credentials, so this one
    // must be read back from the store on a freshly constructed service (#244).
    const { svc } = makeService({ shikimoriSessionExpired: true })
    expect(svc.getSyncStatus().sessionExpired).toBe(true)
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

  // A 429 that outlasts `shikiFetch`'s retry cap (#596) is a global condition,
  // not a bad edit: the drain stops and the edit waits for the next tick (#598).
  describe('429 past the retry cap', () => {
    const RATE_LIMITED = 'Shikimori rate limit — will retry'
    const rateLimited = () => new ShikiApiError('Shikimori API error: 429', 429)
    const queued = (malId: number, queuedAt: number) => ({
      malId,
      queuedAt,
      before: { episodes: 0, status: 'watching', score: 0 },
      after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
    })
    const serverRate = { id: 901, target_id: 1, episodes: 0, status: 'watching', score: 0 }
    const appliedRate = { ...serverRate, episodes: 1, rewatches: 0 }

    it('keeps the edit on a 429 from getUserRate and applies it on the next drain', async () => {
      const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
      getUserRate.mockRejectedValueOnce(rateLimited())

      await svc.syncShikimoriQueue()

      expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(1)
      expect(svc.getSyncStatus().lastSyncError).toBe(RATE_LIMITED)
      expect(updateUserRate).not.toHaveBeenCalled()

      getUserRate.mockResolvedValueOnce(serverRate)
      updateUserRate.mockResolvedValueOnce(appliedRate)

      await svc.syncShikimoriQueue()

      expect(updateUserRate).toHaveBeenCalledWith('access-token', 901, 1, 'watching', 0, 0)
      expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
      expect(svc.getSyncStatus().lastSyncError).toBeNull()
    })

    it('keeps the edit on a 429 from updateUserRate and applies it on the next drain', async () => {
      const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
      // The write never landed, so the next drain reads the same before-state.
      getUserRate.mockResolvedValue(serverRate)
      updateUserRate.mockRejectedValueOnce(rateLimited())

      await svc.syncShikimoriQueue()

      expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(1)
      expect(svc.getSyncStatus().lastSyncError).toBe(RATE_LIMITED)

      updateUserRate.mockResolvedValueOnce(appliedRate)

      await svc.syncShikimoriQueue()

      expect(updateUserRate).toHaveBeenCalledTimes(2)
      expect(updateUserRate).toHaveBeenLastCalledWith('access-token', 901, 1, 'watching', 0, 0)
      expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
    })

    it('keeps the edit on a 429 from createUserRate and applies it on the next drain', async () => {
      const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
      getUserRate.mockResolvedValue(null)
      createUserRate.mockRejectedValueOnce(rateLimited())

      await svc.syncShikimoriQueue()

      expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(1)
      expect(svc.getSyncStatus().lastSyncError).toBe(RATE_LIMITED)

      createUserRate.mockResolvedValueOnce(appliedRate)

      await svc.syncShikimoriQueue()

      expect(createUserRate).toHaveBeenCalledTimes(2)
      expect(createUserRate).toHaveBeenLastCalledWith('access-token', 1, 1, 1, 'watching', 0, 0)
      expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
    })

    it('stops the drain at the first 429 instead of moving on to the next item', async () => {
      vi.useFakeTimers()
      try {
        const { svc, store } = makeService({
          shikimoriUpdateQueue: [queued(1, 1), queued(2, 2)]
        })
        getUserRate.mockRejectedValue(rateLimited())

        const drain = svc.syncShikimoriQueue()
        await vi.advanceTimersByTimeAsync(5_000)
        await drain

        expect(getUserRate).toHaveBeenCalledTimes(1)
        expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })
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

  // The guard on widening the update-rate queue predicate to `ShikiAuthError`
  // (#244 §3): a *genuine* validation failure from `user_rates` must keep being
  // dropped, or one malformed entry jams the drain forever. The case above
  // throws a plain Error, so it never exercised the ShikiApiError branch.
  it.each([400, 422])(
    'still drops the queued item on a %i ShikiApiError from user_rates',
    async (status) => {
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
      getUserRate.mockRejectedValue(
        new ShikiApiError(`Shikimori API error: ${status} (score is invalid)`, status)
      )

      await svc.syncShikimoriQueue()

      expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
    }
  )
})

describe('ShikimoriSyncService — expired session', () => {
  function queuedService(initial: Record<string, unknown> = {}) {
    return makeService({
      shikimoriUpdateQueue: [
        {
          malId: 1,
          queuedAt: 1,
          before: { episodes: 0, status: 'watching', score: 0 },
          after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
        }
      ],
      ...initial
    })
  }

  it('keeps the queue and broadcasts sessionExpired when the refresh is rejected', async () => {
    const { svc, store, broadcast } = queuedService({ shikimoriSessionExpired: true })
    ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    await svc.syncShikimoriQueue()

    expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(1)
    expect(getUserRate).not.toHaveBeenCalled()
    expect(broadcast).toHaveBeenLastCalledWith(
      CHANNELS.syncStatus,
      expect.objectContaining({ sessionExpired: true, lastSyncError: SESSION_EXPIRED_MESSAGE })
    )
  })

  it('stops the sync timer instead of spinning against cleared credentials', async () => {
    // `ensureFreshToken` has already nulled the credentials, so every later tick
    // returns at the `!creds` guard *before* `adjustSyncTimer()` — a timer that
    // can only ever no-op (#244 Risks).
    vi.useFakeTimers()
    try {
      const { svc, store } = queuedService()
      ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))
      svc.startSyncTimer()

      await svc.syncShikimoriQueue()
      expect(ensureFreshToken).toHaveBeenCalledTimes(1)

      // Credentials are gone in production; keep them here so a surviving timer
      // would provably tick again rather than bailing at the `!creds` guard.
      store.set('shikimoriCredentials', { access_token: 'tok', refresh_token: 'r' })
      await vi.advanceTimersByTimeAsync(120_000)

      expect(ensureFreshToken).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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

function rate(target_id: number, status: string) {
  return {
    rate: { id: target_id, target_id, episodes: 0, status, score: 0 },
    shikiAnime: { id: target_id, name: 'X' },
    smotretAnime: null
  }
}

describe('ShikimoriSyncService — prefetchShikimoriDetails genre coverage (#183)', () => {
  it('prefetches details for completed/dropped rates, not just watching/planned', async () => {
    // Pre-#183 the worklist filtered to {watching, planned}, so a completed-only
    // list fetched nothing and the favorite-genres panel stayed empty.
    const { svc } = makeService({
      shikimoriUserRates: [rate(500, 'completed')],
      shikimoriAnimeDetails: {}
    })
    getAnimeDetails.mockResolvedValue({ id: 500, name: 'Done', genres: [] })
    await svc.prefetchShikimoriDetails()
    expect(getAnimeDetails).toHaveBeenCalledWith('access-token', 500)
  })

  it('fetches watching/planned before other statuses', async () => {
    vi.useFakeTimers()
    try {
      getAnimeDetails.mockResolvedValue({ id: 0, name: 'x', genres: [] })
      const { svc } = makeService({
        shikimoriUserRates: [rate(500, 'completed'), rate(10, 'watching'), rate(20, 'planned')],
        shikimoriAnimeDetails: {}
      })
      const p = svc.prefetchShikimoriDetails()
      await vi.runAllTimersAsync()
      await p
      expect(getAnimeDetails.mock.calls.map((c) => c[1])).toEqual([10, 20, 500])
    } finally {
      vi.useRealTimers()
    }
  })

  it('invokes onDetailsPrefetched after a run that fetched at least one', async () => {
    const onDetailsPrefetched = vi.fn()
    const { svc } = makeService({
      shikimoriUserRates: [rate(8, 'dropped')],
      shikimoriAnimeDetails: {}
    })
    getAnimeDetails.mockResolvedValue({ id: 8, name: 'x', genres: [] })
    svc.setOnDetailsPrefetched(onDetailsPrefetched)
    await svc.prefetchShikimoriDetails()
    expect(onDetailsPrefetched).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onDetailsPrefetched when the worklist is empty', async () => {
    const onDetailsPrefetched = vi.fn()
    const { svc } = makeService({
      shikimoriUserRates: [rate(7, 'watching')],
      shikimoriAnimeDetails: { '7': { details: { id: 7 }, fetchedAt: Date.now() } }
    })
    svc.setOnDetailsPrefetched(onDetailsPrefetched)
    await svc.prefetchShikimoriDetails()
    expect(getAnimeDetails).not.toHaveBeenCalled()
    expect(onDetailsPrefetched).not.toHaveBeenCalled()
  })

  it('aborts the loop on a 429 instead of requesting the next MAL ID (#598)', async () => {
    vi.useFakeTimers()
    try {
      const { svc } = makeService({
        shikimoriUserRates: [rate(10, 'watching'), rate(20, 'watching')],
        shikimoriAnimeDetails: {}
      })
      getAnimeDetails
        .mockRejectedValueOnce(new ShikiApiError('Shikimori API error: 429', 429))
        .mockResolvedValue({ id: 20, name: 'x', genres: [] })

      const run = svc.prefetchShikimoriDetails()
      await vi.advanceTimersByTimeAsync(10_000)
      await run

      expect(getAnimeDetails).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// A logout or account switch can land while the drain is mid-loop (#588). The
// item in flight finishes on the old owner's account with the token it holds;
// nothing after it may.
describe('ShikimoriSyncService — owner guard', () => {
  function entry(malId: number, queuedAt: number) {
    return {
      malId,
      rateId: null,
      queuedAt,
      before: { episodes: 0, status: 'watching', score: 0, rewatches: 0 },
      after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
    }
  }
  const OLD_QUEUE = [entry(1, 1), entry(2, 2)]
  const serverRate = (malId: number) => ({
    id: 900 + malId,
    target_id: malId,
    episodes: 0,
    status: 'watching',
    score: 0,
    rewatches: 0
  })

  type Parked = Record<string, { nickname: string; entries: unknown[]; parkedAt: number }>

  /**
   * Item 1's `getUserRate` resolves only after the store has switched to user 2,
   * as exchange-code leaves it: user 1's queue parked (or discarded), and
   * `liveForNewOwner` as the new live queue.
   */
  function switchDuringItem1(
    store: InMemoryStorage,
    opts: { park: boolean; liveForNewOwner?: unknown[] }
  ): void {
    getUserRate.mockImplementation(async (_token: string, userId: number, malId: number) => {
      if (userId === 1 && malId === 1) {
        store.set('shikimoriUser', { id: 2, nickname: 'b' })
        store.set('shikimoriUpdateQueue', opts.liveForNewOwner ?? [])
        if (opts.park) {
          store.set('shikimoriParkedQueues', {
            '1': { nickname: 'a', entries: OLD_QUEUE, parkedAt: 5 }
          } satisfies Parked)
        }
      }
      return serverRate(malId)
    })
    updateUserRate.mockImplementation(async (_t: string, id: number) => ({
      ...serverRate(id - 900),
      episodes: 1
    }))
  }

  it('stops before the next item and drops the consumed one from the parked bucket', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: OLD_QUEUE })
    switchDuringItem1(store, { park: true })

    await svc.syncShikimoriQueue()

    expect(getUserRate).toHaveBeenCalledTimes(1)
    expect(getUserRate).not.toHaveBeenCalledWith(expect.anything(), 1, 2)
    expect(updateUserRate).toHaveBeenCalledTimes(1)
    const parked = store.get('shikimoriParkedQueues') as Parked
    expect(parked['1'].entries).toEqual([entry(2, 2)])
    expect(store.get('shikimoriUpdateQueue')).toEqual([])
  })

  it('creates no bucket after Discard, and broadcasts the live length', async () => {
    const { svc, store, broadcast } = makeService({ shikimoriUpdateQueue: OLD_QUEUE })
    const ownersPending = deferred<string>()
    switchDuringItem1(store, { park: false, liveForNewOwner: [entry(77, 9)] })
    // Hold the re-kicked drain at its token refresh, so user 2's entry is still
    // live when the assertions run.
    ensureFreshToken
      .mockResolvedValueOnce('access-token')
      .mockReturnValueOnce(ownersPending.promise)

    await svc.syncShikimoriQueue()

    expect(store.get('shikimoriParkedQueues')).toBeUndefined()
    expect(broadcast).toHaveBeenCalledWith(CHANNELS.offlineQueueChanged, { length: 1 })
    expect(store.get('shikimoriUpdateQueue')).toEqual([entry(77, 9)])
  })

  it('re-kicks itself for the new owner without waiting for the timer or recording an error', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: OLD_QUEUE })
    // A prior run leaves an error standing; an owner change must not touch it.
    getUserRate.mockRejectedValueOnce(new ShikiApiError('unauthorized', 401))
    await svc.syncShikimoriQueue()
    expect(svc.getSyncStatus().lastSyncError).toBe('unauthorized')

    switchDuringItem1(store, { park: true, liveForNewOwner: [entry(77, 9)] })
    const newOwnersToken = deferred<string>()
    ensureFreshToken
      .mockResolvedValueOnce('access-token')
      .mockReturnValueOnce(newOwnersToken.promise)

    await svc.syncShikimoriQueue()

    expect(svc.getSyncStatus().lastSyncError).toBe('unauthorized')
    expect(svc.getSyncStatus().lastSyncAt).toBe(0)
    newOwnersToken.resolve('access-token-b')
    await vi.waitFor(() => expect(getUserRate).toHaveBeenCalledWith('access-token-b', 2, 77))
  })

  // The guard at the top of each iteration never runs again after the last
  // item, so a switch during that item's await needs its own check (#588 review).
  it('re-kicks after a single-item drain whose owner changed during its only item', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [entry(1, 1)] })
    getUserRate.mockRejectedValueOnce(new ShikiApiError('unauthorized', 401))
    await svc.syncShikimoriQueue()
    expect(svc.getSyncStatus().lastSyncError).toBe('unauthorized')

    switchDuringItem1(store, { park: true, liveForNewOwner: [entry(77, 9)] })
    const newOwnersToken = deferred<string>()
    ensureFreshToken
      .mockResolvedValueOnce('access-token')
      .mockReturnValueOnce(newOwnersToken.promise)

    await svc.syncShikimoriQueue()

    expect(svc.getSyncStatus().lastSyncError).toBe('unauthorized')
    expect(svc.getSyncStatus().lastSyncAt).toBe(0)
    newOwnersToken.resolve('access-token-b')
    await vi.waitFor(() => expect(getUserRate).toHaveBeenCalledWith('access-token-b', 2, 77))
  })

  it("an item in flight across a switch doesn't write the old account's rate into the new cache", async () => {
    const bobsEntry = {
      rate: { id: 5001, target_id: 1, episodes: 9, status: 'completed', score: 2 },
      shikiAnime: { id: 1, name: 'X' },
      smotretAnime: null
    }
    const { svc, store, broadcast } = makeService({
      shikimoriUpdateQueue: [entry(1, 1)],
      shikimoriUserRates: [emptyRate(1)]
    })
    switchDuringItem1(store, { park: true })
    const switchAndFetch = getUserRate.getMockImplementation()!
    getUserRate.mockImplementation(async (...args: [string, number, number]) => {
      const rate = await switchAndFetch(...args)
      store.set('shikimoriUserRates', [bobsEntry])
      return rate
    })

    await svc.syncShikimoriQueue()

    expect(updateUserRate).toHaveBeenCalledTimes(1)
    expect(store.get('shikimoriUserRates')).toEqual([bobsEntry])
    expect(broadcast).not.toHaveBeenCalledWith(CHANNELS.rateUpdated, expect.anything())
  })

  it("the old account's failed token refresh after a switch neither records an error nor stalls the new owner", async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [entry(1, 1)] })
    let rejectOld!: (e: unknown) => void
    ensureFreshToken
      .mockReturnValueOnce(new Promise<string>((_res, rej) => (rejectOld = rej)))
      .mockResolvedValue('access-token-b')
    getUserRate.mockResolvedValue(serverRate(77))
    updateUserRate.mockResolvedValue({ ...serverRate(77), episodes: 1 })

    const drain = svc.syncShikimoriQueue()
    store.set('shikimoriUser', { id: 2, nickname: 'b' })
    store.set('shikimoriUpdateQueue', [entry(77, 9)])
    rejectOld(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))
    await drain

    expect(svc.getSyncStatus().lastSyncError).toBeNull()
    await vi.waitFor(() => expect(getUserRate).toHaveBeenCalledWith('access-token-b', 2, 77))
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
