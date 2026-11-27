import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  buildContinueWatchingEntries,
  finalizeContinueWatchingEntries,
  type ContinueWatchingInputs,
  type ContinueWatchingRate
} from '../../src/main/lib/continue-watching'
import type { AnimeSearchResult, AnimeDetail } from '../../src/main/smotret-api'
import type { AnimeCacheEntry } from '../../src/main/services/anime-cache'
import type { CachedRateEntry } from '../../src/main/lib/shikimori-rate-cache'
import { shikimoriRateCache } from '../../src/main/trackers/shikimori.provider'
import { SHIKIMORI_ORIGIN } from '../../src/shared/shikimori'

// A cached `shikimoriUserRates` row, as older versions may have written it.
interface ShikiRow {
  rate: { target_id?: number | null; episodes: number; status: string; updated_at?: string }
  shikiAnime?: {
    id: number
    name?: string
    russian?: string
    image?: { preview?: string; x96?: string; original?: string }
    episodes_aired?: number
  }
  smotretAnime?: AnimeSearchResult | null
}

// What the primary reader hands continue-watching for a Shikimori primary (#698).
const viaCodec = (row: ShikiRow): ContinueWatchingRate => ({
  ...shikimoriRateCache.entryOf(row as unknown as CachedRateEntry),
  native: row
})

