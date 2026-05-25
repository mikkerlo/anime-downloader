// Live contract test against shikimori.one (#141).
//
// These tests are EXCLUDED from the default `npm run test` suite (see
// `test/contract/**` in vitest.config.ts) — they hit the real API over the
// network and would flake any PR run. Triggered weekly by
// `.github/workflows/contract-check.yml`, or locally via `npm run test:contract`.
//
// Per the review on #141: only anonymous endpoints, only LOOSE assertions
// (parser doesn't throw, required fields present + correct primitive type).
// Upstream is free to add new optional fields without tripping us.

import { describe, it, expect } from 'vitest'

const BASE = 'https://shikimori.one'
const UA = 'anime-dl-app/contract-check'

// Steins;Gate — picked as a stable, long-released MAL id that won't disappear.
const STABLE_MAL_ID = 9253

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`shikimori ${path}: HTTP ${res.status} ${res.statusText}`)
  return res.json()
}

function requireString(obj: Record<string, unknown>, key: string): void {
  expect(obj[key], `expected ${key} to be a non-empty string`).toEqual(expect.any(String))
  expect((obj[key] as string).length, `expected ${key} to be non-empty`).toBeGreaterThan(0)
}

function requireNumber(obj: Record<string, unknown>, key: string): void {
  expect(obj[key], `expected ${key} to be a number`).toEqual(expect.any(Number))
}

describe('Shikimori live contract', () => {
  // Run sequentially to be polite to upstream; total elapsed is ~1–2s.
  it(`GET /api/animes/${STABLE_MAL_ID} returns ShikiAnimeDetails-shaped payload`, async () => {
    const anime = (await getJson(`/api/animes/${STABLE_MAL_ID}`)) as Record<string, unknown>

    // Required scalars from src/main/shikimori.ts → ShikiAnimeDetails.
    requireNumber(anime, 'id')
    requireString(anime, 'name')
    requireString(anime, 'russian')
    requireString(anime, 'kind')
    requireString(anime, 'rating')
    requireNumber(anime, 'duration')
    requireString(anime, 'score')
    requireString(anime, 'status')
    requireNumber(anime, 'episodes')
    requireNumber(anime, 'episodes_aired')

    expect(anime.genres, 'genres must be an array').toBeInstanceOf(Array)
    expect((anime.genres as unknown[]).length).toBeGreaterThan(0)
    const g = (anime.genres as Record<string, unknown>[])[0]
    requireNumber(g, 'id')
    requireString(g, 'name')
    requireString(g, 'russian')
    requireString(g, 'kind')

    expect(anime.studios, 'studios must be an array').toBeInstanceOf(Array)
    if ((anime.studios as unknown[]).length > 0) {
      const s = (anime.studios as Record<string, unknown>[])[0]
      requireNumber(s, 'id')
      requireString(s, 'name')
      requireString(s, 'filtered_name')
      expect(typeof s.real).toBe('boolean')
    }
  })

  it(`GET /api/animes/${STABLE_MAL_ID}/franchise returns ShikiFranchise-shaped payload`, async () => {
    const f = (await getJson(`/api/animes/${STABLE_MAL_ID}/franchise`)) as Record<string, unknown>

    requireNumber(f, 'current_id')
    expect(f.nodes, 'nodes must be an array').toBeInstanceOf(Array)
    expect(f.links, 'links must be an array').toBeInstanceOf(Array)
    expect((f.nodes as unknown[]).length).toBeGreaterThan(0)

    const n = (f.nodes as Record<string, unknown>[])[0]
    requireNumber(n, 'id')
    requireString(n, 'name')
    requireString(n, 'image_url')
    requireString(n, 'url')
    requireNumber(n, 'weight')

    if ((f.links as unknown[]).length > 0) {
      const l = (f.links as Record<string, unknown>[])[0]
      requireNumber(l, 'id')
      requireNumber(l, 'source_id')
      requireNumber(l, 'target_id')
      requireNumber(l, 'weight')
      requireString(l, 'relation')
    }
  })

  it('GET /api/calendar returns ShikiCalendarEntry[] -shaped payload', async () => {
    const entries = (await getJson('/api/calendar')) as Record<string, unknown>[]
    expect(entries, 'response must be an array').toBeInstanceOf(Array)
    // Calendar can technically be empty if nothing is airing — only validate
    // the shape if there's something to validate against.
    if (entries.length === 0) return

    const entry = entries[0]
    expect(entry.next_episode === null || typeof entry.next_episode === 'number').toBe(true)
    expect(entry.next_episode_at === null || typeof entry.next_episode_at === 'string').toBe(true)
    expect(entry.duration === null || typeof entry.duration === 'number').toBe(true)

    const anime = entry.anime as Record<string, unknown>
    expect(anime, 'entry.anime must be an object').toBeTypeOf('object')
    requireNumber(anime, 'id')
    requireString(anime, 'name')
    requireString(anime, 'russian')
    requireString(anime, 'url')
    requireString(anime, 'kind')
    requireString(anime, 'score')
    requireString(anime, 'status')
    requireNumber(anime, 'episodes')
    requireNumber(anime, 'episodes_aired')

    const img = anime.image as Record<string, unknown>
    expect(img, 'entry.anime.image must be an object').toBeTypeOf('object')
    requireString(img, 'original')
    requireString(img, 'preview')
    requireString(img, 'x96')
    requireString(img, 'x48')
  })
})
