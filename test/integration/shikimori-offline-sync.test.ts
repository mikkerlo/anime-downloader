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

import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'

const ensureFreshToken = vi.fn()
const getUserRate = vi.fn()
const createUserRate = vi.fn()
const updateUserRate = vi.fn()
const exchangeCode = vi.fn()
const getUser = vi.fn()
const getUserAnimeRates = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a),
    getUserRate: (...a: unknown[]) => getUserRate(...a),
    createUserRate: (...a: unknown[]) => createUserRate(...a),
    updateUserRate: (...a: unknown[]) => updateUserRate(...a),
    exchangeCode: (...a: unknown[]) => exchangeCode(...a),
    getUser: (...a: unknown[]) => getUser(...a),
    getUserAnimeRates: (...a: unknown[]) => getUserAnimeRates(...a)
  }
})

import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { register } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { ShikiApiError, ShikiAuthError, SESSION_EXPIRED_MESSAGE } from '../../src/main/shikimori'

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

// Unsynced changes across logout and account switch (#588): the real drain and
// the real IPC router on one store, with the Shikimori HTTP client stubbed.
describe('Shikimori offline queue — kept per owner across accounts (#588)', () => {
  const ALICE = { id: 1, nickname: 'alice', avatar: '' }
  const BOB = { id: 2, nickname: 'bob', avatar: '' }
  const credsFor = (u: { nickname: string }) => ({
    access_token: `access-${u.nickname}`,
    refresh_token: `refresh-${u.nickname}`,
    created_at: 1,
    expires_in: 86_400
  })

  type Status = 'planned' | 'watching' | 'completed'
  const values = (episodes: number, status: Status) => ({
    episodes,
    status,
    score: 0,
    rewatches: 0
  })

  // A drift-matching edit, a #566-style entry for a title with no rate yet, and
  // a stale edit the server has since moved past (a higher-ranked status).
  const ALICE_QUEUE = [
    {
      malId: 10,
      rateId: 910,
      before: values(3, 'watching'),
      after: values(4, 'watching'),
      queuedAt: 1
    },
    {
      malId: 20,
      rateId: null,
      before: values(0, 'planned'),
      after: values(1, 'watching'),
      queuedAt: 2
    },
    {
      malId: 30,
      rateId: 930,
      before: values(2, 'watching'),
      after: values(3, 'watching'),
      queuedAt: 3
    }
  ]
  const ALICE_MAL_IDS = ALICE_QUEUE.map((e) => e.malId)

  function serverRate(malId: number, episodes: number, status: Status) {
    return { id: 900 + malId, target_id: malId, ...values(episodes, status) }
  }

  function bootApp(initial: Record<string, unknown>) {
    const { store, broadcast, svc } = boot(initial)
    ;(ipcMain.handle as unknown as { mockClear: () => void }).mockClear()
    register({
      store,
      shikimoriSyncService: svc,
      lookupByMalIds: vi.fn(async () => new Map()),
      maybeBroadcastCleanupPrompt: vi.fn(async () => undefined),
      runAutoDownloadTick: vi.fn(async () => ({})),
      broadcast
    } as unknown as AppDeps)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as unknown as { mock: { calls: [string, never][] } }).mock.calls.map(
        ([channel, handler]) => [channel, handler]
      )
    )
    const invoke = async (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({}, ...args)
    async function signIn(user: typeof ALICE): Promise<void> {
      exchangeCode.mockResolvedValueOnce(credsFor(user))
      getUser.mockResolvedValueOnce(user)
      await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
    }
    async function settle(): Promise<void> {
      await vi.waitFor(
        () => {
          expect(svc.getSyncStatus().state).toBe('idle')
          expect((store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(0)
        },
        { timeout: 5000 }
      )
    }
    return { store, svc, invoke, signIn, settle }
  }

  beforeEach(() => {
    exchangeCode.mockReset()
    getUser.mockReset()
    getUserAnimeRates.mockReset().mockResolvedValue([])
    // As in production: the token is whatever the store holds right now.
    ensureFreshToken.mockImplementation(async (store: InMemoryStorage) => {
      const creds = store.get('shikimoriCredentials') as { access_token: string } | null
      if (!creds) throw new ShikiAuthError(SESSION_EXPIRED_MESSAGE)
      return creds.access_token
    })
    const server: Record<number, Record<number, ReturnType<typeof serverRate> | null>> = {
      [ALICE.id]: {
        10: serverRate(10, 3, 'watching'),
        20: null,
        30: serverRate(30, 1, 'completed')
      },
      [BOB.id]: {}
    }
    getUserRate.mockImplementation(
      async (_t: string, userId: number, malId: number) => server[userId]?.[malId] ?? null
    )
    createUserRate.mockImplementation(
      async (_t: string, _u: number, malId: number, episodes: number, status: Status) =>
        serverRate(malId, episodes, status)
    )
    updateUserRate.mockImplementation(
      async (_t: string, rateId: number, episodes: number, status: Status) =>
        serverRate(rateId - 900, episodes, status)
    )
  })

  const departures = {
    'A logs out and keeps the changes': async (app: ReturnType<typeof bootApp>) => {
      await app.invoke(CHANNELS.SHIKIMORI_LOGOUT, { pending: 'keep' })
      await app.signIn(BOB)
    },
    'A expires and Reconnect signs in as B': async (app: ReturnType<typeof bootApp>) => {
      app.store.set('shikimoriCredentials', null)
      app.store.set('shikimoriSessionExpired', true)
      await app.signIn(BOB)
    }
  }

  it.each(Object.keys(departures))(
    '%s: nothing reaches B, and A gets every change back on signing in again',
    async (departure) => {
      const app = bootApp({
        shikimoriUser: ALICE,
        shikimoriCredentials: credsFor(ALICE),
        shikimoriUpdateQueue: ALICE_QUEUE
      })

      // Step 2: B signs in and its drain runs.
      await departures[departure as keyof typeof departures](app)
      await app.settle()
      await app.svc.syncShikimoriQueue()
      for (const fn of [getUserRate, createUserRate, updateUserRate]) {
        for (const call of fn.mock.calls) {
          expect(call[0]).not.toBe('access-bob')
          expect(call).not.toContain(BOB.id)
        }
      }
      expect(getUserRate.mock.calls.filter((c) => ALICE_MAL_IDS.includes(c[2]))).toEqual([])
      expect(Object.keys(app.store.get('shikimoriParkedQueues') as object)).toEqual(['1'])

      // Step 3: B leaves, A comes back; every call carries A's id and token.
      await app.invoke(CHANNELS.SHIKIMORI_LOGOUT, { pending: 'keep' })
      await app.signIn(ALICE)
      await app.settle()

      // The stale edit kept its original `before`, so it lost to the server's
      // completed status: only the matching edit is written.
      expect(updateUserRate.mock.calls).toEqual([['access-alice', 910, 4, 'watching', 0, 0]])
      expect(createUserRate.mock.calls).toEqual([
        ['access-alice', ALICE.id, 20, 1, 'watching', 0, 0]
      ])
      expect(getUserRate.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
        ['access-alice', ALICE.id, 10],
        ['access-alice', ALICE.id, 20],
        ['access-alice', ALICE.id, 30]
      ])
      expect(app.store.get('shikimoriParkedQueues')).toEqual({})
      app.svc.stopSyncTimer()
    }
  )

  it('a 5xx-stamped edit keeps its clock through logout, another account and restore (#599)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const T0 = Date.UTC(2026, 9, 1)
      vi.setSystemTime(T0)
      const app = bootApp({
        shikimoriUser: ALICE,
        shikimoriCredentials: credsFor(ALICE),
        shikimoriUpdateQueue: ALICE_QUEUE.slice(0, 1)
      })
      getUserRate.mockRejectedValue(new ShikiApiError('Shikimori API error: 503', 503))
      // No rates-refreshed drain, so each sign-in runs exactly one.
      getUserAnimeRates.mockReturnValue(new Promise(() => {}))

      await app.svc.syncShikimoriQueue()
      const stamped = { ...ALICE_QUEUE[0], firstServerErrorAt: T0, lastServerErrorAt: T0 }
      expect(app.store.get('shikimoriUpdateQueue')).toEqual([stamped])

      await app.invoke(CHANNELS.SHIKIMORI_LOGOUT, { pending: 'keep' })
      await app.signIn(BOB)
      await vi.waitFor(() => expect(app.svc.getSyncStatus().state).toBe('idle'))
      expect(
        (app.store.get('shikimoriParkedQueues') as Record<string, { entries: unknown[] }>)['1']
          .entries
      ).toEqual([stamped])

      vi.setSystemTime(T0 + 10 * 60_000)
      await app.invoke(CHANNELS.SHIKIMORI_LOGOUT, { pending: 'keep' })
      await app.signIn(ALICE)
      await vi.waitFor(() => {
        expect(getUserRate).toHaveBeenCalledTimes(2)
        expect(app.svc.getSyncStatus().state).toBe('idle')
      })

      expect(app.store.get('shikimoriUpdateQueue')).toEqual([
        { ...stamped, lastServerErrorAt: T0 + 10 * 60_000 }
      ])
      app.svc.stopSyncTimer()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('the switch window: a drain tick during B’s pending getUser sends nothing with B’s token', async () => {
    const app = bootApp({
      shikimoriUser: ALICE,
      shikimoriCredentials: null,
      shikimoriSessionExpired: true,
      shikimoriUpdateQueue: ALICE_QUEUE.slice(0, 1)
    })
    app.svc.startSyncTimer()
    exchangeCode.mockResolvedValueOnce(credsFor(BOB))
    let resolveUser!: (u: typeof BOB) => void
    getUser.mockReturnValueOnce(new Promise((res) => (resolveUser = res)))

    const exchange = app.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
    await vi.waitFor(() => expect(getUser).toHaveBeenCalled())
    await app.svc.syncShikimoriQueue()

    expect(getUserRate).not.toHaveBeenCalled()
    expect(updateUserRate).not.toHaveBeenCalled()

    resolveUser(BOB)
    await exchange
    await app.settle()
    for (const call of getUserRate.mock.calls) expect(call[1]).not.toBe(ALICE.id)
    expect(updateUserRate).not.toHaveBeenCalled()
    app.svc.stopSyncTimer()
  })
})