// An AniList primary's entry: absolute posters, a nullable `episodesAired`.
const anilist = (
  malId: number,
  status: ShikiUserRateStatus,
  episodes: number,
  extras: {
    updatedAt?: number | null
    episodesAired?: number | null
    poster?: string | null
    title?: string
    smotretAnime?: AnimeSearchResult | null
  } = {}
): ContinueWatchingRate => ({
  trackerId: 'anilist',
  malId,
  values: { episodes, status, score: 0, rewatches: 0 },
  updatedAt: extras.updatedAt === undefined ? null : extras.updatedAt,
  anime: {
    title: extras.title ?? `AniList ${malId}`,
    poster: extras.poster === undefined ? null : extras.poster,
    kind: 'TV',
    episodes: null,
    episodesAired: extras.episodesAired === undefined ? null : extras.episodesAired,
    status: null
  },
  smotretAnime: extras.smotretAnime ?? null,
  native: { mediaId: malId + 100000 }
})

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
  // Every case here goes through the Shikimori codec, as the primary reader does.
  const rate = (
    targetId: number,
    status: string,
    extras: Partial<ShikiRow['rate']> = {},
    shiki?: ShikiRow['shikiAnime']
  ): ContinueWatchingRate =>
    viaCodec({
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
      viaCodec({
        rate: { target_id: 300, episodes: 12, status: 'watching' },
        shikiAnime: { id: 300, episodes_aired: 12 }
      })
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

describe('buildContinueWatchingEntries — the Shikimori codec keeps 6.x picks (#698)', () => {
  const NOW = Date.parse('2026-11-27T12:00:00Z')

  afterEach(() => {
    vi.useRealTimers()
  })

  function posterOf(image: NonNullable<ShikiRow['shikiAnime']>['image']): string {
    const inputs = emptyInputs()
    inputs.malMap = { '600': stubAnime(60, { posterUrlSmall: '' }) }
    inputs.rates = [
      viaCodec({
        rate: { target_id: 600, episodes: 1, status: 'watching' },
        shikiAnime: { id: 600, image }
      })
    ]
    return buildContinueWatchingEntries(inputs).entries[0].posterUrl
  }

  it('the poster fallback is the preview, made absolute on the Shikimori origin', () => {
    expect(posterOf({ preview: '/p/600.jpg', x96: '/x/600.jpg', original: '/o/600.jpg' })).toBe(
      `${SHIKIMORI_ORIGIN}/p/600.jpg`
    )
  })

  it('then x96, and an absolute path is kept as it is', () => {
    expect(posterOf({ x96: 'https://cdn.invalid/x96/600.jpg', original: '/o/600.jpg' })).toBe(
      'https://cdn.invalid/x96/600.jpg'
    )
  })

  it('then original; no image leaves the poster empty', () => {
    expect(posterOf({ original: '/o/600.jpg' })).toBe(`${SHIKIMORI_ORIGIN}/o/600.jpg`)
    expect(posterOf(undefined)).toBe('')
  })

  it('a legacy row with no target_id joins nothing through malIdMap', () => {
    const inputs = emptyInputs()
    inputs.malMap = { '610': stubAnime(61), '612': stubAnime(63) }
    inputs.recent = { '61': stubAnime(61) }
    inputs.watchProgress = { '63:2': { position: 30, duration: 100, updatedAt: 1000 } }
    inputs.library = { '63': stubAnime(63) }
    inputs.rates = [
      // Its codec `malId` is 610, which malIdMap holds: still no next-up row.
      viaCodec({ rate: { episodes: 1, status: 'watching' }, shikiAnime: { id: 610 } }),
      // Completed under 612 = anime 63: the resume row stays.
      viaCodec({ rate: { episodes: 12, status: 'completed' }, shikiAnime: { id: 612 } })
    ]
    expect(inputs.rates.map((r) => r.malId)).toEqual([610, 612])

    // The next-up row has no anime id, so finalize drops it.
    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => `${e.kind}:${e.animeId}`)).toEqual(['resume:63', 'next:0'])
    expect(entries[1].malId).toBeUndefined()
    expect(finalizeContinueWatchingEntries(entries, {}).map((e) => e.animeId)).toEqual([63])
  })

  it('a legacy row joined by smotretAnime keeps its missing or null malId', () => {
    const inputs = emptyInputs()
    // Not local, so the name lookup reaches malIdMap, which it can't by a missing id.
    inputs.malMap = { '611': stubAnime(99), '613': stubAnime(98) }
    inputs.rates = [
      viaCodec({
        rate: { episodes: 1, status: 'watching' },
        shikiAnime: { id: 611 },
        smotretAnime: stubAnime(62)
      }),
      viaCodec({
        rate: { target_id: null, episodes: 1, status: 'watching' },
        shikiAnime: { id: 613 },
        smotretAnime: stubAnime(64)
      })
    ]

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => [e.animeId, e.malId, e.animeName])).toEqual([
      [62, undefined, ''],
      [64, null, '']
    ])
  })

  it('a null updatedAt: a resume row keeps its own sort key, a next-up row takes now', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const inputs = emptyInputs()
    inputs.watchProgress = { '65:1': { position: 30, duration: 100, updatedAt: 1234 } }
    inputs.library = { '65': stubAnime(65) }
    inputs.recent = { '66': stubAnime(66) }
    inputs.rates = [
      viaCodec({
        rate: { target_id: 650, episodes: 0, status: 'watching' },
        smotretAnime: stubAnime(65)
      }),
      viaCodec({
        rate: { target_id: 660, episodes: 0, status: 'watching', updated_at: 'not a date' },
        smotretAnime: stubAnime(66)
      })
    ]
    expect(inputs.rates.map((r) => r.updatedAt)).toEqual([null, null])

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => [e.kind, e.animeId, e.updatedAt])).toEqual([
      ['resume', 65, 1234],
      ['next', 66, NOW]
    ])
  })

  it('the epoch is missing too: no resume override, and a next-up row takes now', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const EPOCH = '1970-01-01T00:00:00.000Z'
    const inputs = emptyInputs()
    inputs.watchProgress = { '67:1': { position: 30, duration: 100, updatedAt: 1234 } }
    inputs.library = { '67': stubAnime(67) }
    inputs.recent = { '68': stubAnime(68) }
    inputs.rates = [
      viaCodec({
        rate: { target_id: 670, episodes: 0, status: 'watching', updated_at: EPOCH },
        smotretAnime: stubAnime(67)
      }),
      viaCodec({
        rate: { target_id: 680, episodes: 0, status: 'watching', updated_at: EPOCH },
        smotretAnime: stubAnime(68)
      })
    ]
    expect(inputs.rates.map((r) => r.updatedAt)).toEqual([0, 0])

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => [e.kind, e.animeId, e.updatedAt])).toEqual([
      ['resume', 67, 1234],
      ['next', 68, NOW]
    ])
  })
})

