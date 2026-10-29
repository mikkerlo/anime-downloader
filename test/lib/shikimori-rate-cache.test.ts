import { describe, it, expect } from 'vitest'
import {
  buildRateCacheEntries,
  findRateEntry,
  keepQueuedEntries,
  rateFromCacheEntry
} from '../../src/main/lib/shikimori-rate-cache'
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

  it("keeps the server's updated_at as serverUpdatedAt, which local writes never move (#572)", () => {
    const [entry] = buildRateCacheEntries([animeRatesRow(54595)], {})
    expect(entry.rate.serverUpdatedAt).toBe('2023-12-31T01:08:08.723+03:00')
    expect(entry.rate.updated_at).toBe('2023-12-31T01:08:08.723+03:00')
  })

  it('leaves smotretAnime null when the mal map has no match', () => {
    const [entry] = buildRateCacheEntries([animeRatesRow(54595)], {})
    expect(entry.smotretAnime).toBeNull()
  })
})

// `get-rate` from the cache (#570): the `getUserRate` shape, field by field.
describe('rateFromCacheEntry', () => {
  const full = {
    rate: {
      id: 159054595,
      score: 8,
      status: 'watching' as const,
      episodes: 5,
      rewatches: 2,
      updated_at: '2026-10-01T00:00:00Z',
      target_id: 54595
    },
    shikiAnime: { id: 54595 }
  }

  it('maps every field of a complete entry and marks it stale', () => {
    expect(rateFromCacheEntry(full)).toEqual({
      id: 159054595,
      score: 8,
      status: 'watching',
      episodes: 5,
      rewatches: 2,
      target_id: 54595,
      target_type: 'Anime',
      stale: true
    })
  })

  it('a missing id becomes -1, the sentinel queueRate returns', () => {
    const { id: _id, ...rate } = full.rate
    expect(rateFromCacheEntry({ ...full, rate }).id).toBe(-1)
  })

  it('a missing rewatches becomes 0', () => {
    const { rewatches: _r, ...rate } = full.rate
    expect(rateFromCacheEntry({ ...full, rate }).rewatches).toBe(0)
  })

  it('a missing target_id falls back to shikiAnime.id', () => {
    const { target_id: _t, ...rate } = full.rate
    expect(rateFromCacheEntry({ rate, shikiAnime: { id: 777 } }).target_id).toBe(777)
  })
})

describe('findRateEntry', () => {
  const byTarget = { rate: { score: 0, status: 'planned' as const, episodes: 0, target_id: 1 } }
  const byAnime = {
    rate: { score: 0, status: 'planned' as const, episodes: 0 },
    shikiAnime: { id: 2 }
  }

  it('matches by rate.target_id, then by shikiAnime.id', () => {
    expect(findRateEntry([byTarget, byAnime], 1)).toBe(byTarget)
    expect(findRateEntry([byTarget, byAnime], 2)).toBe(byAnime)
    expect(findRateEntry([byTarget, byAnime], 3)).toBeNull()
  })
})

describe('keepQueuedEntries (#592)', () => {
  const e = (malId: number, score: number, byAnime = false) =>
    byAnime
      ? { rate: { score, status: 'watching' as const, episodes: 1 }, shikiAnime: { id: malId } }
      : { rate: { score, status: 'watching' as const, episodes: 1, target_id: malId } }

  it('nothing queued: the server list as is', () => {
    const server = [e(1, 6)]
    expect(keepQueuedEntries(server, [e(1, 7)], new Set())).toBe(server)
  })

  it('a queued id keeps its cached entry in place; the others take the server', () => {
    const out = keepQueuedEntries([e(1, 6), e(2, 8)], [e(1, 7), e(2, 1)], new Set([1]))
    expect(out.map((x) => x.rate.score)).toEqual([7, 8])
  })

  it('a queued id the server did not return keeps its cached entry, matched by shikiAnime.id too', () => {
    const out = keepQueuedEntries([e(1, 6)], [e(3, 9, true)], new Set([3]))
    expect(out.map((x) => x.rate.score)).toEqual([6, 9])
  })

  it('a queued id with no cached entry takes the server’s', () => {
    const out = keepQueuedEntries([e(1, 6)], [], new Set([1, 4]))
    expect(out.map((x) => x.rate.score)).toEqual([6])
  })
})
