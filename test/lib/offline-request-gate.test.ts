import { describe, it, expect, vi } from 'vitest'
import {
  installOfflineRequestGate,
  shouldCancelWhileOffline
} from '../../src/main/lib/offline-request-gate'

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
  function install(offline: { value: boolean }): (url: string) => { cancel: boolean } {
    let listener!: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void
    const session = {
      webRequest: {
        onBeforeRequest: vi.fn((l: typeof listener) => {
          listener = l
        })
      }
    }
    installOfflineRequestGate(session, () => offline.value)
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    return (url) => {
      let response!: { cancel: boolean }
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
})
