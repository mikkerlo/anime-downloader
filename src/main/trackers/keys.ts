import type { PersistedStoreKey } from '../store/keys'

/**
 * One tracker's store keys (#690). #691 (T2a)'s
 * `createTrackerSyncService(provider, keys, deps)` takes one of these, so the
 * sync service names no tracker's keys itself.
 */
export interface TrackerStoreKeys {
  credentials: PersistedStoreKey
  user: PersistedStoreKey
  sessionExpired: PersistedStoreKey
  userRates: PersistedStoreKey
  updateQueue: PersistedStoreKey
  parkedQueues: PersistedStoreKey
  animeDetails: PersistedStoreKey
  /** AniList's id → MAL id map. Shikimori and MAL key by MAL id already. */
  idMap?: PersistedStoreKey
  /** MAL's user-supplied client ID (`{ clientId }`, plain). */
  clientConfig?: PersistedStoreKey
}

export const SHIKIMORI_KEYS = {
  credentials: 'shikimoriCredentials',
  user: 'shikimoriUser',
  sessionExpired: 'shikimoriSessionExpired',
  userRates: 'shikimoriUserRates',
  updateQueue: 'shikimoriUpdateQueue',
  parkedQueues: 'shikimoriParkedQueues',
  animeDetails: 'shikimoriAnimeDetails'
} as const satisfies TrackerStoreKeys

export const ANILIST_KEYS = {
  credentials: 'anilistCredentials',
  user: 'anilistUser',
  sessionExpired: 'anilistSessionExpired',
  userRates: 'anilistUserRates',
  updateQueue: 'anilistUpdateQueue',
  parkedQueues: 'anilistParkedQueues',
  animeDetails: 'anilistAnimeDetails',
  idMap: 'anilistIdMap'
} as const satisfies TrackerStoreKeys

// `myanimelist*`, never `mal*`: `malIdMap` already means "a cache keyed by MAL id".
export const MYANIMELIST_KEYS = {
  credentials: 'myanimelistCredentials',
  user: 'myanimelistUser',
  sessionExpired: 'myanimelistSessionExpired',
  userRates: 'myanimelistUserRates',
  updateQueue: 'myanimelistUpdateQueue',
  parkedQueues: 'myanimelistParkedQueues',
  animeDetails: 'myanimelistAnimeDetails',
  clientConfig: 'myanimelistClientConfig'
} as const satisfies TrackerStoreKeys

/** Every tracker's keys by id: a tracker with no sync instance yet still has its keys (#694). */
export const TRACKER_KEYS: Readonly<Record<TrackerId, TrackerStoreKeys>> = {
  shikimori: SHIKIMORI_KEYS,
  anilist: ANILIST_KEYS,
  mal: MYANIMELIST_KEYS
}
