// Live contract test against smotret-anime.ru (#141).
//
// Excluded from the default `npm run test` suite — runs weekly via
// `.github/workflows/contract-check.yml` or locally via `npm run test:contract`.
//
// Anonymous (empty-token) requests only — sufficient for searchAnime, getAnime,
// getEpisode, and the new getEpisodesBatch path. getEmbed requires a token and
// is intentionally out of scope. Assertions are LOOSE per the review on #141:
// parser doesn't throw, required fields present.

import { describe, it, expect } from 'vitest'
import { SmotretApi } from '../../src/main/smotret-api'

const api = new SmotretApi(() => '')

function requireString(obj: Record<string, unknown>, key: string): void {
  expect(obj[key], `expected ${key} to be a string`).toEqual(expect.any(String))
}

function requireNumber(obj: Record<string, unknown>, key: string): void {
  expect(obj[key], `expected ${key} to be a number`).toEqual(expect.any(Number))
}

describe('smotret-anime live contract', () => {
  // The chain: search → anime → episodes-batch / episode. Each step uses the
  // ID from the previous, so we don't pin smotret-anime-specific IDs (those
  // are less stable than MAL ids).
  it('search → anime → episodes-batch + episode covers the cold-load path', async () => {
    // 1) searchAnime — non-empty result with the basic AnimeSearchResult shape.
    const searchResult = await api.searchAnime('Steins;Gate')
    expect(searchResult.data, 'searchAnime.data must be an array').toBeInstanceOf(Array)
    expect(searchResult.data.length, 'search "Steins;Gate" must have results').toBeGreaterThan(0)

    // Prefer a result that has episodes (some entries are 0-episode placeholders).
    const seed = searchResult.data.find((r) => r.numberOfEpisodes > 0) ?? searchResult.data[0]
    const s = seed as unknown as Record<string, unknown>
    requireNumber(s, 'id')
    requireString(s, 'title')
    requireNumber(s, 'numberOfEpisodes')
    requireString(s, 'type')
    requireString(s, 'typeTitle')
    expect(seed.titles, 'titles must be an object').toBeTypeOf('object')

    // 2) getAnime — full AnimeDetail with episodes array + genres + descriptions.
    const animeRes = await api.getAnime(seed.id)
    const anime = animeRes.data as unknown as Record<string, unknown>
    requireNumber(anime, 'id')
    requireString(anime, 'title')
    requireString(anime, 'posterUrl')
    expect(anime.episodes, 'anime.episodes must be an array').toBeInstanceOf(Array)
    expect(anime.genres, 'anime.genres must be an array').toBeInstanceOf(Array)
    expect(anime.descriptions, 'anime.descriptions must be an array').toBeInstanceOf(Array)

    const episodes = anime.episodes as Record<string, unknown>[]
    // Some shows have 0 episodes (announcements). Skip the episode-level shape
    // checks in that case — they aren't a contract breakage.
    if (episodes.length === 0) return

    const firstEp = episodes[0]
    requireNumber(firstEp, 'id')
    requireString(firstEp, 'episodeFull')
    requireString(firstEp, 'episodeInt')
    requireString(firstEp, 'episodeType')
    requireNumber(firstEp, 'isActive')

    // 3) getEpisodesBatch — the new bulk path (#155). Pull the first three
    //    active episodes and confirm the response shape we depend on.
    const activeIds = episodes
      .filter((e) => e.isActive === 1)
      .slice(0, 3)
      .map((e) => e.id as number)
    if (activeIds.length === 0) return

    const batchRes = await api.getEpisodesBatch(activeIds)
    expect(batchRes.data, 'getEpisodesBatch.data must be an array').toBeInstanceOf(Array)
    expect(
      batchRes.data.length,
      'getEpisodesBatch must return at least one episode'
    ).toBeGreaterThan(0)

    const batchEp = batchRes.data[0] as unknown as Record<string, unknown>
    requireNumber(batchEp, 'id')
    requireString(batchEp, 'episodeFull')
    requireString(batchEp, 'episodeInt')
    requireString(batchEp, 'episodeType')
    expect(batchEp.translations, 'translations must be an array').toBeInstanceOf(Array)
    if ((batchEp.translations as unknown[]).length > 0) {
      const t = (batchEp.translations as Record<string, unknown>[])[0]
      requireNumber(t, 'id')
      requireString(t, 'type')
      requireString(t, 'typeKind')
      requireString(t, 'typeLang')
      requireString(t, 'authorsSummary')
      requireNumber(t, 'isActive')
      requireNumber(t, 'width')
      requireNumber(t, 'height')
    }

    // 4) getEpisode (single) — the legacy path still used by the player +
    //    cache-fallback. Confirm one round-trip.
    const single = await api.getEpisode(activeIds[0])
    const singleEp = single.data as unknown as Record<string, unknown>
    requireNumber(singleEp, 'id')
    requireString(singleEp, 'episodeFull')
    requireString(singleEp, 'episodeInt')
    requireString(singleEp, 'episodeType')
    expect(singleEp.translations, 'single-ep translations must be an array').toBeInstanceOf(Array)
  })
})
