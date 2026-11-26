// Shared domain types — list trackers (epic #688, #689).
// Ambient globals (see anime.d.ts header), so the renderer can name them later
// without an import. This is the only definition of `TrackerId`,
// `TrackerUser` and `TrackerErrorClass`; `src/main/trackers/types.ts` uses
// these global names and declares no copy.

// The trackers the app knows, in code. On a Shared Library drive the owner's
// provider is an open string, so this union never validates drive data.
type TrackerId = 'shikimori' | 'anilist' | 'mal'

// The signed-in account a tracker reports. `avatar` is null when the tracker
// has no picture; the sidebar chip falls back to the nickname's initial.
interface TrackerUser {
  id: number
  nickname: string
  avatar: string | null
}

// What a tracker error means to its callers. `docs/trackers.md` holds the
// policy each class implies (`TRACKER_ERROR_POLICY`).
type TrackerErrorClass = 'network' | 'auth' | 'config' | 'rate-limit' | 'server' | 'item'

// ---- The `tracker:*` IPC surface (#694) -------------------------------------
// Each reply and broadcast names its tracker. `raw` is Shikimori's persisted
// `shikimoriUserRates` row, present for `trackerId: 'shikimori'` only, for the
// views that still read `shikiAnime.*`; it goes away with the `shikimori:*`
// aliases (#717).

// A rate in the app's values: Shikimori's six statuses, a 0-10 score.
interface TrackerRateValues {
  episodes: number
  status: ShikiUserRateStatus
  score: number
  rewatches: number
}

// A listed entry, normalized for reading: `src/main/trackers/types.ts`'s
// `TrackerRateEntry<TNative>` without `native`.
interface TrackerRateEntry {
  trackerId: TrackerId
  malId: number
  remoteId: number | null
  values: TrackerRateValues
  // In ms; null when the row has no timestamp or it doesn't parse.
  updatedAt: number | null
  anime: {
    title: string
    poster: string | null
    kind: string | null
    episodes: number | null
    episodesAired: number | null
    status: string | null
  }
  smotretAnime: AnimeSearchResult | null
}

// `tracker:get-rate`. `values` is null when a connected tracker has no row for
// the title; `stale` when it came from the cached list (offline, or a failure
// a queued write survives). `mediaId` is the tracker's own media id where it
// isn't the MAL id: absent for Shikimori and MAL, AniList's from #703.
interface TrackerRateResult {
  values: TrackerRateValues | null
  stale: boolean
  mediaId?: number
}

// `tracker:get-rates`. `queuedAfter` is the last queued `after` per MAL id in
// that tracker's live queue, for the renderer's pending overlay.
interface TrackerRatesSnapshot {
  trackerId: TrackerId
  entries: TrackerRateEntry[]
  queuedAfter: Record<number, TrackerRateValues>
  raw?: ShikiAnimeRateEntry[]
}

// `tracker:get-sync-status`: Shikimori's `shikimori:get-sync-status` fields
// plus "Needs setup".
interface TrackerSyncStatus {
  state: 'idle' | 'syncing'
  queueLength: number
  lastSyncAt: number
  lastSyncError: string | null
  sessionExpired: boolean
  needsSetup: boolean
}

// One kept bucket. `ownerId` is the bucket key (the tracker's user id as a
// string), null for the unknown-account bucket.
interface TrackerParkedQueueSummary {
  trackerId: TrackerId
  ownerId: string | null
  nickname: string
  count: number
  parkedAt: number
}

interface TrackerUpdateRateOptions {
  // Write this tracker alone: no fan-out to the mirrors.
  only?: TrackerId
}

interface TrackerRateUpdatedEvent {
  trackerId: TrackerId
  entry: TrackerRateEntry
  raw?: ShikiAnimeRateEntry
}

interface TrackerRatesRefreshedEvent {
  trackerId: TrackerId
  entries: TrackerRateEntry[]
  raw?: ShikiAnimeRateEntry[]
}

interface TrackerSyncStatusEvent {
  trackerId: TrackerId
  status: TrackerSyncStatus
}

interface TrackerOfflineQueueChangedEvent {
  trackerId: TrackerId
  length: number
  queuedAfter: Record<number, TrackerRateValues>
}
