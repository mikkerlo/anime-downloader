import { test, expect } from '@playwright/test'
import { assertNoDownloads, assertUserData, launchApp, makeProfile } from './helpers/profile'

test('app boots and opens its main window', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-smoke-' })
  const launched = await launchApp(profile).catch((e: unknown) => {
    profile.cleanup()
    throw e
  })
  const { app } = launched

  try {
    await assertUserData(app, profile)
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    await expect.poll(() => window.title()).toContain('Anime DL')
    expect(await window.locator('#app').count()).toBeGreaterThan(0)
    assertNoDownloads(launched)
  } finally {
    await app.close()
    profile.cleanup()
  }
})
