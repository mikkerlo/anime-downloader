// Field clocks for mergeable watch state (#572). Pure: no store, no `fs`.

export const LEGACY_ORIGIN = 'legacy'

/**
 * The clocks a legacy `watchProgress` row (one with no `sync`) stands for:
 * `position` at its `updatedAt`, `watched` at its `watchedAt` (or `updatedAt`).
 * A row's first save materializes these *before* applying the save, so a save
 * that does not stamp cannot turn the moved `updatedAt` into a newer clock.
 */
export function legacyWatchSync(row: { updatedAt: number; watchedAt?: number }): WatchProgressSync {
  return {
    position: { at: row.updatedAt, origin: LEGACY_ORIGIN },
    watched: { at: row.watchedAt ?? row.updatedAt, origin: LEGACY_ORIGIN }
  }
}

/**
 * `clock`, moved past `prev` when the wall clock has stepped back, so a newer
 * edit of a field never carries an older `at` than the edit it replaces.
 */
export function advanceClock(clock: SyncClock, prev: SyncClock | undefined): SyncClock {
  return prev && prev.at >= clock.at ? { at: prev.at + 1, origin: clock.origin } : clock
}

/** A row's clocks: its own `sync`, or the legacy projection when it has none. */
export function watchSyncOf(row: {
  updatedAt: number
  watchedAt?: number
  sync?: WatchProgressSync
}): WatchProgressSync {
  return row.sync ?? legacyWatchSync(row)
}
