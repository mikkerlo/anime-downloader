/**
 * New top-level store keys a later slice of epic #688 adds, each with the
 * default it must hold in a Shikimori-only profile. The 6.0.21 goldens and the
 * `STORE_DEFAULTS` dump test accept exactly these keys beyond the frozen ones,
 * and only at these values. T0 adds none; T1 (#690) adds its tracker keys.
 */
export const GOLDEN_NEW_KEYS: Readonly<Record<string, unknown>> = {
  anilistCredentials: null,
  anilistUser: null,
  anilistSessionExpired: false,
  anilistUserRates: [],
  anilistUpdateQueue: [],
  anilistParkedQueues: {},
  anilistAnimeDetails: {},
  anilistIdMap: {},
  anilistFriends: [],
  myanimelistCredentials: null,
  myanimelistUser: null,
  myanimelistSessionExpired: false,
  myanimelistUserRates: [],
  myanimelistUpdateQueue: [],
  myanimelistParkedQueues: {},
  myanimelistAnimeDetails: {},
  myanimelistClientConfig: null,
  myanimelistClientSecret: null,
  trackerPrimary: null,
  trackerMirror: {},
  trackerFeatureSource: {}
}
