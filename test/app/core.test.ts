// anime-video:// scheme privileges (#490). The player's <video> carries
// crossorigin="anonymous" and the renderer page is file://, so every
// anime-video:// load is cross-origin. Electron >= 41.4 blocks those reads for
// a scheme registered with supportFetchAPI but without corsEnabled, which broke
// local MP4 / .part playback and the remux fallback. e2e/anime-video.spec.ts
// proves the behavior in the real renderer; this pins the registration itself.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { protocol } from 'electron'
import { App } from '../../src/main/app/core'

describe('App scheme registration', () => {
  beforeEach(() => {
    vi.mocked(protocol.registerSchemesAsPrivileged).mockClear()
  })

  it('registers anime-video:// as a streaming, fetchable, CORS-enabled scheme', () => {
    new App()

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    const schemes = vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls[0][0]
    const animeVideo = schemes.find((s) => s.scheme === 'anime-video')
    expect(animeVideo?.privileges).toMatchObject({
      stream: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true
    })
  })
})
