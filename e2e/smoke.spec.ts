import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'path'

test('app boots and opens its main window', async () => {
  const args = [resolve(__dirname, '../out/main/index.js')]
  // GitHub runners can't use the Electron SUID sandbox under xvfb.
  if (process.env.CI) args.unshift('--no-sandbox')

  const app = await electron.launch({ args })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    await expect.poll(() => window.title()).toContain('Anime DL')
    expect(await window.locator('#app').count()).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
