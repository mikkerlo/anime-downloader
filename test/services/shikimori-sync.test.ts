import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
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

function makeService(
  initial: Record<string, unknown> = {},
  snapshotsPath?: string
): {
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
    animeDetailsUpdatedChannel: CHANNELS.animeDetailsUpdated,
    snapshotsPath
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

// A 5xx is often specific to one item, so the drain moves on and keeps the
// edit. Only a continuous 24 h run of 5xx on its newest entry drops it (#599).
describe('ShikimoriSyncService — 5xx keeps the edit (#599)', () => {
  const RETRY = 'Shikimori server error — will retry'
  const HOUR = 60 * 60 * 1000
  const T0 = Date.UTC(2026, 9, 1)
  const serverError = (status = 503) => new ShikiApiError(`Shikimori API error: ${status}`, status)
  const queued = (malId: number, queuedAt: number) => ({
    malId,
    rateId: null,
    queuedAt,
    before: { episodes: 0, status: 'watching', score: 0, rewatches: 0 },
    after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
  })
  const serverRate = (malId: number) => ({
    id: 900 + malId,
    target_id: malId,
    episodes: 0,
    status: 'watching',
    score: 0,
    rewatches: 0
  })
  const applied = (malId: number) => ({ ...serverRate(malId), episodes: 1 })
  type Entry = ReturnType<typeof queued> & {
    firstServerErrorAt?: number
    lastServerErrorAt?: number
  }
  const live = (store: InMemoryStorage) => store.get('shikimoriUpdateQueue') as Entry[]
  type Svc = ReturnType<typeof makeService>['svc']

  async function drainAt(svc: Svc, t: number): Promise<void> {
    vi.setSystemTime(t)
    const drain = svc.syncShikimoriQueue()
    await vi.advanceTimersByTimeAsync(1_000)
    await drain
    svc.stopSyncTimer()
  }

  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('keeps every edit through a 2 h outage of 60 s ticks and reports the retry message', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1), queued(2, 2)] })
    getUserRate.mockRejectedValue(serverError())

    svc.startSyncTimer()
    await vi.advanceTimersByTimeAsync(2 * HOUR + 1_000)
    svc.stopSyncTimer()

    expect(getUserRate).toHaveBeenCalledTimes(240)
    expect(live(store).map((e) => e.malId)).toEqual([1, 2])
    expect(svc.getSyncStatus()).toMatchObject({
      state: 'idle',
      lastSyncAt: 0,
      lastSyncError: RETRY
    })
  })

  it("doesn't advance lastSyncAt on a drain where one item hit a 5xx and another synced", async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockResolvedValueOnce(serverRate(1))
    updateUserRate.mockResolvedValueOnce(applied(1))
    await drainAt(svc, T0)
    expect(svc.getSyncStatus().lastSyncAt).toBe(T0)

    store.set('shikimoriUpdateQueue', [queued(2, 2), queued(3, 3)])
    getUserRate.mockImplementation(async (_t: string, _u: number, malId: number) => {
      if (malId === 2) throw serverError()
      return serverRate(malId)
    })
    updateUserRate.mockImplementation(async (_t: string, id: number) => applied(id - 900))
    await drainAt(svc, T0 + HOUR)

    expect(updateUserRate).toHaveBeenLastCalledWith('access-token', 903, 1, 'watching', 0, 0)
    expect(live(store).map((e) => e.malId)).toEqual([2])
    expect(svc.getSyncStatus().lastSyncAt).toBe(T0)
    expect(svc.getSyncStatus().lastSyncError).toBe(RETRY)
  })

  it.each([500, 502, 503])('keeps the edit and starts its clock on a %i', async (status) => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockRejectedValue(serverError(status))

    await drainAt(svc, T0)

    expect(live(store)).toEqual([
      { ...queued(1, 1), firstServerErrorAt: T0, lastServerErrorAt: T0 }
    ])
    expect(svc.getSyncStatus().lastSyncError).toBe(RETRY)
  })

  // Retrying is safe only because the drift check sees the committed write.
  it('reconciles instead of writing twice when updateUserRate landed but answered 500', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockResolvedValueOnce(serverRate(1))
    updateUserRate.mockRejectedValueOnce(serverError(500))
    await drainAt(svc, T0)
    expect(live(store)).toHaveLength(1)

    getUserRate.mockResolvedValueOnce(applied(1))
    await drainAt(svc, T0 + 60_000)

    expect(updateUserRate).toHaveBeenCalledTimes(1)
    expect(live(store)).toEqual([])
    expect(svc.getSyncStatus().lastSyncError).toBeNull()
  })

  it('reconciles instead of creating twice when createUserRate landed but answered 500', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockResolvedValueOnce(null)
    createUserRate.mockRejectedValueOnce(serverError(500))
    await drainAt(svc, T0)
    expect(live(store)).toHaveLength(1)

    getUserRate.mockResolvedValueOnce(applied(1))
    await drainAt(svc, T0 + 60_000)

    expect(createUserRate).toHaveBeenCalledTimes(1)
    expect(updateUserRate).not.toHaveBeenCalled()
    expect(live(store)).toEqual([])
  })

  it('drops the edit with a warning after 24 h of continuous 5xx', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockRejectedValue(serverError())

    for (let t = T0; t < T0 + 24 * HOUR; t += HOUR / 2) await drainAt(svc, t)
    expect(live(store)).toEqual([
      { ...queued(1, 1), firstServerErrorAt: T0, lastServerErrorAt: T0 + 23.5 * HOUR }
    ])

    await drainAt(svc, T0 + 24 * HOUR)
    expect(live(store)).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      '[shikimori sync] dropping item',
      1,
      'after 24 h of server errors:',
      'Shikimori API error: 503'
    )
  })

  it('restarts the clock for a fresh edit, so the old entry’s 24 h mark drops nothing', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockRejectedValue(serverError())

    let t = T0
    for (; t < T0 + 12 * HOUR; t += HOUR / 2) await drainAt(svc, t)
    store.set('shikimoriUpdateQueue', [...live(store), queued(1, 2)])
    for (; t <= T0 + 24 * HOUR; t += HOUR / 2) await drainAt(svc, t)
    expect(live(store)).toHaveLength(2)
    expect(live(store)[1]).toMatchObject({ queuedAt: 2, firstServerErrorAt: T0 + 12 * HOUR })

    for (; t < T0 + 36 * HOUR; t += HOUR / 2) await drainAt(svc, t)
    expect(live(store)).toHaveLength(2)
    await drainAt(svc, T0 + 36 * HOUR)
    expect(live(store)).toEqual([])
  })

  it('restarts the clock after a gap of more than 1 h between 5xx instead of expiring', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockRejectedValue(serverError())

    await drainAt(svc, T0)
    await drainAt(svc, T0 + 25 * HOUR)

    expect(live(store)).toEqual([
      { ...queued(1, 1), firstServerErrorAt: T0 + 25 * HOUR, lastServerErrorAt: T0 + 25 * HOUR }
    ])
  })

  it('leaves no entry, and so no clock, behind once the item succeeds', async () => {
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockRejectedValueOnce(serverError()).mockResolvedValueOnce(serverRate(1))
    updateUserRate.mockResolvedValueOnce(applied(1))

    await drainAt(svc, T0)
    expect(live(store)[0].firstServerErrorAt).toBe(T0)
    await drainAt(svc, T0 + 60_000)

    expect(live(store)).toEqual([])
    expect(svc.getSyncStatus()).toMatchObject({ lastSyncAt: T0 + 60_000, lastSyncError: null })
  })

  it("stamps the parked entry, not the new owner's queue, when the owner changed mid-item", async () => {
    const bobs = [queued(77, 9)]
    const { svc, store } = makeService({ shikimoriUpdateQueue: [queued(1, 1)] })
    getUserRate.mockImplementationOnce(async () => {
      store.set('shikimoriUser', { id: 2, nickname: 'b' })
      store.set('shikimoriUpdateQueue', bobs)
      store.set('shikimoriParkedQueues', {
        '1': { nickname: 'a', entries: [queued(1, 1)], parkedAt: 5 }
      })
      throw serverError()
    })
    // Hold the re-kicked drain for the new owner at its token refresh.
    ensureFreshToken
      .mockResolvedValueOnce('access-token')
      .mockReturnValueOnce(new Promise<string>(() => {}))

    await svc.syncShikimoriQueue()

    const parked = store.get('shikimoriParkedQueues') as Record<string, { entries: Entry[] }>
    expect(parked['1'].entries).toEqual([
      { ...queued(1, 1), firstServerErrorAt: T0, lastServerErrorAt: T0 }
    ])
    expect(live(store)).toEqual(bobs)
  })
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

  it('invalidateCalendarCache marks the snapshot invalid but keeps it for offline (#568)', () => {
    const { svc } = makeService()
    svc.setCachedCalendar([calEntry('A')])
    svc.invalidateCalendarCache()
    const cached = svc.getCachedCalendar()
    expect(cached?.invalidated).toBe(true)
    expect(cached?.data.map((e) => e.name)).toEqual(['A'])
  })

  it('a fresh setCachedCalendar clears the invalid mark', () => {
    const { svc } = makeService()
    svc.setCachedCalendar([])
    svc.invalidateCalendarCache()
    svc.setCachedCalendar([calEntry('B')])
    expect(svc.getCachedCalendar()?.invalidated).toBe(false)
  })

  it('stamps the snapshot with the signed-in user and serves it to that user only', () => {
    const { svc, store } = makeService()
    svc.setCachedCalendar([calEntry('A')])
    expect(svc.getCachedCalendar()?.userId).toBe(1)
    store.set('shikimoriUser', { id: 2, nickname: 'b' })
    expect(svc.getCachedCalendar()).toBeNull()
    store.set('shikimoriUser', { id: 1, nickname: 'a' })
    expect(svc.getCachedCalendar()?.data).toHaveLength(1)
  })

  it('an explicit userId wins over the signed-in user', () => {
    const { svc } = makeService()
    svc.setCachedCalendar([calEntry('A')], 9)
    expect(svc.getCachedCalendar()).toBeNull()
  })
})

