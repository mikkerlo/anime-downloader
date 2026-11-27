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
import type { AniListCachedRow, AniListProvider, AniListRate } from './provider'

export type AniListSyncService = TrackerSyncService<AniListRate, AniListCachedRow>

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
