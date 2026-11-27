// AniList's sync instance (#703): the generic tracker sync service (#691) over
// the AniList provider and `ANILIST_KEYS`. The one AniList-specific step is the
// list cache's age: `refreshRates` writing `anilistUserRates` stamps the
// provider's `ratesFetchedAt` (cache-first `getAiringInfo`) before any
// `onRatesRefreshed` a caller passes (T11a's tick).

import {
  createTrackerSyncService,
  type TrackerSyncService,
  type TrackerSyncServiceDeps
} from '../../services/trackers/sync'
import { ANILIST_KEYS } from '../keys'
import type { TrackerSessionSteps } from '../lifecycle'
import type { AniListCalendar } from './calendar'
import type { AniListCachedRow, AniListProvider, AniListRate } from './provider'

export type AniListSyncService = TrackerSyncService<AniListRate, AniListCachedRow>

/**
 * AniList's lifecycle steps: the instance's own, plus, on a logout or a
 * switch, the details prefetch's abort and the calendar snapshot's deletion
 * (#709), so neither outlives the account it was for.
 */
export function anilistSessionSteps(deps: {
  provider: Pick<AniListProvider, 'abortPrefetch'>
  sync: Pick<
    AniListSyncService,
    | 'startSyncTimer'
    | 'syncQueue'
    | 'stopSyncTimer'
    | 'broadcastSyncStatus'
    | 'broadcastQueueChanged'
  >
  calendar: Pick<AniListCalendar, 'clear'>
}): TrackerSessionSteps {
  const { provider, sync, calendar } = deps
  return {
    resetExtra: () => {
      provider.abortPrefetch()
      calendar.clear()
    },
    startTimer: () => sync.startSyncTimer(),
    drain: () => void sync.syncQueue(),
    stopTimer: () => sync.stopSyncTimer(),
    broadcastStatus: () => sync.broadcastSyncStatus(),
    broadcastQueue: () => sync.broadcastQueueChanged()
  }
}

export function createAniListSyncService(
  provider: AniListProvider,
  deps: TrackerSyncServiceDeps
): AniListSyncService {
  return createTrackerSyncService(provider, ANILIST_KEYS, {
    ...deps,
    onRatesRefreshed: (trackerId) => {
      provider.markRatesFetched()
      deps.onRatesRefreshed?.(trackerId)
    }
  })
}
