// The production fan-out (#692) for a harness that registers the Shikimori
// router: Shikimori alone, as `src/main/index.ts` builds it. The router sets
// Shikimori's primary branch on it at registration.
import type { StorageService } from '../../src/main/store/types'
import { createTrackerFanOut, type TrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates, type TrackerRates } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'

type ShikimoriSync = {
  tracker: TrackerSyncService<never, never> | TrackerSyncService<unknown, unknown>
}

export function shikimoriOnlyFanOut(store: StorageService, sync: ShikimoriSync): TrackerFanOut {
  return createTrackerFanOut({
    store,
    trackers: [{ sync: sync.tracker as TrackerSyncService<unknown, unknown> }]
  })
}

/**
 * The fan-out plus the `tracker:*` rates service on it (#694), as `index.ts`
 * builds both: the `AppDeps` members `trackers` and `trackerRates`.
 */
export function shikimoriOnlyTrackers(
  store: StorageService,
  sync: ShikimoriSync,
  isOffline?: () => boolean
): { trackers: TrackerFanOut; trackerRates: TrackerRates } {
  const trackers = shikimoriOnlyFanOut(store, sync)
  return { trackers, trackerRates: createTrackerRates({ store, trackers, isOffline }) }
}