describe('ShikimoriSyncService — friends-activity snapshot (#568)', () => {
  it('starts empty and returns what was set, for its own user only', () => {
    const { svc, store } = makeService()
    expect(svc.getCachedFriendsActivity()).toBeNull()
    const set = svc.setCachedFriendsActivity(1, [])
    expect(set).toMatchObject({ userId: 1, data: [] })
    expect(svc.getCachedFriendsActivity()).toEqual(set)
    store.set('shikimoriUser', { id: 2, nickname: 'b' })
    expect(svc.getCachedFriendsActivity()).toBeNull()
  })

  it("a fetch that outlived an account switch doesn't evict the new user's snapshots", () => {
    const { svc, store } = makeService()
    store.set('shikimoriUser', { id: 8, nickname: 'b' })
    svc.setCachedCalendar([calEntry('B')])
    svc.setCachedFriendsActivity(8, [])

    // Results of fetches user 1 started, landing after the switch to 8.
    expect(svc.setCachedCalendar([calEntry('A')], 1)).toMatchObject({ userId: 1 })
    expect(svc.setCachedFriendsActivity(1, [])).toMatchObject({ userId: 1 })

    expect(svc.getCachedCalendar()?.data.map((e) => e.name)).toEqual(['B'])
    expect(svc.getCachedFriendsActivity()?.userId).toBe(8)
  })

  it('clearOfflineSnapshots drops both snapshots', () => {
    const { svc } = makeService()
    svc.setCachedCalendar([calEntry('A')])
    svc.setCachedFriendsActivity(1, [])
    svc.clearOfflineSnapshots()
    expect(svc.getCachedCalendar()).toBeNull()
    expect(svc.getCachedFriendsActivity()).toBeNull()
  })
})

