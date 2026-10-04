import { test, expect, _electron as electron } from '@playwright/test'
import { resolve, join } from 'path'
import * as fs from 'fs'
import * as os from 'os'

/**
 * anime-video:// regression (#490): the player's <video> carries
 * crossorigin="anonymous" and the renderer page is file://, so every
 * anime-video:// load is a cross-origin request. Electron >= 41.4 blocks it
 * ("Cross origin requests are only supported for protocol schemes: …") unless
 * the scheme is registered with `corsEnabled` — local MP4 / .part playback
 * and the remux fallback died with MEDIA_ELEMENT_ERROR code 4. MKV is not
 * covered here: it plays through MSE from a blob: URL, not this scheme.
 *
 * The handler serves any absolute path (no root allow-list), so the committed
 * fixture is loaded straight from the repo.
 */
const FIXTURE = resolve(__dirname, 'fixtures/test-pattern.mp4')

test('anime-video:// serves a crossorigin <video> and a ranged fetch from the file:// renderer', async () => {
  const xdg = fs.mkdtempSync(join(os.tmpdir(), 'anime-dl-animevideo-'))
  const args = [resolve(__dirname, '../out/main/index.js'), '--mute-audio']
  if (process.env.CI) args.unshift('--no-sandbox')

  const app = await electron.launch({ args, env: { ...process.env, XDG_CONFIG_HOME: xdg } })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    expect(new URL(window.url()).protocol).toBe('file:')

    const url = 'anime-video://' + encodeURIComponent(FIXTURE)

    const video = await window.evaluate(
      (src) =>
        new Promise<{ ok: boolean; readyState: number; error: string | null }>((done) => {
          const v = document.createElement('video')
          v.crossOrigin = 'anonymous'
          v.muted = true
          v.preload = 'metadata'
          const finish = (ok: boolean): void =>
            done({
              ok,
              readyState: v.readyState,
              error: v.error ? `code=${v.error.code} ${v.error.message}` : null
            })
          v.addEventListener('loadedmetadata', () => finish(true), { once: true })
          v.addEventListener('error', () => finish(false), { once: true })
          setTimeout(() => finish(false), 10_000)
          v.src = src
        }),
      url
    )
    expect(video.error).toBeNull()
    expect(video.ok).toBe(true)
    expect(video.readyState).toBeGreaterThanOrEqual(1)

    const fetched = await window.evaluate(async (src) => {
      try {
        const res = await fetch(src, { headers: { Range: 'bytes=0-15' } })
        return { status: res.status, bytes: (await res.arrayBuffer()).byteLength, error: null }
      } catch (e) {
        return { status: 0, bytes: 0, error: String(e) }
      }
    }, url)
    expect(fetched.error).toBeNull()
    expect([200, 206]).toContain(fetched.status)
    expect(fetched.bytes).toBeGreaterThan(0)
  } finally {
    await app.close()
    fs.rmSync(xdg, { recursive: true, force: true })
  }
})
