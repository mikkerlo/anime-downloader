import { test, expect, type Page } from '@playwright/test'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp,
  type Profile
} from './helpers/profile'
import { SHIKIMORI_ORIGIN } from '../src/shared/shikimori'

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

  // The Shikimori account card lives in Trackers (#700), not in Connectors.
  await expect(page.getByRole('button', { name: 'Connect Shikimori' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Trackers' }).click()
  await expect(page.getByRole('button', { name: 'Connect Shikimori' })).toBeVisible()
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

// The list page (#707), on its own profile: a Shikimori user with two cached
// rates and Work offline on, so nothing reaches the network (posters included,
// the offline request gate cancels them).
test.describe('the "Lists" group and the list page', () => {
  test('a Shikimori user reads "Lists", and the list page renders the codec’s title and poster', async () => {
    const created = Math.floor(Date.now() / 1000)
    const listProfile = makeProfile({
      prefix: 'anime-dl-nav-lists-',
      config: {
        workOffline: true,
        prefetchNextEpisode: 'off',
        shikimoriUser: { id: 7, nickname: 'e2e', avatar: '' },
        shikimoriCredentials: {
          access_token: 'e2e-access',
          refresh_token: 'e2e-refresh',
          created_at: created,
          expires_in: 86_400
        },
        shikimoriUserRates: [
          {
            rate: {
              id: 70001,
              target_id: 5001,
              episodes: 1,
              status: 'watching',
              score: 0,
              rewatches: 0,
              updated_at: '2026-05-01T10:00:00.000Z',
              serverUpdatedAt: '2026-05-01T10:00:00.000Z'
            },
            shikiAnime: {
              id: 5001,
              name: 'Seeded Romaji',
              russian: 'Сидированный',
              image: {
                original: '/system/animes/original/5001.jpg',
                preview: '/system/animes/preview/5001.jpg',
                x96: '/system/animes/x96/5001.jpg',
                x48: '/system/animes/x48/5001.jpg'
              },
              episodes: 12,
              episodes_aired: 3,
              kind: 'tv',
              score: '8.0',
              status: 'ongoing'
            },
            smotretAnime: null
          },
          {
            rate: {
              id: 70002,
              target_id: 5002,
              episodes: 1,
              status: 'completed',
              score: 7,
              rewatches: 0,
              updated_at: '2026-04-01T10:00:00.000Z',
              serverUpdatedAt: '2026-04-01T10:00:00.000Z'
            },
            shikiAnime: {
              id: 5002,
              name: 'Name Only',
              russian: '',
              image: {
                original: '/system/animes/original/5002.jpg',
                preview: '/system/animes/preview/5002.jpg',
                x96: '',
                x48: ''
              },
              episodes: 1,
              episodes_aired: 1,
              kind: 'movie',
              score: '7.0',
              status: 'released'
            },
            smotretAnime: {
              id: 50020,
              title: 'Name Only',
              titles: { romaji: 'Name Only' },
              posterUrlSmall: '',
              numberOfEpisodes: 1,
              type: 'movie',
              typeTitle: 'Movie',
              year: 2020,
              season: ''
            }
          }
        ],
        malIdMap: {
          5002: { id: 50020, title: 'Name Only' }
        },
        // The cached dashboard (Work offline can't fetch one), which holds
        // "Recent activity" for Shikimori.
        shikimoriProfile: {
          id: 7,
          nickname: 'e2e',
          avatar: '',
          friendsCount: 0,
          lists: [
            { status: 'watching', n: 1 },
            { status: 'completed', n: 1 }
          ],
          scores: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
          genres: [],
          stats: { titles: 2, episodes: 2, mean: 7, daysWatched: 0.1 }
        }
      }
    })
    let listApp: LaunchedApp | undefined
    try {
      listApp = await launchApp(listProfile)
      await assertUserData(listApp.app, listProfile)
      const win = await listApp.app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await expect.poll(() => win.title()).toContain('Anime DL')

      const sidebar = win.locator('.sidebar')
      await expect(sidebar.locator('.nav-label')).toHaveText('Lists')
      await expect(
        sidebar.locator('.nav-group').filter({ hasText: 'Lists' }).locator('.nav-item')
      ).toHaveText(['Shikimori', 'For You', 'Friends', 'Calendar'])
      await sidebar.getByRole('button', { name: 'Shikimori', exact: true }).click()

      const view = win.locator('.tracker-list-view')
      await expect(view).toBeVisible()
      await expect(view.locator('header h2')).toHaveText('Shikimori')
      // "To Watch" (the default filter): the watching title with unwatched episodes.
      const card = view.locator('.results-grid .fallback-card')
      await expect(card.locator('.acard-title')).toHaveText('Сидированный')
      await expect(card.locator('img.poster')).toHaveAttribute(
        'src',
        `${SHIKIMORI_ORIGIN}/system/animes/original/5001.jpg`
      )
      // Recent activity: `russian || name`, and an empty smotret poster falls to the codec's.
      const rows = view.locator('.act-row')
      await expect(rows.locator('.act-title')).toHaveText(['Сидированный', 'Name Only'])
      await expect(rows.nth(1).locator('img')).toHaveAttribute(
        'src',
        `${SHIKIMORI_ORIGIN}/system/animes/original/5002.jpg`
      )
      assertNoDownloads(listApp)
    } finally {
      await listApp?.app.close()
      listProfile.cleanup()
    }
  })
})
