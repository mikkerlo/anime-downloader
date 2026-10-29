// Pure builder for the cached `shikimoriUserRates` entries — split out from the
// IPC fetch orchestration so the field-mapping (the part that has actually had
// bugs) can be unit-tested without network or electron-store.
//
// The source rows come from `/api/users/:id/anime_rates` (`getUserAnimeRates`),
// whose entries nest the anime id under `anime.id` and carry NO top-level
// `target_id`. The renderer store keys rate lookups by `rate.target_id`
// (`rateByMalId`), so the mapping must derive `target_id` from `anime.id` when
// the row lacks one — otherwise every cached entry gets a null target and the
// store can never mirror a status from cache.

import type { AnimeSearchResult } from '../smotret-api'
import type { ShikiAnimeRateEntry, ShikiUserRate } from '../shikimori'

export interface CachedRateEntry {
  rate: {
    id: number
    score: number
    status: ShikiAnimeRateEntry['status']
    episodes: number
    rewatches: number
    updated_at: string
    target_id: number
    // The server's `updated_at` as of the last wholesale refresh. Local writes
    // move `updated_at` to the local clock and never touch this (#572).
    serverUpdatedAt?: string
  }
  shikiAnime: ShikiAnimeRateEntry['anime']
  smotretAnime: AnimeSearchResult | null
}

export function buildRateCacheEntries(
  rates: ShikiAnimeRateEntry[],
  malMap: Record<number, AnimeSearchResult>
): CachedRateEntry[] {
  return rates.map((rate) => ({
    rate: {
      id: rate.id,
      score: rate.score,
      status: rate.status,
      episodes: rate.episodes,
      rewatches: rate.rewatches ?? 0,
      updated_at: rate.updated_at,
      // anime_rates rows have no top-level target_id; fall back to the nested
      // anime id so `rateByMalId` can match.
      target_id: rate.target_id ?? rate.anime.id,
      serverUpdatedAt: rate.updated_at
    },
    shikiAnime: rate.anime,
    smotretAnime: malMap[rate.anime.id] ?? null
  }))
}

/** A cached entry as stored; rows from older versions can lack these fields. */
export interface StoredRateEntry {
  rate: Pick<CachedRateEntry['rate'], 'score' | 'status' | 'episodes'> &
    Partial<Pick<CachedRateEntry['rate'], 'id' | 'rewatches' | 'target_id'>>
  shikiAnime?: { id: number }
}

/** The entry for `malId`, matched by `rate.target_id`, then `shikiAnime.id`. */
export function findRateEntry<E extends StoredRateEntry>(entries: E[], malId: number): E | null {
  return entries.find((e) => (e.rate.target_id ?? e.shikiAnime?.id) === malId) ?? null
}

/**
 * `get-rate`'s answer from the cache (#570) when the live read can't be made.
 * `id` is `-1` when missing, the sentinel `queueRate` uses for "no rate yet".
 */
export function rateFromCacheEntry(entry: StoredRateEntry): ShikiUserRate & { stale: true } {
  const { rate, shikiAnime } = entry
  return {
    id: typeof rate.id === 'number' ? rate.id : -1,
    score: rate.score,
    status: rate.status,
    episodes: rate.episodes,
    rewatches: rate.rewatches ?? 0,
    target_id: rate.target_id ?? shikiAnime?.id ?? -1,
    target_type: 'Anime',
    stale: true
  }
}

/**
 * A wholesale refresh that keeps the cached entry of every MAL id in `queued`
 * (#592): those still have edits waiting in the offline queue, so the server's
 * value is older than the cache's. A queued id the server didn't return keeps
 * its cached entry too; one with no cached entry takes the server's.
 */
export function keepQueuedEntries<S extends StoredRateEntry, C extends StoredRateEntry>(
  server: S[],
  cached: C[],
  queued: ReadonlySet<number>
): (S | C)[] {
  if (queued.size === 0) return server
  const malIdOf = (e: StoredRateEntry): number | undefined => e.rate.target_id ?? e.shikiAnime?.id
  const seen = new Set<number>()
  const out: (S | C)[] = server.map((e) => {
    const id = malIdOf(e)
    if (id === undefined || !queued.has(id)) return e
    seen.add(id)
    return findRateEntry(cached, id) ?? e
  })
  for (const id of queued) {
    if (seen.has(id)) continue
    const kept = findRateEntry(cached, id)
    if (kept) out.push(kept)
  }
  return out
}
