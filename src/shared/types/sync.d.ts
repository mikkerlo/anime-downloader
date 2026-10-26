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
}
