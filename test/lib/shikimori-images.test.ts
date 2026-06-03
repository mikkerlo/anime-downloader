import { describe, it, expect, vi } from 'vitest'
import {
  withShikimoriReferer,
  installShikimoriReferer,
  SHIKIMORI_IMAGE_URL_FILTER
} from '../../src/main/lib/shikimori-images'

describe('withShikimoriReferer', () => {
  it('sets the Referer to the Shikimori origin', () => {
    expect(withShikimoriReferer({})).toEqual({ Referer: 'https://shikimori.one/' })
  })

  it('replaces a foreign Referer (the bug: renderer origin is rejected by hotlink protection)', () => {
    const out = withShikimoriReferer({ Referer: 'http://localhost:5173/' })
    expect(out.Referer).toBe('https://shikimori.one/')
  })

  it('preserves other request headers', () => {
    const out = withShikimoriReferer({ 'User-Agent': 'anime-dl', Accept: 'image/*' })
    expect(out).toEqual({
      'User-Agent': 'anime-dl',
      Accept: 'image/*',
      Referer: 'https://shikimori.one/'
    })
  })

  it('does not mutate the input headers', () => {
    const input = { Accept: 'image/*' }
    withShikimoriReferer(input)
    expect(input).toEqual({ Accept: 'image/*' })
  })
})

describe('installShikimoriReferer', () => {
  it('registers an onBeforeSendHeaders listener scoped to Shikimori URLs', () => {
    const onBeforeSendHeaders = vi.fn()
    installShikimoriReferer({ webRequest: { onBeforeSendHeaders } })

    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(onBeforeSendHeaders.mock.calls[0][0]).toEqual({ urls: SHIKIMORI_IMAGE_URL_FILTER })
  })

  it('rewrites the Referer on intercepted requests', () => {
    let listener: (
      details: { requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void
    ) => void = () => {}
    const onBeforeSendHeaders = vi.fn((_filter, fn) => {
      listener = fn
    })
    installShikimoriReferer({ webRequest: { onBeforeSendHeaders } })

    const callback = vi.fn()
    listener({ requestHeaders: { Referer: 'http://localhost:5173/' } }, callback)

    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Referer: 'https://shikimori.one/' }
    })
  })
})
