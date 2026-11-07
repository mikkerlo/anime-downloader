import { describe, it, expect, vi } from 'vitest'
import {
  installOfflineRequestGate,
  shouldCancelWhileOffline
} from '../../src/main/lib/offline-request-gate'
import { rewriteLegacySmotretUrl } from '../../src/main/lib/api-bases'

describe('shouldCancelWhileOffline (#567)', () => {
  it('cancels renderer http(s): posters, avatars, the CDN', () => {
    expect(shouldCancelWhileOffline('https://smotret-anime.ru/posters/1.jpg')).toBe(true)
    expect(shouldCancelWhileOffline('https://desu.shikimori.io/x48/1.png')).toBe(true)
    expect(shouldCancelWhileOffline('http://example.test/a')).toBe(true)
  })

  it('never cancels local schemes', () => {
    for (const url of [
      'anime-video:///home/u/a.mp4',
      'file:///app/out/renderer/index.html',
      'devtools://devtools/bundled/inspector.html',
      'data:image/png;base64,AAAA',
      'blob:file:///1234'
    ]) {
      expect(shouldCancelWhileOffline(url), url).toBe(false)
    }
  })

  it('lets the electron-vite dev server through', () => {
    const dev = 'http://localhost:5173'
    expect(shouldCancelWhileOffline('http://localhost:5173/src/main.ts', dev)).toBe(false)
    expect(shouldCancelWhileOffline('http://localhost:5174/x', dev)).toBe(true)
    expect(shouldCancelWhileOffline('https://smotret-anime.ru/x', dev)).toBe(true)
  })

  it('treats a malformed URL or dev-server value as no exemption, never as a throw', () => {
    expect(shouldCancelWhileOffline('not a url')).toBe(false)
    expect(shouldCancelWhileOffline('https://a.test/', 'not a url')).toBe(true)
  })
})

describe('installOfflineRequestGate', () => {
  type Answer = { cancel?: boolean; redirectURL?: string }
  function install(
    offline: { value: boolean },
    redirect?: (url: string) => string | null
  ): (url: string) => Answer {
    let listener!: (d: { url: string }, cb: (r: Answer) => void) => void
    const session = {
      webRequest: {
        onBeforeRequest: vi.fn((l: typeof listener) => {
          listener = l
        })
      }
    }
    installOfflineRequestGate(session, () => offline.value, undefined, redirect)
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    return (url) => {
      let response!: Answer
      listener({ url }, (r) => (response = r))
      return response
    }
  }

  it('cancels http(s) only while offline, and reads the state per request', () => {
    const offline = { value: false }
    const request = install(offline)
    expect(request('https://smotret-anime.ru/p.jpg')).toEqual({ cancel: false })
    offline.value = true
    expect(request('https://smotret-anime.ru/p.jpg')).toEqual({ cancel: true })
    expect(request('anime-video:///a.mp4')).toEqual({ cancel: false })
    offline.value = false
    expect(request('https://smotret-anime.ru/p.jpg')).toEqual({ cancel: false })
  })

  // #684: stored `.ru` poster URLs move to the new host in the same listener,
  // since Electron keeps only the last `onBeforeRequest` per session.
  describe('with the legacy smotret redirect (#684)', () => {
    const RU = 'https://smotret-anime.ru/posters/1234.5678.200x600.0.jpg'
    const APP = 'https://smotret-anime.app/posters/1234.5678.200x600.0.jpg'

    it('online, a .ru poster is redirected to smotret-anime.app', () => {
      const request = install({ value: false }, rewriteLegacySmotretUrl)
      expect(request(RU)).toEqual({ redirectURL: APP })
    })

    it('offline, the same URL is cancelled: cancel wins', () => {
      const request = install({ value: true }, rewriteLegacySmotretUrl)
      expect(request(RU)).toEqual({ cancel: true })
    })

    it('online, a live host or a local scheme passes untouched', () => {
      const request = install({ value: false }, rewriteLegacySmotretUrl)
      expect(request(APP)).toEqual({ cancel: false })
      expect(request('anime-video:///a.mp4')).toEqual({ cancel: false })
    })
  })
})
