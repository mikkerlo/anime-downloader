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

// How far ahead of this PC's clock an imported `at` may be before it is clamped.
export const MAX_FUTURE_SKEW_MS = 120_000

/** The later of two clocks; on a tie, `a` (the local side). */
export function laterClock<T extends SyncClock>(a: T, b: T): T {
  return b.at > a.at ? b : a
}

/**
 * `doc` with every clock more than `MAX_FUTURE_SKEW_MS` in the future moved
 * back to `now`, and one report per clamp. The input is not modified.
 */
export function clampSyncDoc(
  doc: SyncDoc,
  now: number
): { doc: SyncDoc; clamped: SyncClampReport[] } {
  const out = structuredClone(doc)
  const clamped: SyncClampReport[] = []
  const clamp = (clock: SyncClock | undefined, path: string): void => {
    if (!clock || clock.at - now <= MAX_FUTURE_SKEW_MS) return
    clamped.push({ path, at: clock.at, clampedTo: now })
    clock.at = now
  }
  for (const [id, title] of Object.entries(out.titles)) {
    for (const [ep, entry] of Object.entries(title.watch ?? {})) {
      clamp(entry.position, `titles.${id}.watch.${ep}.position`)
      clamp(entry.watched, `titles.${id}.watch.${ep}.watched`)
    }
    clamp(title.starred, `titles.${id}.starred`)
    clamp(title.priority, `titles.${id}.priority`)
    if (title.rate) {
      for (const field of ['episodes', 'status', 'score', 'rewatches'] as const) {
        clamp(title.rate[field], `titles.${id}.rate.${field}`)
      }
    }
  }
  clamp(out.priorityOrder, 'priorityOrder')
  for (const [id, stones] of Object.entries(out.tombstones)) {
    clamp(stones.starred, `tombstones.${id}.starred`)
    clamp(stones.priority, `tombstones.${id}.priority`)
  }
  return { doc: out, clamped }
}
