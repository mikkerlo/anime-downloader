// Main's side of the feature sources (#706, epic #688): the shared resolver
// over store state, and the `airing` dep the auto-downloader reads through.
// It never passes `capabilities`, so main and `useTrackersStore` read the one
// matrix in `src/shared/trackers/feature-source.ts`.

import { resolveFeatureSource, type FeatureKey } from '@shared/trackers/feature-source'
import type { StorageService } from '../store/types'
import { TRACKER_KEYS } from './keys'
import { isConnected, resolvePrimary } from './primary'
import type { AiringInfo, TrackerProvider } from './types'

type Store = Pick<StorageService, 'get'>

const ORDER = Object.keys(TRACKER_KEYS) as TrackerId[]

/**
 * `feature`'s source from the stored overrides, the primary as the accounts
 * state resolves it, and the connected trackers (`<provider>User` set).
 */
export function storedFeatureSource(store: Store, feature: FeatureKey): TrackerId | null {
  return resolveFeatureSource(feature, {
    connected: ORDER.filter((id) => isConnected(store, id)),
    primary: resolvePrimary(store),
    overrides:
      (store.get('trackerFeatureSource') as Partial<Record<FeatureKey, TrackerId>> | undefined) ??
      {}
  })
}

/** Whether the tracker's credentials are stored: Shikimori's is today's tick gate. */
export function hasCredentials(store: Store, id: TrackerId): boolean {
  return Boolean(store.get(TRACKER_KEYS[id].credentials))
}

/** What the auto-downloader reads the aired count through. */
export interface AiringDep {
  /** The resolved `airing` source, read at call time. */
  source(): TrackerId | null
  hasCredentials(id: TrackerId): boolean
  /** That tracker's cache-first read (`AiringInfo`); null when it has none. */
  getAiringInfo(id: TrackerId, malId: number): Promise<AiringInfo | null>
}

export function createAiringDep(deps: {
  store: Store
  providers: Partial<Record<TrackerId, Pick<TrackerProvider<unknown, unknown>, 'getAiringInfo'>>>
}): AiringDep {
  const { store, providers } = deps
  return {
    source: () => storedFeatureSource(store, 'airing'),
    hasCredentials: (id) => hasCredentials(store, id),
    async getAiringInfo(id, malId) {
      const read = providers[id]?.getAiringInfo
      return read ? read(malId) : null
    }
  }
}

/**
 * The `airing` source's own rate refresh ticks (#706): passed as the AniList
 * sync instance's `onRatesRefreshed`, it runs a `'rates-refreshed'` tick only
 * while `id` is the resolved `airing` source. Shikimori keeps its call in
 * `ipc/shikimori.ipc.ts`, and MAL can't be the source, so neither gets it.
 */
export function createTickIfAiringSource(deps: {
  store: Store
  runTick: () => Promise<unknown>
  log?: Pick<Console, 'warn'>
}): (id: TrackerId) => void {
  const log = deps.log ?? console
  return (id) => {
    if (storedFeatureSource(deps.store, 'airing') !== id) return
    void deps.runTick().catch((err) => log.warn('[auto-dl] rates-refreshed tick failed:', err))
  }
}
