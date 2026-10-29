// Shared domain types — mergeable watch state (#572, epic #563).
// Ambient globals (see anime.ts header).

// When and where a field last changed. `origin` is this install's `installId`,
// `'shikimori'` for a value observed on the server, or `'legacy'` for a clock
// projected from a row written before clocks existed.
interface SyncClock {
  at: number
  origin: string
}

// A `starred` / `priority` clock. `deleted: true` is the tombstone an unstar or
// unprioritise leaves behind.
interface SyncMembershipClock extends SyncClock {
  deleted?: true
}

type SyncRateField = 'episodes' | 'status' | 'score' | 'rewatches'

interface SyncRateFieldClock extends SyncClock {
  value: number | string
}

// `watchProgress[key].sync`. Absent on a legacy row; present (possibly `{}`) on
// every row written since #572.
interface WatchProgressSync {
  position?: SyncClock
  watched?: SyncClock
}

// What a `watch-progress:save` was made for. Only `'playback'` moves
// `sync.position`.
type WatchProgressSaveSource = 'playback' | 'choice' | 'mark'

// The `syncMeta` store key.
interface SyncMeta {
  // Keyed by smotret `animeId`.
  titles: Record<string, { starred?: SyncMembershipClock; priority?: SyncMembershipClock }>
  priorityOrder?: SyncClock
  // Keyed `"<shikimoriUserId>:<malId>"`.
  rates: Record<string, Partial<Record<SyncRateField, SyncRateFieldClock>>>
  // Fields of a newer writer's `SyncDoc` that this version doesn't know,
  // kept so the next projection writes them back verbatim (#572).
  unknown?: {
    doc?: Record<string, unknown>
    titles?: Record<string, Record<string, unknown>>
  }
}

// --- SyncDoc v1: the projection of local watch state that a Shared Library
// carries (S5 #573 serializes it, S9 #584 merges it). Frozen by #572; a change
// follows the version rule: `stateMinor` for an added optional field whose
// absence has a defined meaning and whose rule is silent, `stateVersion` for
// anything else.

// A field and the clock of its last change.
interface SyncField<T> {
  value: T
  at: number
  origin: string
}

// An unstar or unprioritise of a title, in `SyncDoc.tombstones`.
interface SyncTombstone {
  deleted: true
  at: number
  origin: string
}

// Rule 1's value: the resume point and the translation it belongs to.
interface SyncWatchPosition {
  position: number
  duration: number
  translationId?: number
}

interface SyncWatchEntry {
  position: SyncField<SyncWatchPosition>
  watched: SyncField<boolean>
  // Rule 3: earliest non-null wins; it needs no clock.
  watchedAt: number | null
}

interface SyncRateState {
  malId: number
  episodes: SyncField<number>
  status: SyncField<string>
  score: SyncField<number>
  rewatches: SyncField<number>
}

// One episode's detection, without the local `filePath`: `file` is the
// identity this PC matches against its own file before taking the entry.
interface SyncSkipEpisode {
  file: { translationId: number; fileSize: number }
  episodeLabel: string
  durationSec: number
  hashesPerSec: number
  op: SkipRange | null
  ed: SkipRange | null
}

interface SyncSkipState {
  algorithm: ShowSkipDetections['algorithm']
  analyzedAt: number
  episodeCount: number
  perEpisode: Record<string, SyncSkipEpisode>
}

// One title's state. Keys this version doesn't know are kept verbatim.
interface SyncTitleState {
  // Keyed by `episodeInt`, an opaque string (`"12.5"` included).
  watch?: Record<string, SyncWatchEntry>
  starred?: SyncField<true>
  priority?: SyncField<true>
  rate?: SyncRateState
  // Rule 11: the dismissed continue-watching `episodeInt`s, sorted. A 3-way
  // set merge, so it carries no clock.
  dismissed?: string[]
  // Rule 12: a cache, merged per episode by file identity; no clock.
  skip?: SyncSkipState
  [unknownField: string]: unknown
}

interface SyncDoc {
  stateVersion: 1
  stateMinor: number
  installId: string
  // In-scope titles only, keyed by smotret `animeId`.
  titles: Record<string, SyncTitleState>
  // In-scope ids only, in the local priority order.
  priorityOrder: SyncField<string[]>
  // Unstar / unprioritise tombstones of in-scope titles.
  tombstones: Record<string, { starred?: SyncTombstone; priority?: SyncTombstone }>
  [unknownField: string]: unknown
}

// A clock moved back to now on import because it was too far in the future.
interface SyncClampReport {
  path: string
  at: number
  clampedTo: number
}

// --- The merge runner (S9 #584) -------------------------------------------------

// Where a Shikimori-bound merge value came from: a library leg (or a raise its
// flips caused), or an S10 (#585) resolution of a conflict those libraries
// were parties to.
type SyncProvenance = { libraryId: string } | { resolution: string; libraryIds: string[] }

type SyncTrigger = 'attach' | 'plug' | 'online' | 'login' | 'manual' | 'prepare'

interface SyncLibraryResult {
  libraryId: string
  drive: 'ok' | 'skipped' | 'error'
  driveReason?:
    | 'unavailable'
    | 'read-only'
    | 'videos-only'
    | 'foreign'
    | 'write-failed-read-only'
    | 'io'
    | 'unreadable'
  shikimori: 'ok' | 'skipped' | 'error'
  shikimoriReason?: 'offline' | 'logged-out' | 'claim' | 'foreign' | 'auth' | 'network' | 'api'
  counts: { applied: number; conflicts: number; clamped: number }
  // §2 step 2: skipped while user edits are queued.
  waitingMalIds: number[]
  // Path F entries written in this run.
  rewatchesSuperseded: number
}

interface SyncRunResult {
  runId: string
  trigger: SyncTrigger
  // Every attached library, in attach order.
  libraries: SyncLibraryResult[]
}

/** `shared-library:sync-now`: every library, or one title's libraries restricted to it. */
interface SyncNowRequest {
  libraryId?: string
  animeId?: number
}

/** `sync:get-status`: runs in flight, and each library's last result and held conflicts. */
interface SyncStatus {
  running: string[]
  libraries: Record<string, { last: SyncLibraryResult | null; needReview: number }>
}

type SyncConflictFieldPath =
  | `watch.${string}.watched`
  | 'rate.episodes'
  | 'rate.status'
  | 'rate.score'
  | 'rate.rewatches'

/** One held conflict in `userData/sync-state/conflicts.json`, keyed by (ownerScope, animeId, fieldPath). */
interface SyncConflictRecord {
  id: string
  ownerScope: number
  animeId: string
  fieldPath: SyncConflictFieldPath
  // `local`, `library:<id>`, `shikimori`.
  parties: Record<string, unknown>
  // Each leg's base value (`library:<id>` / `shikimori`).
  bases: Record<string, unknown>
  at: Record<string, SyncClock>
  // The party with the newest `at`, or null (equal or missing, and every "both rose" rewatch).
  suggestion: string | null
  reason: string
  firstSeenRunId: string
  lastSeenRunId: string
}

interface SyncApplyReport {
  // Field paths written to the local store.
  applied: string[]
  // Field paths left as they were, and why. The caller does not advance its
  // base for these, so they are retried.
  unapplied: { path: string; reason: string }[]
  clamped: SyncClampReport[]
}
