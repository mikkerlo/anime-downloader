// Tombstone garbage collection for mergeable watch state (#572). Pure.

export const TOMBSTONE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

export function isExpiredTombstone(clock: SyncMembershipClock | undefined, now: number): boolean {
  return clock?.deleted === true && now - clock.at > TOMBSTONE_MAX_AGE_MS
}

/**
 * `meta` without the `starred` / `priority` tombstones older than
 * `TOMBSTONE_MAX_AGE_MS`. A title left with nothing is dropped. Live clocks
 * are never touched.
 */
export function pruneExpiredTombstones(meta: SyncMeta, now: number): SyncMeta {
  const titles: SyncMeta['titles'] = {}
  for (const [animeId, clocks] of Object.entries(meta.titles)) {
    const kept = { ...clocks }
    if (isExpiredTombstone(kept.starred, now)) delete kept.starred
    if (isExpiredTombstone(kept.priority, now)) delete kept.priority
    if (Object.keys(kept).length > 0) titles[animeId] = kept
  }
  return { ...meta, titles }
}

/**
 * A drive doc's tombstones without the ones older than `TOMBSTONE_MAX_AGE_MS`
 * or for a title that has left the library's scope (S9 #584 calls this before
 * its drive write). With a base, a deletion propagates without a tombstone,
 * so dropping one only matters to a PC that first merges with no base.
 */
export function pruneDocTombstones(
  tombstones: SyncDoc['tombstones'],
  now: number,
  scope: Iterable<string | number>
): SyncDoc['tombstones'] {
  const inScope = new Set([...scope].map(String))
  const out: SyncDoc['tombstones'] = {}
  for (const [animeId, stones] of Object.entries(tombstones)) {
    if (!inScope.has(animeId)) continue
    const kept = { ...stones }
    if (isExpiredTombstone(kept.starred, now)) delete kept.starred
    if (isExpiredTombstone(kept.priority, now)) delete kept.priority
    if (kept.starred || kept.priority) out[animeId] = kept
  }
  return out
}
