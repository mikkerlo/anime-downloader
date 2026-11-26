// How the stored primary is read (#696 § 0), in one place: the stored
// `trackerPrimary` if that tracker is connected (`<provider>User` set), else
// the first connected tracker in `shikimori`, `anilist`, `mal` order, else
// null. The account lifecycle answers with it (`trackerLifecycle.primary()`),
// and `index.ts` hands the fan-out that same getter, so the accounts state and
// the writes can't disagree about which tracker is primary.

import { TRACKER_IDS } from '../services/trackers/rates'
import type { StorageService } from '../store/types'
import { TRACKER_KEYS } from './keys'

/** The stored `trackerPrimary` when it names a known tracker, connected or not. */
export function storedPrimary(store: Pick<StorageService, 'get'>): TrackerId | null {
  const stored = store.get('trackerPrimary') as TrackerId | null | undefined
  return stored && TRACKER_IDS.includes(stored) ? stored : null
}

export function isConnected(store: Pick<StorageService, 'get'>, id: TrackerId): boolean {
  return store.get(TRACKER_KEYS[id].user) != null
}

export function resolvePrimary(store: Pick<StorageService, 'get'>): TrackerId | null {
  const stored = storedPrimary(store)
  if (stored && isConnected(store, stored)) return stored
  return TRACKER_IDS.find((id) => isConnected(store, id)) ?? null
}
