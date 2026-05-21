import { describe, it, expect } from 'vitest'
import {
  buildContinueWatchingEntries,
  finalizeContinueWatchingEntries,
  type ContinueWatchingInputs,
  type CachedShikiRate
} from '../../src/main/lib/continue-watching'
import type { AnimeSearchResult, AnimeDetail } from '../../src/main/smotret-api'
import type { AnimeCacheEntry } from '../../src/main/services/anime-cache'

const stubAnime = (id: number, extras: Partial<AnimeSearchResult> = {}): AnimeSearchResult => ({
  id,
  title: `Anime ${id}`,
  titles: { ru: `Рус ${id}`, romaji: `Romaji ${id}` },
  posterUrlSmall: `poster-${id}.jpg`,
  numberOfEpisodes: 12,
  type: 'tv',
  typeTitle: 'TV',
  year: 2026,
  season: 'spring',
  ...extras
})

const stubCacheEntry = (
  animeId: number,
  episodes: { episodeInt: string; episodeFull: string; episodeType?: string }[]
): AnimeCacheEntry => ({
  animeDetail: {
    ...stubAnime(animeId),
    posterUrl: `poster-${animeId}-full.jpg`,
    descriptions: [],
    episodes: episodes.map((e, i) => ({
      id: i + 1,
      episodeFull: e.episodeFull,
      episodeInt: e.episodeInt,
      episodeType: e.episodeType ?? 'tv',
      isActive: 1
    })),
    genres: []
  },
  episodes: {},
  qualityProbes: {},
  cachedAt: Date.now(),
  posterCached: false
})

const emptyInputs = (): ContinueWatchingInputs => ({
  watchProgress: {},
  rates: [],
  library: {},
  downloaded: {},
  recent: {},
  malMap: {},
  cache: {}
})

describe('buildContinueWatchingEntries — resume rows', () => {
  it('drops entries that are marked watched or near-complete', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = {
      '1:1': { position: 60, duration: 100, updatedAt: 100, watched: true },
      '1:2': { position: 99, duration: 100, updatedAt: 200 },
      '1:3': { position: 5, duration: 100, updatedAt: 300 },
      '1:4': { position: 50, duration: 0, updatedAt: 400 },
      '2:1': { position: 30, duration: 100, updatedAt: 500 }
    }
    inputs.library = { '2': stubAnime(2) }

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => `${e.animeId}:${e.episodeInt}`)).toEqual(['2:1'])
  })

  it('collapses multi-episode progress to the most-recently-updated unfinished episode', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = {
      '7:1': { position: 30, duration: 100, updatedAt: 1000 },
      '7:2': { position: 60, duration: 100, updatedAt: 2000 },
      '7:3': { position: 10, duration: 100, updatedAt: 1500 }
    }
    inputs.library = { '7': stubAnime(7) }

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ animeId: 7, episodeInt: '2', position: 60 })
  })

  it('uses cache episodeFull for the label when available', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = { '5:3': { position: 30, duration: 100, updatedAt: 1000 } }
    inputs.library = { '5': stubAnime(5) }
    inputs.cache = {
      '5': stubCacheEntry(5, [{ episodeInt: '3', episodeFull: 'Эпизод 3 — пробуждение' }])
    }

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries[0].episodeLabel).toBe('Эпизод 3 — пробуждение')
  })

  it('skips "preview" episode types when picking the label', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = { '8:1': { position: 30, duration: 100, updatedAt: 1000 } }
    inputs.library = { '8': stubAnime(8) }
    inputs.cache = {
      '8': stubCacheEntry(8, [
        { episodeInt: '1', episodeFull: 'Trailer', episodeType: 'preview' },
        { episodeInt: '1', episodeFull: 'First Strike', episodeType: 'tv' }
      ])
    }

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries[0].episodeLabel).toBe('First Strike')
  })
})

