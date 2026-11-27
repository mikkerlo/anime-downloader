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

// ---- Accounts, auth and logout (#695) ----------------------------------------

// One tracker's account, connected or not. "Connected" means `user` is set;
// `sessionExpired` means the user is kept and the credentials are cleared.
// `credentialState` is `'locked'` only after a real read failed to decrypt the
// stored blob (AniList, MAL); listing accounts never decrypts. `needsSetup` is
// MAL with no client ID saved, or the tracker's sync instance reporting a
// `config`-class failure.
interface TrackerAccount {
  trackerId: TrackerId
  user: TrackerUser | null
  hasCredentials: boolean
  sessionExpired: boolean
  needsSetup: boolean
  credentialState: 'none' | 'ok' | 'locked'
  // When the session ends, in ms, from a provider that knows it (AniList, #703).
  sessionExpiresAt?: number
}

// `tracker:list-accounts`, and the `tracker:accounts-changed` payload (#696).
// `primary` is resolved: the stored `trackerPrimary` when that tracker is
// connected, else the first connected one in `shikimori`, `anilist`, `mal`
// order, else null. `mirror` and `featureSources` are as stored
// (`trackerMirror`, `trackerFeatureSource`).
interface TrackerAccountsState {
  accounts: TrackerAccount[]
  primary: TrackerId | null
  mirror: Partial<Record<TrackerId, boolean>>
  featureSources: Partial<Record<TrackerFeature, TrackerId>>
  // Whether the MyAnimeList and AniList cards show in Settings → Trackers
  // (#702, #703): false in packaged builds until the flag lifts.
  newTrackerCardsEnabled: boolean
}

// What `tracker:begin-auth` and `tracker:complete-auth` resolve to.
// `open-failed` and `port-busy` resolve early and keep the attempt held, so a
// paste can still finish it; `port-busy` never opens the browser.
type TrackerAuthResult =
  | { status: 'connected'; account: TrackerAccount }
  | { status: 'cancelled' }
  | { status: 'error'; kind: TrackerErrorClass; message: string }
  | { status: 'offline' }
  | { status: 'needs-setup' }
  | { status: 'open-failed'; authorizeUrl: string }
  | { status: 'port-busy'; authorizeUrl: string }

// `tracker:get-client-config` / `tracker:set-client-config` (MAL only). The
// secret is never returned: `hasSecret` says whether one is stored.
interface TrackerClientConfig {
  clientId: string | null
  hasSecret: boolean
  // The one redirect URL the user registers, with main's loopback port (#702).
  redirectUri?: string
}

// `tracker:test-client-config` (MAL only, #702): the saved client ID against
// `GET /anime/1`. `kind` is the failure's class (`config` for a rejected ID,
// `network` when MyAnimeList can't be reached).
type TrackerTestClientConfigResult =
  | { ok: true }
  | { ok: false; kind: TrackerErrorClass; message: string }

// `secret`: a string stores one, null clears it, and leaving it out keeps it.
interface TrackerClientConfigInput {
  clientId: string
  secret?: string | null
}

interface TrackerLogoutOptions {
  // The live queue: `keep` (the default) parks it under the user, `discard` drops it.
  pending?: 'keep' | 'discard'
}

// ---- Primary, mirrors and feature sources (#696) -----------------------------

// `tracker:logout`. `needsPrimaryChoice` when the primary logged out and 2 or
// more trackers remain: `candidates` are the remaining connected ones in
// `shikimori`, `anilist`, `mal` order, and the first is already the primary.
interface TrackerLogoutResult {
  needsPrimaryChoice?: { candidates: TrackerId[] }
}

// A feature whose tracker `tracker:set-feature-source` can override (#706
// resolves it).
type TrackerFeature = 'calendar' | 'chronology' | 'forYou' | 'details' | 'airing'

interface TrackerSetMirrorOptions {
  // Switching off: without it nothing changes and the count comes back.
  confirm?: boolean
}

// `tracker:set-mirror`. `applied` is whether the toggle was written; a call
// that matches the stored toggle is `{ applied: false }`. Off without
// `confirm`: `pendingMirrorChanges`, the live `via: 'mirror'` count. Off with
// `confirm`: `discarded`, the count actually removed, which can be smaller or
// larger than the count shown; a discard that failed after the toggle was
// written is `{ applied: true, discarded: 0 }`, since the toggle is off either
// way. On: `offerReconcile: true`.
interface TrackerSetMirrorResult {
  applied: boolean
  pendingMirrorChanges?: number
  discarded?: number
  offerReconcile?: boolean
}
