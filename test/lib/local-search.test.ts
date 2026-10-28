// Offline local search (#571): the corpus is what this PC has (starred,
// downloaded, cached detail), the Shikimori list only annotates it, and the
// matcher is a prefix pass plus a substring fallback for one token.
import { describe, it, expect } from 'vitest'
import {
  buildCorpus,
  normalize,
  searchLocal,
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
