import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { resolve } from 'path'

/**
 * Navigation e2e (Phase 7 PR 4, #140).
 *
 * Drives the real built app through sidebar navigation with no network
 * dependency — every view here renders from local state. Network/media-bound
 * flows (search, player, Shikimori sync) are deliberately excluded; see the
 * PR description for why they're deferred.
 */

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const args = [resolve(__dirname, '../out/main/index.js')]
  if (process.env.CI) args.unshift('--no-sandbox')
  app = await electron.launch({ args })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.title()).toContain('Anime DL')
})

test.afterAll(async () => {
  await app?.close()
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

  // Library.
  await page.getByRole('button', { name: 'Library' }).click()
  await expect(page.getByRole('button', { name: 'Library' })).toHaveClass(/active/)

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
