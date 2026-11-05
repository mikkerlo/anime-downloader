import { describe, it, expect } from 'vitest'
import {
  animeRecordFrom,
  animeRecordsFrom,
  playerRecordFrom,
  subscriptionNameFrom,
  titleNames
} from '../../src/main/lib/anime-record'

const rec = (romaji: string): AnimeSearchResult =>
  ({ id: 7, title: romaji, titles: { romaji } }) as AnimeSearchResult

function storeOf(data: Record<string, unknown>): { get(key: string): unknown } {
  return { get: (key) => data[key] }
}

describe('animeRecordFrom', () => {
  it('reads downloadedAnime, then library, then the cached details, then recentAnimeMeta', () => {
    const data: Record<string, unknown> = {
      downloadedAnime: { 7: rec('Downloaded') },
      library: { 7: rec('Library') },
      animeCache: { 7: { animeDetail: rec('Cached'), episodes: {} } },
      recentAnimeMeta: { 7: rec('Recent') }
    }
    const store = storeOf(data)
    const romaji = (): string | undefined => animeRecordFrom(store, 7)?.titles?.romaji

    expect(romaji()).toBe('Downloaded')
    delete data.downloadedAnime
    expect(romaji()).toBe('Library')
    delete data.library
    expect(romaji()).toBe('Cached')
    delete data.animeCache
    expect(romaji()).toBe('Recent')
    delete data.recentAnimeMeta
    expect(animeRecordFrom(store, 7)).toBeNull()
  })

  it('falls through a cached entry whose animeDetail is null to recentAnimeMeta', () => {
    const store = storeOf({
      downloadedAnime: {},
      library: {},
      animeCache: { 7: { animeDetail: null, episodes: {} } },
      recentAnimeMeta: { 7: rec('Recent') }
    })
    expect(animeRecordFrom(store, 7)?.titles?.romaji).toBe('Recent')
  })

  it("doesn't take another id's record", () => {
    const store = storeOf({ downloadedAnime: { 8: rec('Other') }, recentAnimeMeta: {} })
    expect(animeRecordFrom(store, 7)).toBeNull()
  })
})

describe('animeRecordsFrom (#674)', () => {
  it("returns every record the store holds in the chain's order; animeRecordFrom is its first", () => {
    const data: Record<string, unknown> = {
      downloadedAnime: { 7: rec('Downloaded') },
      library: { 7: rec('Library') },
      animeCache: { 7: { animeDetail: rec('Cached'), episodes: {} } },
      recentAnimeMeta: { 7: rec('Recent') }
    }
    const store = storeOf(data)
    const romaji = (): (string | undefined)[] =>
      animeRecordsFrom(store, 7).map((r) => r.titles?.romaji)
    const first = (): AnimeSearchResult | null => animeRecordsFrom(store, 7)[0] ?? null

    expect(romaji()).toEqual(['Downloaded', 'Library', 'Cached', 'Recent'])
    expect(animeRecordFrom(store, 7)).toBe(first())
    delete data.downloadedAnime
    expect(romaji()).toEqual(['Library', 'Cached', 'Recent'])
    expect(animeRecordFrom(store, 7)).toBe(first())
    delete data.library
    expect(romaji()).toEqual(['Cached', 'Recent'])
    expect(animeRecordFrom(store, 7)).toBe(first())
    delete data.animeCache
    expect(romaji()).toEqual(['Recent'])
    expect(animeRecordFrom(store, 7)).toBe(first())
    delete data.recentAnimeMeta
    expect(animeRecordsFrom(store, 7)).toEqual([])
    expect(animeRecordFrom(store, 7)).toBeNull()
  })

  it("skips a cached entry whose animeDetail is null, and doesn't take another id's records", () => {
    const store = storeOf({
      downloadedAnime: { 8: rec('Other') },
      library: { 7: rec('Library') },
      animeCache: { 7: { animeDetail: null, episodes: {} } },
      recentAnimeMeta: { 7: rec('Recent') }
    })
    expect(animeRecordsFrom(store, 7).map((r) => r.titles?.romaji)).toEqual(['Library', 'Recent'])
    expect(animeRecordsFrom(store, 9)).toEqual([])
  })
})

describe('playerRecordFrom', () => {
  it('returns the cached details over a downloadedAnime record', () => {
    const store = storeOf({
      downloadedAnime: { 7: rec('Downloaded') },
      library: { 7: rec('Library') },
      animeCache: { 7: { animeDetail: rec('Cached'), episodes: {} } },
      recentAnimeMeta: { 7: rec('Recent') }
    })
    expect(playerRecordFrom(store, 7)?.titles?.romaji).toBe('Cached')
  })

  it("with animeDetail null or no cache entry, falls through in animeRecordFrom's order", () => {
    const data: Record<string, unknown> = {
      downloadedAnime: { 7: rec('Downloaded') },
      library: { 7: rec('Library') },
      animeCache: { 7: { animeDetail: null, episodes: {} } },
      recentAnimeMeta: { 7: rec('Recent') }
    }
    const store = storeOf(data)
    const romaji = (): string | undefined => playerRecordFrom(store, 7)?.titles?.romaji

    expect(romaji()).toBe('Downloaded')
    delete data.downloadedAnime
    expect(romaji()).toBe('Library')
    delete data.library
    expect(romaji()).toBe('Recent')
    delete data.animeCache
    expect(romaji()).toBe('Recent')
    delete data.recentAnimeMeta
    expect(playerRecordFrom(store, 7)).toBeNull()
  })

  it("doesn't take another id's cached details", () => {
    const store = storeOf({
      animeCache: { 8: { animeDetail: rec('Other'), episodes: {} } },
      library: { 7: rec('Library') }
    })
    expect(playerRecordFrom(store, 7)?.titles?.romaji).toBe('Library')
  })
})

describe('titleNames', () => {
  it('lists romaji, ru, title once each, skipping empty ones', () => {
    expect(
      titleNames({ id: 1, title: 'Show', titles: { romaji: '', ru: 'Шоу' } } as AnimeSearchResult)
    ).toEqual(['Шоу', 'Show'])
    expect(
      titleNames({
        id: 1,
        title: 'Show',
        titles: { romaji: 'Show', ru: 'Шоу' }
      } as AnimeSearchResult)
    ).toEqual(['Show', 'Шоу'])
    expect(titleNames(null)).toEqual([])
  })
})

describe('subscriptionNameFrom', () => {
  const subs = (animeName: string): Record<string, AutoDownloadSubscription> => ({
    7: {
      animeId: 7,
      malId: 70,
      animeName,
      subscribedAt: 0,
      lastEnqueuedEpisodeInt: 0,
      lastCheckedAt: 0
    }
  })

  it('reads autoDownloadSubscriptions[id].animeName, and null for another id, an empty name or no key', () => {
    const store = storeOf({ autoDownloadSubscriptions: subs('Old Name') })
    expect(subscriptionNameFrom(store, 7)).toBe('Old Name')
    expect(subscriptionNameFrom(store, 8)).toBeNull()
    expect(subscriptionNameFrom(storeOf({ autoDownloadSubscriptions: subs('') }), 7)).toBeNull()
    expect(subscriptionNameFrom(storeOf({}), 7)).toBeNull()
  })
})
