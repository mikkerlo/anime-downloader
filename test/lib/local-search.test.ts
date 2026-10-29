// Offline local search (#571): the corpus is what this PC has (starred,
// downloaded, cached detail) plus the available attached Shared Libraries
// (#583), the Shikimori list only annotates it, and the matcher is a prefix
// pass plus a substring fallback for one token.
import { describe, it, expect } from 'vitest'
import {
  buildCorpus,
  normalize,
  searchLocal,
  type AttachedSnapshot,
  type LocalCorpusEntry,
  type LocalSearchSnapshot
} from '../../src/main/lib/local-search'

function anime(
  id: number,
  title: string,
  titles: AnimeSearchResult['titles'] = {}
): AnimeSearchResult {
  return {
    id,
    title,
    titles,
    posterUrlSmall: `https://example.invalid/${id}.jpg`,
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2020,
    season: 'spring'
  }
}

function detail(
  a: AnimeSearchResult,
  genres: string[] = [],
  myAnimeListId?: number
): { animeDetail: AnimeDetail } {
  return {
    animeDetail: {
      ...a,
      posterUrl: '',
      descriptions: [],
      episodes: [],
      genres: genres.map((title, i) => ({ id: i + 1, title })),
      ...(myAnimeListId !== undefined ? { myAnimeListId } : {})
    }
  }
}

// The cached `shikimoriUserRates` row shape, `smotretAnime` included.
function rate(malId: number, status: ShikiUserRateStatus, smotretAnime?: AnimeSearchResult): never {
  return {
    rate: { id: malId, status, target_id: malId },
    shikiAnime: { id: malId, name: smotretAnime?.title ?? '' },
    smotretAnime: smotretAnime ?? null
  } as never
}

const AOT = anime(1, 'Shingeki no Kyojin', {
  ru: 'Атака титанов',
  romaji: 'Shingeki no Kyojin',
  ja: '進撃の巨人'
})
const DEMON = anime(2, 'Kimetsu no Yaiba', {
  ru: 'Клинок, рассекающий демонов',
  romaji: 'Kimetsu no Yaiba',
  ja: '鬼滅の刃'
})
const HEDGEHOG = anime(3, 'Ёжик в тумане', { ru: 'Ёжик в тумане' })
const ROMAJI_ONLY = anime(4, 'Sousou no Frieren', { romaji: 'Sousou no Frieren' })
const CONTINUE = anime(5, 'Continue Only', { romaji: 'Continue Only' })
const LIST_ONLY = anime(6, 'List Only Title', { romaji: 'List Only Title' })

function snapshot(overrides: Partial<LocalSearchSnapshot> = {}): LocalSearchSnapshot {
  return {
    library: { 1: AOT, 2: DEMON, 3: HEDGEHOG },
    downloadedAnime: { 2: DEMON, 4: ROMAJI_ONLY },
    animeCache: {
      1: detail(AOT, ['Action', 'Drama'], 101),
      2: detail(DEMON, ['Action', 'Fantasy'], 102),
      5: detail(CONTINUE, ['Slice of Life'], 105),
      // A cache entry with no detail is not a corpus title by itself.
      9: {}
    },
    shikimoriUserRates: [
      rate(101, 'completed'),
      rate(102, 'watching'),
      rate(106, 'planned', LIST_ONLY)
    ],
    shikimoriAnimeDetails: { 101: { details: { status: 'released' } } },
    isRecentlyWatched: (id) => id === 5,
    ...overrides
  }
}

function ids(query: string, s = snapshot(), filters?: LocalSearchFilters): number[] {
  return searchLocal(buildCorpus(s), query, filters).map((r) => r.id)
}

describe('normalize', () => {
  it.each([
    ['ФРИРЕН', 'фрирен'],
    ['Ёжик', 'ежик'],
    ['ｓｈｉｎｇｅｋｉ', 'shingeki'],
    ['Pokémon', 'pokemon'],
    ['Мой', 'мой'],
    ['ガンダム', 'ガンダム'],
    ['ｶﾞﾝﾀﾞﾑ', 'ガンダム']
  ])('%s → %s', (input, out) => {
    expect(normalize(input)).toBe(out)
  })
})

