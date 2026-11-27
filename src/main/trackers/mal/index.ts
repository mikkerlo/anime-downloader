// MyAnimeList's construction (#702), shared by `index.ts` and the tests: one
// HTTP client (its limiter spaces every MAL request), the sign-in and tokens,
// the provider, its sync instance, the card's setup, and the primary branch.
// The account-state broadcasts are wired here: a session expiry and every
// "Needs setup" transition send the sync status and `notifyAccountsChanged()`.

import type { RateValues } from '../../lib/shikimori-rate'
import type { AnimeSearchResult } from '../../smotret-api'
import type { StorageService } from '../../store/types'
import type { TrackerFanOut } from '../../services/trackers/fan-out'
import { createMalPrimary, type MalPrimaryDeps } from '../../services/trackers/mal-primary'
import { createTrackerSyncService, type TrackerSyncService } from '../../services/trackers/sync'
import type { CredentialVault } from '../credential-vault'
import type { TrackerEventChannels } from '../events'
import { MYANIMELIST_KEYS } from '../keys'
import { createMalAuth, type MalAuth } from './auth'
import { createMalClient, type MalClient } from './client'
import { createMalEventBroadcast } from './events'
import {
  createMalProvider,
  type MalCachedRow,
  type MalListStatus,
  type MalProvider
} from './provider'
import { createMalSetup, type MalSetup } from './setup'

export interface MalTrackerDeps {
  store: StorageService
  vault: CredentialVault
  /** The bare broadcast to every window; MAL's payloads are reshaped on the way. */
  broadcast: (channel: string, ...args: unknown[]) => void
  /** The four `tracker:*` channels (`index.ts` passes `EVENT_CHANNELS.TRACKER_*`). */
  channels: TrackerEventChannels
  isOffline: () => boolean
  /** `lifecycle.generation('mal')`, read at call time. */
  generation: () => number
  /** `lifecycle.notifyAccountsChanged()`, read at call time. */
  notifyAccountsChanged: () => void
  /** `trackerRates.queuedAfter('mal')`, read at emit time. */
  queuedAfter: () => Record<number, RateValues>
  /** `malLoopbackPort(process.env, app.isPackaged)`. */
  port: number
  lookupByMalIds?: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  /** Tests pass one with no spacing. */
  client?: MalClient
  timeoutMs?: number
}

export interface MalTracker {
  client: MalClient
  auth: MalAuth
  provider: MalProvider
  sync: TrackerSyncService<MalListStatus, MalCachedRow>
  setup: MalSetup
  /** Sets MAL's primary branch on the fan-out (`setPrimaryWriter('mal', …)`). */
  registerPrimary(
    fanOut: Pick<TrackerFanOut, 'setPrimaryWriter'>,
    maybeBroadcastCleanupPrompt: MalPrimaryDeps['maybeBroadcastCleanupPrompt']
  ): void
}

export function createMalTracker(deps: MalTrackerDeps): MalTracker {
  const { store } = deps
  const client = deps.client ?? createMalClient()
  // Both hooks run after construction, so `sync` is set by then.
  const accountStateChanged = (): void => {
    sync.broadcastSyncStatus()
    deps.notifyAccountsChanged()
  }
  const auth = createMalAuth({
    store,
    vault: deps.vault,
    client,
    generation: deps.generation,
    port: deps.port,
    timeoutMs: deps.timeoutMs,
    // An `invalid_grant` refresh cleared the credentials.
    onSessionExpired: accountStateChanged
  })
  const provider = createMalProvider({
    store,
    client,
    auth,
    generation: deps.generation,
    lookupByMalIds: deps.lookupByMalIds
  })
  const sync: TrackerSyncService<MalListStatus, MalCachedRow> = createTrackerSyncService(
    provider,
    MYANIMELIST_KEYS,
    {
      store,
      // MAL emits `tracker:*` only, reshaped from the instance's payloads.
      broadcast: createMalEventBroadcast({
        broadcast: deps.broadcast,
        channels: deps.channels,
        needsSetup: () => sync.needsSetup(),
        queuedAfter: deps.queuedAfter
      }),
      syncStatusChannel: deps.channels.syncStatus,
      offlineQueueChangedChannel: deps.channels.offlineQueueChanged,
      rateUpdatedChannel: deps.channels.rateUpdated,
      ratesRefreshedChannel: deps.channels.ratesRefreshed,
      isOffline: deps.isOffline,
      // "Needs setup" is on the sync status and the accounts state: both go out.
      onNeedsSetupChanged: accountStateChanged
    }
  )
  const setup = createMalSetup({ store, client, auth })
  return {
    client,
    auth,
    provider,
    sync,
    setup,
    registerPrimary(fanOut, maybeBroadcastCleanupPrompt) {
      const primary = createMalPrimary({ store, sync, provider, maybeBroadcastCleanupPrompt })
      fanOut.setPrimaryWriter('mal', primary.write)
    }
  }
}
