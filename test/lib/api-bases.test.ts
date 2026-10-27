import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  SHIKIMORI_ORIGIN_ENV,
  SMOTRET_API_BASE,
  SMOTRET_API_BASE_ENV,
  applyApiBaseOverrides,
  shikimoriOrigin,
  smotretApiBase
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
    expect(smotretApiBase()).toBe('https://smotret-anime.ru/api')
    expect(SMOTRET_API_BASE).toBe('https://smotret-anime.ru/api')
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

  it('points Shikimori requests and the auth URL at the override', async () => {
    applyApiBaseOverrides(STUBS, false)
    const stub = captureFetch({ id: 1, nickname: 'n', image: { x48: '' } })
    await shikimori.getUser('tok')
    expect(String(stub.mock.calls[0][0])).toMatch(/^http:\/\/127\.0\.0\.1:4002\/api\//)
    expect(shikimori.getAuthUrl()).toMatch(/^http:\/\/127\.0\.0\.1:4002\/oauth\/authorize\?/)
  })
})