describe('searchLocal: matching', () => {
  it.each<[string, string, number[]]>([
    ['romaji prefix', 'shing', [1]],
    ['romaji, any case', 'KIMETSU', [2]],
    ['Russian prefix', 'клин', [2]],
    ['Russian with ё in the query', 'ёжик', [3]],
    ['Russian with е for a stored ё', 'ежик туман', [3]],
    ['Japanese prefix', '鬼滅', [2]],
    ['multi-token prefix, any order', 'kyo shin', [1]],
    ['multi-token across words of the same title', 'атака тит', [1]],
    ['a title with only romaji', 'frieren', [4]],
    ['a genre title', 'fantasy', [2]],
    ['a title only in animeCache (continue-watching)', 'continue', [5]],
    ['a title only on the Shikimori list is not in the corpus', 'list only', []],
    ['nothing matches', 'zzz', []]
  ])('%s: %s', (_label, query, expected) => {
    expect(ids(query)).toEqual(expected)
  })

  it('substring fallback: an unspaced Japanese fragment from the middle of a title', () => {
    expect(ids('巨人')).toEqual([1])
  })

  it('substring fallback: a mid-word Russian fragment', () => {
    expect(ids('секающ')).toEqual([2])
  })

  it('a multi-token query with a mid-word token does not match', () => {
    expect(ids('клинок секающ')).toEqual([])
    expect(ids('клинок рассекающ')).toEqual([2])
  })

  it('a query shorter than 2 code points returns nothing at all', () => {
    expect(ids('s')).toEqual([])
    expect(ids(' 進 ')).toEqual([])
    expect(ids('')).toEqual([])
    // Two code points, one of them astral (two code units), is enough.
    expect(searchLocal(buildCorpus(snapshot({ library: { 8: anime(8, '𝔸b') } })), '𝔸b')).toEqual([
      expect.objectContaining({ id: 8 })
    ])
  })
})

describe('searchLocal: ranking', () => {
  // Each pair sorts the other way alphabetically, so only the tier puts the
  // prefix hit first.
  it.each<[string, string, string, string]>([
    ['Russian', 'Тора Сикай', 'Касикай', 'сикай'],
    ['Japanese', '巨人の星', '進撃の巨人', '巨人'],
    ['romaji', 'Zoku Saga', 'Asaga', 'saga']
  ])('%s: a substring hit ranks below a prefix hit', (_label, prefixHit, substringHit, query) => {
    const s: LocalSearchSnapshot = {
      library: { 10: anime(10, prefixHit), 11: anime(11, substringHit) },
      isRecentlyWatched: () => false
    }
    expect(ids(query, s)).toEqual([10, 11])
  })

  it('exact title > prefix > substring', () => {
    const s: LocalSearchSnapshot = {
      library: {
        20: anime(20, 'Monster Hunter'),
        21: anime(21, 'Monster'),
        22: anime(22, 'Gyakuten Monsters')
      },
      isRecentlyWatched: () => false
    }
    // 22 has "monsters" as a word, so "monster" is a prefix there too.
    expect(ids('monster', s)).toEqual([21, 22, 20])
    const t: LocalSearchSnapshot = {
      library: {
        23: anime(23, 'Xmonster'),
        24: anime(24, 'Monster Farm'),
        25: anime(25, 'Monster')
      },
      isRecentlyWatched: () => false
    }
    expect(ids('monster', t)).toEqual([25, 24, 23])
  })

  it('a watching source and a watching list status each bump a title inside its tier', () => {
    const s: LocalSearchSnapshot = {
      library: {
        30: anime(30, 'Alpha Saga'),
        31: anime(31, 'Beta Saga'),
        32: anime(32, 'Gamma Saga')
      },
      animeCache: { 32: detail(anime(32, 'Gamma Saga'), [], 132) },
      shikimoriUserRates: [rate(132, 'rewatching')],
      isRecentlyWatched: (id) => id === 31
    }
    expect(ids('saga', s)).toEqual([31, 32, 30])
    // The bump never lifts a title over a better tier.
    const t: LocalSearchSnapshot = { ...s, library: { ...s.library, 33: anime(33, 'Saga') } }
    expect(ids('saga', t)).toEqual([33, 31, 32, 30])
  })
})

