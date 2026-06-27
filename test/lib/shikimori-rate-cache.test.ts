import { describe, it, expect } from 'vitest'
import { buildRateCacheEntries } from '../../src/main/lib/shikimori-rate-cache'
import type { ShikiAnimeRateEntry } from '../../src/main/shikimori'
import type { AnimeSearchResult } from '../../src/main/smotret-api'

// `/api/users/:id/anime_rates` rows: anime id nested under `anime.id`, and —
// crucially — NO top-level `target_id`. We cast through `unknown` so the test
// row matches the real wire shape rather than the (optimistic) interface.
function animeRatesRow(animeId: number, status = 'completed'): ShikiAnimeRateEntry {
  return {
    id: 159000000 + animeId,
    score: 10,
    status,
    episodes: 12,
    rewatches: 0,
    updated_at: '2023-12-31T01:08:08.723+03:00',
    anime: { id: animeId, name: `Anime ${animeId}` }
  } as unknown as ShikiAnimeRateEntry
}

describe('buildRateCacheEntries', () => {
  it('derives target_id from anime.id when the row has none (regression: anime_rates has no top-level target_id, so rateByMalId never matched)', () => {
    const [entry] = buildRateCacheEntries([animeRatesRow(54595)], {})
    // Old behavior copied `rate.target_id` straight through → undefined/null,
    // which the renderer store's `rateByMalId` could never match.
    expect(entry.rate.target_id).toBe(54595)
  })

  it('prefers an explicit target_id when one is present', () => {
    const row = { ...animeRatesRow(54595), target_id: 999 } as ShikiAnimeRateEntry
    const [entry] = buildRateCacheEntries([row], {})
    expect(entry.rate.target_id).toBe(999)
  })

  it('joins the smotret entry by anime id and defaults missing rewatches to 0', () => {
    const smotret = { id: 33172, title: 'X' } as unknown as AnimeSearchResult
    const [entry] = buildRateCacheEntries([animeRatesRow(54595)], { 54595: smotret })
    expect(entry.smotretAnime).toBe(smotret)
    expect(entry.rate.rewatches).toBe(0)
    expect(entry.shikiAnime.id).toBe(54595)
  })

  it('leaves smotretAnime null when the mal map has no match', () => {
    const [entry] = buildRateCacheEntries([animeRatesRow(54595)], {})
    expect(entry.smotretAnime).toBeNull()
  })
})
