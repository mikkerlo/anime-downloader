import { test, expect } from '@playwright/test'
import { assertUserData, launchApp, makeProfile } from './helpers/profile'

/**
 * Cold-start regression: IPC must be registered before the renderer mounts.
 *
 * On a fresh profile (no ffmpeg binaries yet) the pre-fix bootstrap awaited
 * the ensureFfmpeg network download BEFORE registerIpcHandlers(), while the
 * window was already up — so every view's first IPC call failed with
 * "No handler registered for 'library-get'" and the UI sat dead until the
 * download settled (or forever, if it failed). Launching on a profile with no
 * binaries seeded reproduces the first-launch state; the assertion is that a
 * store-backed IPC call answers immediately after load, regardless of the
 * (still in-flight, background) binary download.
 */
test('cold start: IPC answers while first-launch binary downloads are pending', async () => {
  // The one spec that opts out of seeding (#562): the download is what it tests.
  const profile = makeProfile({ prefix: 'anime-dl-coldstart-', ffmpeg: 'none', fpcalc: 'none' })
  const { app } = await launchApp(profile).catch((e: unknown) => {
    profile.cleanup()
    throw e
  })
  try {
    await assertUserData(app, profile)
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const lib = await window.evaluate(() =>
      (window as unknown as { api: { libraryGet: () => Promise<unknown> } }).api.libraryGet()
    )
    expect(lib).toBeTruthy()
  } finally {
    await app.close()
    profile.cleanup()
  }
})