describe('searchLocal: filters', () => {
  it('genre narrows to titles with that genre title', () => {
    expect(ids('no', snapshot(), { genre: 'Fantasy' })).toEqual([2])
    expect(ids('no', snapshot(), { genre: 'Action' }).sort()).toEqual([1, 2])
  })

  it('status filters on listStatus', () => {
    expect(ids('no', snapshot(), { status: 'completed' })).toEqual([1])
    expect(ids('no', snapshot(), { status: 'watching' })).toEqual([2])
    expect(ids('no', snapshot(), { status: 'planned' })).toEqual([])
  })
})

describe('buildCorpus: sources and annotations', () => {
  it('a title starred and downloaded appears once with both sources', () => {
    const results = searchLocal(buildCorpus(snapshot()), 'kimetsu')
    expect(results).toHaveLength(1)
    expect(results[0].localSources).toEqual([{ kind: 'starred' }, { kind: 'downloaded' }])
  })

  it('`watching` comes from recent watchProgress, not from the Shikimori status', () => {
    const [demon] = searchLocal(buildCorpus(snapshot()), 'kimetsu')
    expect(demon.listStatus).toBe('watching')
    expect(demon.localSources).not.toContainEqual({ kind: 'watching' })

    const [cont] = searchLocal(buildCorpus(snapshot()), 'continue')
    expect(cont.listStatus).toBeUndefined()
    expect(cont.localSources).toEqual([{ kind: 'watching' }])
  })

  it('carries genres, listStatus and the cached airing status, and drops detail-only fields', () => {
    const [aot] = searchLocal(buildCorpus(snapshot()), 'shingeki')
    expect(aot).toEqual({
      ...AOT,
      localSources: [{ kind: 'starred' }],
      listStatus: 'completed',
      genres: ['Action', 'Drama'],
      airingStatus: 'released'
    })
  })

  it('a starred title with no cached detail still matches on its title, with no genres', () => {
    const [hedgehog] = searchLocal(buildCorpus(snapshot()), 'туман')
    expect(hedgehog).toMatchObject({ id: 3, genres: [], localSources: [{ kind: 'starred' }] })
    expect(hedgehog.listStatus).toBeUndefined()
  })

  it('skips malformed keys and records, and tolerates missing store keys', () => {
    const corpus = buildCorpus({
      library: { abc: anime(1, 'Bad Key'), 0: anime(0, 'Zero'), 40: undefined, 41: {} as never },
      isRecentlyWatched: () => false
    })
    expect(corpus).toEqual([])
    expect(buildCorpus({ isRecentlyWatched: () => false })).toEqual([])
  })

  it('a non-string query returns nothing', () => {
    expect(searchLocal(buildCorpus(snapshot()), undefined as unknown as string)).toEqual([])
    expect(searchLocal(buildCorpus(snapshot()), '   ́ ')).toEqual([])
  })
})

