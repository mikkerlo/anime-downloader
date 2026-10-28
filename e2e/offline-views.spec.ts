import { test, expect } from '@playwright/test'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp
} from './helpers/profile'

/**
 * Each view offline (#568), on a profile seeded with Work offline on, one
 * library title whose detail cache is three days old (past the 24 h TTL), and
 * a signed-in Shikimori user with no calendar snapshot (snapshots live in
 * memory, so a fresh launch has none). Work offline refuses every request, so
 * nothing here depends on the network.
 */

const ANIME_ID = 4242
const TITLE = 'Offline Seeded Title'
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

const anime = {
  id: ANIME_ID,
  title: TITLE,
  titles: { romaji: TITLE },
  posterUrlSmall: 'https://example.invalid/p.jpg',
  numberOfEpisodes: 1,
  type: 'tv',
  typeTitle: 'TV Series',
  year: 2024,
  season: 'spring'
}

const detail = {
  ...anime,
  posterUrl: 'https://example.invalid/p.jpg',
  descriptions: [],
  genres: [],
  episodes: [{ id: 90001, episodeFull: '1 серия', episodeInt: '1', episodeType: 'tv', isActive: 1 }]
}

test('Search, Calendar and the detail page each say what works offline', async () => {
  const cachedAt = Date.now() - THREE_DAYS_MS
  const profile = makeProfile({
    prefix: 'anime-dl-offline-views-',
    config: {
      workOffline: true,
      library: { [ANIME_ID]: anime },
      animeCache: {
        [ANIME_ID]: {
          animeDetail: detail,
          episodes: {},
          qualityProbes: {},
          cachedAt,
          posterCached: false
        }
      },
      shikimoriUser: { id: 7, nickname: 'e2e', avatar: '' },
      shikimoriCredentials: {
        access_token: 'e2e-access',
        refresh_token: 'e2e-refresh',
        created_at: Math.floor(Date.now() / 1000),
        expires_in: 86_400
      }
    }
  })
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile)
    await assertUserData(launched.app, profile)
    const page = await launched.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => page.title()).toContain('Anime DL')
    await expect(page.getByTestId('offline-pill')).toHaveText('Offline (manual)')

    const nav = (name: string): ReturnType<typeof page.getByRole> =>
      page.locator('.sidebar').getByRole('button', { name, exact: true })
    // This PC has a title, so Search searches it (#571) instead of the notice.
    await nav('Search').click()
    const search = page.locator('.search-view')
    await expect(search.getByTestId('local-subtitle')).toContainText(
      'Showing titles saved on this PC'
    )
    await expect(page.locator('.search-input')).toBeEnabled()
    await page.locator('.search-input').fill('nothing like it')
    await page.locator('.search-input').press('Enter')
    await expect(search.getByTestId('local-empty')).toHaveText('Nothing saved on this PC matches')
    await expect(search.getByTestId('offline-notice')).toHaveCount(0)

    await nav('Calendar').click()
    await expect(page.locator('.calendar-view').getByTestId('offline-notice')).toContainText(
      'Calendar needs an internet connection'
    )

    await nav('Library').click()
    await page.locator('.acard', { hasText: TITLE }).first().click()
    // The date is in the app's locale; the year pins it to the seeded entry.
    const year = new Date(cachedAt).getFullYear()
    await expect(page.getByTestId('saved-offline-badge')).toHaveText(
      new RegExp(`^Saved .*${year}.*, offline$`)
    )
    await expect(page.locator('.detail-view h1')).toHaveText(TITLE)
    await expect(page.getByTestId('download-all')).toBeDisabled()
    await expect(page.getByTestId('download-all')).toHaveAttribute(
      'title',
      'Downloads need an internet connection'
    )
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
    }
  }
})
