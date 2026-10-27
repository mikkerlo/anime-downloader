import { test, expect, type Locator } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp
} from './helpers/profile'

/**
 * The library offline (#570), on a profile seeded with Work offline on, one
 * starred title and one continue-watching title that is neither starred nor
 * downloaded. Both have a detail cache three days old and a poster in
 * `poster-cache/`. Work offline refuses every remote request, so a poster that
 * renders came from the `anime-poster://` scheme. The continue-watching title
 * also shows that the boot `cleanupStale` keeps its cache and poster.
 */

const STARRED_ID = 4301
const WATCHING_ID = 4302
const STARRED_TITLE = 'Offline Starred Title'
const WATCHING_TITLE = 'Offline Watching Title'
const DAY_MS = 24 * 60 * 60 * 1000

// A valid 1×1 PNG. Blink picks the image decoder by signature, so the
// `image/jpeg` the handler sends for every `.jpg` does not matter.
const POSTER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

function anime(id: number, title: string): Record<string, unknown> {
  return {
    id,
    title,
    titles: { romaji: title },
    posterUrlSmall: `https://example.invalid/${id}.jpg`,
    numberOfEpisodes: 2,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2024,
    season: 'spring'
  }
}

function cacheEntry(id: number, title: string, cachedAt: number): Record<string, unknown> {
  return {
    animeDetail: {
      ...anime(id, title),
      posterUrl: `https://example.invalid/${id}-big.jpg`,
      descriptions: [],
      genres: [],
      episodes: [
        { id: id * 10 + 1, episodeFull: '1 серия', episodeInt: '1', episodeType: 'tv', isActive: 1 }
      ]
    },
    episodes: {},
    qualityProbes: {},
    cachedAt,
    posterCached: true
  }
}

async function expectRendered(img: Locator): Promise<void> {
  await expect(img).toHaveAttribute('src', /^anime-poster:\/\/\d+$/)
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
}

test('Library, Home and Detail keep their posters and details offline', async () => {
  const now = Date.now()
  const cachedAt = now - 3 * DAY_MS
  const profile = makeProfile({
    prefix: 'anime-dl-offline-library-',
    config: {
      workOffline: true,
      library: { [STARRED_ID]: anime(STARRED_ID, STARRED_TITLE) },
      recentAnimeMeta: { [WATCHING_ID]: anime(WATCHING_ID, WATCHING_TITLE) },
      watchProgress: {
        [`${WATCHING_ID}:1`]: { position: 600, duration: 1400, updatedAt: now - DAY_MS }
      },
      animeCache: {
        [STARRED_ID]: cacheEntry(STARRED_ID, STARRED_TITLE, cachedAt),
        [WATCHING_ID]: cacheEntry(WATCHING_ID, WATCHING_TITLE, cachedAt)
      }
    }
  })
  const posterDir = path.join(profile.userData, 'poster-cache')
  fs.mkdirSync(posterDir)
  for (const id of [STARRED_ID, WATCHING_ID])
    fs.writeFileSync(path.join(posterDir, `${id}.jpg`), POSTER)

  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile)
    await assertUserData(launched.app, profile)
    const page = await launched.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('offline-pill')).toHaveText('Offline (manual)')

    const watchingCard = page.locator('.cw-card', { hasText: WATCHING_TITLE })
    await expectRendered(watchingCard.locator('.cw-poster img'))

    const nav = (name: string): Locator =>
      page.locator('.sidebar').getByRole('button', { name, exact: true })
    await nav('Library').click()
    const starredCard = page.locator('.acard', { hasText: STARRED_TITLE })
    await expectRendered(starredCard.locator('img.poster'))

    await starredCard.click()
    await expect(page.locator('.detail-view h1')).toHaveText(STARRED_TITLE)
    await expect(page.getByTestId('saved-offline-badge')).toContainText('offline')
    await expectRendered(page.locator('.detail-poster img'))

    // Neither starred nor downloaded: on the old scope the boot cleanup
    // deleted this title's cache and poster.
    await nav('Home').click()
    await page.locator('.cw-card', { hasText: WATCHING_TITLE }).click()
    await expect(page.locator('.detail-view h1')).toHaveText(WATCHING_TITLE)
    await expectRendered(page.locator('.detail-poster img'))
    expect(fs.existsSync(path.join(posterDir, `${WATCHING_ID}.jpg`))).toBe(true)
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
    }
  }
})
