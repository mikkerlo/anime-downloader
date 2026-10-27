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
  stateMinor: 0
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

interface SyncApplyReport {
  // Field paths written to the local store.
  applied: string[]
  // Field paths left as they were, and why. The caller does not advance its
  // base for these, so they are retried.
  unapplied: { path: string; reason: string }[]
  clamped: SyncClampReport[]
}