describe('buildContinueWatchingEntries — Shikimori interaction', () => {
  const rate = (
    targetId: number,
    status: string,
    extras: Partial<CachedShikiRate['rate']> = {},
    shiki?: CachedShikiRate['shikiAnime']
  ): CachedShikiRate => ({
    rate: { target_id: targetId, episodes: 3, status, ...extras },
    shikiAnime: shiki
  })

  it('overrides resume.updatedAt with Shikimori rate.updated_at when available', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = { '10:2': { position: 30, duration: 100, updatedAt: 1000 } }
    inputs.library = { '10': stubAnime(10) }
    inputs.malMap = { '99': stubAnime(10) }
    inputs.rates = [rate(99, 'watching', { updated_at: '2026-05-21T00:00:00Z' })]

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries[0].kind).toBe('resume')
    expect(entries[0].updatedAt).toBe(Date.parse('2026-05-21T00:00:00Z'))
  })

  it('hides resume rows when Shikimori says the show is completed', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = { '11:5': { position: 50, duration: 100, updatedAt: 1000 } }
    inputs.library = { '11': stubAnime(11) }
    inputs.malMap = { '111': stubAnime(11) }
    inputs.rates = [rate(111, 'completed')]

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries).toHaveLength(0)
  })

  it('adds next-episode rows for "watching"/"rewatching" rates not already in resume', () => {
    const inputs = emptyInputs()
    inputs.malMap = { '200': stubAnime(20), '201': stubAnime(21) }
    inputs.recent = { '20': stubAnime(20), '21': stubAnime(21) }
    inputs.rates = [
      rate(200, 'watching', { episodes: 3 }),
      rate(201, 'rewatching', { episodes: 7 }),
      rate(202, 'planned', { episodes: 0 })
    ]

    const { entries } = buildContinueWatchingEntries(inputs)
    const kinds = entries.map((e) => `${e.kind}:${e.animeId}:${e.episodeInt}`).sort()
    expect(kinds).toEqual(['next:20:4', 'next:21:8'])
  })

  it('drops next-episode rows when watched+1 > episodes_aired', () => {
    const inputs = emptyInputs()
    inputs.malMap = { '300': stubAnime(30) }
    inputs.recent = { '30': stubAnime(30) }
    inputs.rates = [
      {
        rate: { target_id: 300, episodes: 12, status: 'watching' },
        shikiAnime: { id: 300, episodes_aired: 12 }
      }
    ]

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries).toHaveLength(0)
  })

  it('skips next-episode row when a resume row already covers the same anime', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = { '40:2': { position: 30, duration: 100, updatedAt: 1000 } }
    inputs.library = { '40': stubAnime(40) }
    inputs.malMap = { '400': stubAnime(40) }
    inputs.rates = [rate(400, 'watching', { episodes: 4 })]

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('resume')
  })
})

describe('buildContinueWatchingEntries — unresolvedIds + finalize', () => {
  it('flags rows missing local metadata for fetch', () => {
    const inputs = emptyInputs()
    inputs.malMap = { '500': stubAnime(50, { posterUrlSmall: '' }) }
    inputs.rates = [
      { rate: { target_id: 500, episodes: 1, status: 'watching' }, shikiAnime: { id: 500 } }
    ]

    const { unresolvedIds } = buildContinueWatchingEntries(inputs)
    expect(unresolvedIds).toEqual([50])
  })

  it('finalizeContinueWatchingEntries sorts by updatedAt desc and caps at 24', () => {
    const draft = Array.from({ length: 30 }, (_, i) => ({
      kind: 'resume' as const,
      animeId: i + 1,
      animeName: `Anime ${i + 1}`,
      posterUrl: `poster-${i + 1}.jpg`,
      episodeInt: '1',
      episodeLabel: 'Episode 1',
      updatedAt: i * 100
    }))
    const out = finalizeContinueWatchingEntries(draft, {})
    expect(out).toHaveLength(24)
    expect(out[0].updatedAt).toBe(29 * 100)
    expect(out[23].updatedAt).toBe(6 * 100)
  })

  it('finalizeContinueWatchingEntries applies fetched poster + name + episode label', () => {
    const draft = [
      {
        kind: 'next' as const,
        animeId: 77,
        animeName: '',
        posterUrl: 'shiki-fallback.jpg',
        episodeInt: '5',
        episodeLabel: 'Episode 5',
        updatedAt: 100,
        shikiPosterFallback: 'shiki-fallback.jpg',
        shikiNameFallback: 'Shiki Title'
      }
    ]
    const fetched: Record<number, AnimeDetail | null> = {
      77: {
        ...stubAnime(77, { posterUrlSmall: 'fresh-poster.jpg' }),
        posterUrl: 'fresh-poster-full.jpg',
        descriptions: [],
        episodes: [
          { id: 1, episodeInt: '5', episodeFull: 'Pilot', episodeType: 'tv', isActive: 1 }
        ],
        genres: []
      }
    }
    const out = finalizeContinueWatchingEntries(draft, fetched)
    expect(out[0]).toMatchObject({
      animeName: 'Рус 77',
      posterUrl: 'fresh-poster.jpg',
      episodeLabel: 'Pilot'
    })
    // Internal Shikimori fallback fields are stripped.
    expect(out[0]).not.toHaveProperty('shikiPosterFallback')
    expect(out[0]).not.toHaveProperty('shikiNameFallback')
  })

  it('finalizeContinueWatchingEntries drops entries that are still nameless', () => {
    const draft = [
      {
        kind: 'resume' as const,
        animeId: 88,
        animeName: '',
        posterUrl: '',
        episodeInt: '1',
        episodeLabel: 'Episode 1',
        updatedAt: 100
      }
    ]
    expect(finalizeContinueWatchingEntries(draft, {})).toEqual([])
  })
})