// The disk half of #568's rule (#570): both snapshots persist to
// `userData/shikimori-snapshots.json`, for the signed-in user only.
describe('ShikimoriSyncService — snapshots on disk (#570)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiki-snapshots-'))
    file = path.join(dir, 'shikimori-snapshots.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function readFile(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  }

  // Red on main: no file, so a re-created service starts empty.
  it('both snapshots survive a service re-create from the same userData dir', () => {
    const first = makeService({}, file).svc
    const cal = first.setCachedCalendar([calEntry('A')])
    const fa = first.setCachedFriendsActivity(1, [])

    const { svc } = makeService({}, file)
    expect(svc.getCachedCalendar()).toEqual({
      data: cal.data,
      fetchedAt: cal.fetchedAt,
      userId: 1,
      invalidated: true
    })
    expect(svc.getCachedFriendsActivity()).toEqual({
      data: [],
      fetchedAt: fa.fetchedAt,
      userId: 1
    })
  })

  it('writes the documented shape with tmp + rename, leaving no tmp file', () => {
    const { svc } = makeService({}, file)
    svc.setCachedCalendar([calEntry('A')])
    expect(readFile()).toMatchObject({
      version: 1,
      userId: 1,
      calendar: { data: [calEntry('A')] }
    })
    expect(readFile()).not.toHaveProperty('friendsActivity')
    expect(fs.readdirSync(dir)).toEqual(['shikimori-snapshots.json'])
  })

  it('a file written for user 7 is ignored and deleted when the stored user is 8', () => {
    makeService({ shikimoriUser: { id: 7, nickname: 'a' } }, file).svc.setCachedCalendar([
      calEntry('A')
    ])
    expect(fs.existsSync(file)).toBe(true)

    const { svc } = makeService({ shikimoriUser: { id: 8, nickname: 'b' } }, file)
    expect(svc.getCachedCalendar()).toBeNull()
    expect(svc.getCachedFriendsActivity()).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a file is deleted when nobody is signed in', () => {
    makeService({}, file).svc.setCachedFriendsActivity(1, [])
    makeService({ shikimoriUser: null }, file)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a corrupt or unknown-version file is deleted', () => {
    fs.writeFileSync(file, '{not json')
    makeService({}, file)
    expect(fs.existsSync(file)).toBe(false)

    fs.writeFileSync(file, JSON.stringify({ version: 2, userId: 1, calendar: {} }))
    expect(makeService({}, file).svc.getCachedCalendar()).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('clearOfflineSnapshots() deletes the file', () => {
    const { svc } = makeService({}, file)
    svc.setCachedCalendar([calEntry('A')])
    svc.clearOfflineSnapshots()
    expect(fs.existsSync(file)).toBe(false)
    expect(makeService({}, file).svc.getCachedCalendar()).toBeNull()
  })

  it("a fetch that outlived an account switch doesn't write the old user's data", () => {
    const { svc, store } = makeService({}, file)
    store.set('shikimoriUser', { id: 8, nickname: 'b' })
    svc.setCachedCalendar([calEntry('B')])
    svc.setCachedCalendar([calEntry('A')], 1)
    svc.setCachedFriendsActivity(1, [])
    expect(readFile()).toMatchObject({ userId: 8, calendar: { data: [calEntry('B')] } })
    expect(readFile()).not.toHaveProperty('friendsActivity')
  })

  it('without a path the snapshots stay in memory and nothing is written', () => {
    const { svc } = makeService()
    svc.setCachedCalendar([calEntry('A')])
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

function calEntry(name: string) {
  return {
    malId: 1,
    animeId: null,
    name,
    posterUrl: '',
    kind: 'tv',
    episodeInt: '1',
    nextEpisodeAt: '2026-01-01',
    userStatus: 'watching' as const
  }
}

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

  it('logs a 5xx as one short line and returns null (#599)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { svc } = makeService()
      getAnimeDetails.mockRejectedValue(new ShikiApiError('Shikimori API error: 502', 502))
      expect(await svc.refreshShikimoriDetailsForMalId(1)).toBeNull()
      expect(warn.mock.calls).toEqual([
        ['[shikimori] single-show refresh: server error', 502, 'for', 1]
      ])
    } finally {
      warn.mockRestore()
    }
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

  it('logs a 5xx as one short line and moves on to the next MAL ID (#599)', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { svc } = makeService({
        shikimoriUserRates: [rate(10, 'watching'), rate(20, 'watching')],
        shikimoriAnimeDetails: {}
      })
      getAnimeDetails
        .mockRejectedValueOnce(new ShikiApiError('Shikimori API error: 503', 503))
        .mockResolvedValue({ id: 20, name: 'x', genres: [] })

      const run = svc.prefetchShikimoriDetails()
      await vi.advanceTimersByTimeAsync(10_000)
      await run

      expect(getAnimeDetails.mock.calls.map((c) => c[1])).toEqual([10, 20])
      expect(warn.mock.calls).toEqual([
        ['[shikimori prefetch] server error', 503, 'for', 10, 'skipping']
      ])
    } finally {
      warn.mockRestore()
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

  // The new owner has nothing queued, so no drain of theirs would ever clear a
  // message the old account's item left behind (#599 review).
  it.each([
    ['401', 401],
    ['403', 403],
    ['429', 429],
    ['503', 503]
  ])(
    "an old-account %s on the item in flight across a switch doesn't reach the new owner's lastSyncError",
    async (_label, status) => {
      const { svc, store } = makeService({ shikimoriUpdateQueue: [entry(1, 1)] })
      getUserRate.mockImplementationOnce(async () => {
        store.set('shikimoriUser', { id: 2, nickname: 'b' })
        store.set('shikimoriUpdateQueue', [])
        store.set('shikimoriParkedQueues', {
          '1': { nickname: 'a', entries: [entry(1, 1)], parkedAt: 5 }
        } satisfies Parked)
        throw new ShikiApiError(`Shikimori API error: ${status}`, status)
      })

      await svc.syncShikimoriQueue()

      expect(svc.getSyncStatus()).toMatchObject({ queueLength: 0, lastSyncError: null })
    }
  )
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
