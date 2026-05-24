import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { SmotretApi } from '../../src/main/smotret-api'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, '../fixtures/smotret', name), 'utf8'))
}

function mockFetchOnce(body: unknown, status = 200, statusText = 'OK'): void {
  global.fetch = vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText,
        json: async () => body,
        text: async () => JSON.stringify(body),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: {} as ReadableStream
      }) as unknown as Response
  )
}

function lastFetchUrl(): string {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0] as string
}

function makeApi(token = 'test-token'): SmotretApi {
  return new SmotretApi(() => token)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('SmotretApi — fixture replay', () => {
  describe('searchAnime', () => {
    it('parses the search-results envelope', async () => {
      mockFetchOnce(fixture('search.json'))
      const result = await makeApi().searchAnime('Steins')
      expect(result.data.length).toBe(2)
      expect(result.data[0]).toMatchObject({
        id: 7,
        title: 'Steins;Gate',
        numberOfEpisodes: 24
      })
      expect(result.data[0].titles.ru).toBe('Врата Штейна')
    })

    it('URL-encodes the query', async () => {
      mockFetchOnce(fixture('search.json'))
      await makeApi().searchAnime('Steins;Gate 0')
      expect(lastFetchUrl()).toContain('query=Steins%3BGate%200')
    })

    it('appends the API token as a query param', async () => {
      mockFetchOnce(fixture('search.json'))
      await makeApi('secret-tok').searchAnime('foo')
      expect(lastFetchUrl()).toContain('access_token=secret-tok')
    })

    it('omits the token query param when token is empty', async () => {
      mockFetchOnce(fixture('search.json'))
      await makeApi('').searchAnime('foo')
      expect(lastFetchUrl()).not.toContain('access_token=')
    })
  })

  describe('getAnime', () => {
    it('parses AnimeDetail with episodes + genres + descriptions + myAnimeListId', async () => {
      mockFetchOnce(fixture('anime.json'))
      const result = await makeApi().getAnime(7)
      expect(result.data.id).toBe(7)
      expect(result.data.episodes.length).toBe(2)
      expect(result.data.episodes[0].episodeInt).toBe('1')
      expect(result.data.genres[0].title).toBe('Sci-Fi')
      expect(result.data.myAnimeListId).toBe(9253)
      expect(result.data.posterUrl).toContain('large')
    })
  })

  describe('getEpisode', () => {
    it('parses the translations array', async () => {
      mockFetchOnce(fixture('episode.json'))
      const result = await makeApi().getEpisode(100)
      expect(result.data.translations.length).toBe(2)
      expect(result.data.translations[0]).toMatchObject({
        id: 1001,
        type: 'subtitles',
        typeKind: 'sub',
        height: 1080,
        authorsSummary: 'AniDub'
      })
    })
  })

  describe('getEmbed', () => {
    it('unwraps the data envelope and returns EmbedData directly', async () => {
      mockFetchOnce(fixture('embed.json'))
      const embed = await makeApi().getEmbed(1001)
      expect(embed.download.length).toBe(2)
      expect(embed.download[0]).toEqual({ height: 1080, url: 'https://example/1001-1080.mp4' })
      expect(embed.stream[0].urls[0]).toContain('.m3u8')
      expect(embed.subtitlesUrl).toBe('https://example/1001-subs.ass')
    })
  })

  describe('lookupByMalIds', () => {
    it('batches in groups of 50 and concatenates results', async () => {
      const fetchSpy = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => fixture('lookup-by-mal.json')
          }) as unknown as Response
      )
      global.fetch = fetchSpy
      const malIds = Array.from({ length: 51 }, (_, i) => i + 1)
      const results = await makeApi().lookupByMalIds(malIds)
      // Two batches: 50 + 1 → fetch called twice; fixture returns 1 entry per call
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(results.length).toBe(2)
      expect(results[0]).toMatchObject({ id: 7, myAnimeListId: 9253 })
    })

    it('requests myAnimeListId[] for each id and the right field list', async () => {
      mockFetchOnce(fixture('lookup-by-mal.json'))
      await makeApi().lookupByMalIds([9253, 5114])
      expect(lastFetchUrl()).toContain('myAnimeListId[]=9253')
      expect(lastFetchUrl()).toContain('myAnimeListId[]=5114')
      expect(lastFetchUrl()).toContain('fields=')
    })
  })

  describe('URL builders', () => {
    it('getSubtitlesUrl appends ?download=1 and the token', () => {
      const url = makeApi('abc').getSubtitlesUrl(1001)
      expect(url).toBe('https://smotret-anime.ru/translations/ass/1001?download=1&access_token=abc')
    })

    it('getSubtitlesUrl omits the token when empty', () => {
      const url = makeApi('').getSubtitlesUrl(1001)
      expect(url).toBe('https://smotret-anime.ru/translations/ass/1001?download=1')
    })

    it('getFallbackVideoUrl encodes the height and token', () => {
      const url = makeApi('xyz').getFallbackVideoUrl(2002, 720)
      expect(url).toBe(
        'https://smotret-anime.ru/translations/mp4/2002?format=mp4&height=720&access_token=xyz'
      )
    })
  })

  describe('validateToken', () => {
    it('returns valid=true when the embed probe returns a non-403 payload', async () => {
      mockFetchOnce({ data: {} })
      const v = await makeApi('valid-tok').validateToken()
      expect(v).toEqual({ valid: true })
    })

    it('returns valid=false when the embed probe returns error.code=403', async () => {
      mockFetchOnce({ error: { code: 403, message: 'forbidden' } })
      const v = await makeApi('bad-tok').validateToken()
      expect(v).toEqual({ valid: false, error: 'Invalid token' })
    })

    it('returns valid=false with no error message when no token is configured', async () => {
      const v = await makeApi('').validateToken()
      expect(v).toEqual({ valid: false, error: 'No token configured' })
    })
  })

  describe('error handling', () => {
    it('throws on non-2xx with status + statusText in the message', async () => {
      mockFetchOnce({}, 500, 'Server Error')
      await expect(makeApi().getAnime(1)).rejects.toThrow(/API error: 500 Server Error/)
    })
  })
})
