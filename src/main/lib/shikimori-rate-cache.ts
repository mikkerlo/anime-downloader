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
import type { ShikiAnimeRateEntry } from '../shikimori'

export interface CachedRateEntry {
  rate: {
    id: number
    score: number
    status: ShikiAnimeRateEntry['status']
    episodes: number
    rewatches: number
    updated_at: string
    target_id: number
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
      target_id: rate.target_id ?? rate.anime.id
    },
    shikiAnime: rate.anime,
    smotretAnime: malMap[rate.anime.id] ?? null
  }))
}
