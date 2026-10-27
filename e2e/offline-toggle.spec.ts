import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp,
  type Profile
} from './helpers/profile'

/**
 * Work offline (#567). Main reaches the network through Node `fetch`, which
 * Chromium's offline switches cannot reach, and CI cannot block the network,
 * so the toggle is the e2e lever: it drives the switch and the pill, and checks
 * the persisted `workOffline`. Auto-detection is covered by the unit suite.
 */

function persisted(profile: Profile): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(profile.userData, 'config.json'), 'utf-8'))
  } catch {
    return {}
  }
}

async function open(profile: Profile): Promise<{ launched: LaunchedApp; page: Page }> {
  const launched = await launchApp(profile)
  await assertUserData(launched.app, profile)
  const page = await launched.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.title()).toContain('Anime DL')
  return { launched, page }
}

async function close(
  launched: LaunchedApp | undefined,
  profile: Profile | undefined
): Promise<void> {
  try {
    if (launched) assertNoDownloads(launched)
  } finally {
    await launched?.app.close()
    profile?.cleanup()
  }
}

test('the Work offline switch shows the pill and persists; the pill goes back online', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-offline-' })
  let launched: LaunchedApp | undefined
  try {
    const opened = await open(profile)
    launched = opened.launched
    const page = opened.page
    const pill = page.getByTestId('offline-pill')
    await expect(pill).toBeHidden()

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'General' }).click()
    const toggle = page.getByTestId('work-offline-switch')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()

    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveText('Offline (manual)')
    await expect.poll(() => persisted(profile).workOffline).toBe(true)

    // In manual mode the pill is the way back online.
    await pill.click()
    await expect(pill).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => persisted(profile).workOffline).toBe(false)
  } finally {
    await close(launched, profile)
  }
})

test('a persisted workOffline starts the app offline', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-offline-boot-', config: { workOffline: true } })
  let launched: LaunchedApp | undefined
  try {
    const opened = await open(profile)
    launched = opened.launched
    await expect(opened.page.getByTestId('offline-pill')).toHaveText('Offline (manual)')
  } finally {
    await close(launched, profile)
  }
})
