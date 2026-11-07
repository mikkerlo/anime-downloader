import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  SHIKIMORI_ORIGIN_ENV,
  SMOTRET_API_BASE,
  SMOTRET_API_BASE_ENV,
  applyApiBaseOverrides,
  rewriteLegacySmotretUrl,
  shikimoriOrigin,
  smotretApiBase,
  smotretOrigin
} from '../../src/main/lib/api-bases'
import { SHIKIMORI_ORIGIN } from '../../src/shared/shikimori'
import { SmotretApi } from '../../src/main/smotret-api'
import * as shikimori from '../../src/main/shikimori'

const STUBS = {
  [SMOTRET_API_BASE_ENV]: 'http://127.0.0.1:4001/api/',
  [SHIKIMORI_ORIGIN_ENV]: 'http://127.0.0.1:4002'
}

const realFetch = globalThis.fetch

function captureFetch(body: unknown): ReturnType<typeof vi.fn> {
  const stub = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body)
      }) as unknown as Response
  )
  globalThis.fetch = stub
  return stub
}

afterEach(() => {
  applyApiBaseOverrides({}, false)
  globalThis.fetch = realFetch
})

describe('API base overrides (#567)', () => {
  it('defaults to the production hosts', () => {
    expect(smotretApiBase()).toBe('https://smotret-anime.app/api')
    expect(SMOTRET_API_BASE).toBe('https://smotret-anime.app/api')
    expect(shikimoriOrigin()).toBe(SHIKIMORI_ORIGIN)
  })

  it('honours both variables in an unpackaged build, trailing slash dropped', () => {
    applyApiBaseOverrides(STUBS, false)
    expect(smotretApiBase()).toBe('http://127.0.0.1:4001/api')
    expect(shikimoriOrigin()).toBe('http://127.0.0.1:4002')
  })

  it('ignores them in a packaged build', () => {
    applyApiBaseOverrides(STUBS, true)
    expect(smotretApiBase()).toBe(SMOTRET_API_BASE)
    expect(shikimoriOrigin()).toBe(SHIKIMORI_ORIGIN)
  })

  it('ignores an empty or blank value', () => {
    applyApiBaseOverrides({ [SMOTRET_API_BASE_ENV]: '', [SHIKIMORI_ORIGIN_ENV]: '  ' }, false)
    expect(smotretApiBase()).toBe(SMOTRET_API_BASE)
    expect(shikimoriOrigin()).toBe(SHIKIMORI_ORIGIN)
  })

  it('points SmotretApi requests at the override', async () => {
    applyApiBaseOverrides(STUBS, false)
    const stub = captureFetch({ data: [] })
    await new SmotretApi(() => '').searchAnime('x')
    expect(String(stub.mock.calls[0][0])).toMatch(/^http:\/\/127\.0\.0\.1:4001\/api\/series/)
  })

  // #685 review: the subtitle and mp4-fallback builders went to the real host
  // under a stubbed API.
  it('builds the subtitle and mp4-fallback URLs on the override’s site', () => {
    applyApiBaseOverrides(STUBS, false)
    const api = new SmotretApi(() => 'tok')
    expect(smotretOrigin()).toBe('http://127.0.0.1:4001')
    expect(api.getSubtitlesUrl(9001)).toBe(
      'http://127.0.0.1:4001/translations/ass/9001?download=1&access_token=tok'
    )
    expect(api.getFallbackVideoUrl(9001, 720)).toBe(
      'http://127.0.0.1:4001/translations/mp4/9001?format=mp4&height=720&access_token=tok'
    )
    expect(rewriteLegacySmotretUrl('https://smotret-anime.ru/posters/9.jpg')).toBe(
      'http://127.0.0.1:4001/posters/9.jpg'
    )
  })

  it('drops /api from an override, takes the origin of any other, and ignores it packaged', () => {
    applyApiBaseOverrides({ [SMOTRET_API_BASE_ENV]: 'http://127.0.0.1:4003/smotret' }, false)
    expect(smotretOrigin()).toBe('http://127.0.0.1:4003')
    applyApiBaseOverrides({ [SMOTRET_API_BASE_ENV]: 'http://127.0.0.1:4004/smotret/api' }, false)
    expect(smotretOrigin()).toBe('http://127.0.0.1:4004/smotret')
    applyApiBaseOverrides(STUBS, true)
    expect(smotretOrigin()).toBe('https://smotret-anime.app')
    applyApiBaseOverrides({}, false)
    expect(smotretOrigin()).toBe('https://smotret-anime.app')
  })

  it('points Shikimori requests and the auth URL at the override', async () => {
    applyApiBaseOverrides(STUBS, false)
    const stub = captureFetch({ id: 1, nickname: 'n', image: { x48: '' } })
    await shikimori.getUser('tok')
    expect(String(stub.mock.calls[0][0])).toMatch(/^http:\/\/127\.0\.0\.1:4002\/api\//)
    expect(shikimori.getAuthUrl()).toMatch(/^http:\/\/127\.0\.0\.1:4002\/oauth\/authorize\?/)
  })
})

describe('rewriteLegacySmotretUrl (#684)', () => {
  it.each([
    [
      'https://smotret-anime.ru/posters/1234.5678.200x600.0.jpg',
      'https://smotret-anime.app/posters/1234.5678.200x600.0.jpg'
    ],
    [
      'https://www.smotret-anime.ru/posters/1234.jpg?v=2',
      'https://smotret-anime.app/posters/1234.jpg?v=2'
    ],
    [
      'http://smotretanime.ru/translations/ass/42?download=1&access_token=t',
      'https://smotret-anime.app/translations/ass/42?download=1&access_token=t'
    ],
    ['https://www.smotretanime.ru/posters/9.jpg', 'https://smotret-anime.app/posters/9.jpg'],
    [
      'https://anime-365.ru/posters/9.jpg?a=1&b=2',
      'https://smotret-anime.app/posters/9.jpg?a=1&b=2'
    ],
    ['https://www.anime-365.ru/posters/9.jpg', 'https://smotret-anime.app/posters/9.jpg'],
    ['https://SMOTRET-ANIME.RU/posters/9.jpg', 'https://smotret-anime.app/posters/9.jpg']
  ])('%s → .app', (from, to) => {
    expect(rewriteLegacySmotretUrl(from)).toBe(to)
  })

  it.each([
    'https://smotret-anime.app/posters/9.jpg',
    'https://smotret-anime.co/posters/9.jpg',
    'https://smotret-anime.org/catalog/9',
    'https://shikimori.io/system/animes/original/9.jpg',
    'https://example.invalid/9.jpg',
    'https://notsmotret-anime.ru/posters/9.jpg',
    'https://smotret-anime.ru.example.invalid/posters/9.jpg',
    'anime-poster://1',
    'ftp://smotret-anime.ru/posters/9.jpg',
    'not a url',
    ''
  ])('%s → null', (url) => {
    expect(rewriteLegacySmotretUrl(url)).toBeNull()
  })
})
