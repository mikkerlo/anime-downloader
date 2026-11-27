// Feature sources (#706, epic #688): which tracker backs each tracker-backed
// feature. One pure resolver and one static capability matrix, shared by main
// (`src/main/trackers/feature-source.ts` calls it with store state) and the
// renderer (`useTrackersStore` calls it with its own state), so the two sides
// can't disagree. `docs/trackers.md` § Feature sources describes the rules.

/** A feature with a source. Friends has none: it is one merged tab. */
export type FeatureKey = TrackerFeature

/** The fixed order "the first capable tracker" walks (the `TrackerId` order). */
export const TRACKER_ORDER: readonly TrackerId[] = ['shikimori', 'anilist', 'mal']

/** The capability each feature needs. */
export const FEATURE_CAPABILITY = {
  calendar: 'getCalendar',
  chronology: 'getRelated',
  forYou: 'getRecommendations',
  details: 'getDetails',
  airing: 'getAiringInfo'
} as const satisfies Record<FeatureKey, string>

export const FEATURE_KEYS = Object.keys(FEATURE_CAPABILITY) as readonly FeatureKey[]

/** A matrix row: the five feature capabilities, and `getFriends`, which has no feature key. */
export type MatrixCapability = (typeof FEATURE_CAPABILITY)[FeatureKey] | 'getFriends'

export type CapabilityMatrix = Readonly<
  Record<MatrixCapability, Readonly<Record<TrackerId, boolean>>>
>

/**
 * What each tracker can do. MAL has no calendar, no airing data (only the
 * total `num_episodes` and `status`) and no friends endpoint. The `getFriends`
 * row is read by the sidebar's Friends gate (T9) and the friends fan-out (T12);
 * `resolveFeatureSource` never sees it.
 */
export const CAPABILITY_MATRIX: CapabilityMatrix = {
  getCalendar: { shikimori: true, anilist: true, mal: false },
  getRelated: { shikimori: true, anilist: true, mal: true },
  getRecommendations: { shikimori: true, anilist: true, mal: true },
  getDetails: { shikimori: true, anilist: true, mal: true },
  getAiringInfo: { shikimori: true, anilist: true, mal: false },
  getFriends: { shikimori: true, anilist: true, mal: false }
}

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value)
}

/** Whether `trackerId` can be `feature`'s source. */
export function isCapable(
  feature: FeatureKey,
  trackerId: TrackerId,
  capabilities: CapabilityMatrix = CAPABILITY_MATRIX
): boolean {
  return capabilities[FEATURE_CAPABILITY[feature]][trackerId] === true
}

export interface FeatureSourceState {
  /** Trackers with an account (`<provider>User` set), whatever their credentials. */
  connected: readonly TrackerId[]
  primary: TrackerId | null
  /** The stored overrides (`trackerFeatureSource`). */
  overrides: Partial<Record<FeatureKey, TrackerId>>
  /** Defaults to `CAPABILITY_MATRIX`; only tests pass another. */
  capabilities?: CapabilityMatrix
}

/**
 * The tracker backing `feature`: the override if it is connected and capable,
 * else the primary if it is, else the first connected capable tracker in
 * `TRACKER_ORDER`, else null. "Connected" is an account being present, so an
 * expired session keeps its source.
 */
export function resolveFeatureSource(
  feature: FeatureKey,
  state: FeatureSourceState
): TrackerId | null {
  const { connected, primary, overrides, capabilities = CAPABILITY_MATRIX } = state
  const usable = (id: TrackerId | null | undefined): id is TrackerId =>
    !!id && connected.includes(id) && isCapable(feature, id, capabilities)
  const override = overrides[feature]
  if (usable(override)) return override
  if (usable(primary)) return primary
  return TRACKER_ORDER.find((id) => usable(id)) ?? null
}