describe('buildCorpus: attached Shared Libraries (#583)', () => {
  const LIB_A = '5d7c1f3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f'
  const LIB_B = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'

  function meta(animeId: number, over: Partial<SharedLibraryMeta> = {}): SharedLibraryMeta {
    return { animeId, ...over }
  }

  function lib(
    libraryId: string,
    name: string,
    titles: AttachedSnapshot['titles']
  ): AttachedSnapshot {
    return { libraryId, name, titles }
  }

  const FRIEREN_META = meta(101, {
    malId: 52991,
    titles: { ru: 'Провожающая в последний путь Фрирен', romaji: 'Sousou no Frieren' },
    genres: [{ id: 2, title: 'Adventure' }],
    year: 2023,
    type: 'tv',
    episodes: [{ episodeInt: '1' }, { episodeInt: '2' }],
    searchResult: {
      ...anime(101, 'Frieren', { ru: 'Фрирен', romaji: 'Sousou no Frieren' }),
      numberOfEpisodes: 28,
      year: 2023,
      season: 'fall'
    }
  })

  // The local titles minus the downloaded "Sousou no Frieren" (id 4), so a drive's Frieren stands alone.
  const local = (over: Partial<LocalSearchSnapshot> = {}): LocalSearchSnapshot =>
    snapshot({ downloadedAnime: { 2: DEMON }, ...over })
  const drive = (titles: AttachedSnapshot['titles']): LocalSearchSnapshot =>
    local({ attached: [lib(LIB_A, 'Stick', titles)] })

  it('an attached-only title is found, with its library as the source and the shared poster', () => {
    const s = drive([{ animeId: 101, name: 'Frieren folder', meta: FRIEREN_META }])
    const [hit, ...rest] = searchLocal(buildCorpus(s), 'frieren')
    expect(rest).toEqual([])
    expect(hit).toEqual({
      ...anime(101, 'Frieren', { ru: 'Фрирен', romaji: 'Sousou no Frieren' }),
      numberOfEpisodes: 28,
      year: 2023,
      season: 'fall',
      posterUrlSmall: `anime-poster://shared/${LIB_A}/101`,
      localSources: [{ kind: 'shared', libraryId: LIB_A, libraryName: 'Stick' }],
      genres: ['Adventure']
    })
  })

  it('matches every title the snapshot holds: the manifest name, meta titles and en', () => {
    const s = drive([
      {
        animeId: 101,
        name: 'Frieren folder',
        meta: { ...FRIEREN_META, titles: { ...FRIEREN_META.titles, en: 'Frieren: Beyond' } }
      }
    ])
    for (const q of ['folder', 'провожающая', 'фрирен', 'beyond', 'sousou']) {
      expect(ids(q, s), q).toEqual([101])
    }
  })

  it('with no search record, reads the manifest name and the meta fields', () => {
    const s = drive([
      {
        animeId: 202,
        name: 'Dungeon Meshi',
        meta: meta(202, {
          titles: { romaji: 'Dungeon Meshi', ja: 'ダンジョン飯' },
          year: 2024,
          type: 'tv',
          episodes: [{ episodeInt: '1' }, { episodeInt: '2' }, { episodeInt: '3' }]
        })
      },
      { animeId: 303, name: 'No Meta Title', meta: null }
    ])
    const [meshi] = searchLocal(buildCorpus(s), 'ダンジョン')
    expect(meshi).toMatchObject({
      id: 202,
      title: 'Dungeon Meshi',
      titles: { romaji: 'Dungeon Meshi', ja: 'ダンジョン飯' },
      numberOfEpisodes: 3,
      type: 'tv',
      typeTitle: '',
      year: 2024,
      genres: []
    })
    expect(searchLocal(buildCorpus(s), 'no meta')).toEqual([
      expect.objectContaining({
        id: 303,
        title: 'No Meta Title',
        titles: {},
        numberOfEpisodes: 0,
        posterUrlSmall: `anime-poster://shared/${LIB_A}/303`
      })
    ])
  })

  it('a title both local and attached comes back once, with both sources, from the local record', () => {
    const s = drive([
      { animeId: 1, name: 'AoT on the stick', meta: meta(1, { titles: { en: 'Attack on Titan' } }) }
    ])
    const results = searchLocal(buildCorpus(s), 'shingeki')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      ...AOT,
      localSources: [
        { kind: 'starred' },
        { kind: 'shared', libraryId: LIB_A, libraryName: 'Stick' }
      ],
      genres: ['Action', 'Drama']
    })
    // The drive's titles still find it.
    expect(ids('attack on', s)).toEqual([1])
  })

  it('a downloaded title with no detail takes its genres and list status from the drive', () => {
    const corpus = buildCorpus({
      ...snapshot(),
      attached: [
        lib(LIB_A, 'Stick', [
          {
            animeId: 4,
            name: 'Frieren',
            meta: meta(4, { malId: 104, genres: [{ id: 2, title: 'Adventure' }] })
          }
        ])
      ],
      shikimoriUserRates: [rate(104, 'watching')],
      shikimoriAnimeDetails: { 104: { details: { status: 'ongoing' } } }
    })
    expect(searchLocal(corpus, 'frieren')).toEqual([
      {
        ...ROMAJI_ONLY,
        localSources: [
          { kind: 'downloaded' },
          { kind: 'shared', libraryId: LIB_A, libraryName: 'Stick' }
        ],
        listStatus: 'watching',
        genres: ['Adventure'],
        airingStatus: 'ongoing'
      }
    ])
    expect(searchLocal(corpus, 'frieren', { genre: 'Adventure' })).toHaveLength(1)
    expect(searchLocal(corpus, 'frieren', { status: 'watching' })).toHaveLength(1)
  })

  it("a cached detail's genres win over the drive's", () => {
    const s = drive([
      { animeId: 1, name: 'AoT', meta: meta(1, { genres: [{ id: 9, title: 'Horror' }] }) }
    ])
    expect(searchLocal(buildCorpus(s), 'shingeki')[0].genres).toEqual(['Action', 'Drama'])
  })

  it('an attached-only title watched on this PC also carries `watching`', () => {
    const s = drive([{ animeId: 101, name: 'Frieren', meta: FRIEREN_META }])
    const corpus = buildCorpus({ ...s, isRecentlyWatched: (id) => id === 101 })
    expect(searchLocal(corpus, 'frieren')[0].localSources).toEqual([
      { kind: 'watching' },
      { kind: 'shared', libraryId: LIB_A, libraryName: 'Stick' }
    ])
  })

  it('two libraries with the same title give one result with two drive sources', () => {
    const s = local({
      attached: [
        lib(LIB_A, 'Stick', [{ animeId: 101, name: 'Frieren', meta: FRIEREN_META }]),
        lib(LIB_B, 'Backup', [{ animeId: 101, name: 'Frieren', meta: null }])
      ]
    })
    const results = searchLocal(buildCorpus(s), 'frieren')
    expect(results).toHaveLength(1)
    expect(results[0].localSources).toEqual([
      { kind: 'shared', libraryId: LIB_A, libraryName: 'Stick' },
      { kind: 'shared', libraryId: LIB_B, libraryName: 'Backup' }
    ])
    // Read from the first library listed.
    expect(results[0].posterUrlSmall).toBe(`anime-poster://shared/${LIB_A}/101`)
  })

  it('a title listed twice in one library is one source', () => {
    const s = drive([
      { animeId: 101, name: 'Frieren', meta: FRIEREN_META },
      { animeId: 101, name: 'Frieren again', meta: null }
    ])
    expect(searchLocal(buildCorpus(s), 'frieren')[0].localSources).toHaveLength(1)
  })

  it('a library the caller leaves out (unavailable) contributes nothing', () => {
    const titles = [{ animeId: 101, name: 'Frieren', meta: FRIEREN_META }]
    const plugged = buildCorpus(drive(titles))
    const unplugged = buildCorpus(local({ attached: [] }))
    expect(searchLocal(plugged, 'frieren').map((r) => r.id)).toEqual([101])
    expect(searchLocal(unplugged, 'frieren')).toEqual([])
    expect(plugged.length - unplugged.length).toBe(1)
  })

  it('a malformed snapshot entry is skipped, not thrown, and the rest still count', () => {
    const good = { animeId: 101, name: 'Frieren', meta: FRIEREN_META }
    const bad = [
      // Missing titles: no name and no search record.
      { animeId: 401, meta: meta(401) },
      { animeId: 402, name: '   ', meta: { animeId: 402, searchResult: { title: 7 } } },
      { animeId: 0, name: 'Zero' },
      { animeId: -3, name: 'Negative' },
      { animeId: '404', name: 'String id' },
      { animeId: 1.5, name: 'Fraction' },
      // An integer past 2^53 can't round-trip as an id.
      { animeId: 2 ** 53 + 2, name: 'Unsafe' },
      null,
      'nope',
      // Bad meta fields read as missing.
      {
        animeId: 405,
        name: 'Odd Meta',
        meta: { animeId: 405, genres: 'Action', titles: 'x', episodes: {}, malId: 'x' }
      },
      { animeId: 406, name: 'Odd Genres', meta: { animeId: 406, genres: [null, { title: 3 }] } }
    ]
    const libs = [
      lib(LIB_A, 'Stick', [...bad, good] as never),
      { libraryId: LIB_B, name: 'No titles' },
      { libraryId: 42, name: 'Bad id', titles: [good] },
      null
    ] as never
    let corpus: LocalCorpusEntry[] = []
    expect(() => {
      corpus = buildCorpus(
        snapshot({ library: {}, downloadedAnime: {}, animeCache: {}, attached: libs })
      )
    }).not.toThrow()
    expect(corpus.map((e) => e.anime.id).sort((a, b) => a - b)).toEqual([101, 405, 406])
    const odd = searchLocal(corpus, 'odd')
    expect(odd.map((r) => [r.id, r.genres, r.titles, r.numberOfEpisodes])).toEqual([
      [406, [], {}, 0],
      [405, [], {}, 0]
    ])
    expect(searchLocal(buildCorpus(snapshot({ attached: 'x' as never })), 'zzz')).toEqual([])
  })
})
