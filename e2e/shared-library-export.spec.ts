import { test, expect, type Locator } from '@playwright/test'
import { createHash } from 'node:crypto'
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
 * Export to a Shared Library (#574), on a profile seeded with
 * `fixtures/test-pattern.mp4` registered as a downloaded episode. The folder
 * picker is stubbed in main to a temp "drive"; the export runs through the
 * Library's multi-select, and the files and the manifest are checked on disk.
 */

const ANIME_ID = 5101
const TITLE = 'E2E Export Show'
const FIXTURE = path.resolve(__dirname, 'fixtures', 'test-pattern.mp4')

const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('exports a downloaded episode to a new Shared Library', async () => {
  const anime = {
    id: ANIME_ID,
    title: TITLE,
    titles: { romaji: TITLE },
    posterUrlSmall: `https://example.invalid/${ANIME_ID}.jpg`,
    numberOfEpisodes: 1,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2024,
    season: 'spring'
  }
  const profile = makeProfile({ prefix: 'anime-dl-export-' })
  const downloads = path.join(profile.root, 'downloads')
  const drive = path.join(profile.root, 'drive')
  fs.mkdirSync(path.join(downloads, TITLE), { recursive: true })
  fs.mkdirSync(drive)
  const source = path.join(downloads, TITLE, `${TITLE} - 01 [Studio].mp4`)
  fs.copyFileSync(FIXTURE, source)
  fs.writeFileSync(
    path.join(profile.userData, 'config.json'),
    JSON.stringify({
      playerVolume: 0,
      playerMuted: true,
      workOffline: true,
      downloadDir: downloads,
      library: { [ANIME_ID]: anime },
      downloadedAnime: { [ANIME_ID]: anime },
      downloadedEpisodes: {
        [`${ANIME_ID}:1:91`]: {
          translationType: 'subRu',
          author: 'Studio',
          quality: 720,
          translationId: 91
        }
      }
    }),
    { mode: 0o600 }
  )

  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile)
    await assertUserData(launched.app, profile)
    await launched.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
    }, drive)
    const page = await launched.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const nav = (name: string): Locator =>
      page.locator('.sidebar').getByRole('button', { name, exact: true })
    await nav('Library').click()
    await page.getByTestId('library-select-toggle').click()
    await page.locator('.acard', { hasText: TITLE }).click()
    await page.getByTestId('library-export-selected').click()

    const dialog = page.getByTestId('export-dialog')
    await expect(dialog.getByTestId(`tree-episode-${ANIME_ID}:1:91`)).toBeChecked()
    await dialog.getByTestId('export-name').fill('E2E Trip')
    await dialog.getByTestId('export-pick').click()
    await expect(dialog.getByTestId('export-target-line')).toHaveText("New library 'E2E Trip'")
    await expect(dialog.getByTestId('export-start')).toBeEnabled()
    await dialog.getByTestId('export-start').click()
    await expect(dialog).toHaveCount(0)

    await nav('Downloads').click()
    await expect(page.getByTestId('export-job-completed')).toContainText(
      'Exported to E2E Trip — 1 / 1 files'
    )

    const root = path.join(drive, 'E2E Trip')
    const copied = path.join(root, TITLE, `${TITLE} - 01 [Studio].mp4`)
    expect(sha256(copied)).toBe(sha256(source))
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.anime-dl', 'manifest.json'), 'utf8')
    )
    expect(manifest).toMatchObject({
      layoutVersion: 1,
      name: 'E2E Trip',
      owner: null,
      mode: 'videos',
      titles: [{ animeId: ANIME_ID, name: TITLE }],
      items: [
        {
          animeId: ANIME_ID,
          episodeInt: '1',
          translationId: 91,
          path: `${TITLE}/${TITLE} - 01 [Studio].mp4`,
          size: fs.statSync(source).size,
          sha256: sha256(source)
        }
      ]
    })
    expect(fs.existsSync(path.join(root, '.anime-dl', 'meta', `${ANIME_ID}.json`))).toBe(true)
    expect(fs.readdirSync(path.join(root, TITLE))).toEqual([`${TITLE} - 01 [Studio].mp4`])
    expect(fs.existsSync(path.join(profile.userData, 'export-jobs'))).toBe(true)
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
    }
  }
})
