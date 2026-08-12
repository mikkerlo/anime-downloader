// Behavior of the Shikimori IPC router around an expired OAuth session (#244).
//
// The reported bug lives here: `SHIKIMORI_UPDATE_RATE` calls `ensureFreshToken`
// inside its `try`, so a dead refresh token surfaced as an opaque
// `ShikiApiError: Shikimori API error: 400` *and* discarded the edit the user
// had just made — the queue-and-optimistically-update branch only accepted
// network errors.
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
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
  register({
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
    sync
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
