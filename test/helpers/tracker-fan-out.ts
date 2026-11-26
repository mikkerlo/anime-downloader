// The production fan-out (#692) for a harness that registers the Shikimori
// router: Shikimori alone, as `src/main/index.ts` builds it. The router sets
// Shikimori's primary branch on it at registration.
import type { StorageService } from '../../src/main/store/types'
import { createTrackerFanOut, type TrackerFanOut } from '../../src/main/services/trackers/fan-out'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'

export function shikimoriOnlyFanOut(
  store: StorageService,
  sync: { tracker: TrackerSyncService<never, never> | TrackerSyncService<unknown, unknown> }
): TrackerFanOut {
  return createTrackerFanOut({
    store,
    trackers: [{ sync: sync.tracker as TrackerSyncService<unknown, unknown> }]
  })
}
