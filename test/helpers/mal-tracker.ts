// The MAL tracker as `index.ts` builds it (#702), over `fake-mal.ts`: the real
// `createMalTracker` (client, auth, provider, sync instance, setup), the real
// lifecycle, vault, fan-out and `trackerRates`, and the `tracker:*` router on
// the mocked `ipcMain`. For the drain integration and the primary-branch tests.
import { vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createMalClient } from '../../src/main/trackers/mal/client'
import type { MalCredentials } from '../../src/main/trackers/mal/auth'
import { createMalTracker } from '../../src/main/trackers/mal'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
import { InMemoryStorage } from './in-memory-storage'
import { createFakeSafeStorage } from './fake-safe-storage'

export const MAL_USER = { id: 1234567, nickname: 'fake_mal_user', avatar: null }

export const malCreds = (extra: Partial<MalCredentials> = {}): MalCredentials => ({
  access_token: 'fake-access-token-mal-1',
  refresh_token: 'fake-refresh-token-mal-1',
  expires_in: 2415600,
  obtainedAt: Date.now(),
  ...extra
})

export function queued(malId: number, queuedAt: number): QueuedTrackerUpdate {
  return {
    malId,
    rateId: malId,
    before: { episodes: 1, status: 'watching', score: 0, rewatches: 0 },
    after: { episodes: 2, status: 'watching', score: 0, rewatches: 0 },
    queuedAt
  }
}

export async function malTrackerRig(
  opts: {
    seed?: Record<string, unknown>
    creds?: MalCredentials | null
    registerPrimary?: boolean
  } = {}
) {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    myanimelistClientConfig: { clientId: 'cid-123' },
    myanimelistUser: MAL_USER,
    ...opts.seed
  })
  const safe = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const creds = opts.creds === undefined ? malCreds() : opts.creds
  if (creds) vault.commit('myanimelistCredentials', await vault.encrypt(creds))

  const broadcast = vi.fn()
  const isOffline = (): boolean => false
  const lifecycle = createTrackerLifecycle({
    store,
    vault,
    trackerRates: {
      instance: (id) => trackerRates.instance(id),
      refreshInBackground: (id) => trackerRates.refreshInBackground(id)
    },
    broadcast,
    accountsChangedChannel: EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED,
    newTrackerCardsEnabled: true,
    // As `index.ts` wires it (#701): the accounts state's `primaryCapable`.
    hasPrimaryWriter: (id) => fan.hasPrimaryWriter(id)
  })
  const notify = vi.spyOn(lifecycle, 'notifyAccountsChanged')
  const mal = createMalTracker({
    store,
    vault,
    broadcast,
    channels: {
      rateUpdated: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
      ratesRefreshed: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
      syncStatus: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
      offlineQueueChanged: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED
    },
    isOffline,
    generation: () => lifecycle.generation('mal'),
    notifyAccountsChanged: () => lifecycle.notifyAccountsChanged(),
    queuedAfter: () => trackerRates.queuedAfter('mal'),
    port: 0,
    client: createMalClient({ spacingMs: 0, sleep: async () => {} }),
    detailsUpdatedChannel: EVENT_CHANNELS.TRACKER_DETAILS_UPDATED
  })
  const fan = createTrackerFanOut({
    store,
    trackers: [{ sync: mal.sync as TrackerSyncService<unknown, unknown> }],
    primary: () => lifecycle.primary(),
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({ store, trackers: fan, isOffline })
  const cleanupPrompt = vi.fn(async () => {})
  if (opts.registerPrimary !== false) mal.registerPrimary(fan, cleanupPrompt)
  ;(ipcMain.handle as unknown as Mock).mockClear()
  registerTrackers({
    store,
    credentialVault: vault,
    trackers: fan,
    trackerRates,
    trackerLifecycle: lifecycle,
    trackerAuth: { begin: vi.fn(), complete: vi.fn(), cancel: vi.fn(), phase: () => null },
    trackerChoices: {},
    newTrackerCardsEnabled: true,
    malSetup: mal.setup
  } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    (await handlers.get(channel)!({}, ...args)) as T
  const listAccounts = (): TrackerAccountsState =>
    handlers.get(CHANNELS.TRACKER_LIST_ACCOUNTS)!({}) as TrackerAccountsState
  const accountsEmits = (): TrackerAccountsState[] =>
    broadcast.mock.calls
      .filter(([c]) => c === EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED)
      .map(([, p]) => p as TrackerAccountsState)
  const queue = (): QueuedTrackerUpdate[] =>
    store.get('myanimelistUpdateQueue') as QueuedTrackerUpdate[]

  return {
    store,
    vault,
    broadcast,
    lifecycle,
    notify,
    mal,
    fan,
    trackerRates,
    cleanupPrompt,
    invoke,
    listAccounts,
    accountsEmits,
    queue
  }
}

export type MalTrackerRig = Awaited<ReturnType<typeof malTrackerRig>>
