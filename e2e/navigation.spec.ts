import { test, expect, type Page } from '@playwright/test'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp,
  type Profile
} from './helpers/profile'

/**
 * Navigation e2e (Phase 7 PR 4, #140).
 *
 * Drives the real built app through sidebar navigation with no network
 * dependency — every view here renders from local state. Network/media-bound
 * flows (search, player, Shikimori sync) are deliberately excluded; see the
 * PR description for why they're deferred.
 */

// A fresh temp profile per run: on a shared one, the token round-trip below
// read the previous run's token back and passed without typing it (#562).
let profile: Profile
let launched: LaunchedApp
let page: Page

test.beforeAll(async () => {
  profile = makeProfile({ prefix: 'anime-dl-nav-' })
  launched = await launchApp(profile)
  await assertUserData(launched.app, profile)
  page = await launched.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.title()).toContain('Anime DL')
})

test.afterAll(async () => {
  try {
    if (launched) assertNoDownloads(launched)
  } finally {
    await launched?.app.close()
    profile?.cleanup()
  }
})

test('sidebar navigates between local views', async () => {
  // The app boots on Home.
  await expect(page.locator('.home-view')).toBeVisible()

  // Downloads — `v-if`, so the view mounts on navigation.
  await page.getByRole('button', { name: 'Downloads' }).click()
  await expect(page.locator('.downloads-view, [class*="downloads"]').first()).toBeVisible()

  // Settings — has a stable "Settings" heading.
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // Library. Exact: the Library header's "Open Shared Library…" (#578) is a button too.
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Library', exact: true })).toHaveClass(/active/)

  // Back to Home.
  await page.getByRole('button', { name: 'Home' }).click()
  await expect(page.locator('.home-view')).toBeVisible()
})

test('settings tabs switch and the token round-trips through electron-store', async () => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // Switch to the Connectors tab where the smotret token input lives.
  await page.getByRole('button', { name: 'Connectors' }).click()
  const tokenInput = page.locator('#token-input')
  await expect(tokenInput).toBeVisible()

  // Type a token; the tab autosaves after an 800ms debounce.
  const sample = 'e2e-sample-token-123'
  await tokenInput.fill(sample)
  // Wait past the debounce + IPC round-trip.
  await page.waitForTimeout(1200)

  // Navigate away and back — the value should reload from the persisted store.
  await page.getByRole('button', { name: 'Home' }).click()
  await expect(page.locator('.home-view')).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Connectors' }).click()

  await expect(page.locator('#token-input')).toHaveValue(sample)
})

test('Ctrl+F navigates to search and focuses the input', async () => {
  // Make sure we're not already on search.
  await page.getByRole('button', { name: 'Home' }).click()
  await expect(page.locator('.home-view')).toBeVisible()

  await page.keyboard.press('Control+f')

  // Search view becomes active; its input gains focus.
  await expect(page.getByRole('button', { name: 'Search' })).toHaveClass(/active/)
  const searchInput = page.locator('input[type="text"], input[type="search"]').first()
  await expect(searchInput).toBeFocused()
})