describe('buildContinueWatchingEntries — an AniList primary (#698)', () => {
  const COVER = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx700.jpg'

  it('next-up rows come from AniList watching / rewatching entries', () => {
    const inputs = emptyInputs()
    inputs.malMap = { '701': stubAnime(71) }
    inputs.recent = { '70': stubAnime(70), '71': stubAnime(71), '72': stubAnime(72) }
    inputs.rates = [
      anilist(700, 'watching', 3, { smotretAnime: stubAnime(70) }),
      // Joined through malIdMap by the entry's malId.
      anilist(701, 'rewatching', 7),
      anilist(702, 'planned', 0, { smotretAnime: stubAnime(72) }),
      anilist(703, 'completed', 12, { smotretAnime: stubAnime(72) })
    ]

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => [e.kind, e.animeId, e.episodeInt, e.malId])).toEqual([
      ['next', 70, '4', 700],
      ['next', 71, '8', 701]
    ])
  })

  it('the episodesAired skip holds', () => {
    const inputs = emptyInputs()
    inputs.recent = { '73': stubAnime(73) }
    inputs.rates = [
      anilist(730, 'watching', 12, { episodesAired: 12, smotretAnime: stubAnime(73) })
    ]
    expect(buildContinueWatchingEntries(inputs).entries).toEqual([])
  })

  it('episodesAired null or 0 is no upper bound: a long-running show still gets a next-up row', () => {
    const inputs = emptyInputs()
    inputs.recent = { '74': stubAnime(74), '75': stubAnime(75) }
    inputs.rates = [
      anilist(740, 'watching', 1100, { episodesAired: null, smotretAnime: stubAnime(74) }),
      anilist(750, 'watching', 20, { episodesAired: 0, smotretAnime: stubAnime(75) })
    ]
    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => [e.animeId, e.episodeInt])).toEqual([
      [74, '1101'],
      [75, '21']
    ])
  })

  it("the poster and name fallbacks are AniList's, with no Shikimori prefix", () => {
    const inputs = emptyInputs()
    inputs.malMap = { '760': stubAnime(76, { posterUrlSmall: '' }) }
    inputs.rates = [anilist(760, 'watching', 0, { poster: COVER, title: 'Frieren' })]
    const [draft] = buildContinueWatchingEntries(inputs).entries
    expect(draft.posterUrl).toBe(COVER)

    const out = finalizeContinueWatchingEntries([{ ...draft, animeName: '' }], {
      76: {
        ...stubAnime(76, { posterUrlSmall: '', title: '', titles: {} }),
        posterUrl: '',
        descriptions: [],
        episodes: [],
        genres: []
      }
    })
    expect(out[0]).toMatchObject({ animeName: 'Frieren', posterUrl: COVER })
  })

  it('resume rows take the AniList updatedAt, and a completed AniList status hides them', () => {
    const inputs = emptyInputs()
    inputs.watchProgress = {
      '77:2': { position: 30, duration: 100, updatedAt: 1000 },
      '78:5': { position: 50, duration: 100, updatedAt: 2000 }
    }
    inputs.library = { '77': stubAnime(77), '78': stubAnime(78) }
    inputs.malMap = { '770': stubAnime(77) }
    inputs.rates = [
      anilist(770, 'on_hold', 1, { updatedAt: 1_800_000_000_000 }),
      anilist(780, 'completed', 12, { updatedAt: 5, smotretAnime: stubAnime(78) })
    ]

    const { entries } = buildContinueWatchingEntries(inputs)
    expect(entries.map((e) => [e.kind, e.animeId, e.updatedAt])).toEqual([
      ['resume', 77, 1_800_000_000_000]
    ])
  })
})

describe('buildContinueWatchingEntries — unresolvedIds + finalize', () => {
  it('flags rows missing local metadata for fetch', () => {
    const inputs = emptyInputs()
    inputs.malMap = { '500': stubAnime(50, { posterUrlSmall: '' }) }
    inputs.rates = [
      viaCodec({
        rate: { target_id: 500, episodes: 1, status: 'watching' },
        shikiAnime: { id: 500 }
      })
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
        posterFallback: 'shiki-fallback.jpg',
        nameFallback: 'Shiki Title'
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
    // The internal draft fallback fields are stripped.
    expect(out[0]).not.toHaveProperty('posterFallback')
    expect(out[0]).not.toHaveProperty('nameFallback')
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
