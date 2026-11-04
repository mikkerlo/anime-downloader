import { describe, it, expect } from 'vitest'
import { animeRecordFrom, titleNames } from '../../src/main/lib/anime-record'

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
