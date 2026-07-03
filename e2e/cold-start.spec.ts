import { test, expect, _electron as electron } from '@playwright/test'
import { resolve, join } from 'path'
import * as fs from 'fs'
import * as os from 'os'

/**
 * Cold-start regression: IPC must be registered before the renderer mounts.
 *
 * On a fresh profile (no ffmpeg binaries yet) the pre-fix bootstrap awaited
 * the ensureFfmpeg network download BEFORE registerIpcHandlers(), while the
 * window was already up — so every view's first IPC call failed with
 * "No handler registered for 'library-get'" and the UI sat dead until the
 * download settled (or forever, if it failed). Launching with an empty
 * XDG_CONFIG_HOME reproduces the first-launch state; the assertion is that a
 * store-backed IPC call answers immediately after load, regardless of the
 * (still in-flight, background) binary download.
 */
test('cold start: IPC answers while first-launch binary downloads are pending', async () => {
  // XDG_CONFIG_HOME only relocates userData on Linux; elsewhere this would
  // silently run against the real profile and stop testing first-launch state.
  test.skip(process.platform !== 'linux', 'XDG profile isolation is Linux-only')
  const xdg = fs.mkdtempSync(join(os.tmpdir(), 'anime-dl-coldstart-'))
  const args = [resolve(__dirname, '../out/main/index.js')]
  if (process.env.CI) args.unshift('--no-sandbox')

  const app = await electron.launch({ args, env: { ...process.env, XDG_CONFIG_HOME: xdg } })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const lib = await window.evaluate(() =>
      (window as unknown as { api: { libraryGet: () => Promise<unknown> } }).api.libraryGet()
    )
    expect(lib).toBeTruthy()
  } finally {
    await app.close()
    fs.rmSync(xdg, { recursive: true, force: true })
  }
})
