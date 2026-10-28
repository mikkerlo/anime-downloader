import { test, expect, type Locator, type Page } from '@playwright/test'
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
 * Open a Shared Library and play from it (#578). The checked-in fixture
 * library (an `.mp4` + `.ass` under a shortened folder name, an `.mkv`, a
 * poster) is copied to a temp "drive"; `showOpenDialog` is stubbed in main to
 * return it. The profile has no Shikimori account, so the open flow offers
 * the claim, and the spec takes "Use as videos only". Both files play from the
 * drive: the `.mp4` through `anime-video://`, the `.mkv` through the MSE remux.
 * Nothing on the drive changes.
 */
const FIXTURE = path.resolve(
  __dirname,
  '..',
  'test',
  'fixtures',
  'shared-library',
  'fixture-library'
)

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      const st = fs.statSync(p)
      out[path.relative(root, p)] = `${st.size}:${st.mtimeMs}`
      if (e.isDirectory()) walk(p)
    }
  }
  walk(root)
  return out
}

async function playAndWait(page: Page, card: Locator): Promise<void> {
  await card.getByTestId('play-from-drive').click()
  const video = page.locator('video').first()
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2)
}

test('open a Shared Library, see its titles, and play an .mp4 and an .mkv from the drive', async () => {
  const profile = makeProfile({
    prefix: 'anime-dl-shared-open-',
    config: { playerMode: 'builtin' }
  })
  const drive = path.join(profile.root, 'drive', 'Fixture library')
  fs.cpSync(FIXTURE, drive, { recursive: true })
  const before = tree(drive)

  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile)
    const { app } = launched
    await assertUserData(app, profile)
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
    }, path.dirname(drive))
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await page.locator('.sidebar').getByRole('button', { name: 'Library', exact: true }).click()
    await page.locator('.library-view').getByTestId('open-shared-library').click()

    // No account: the identity check offers the claim; take videos only.
    await expect(page.getByTestId('identity-warning')).toContainText('belongs to owner')
    await page.getByTestId('use-videos').click()
    await page.getByTestId('show-library').click()

    await expect(page.locator('.pill-tab', { hasText: 'Shared Libraries' })).toHaveClass(/active/)
    const cards = page.getByTestId('drive-title')
    // Frieren's card reads its snapshot's romaji title; Dungeon Meshi has no meta.
    await expect(cards.locator('.acard-title')).toHaveText(['Sousou no Frieren', 'Dungeon Meshi'])
    // The poster comes from the drive through `anime-poster://`.
    const poster = cards.filter({ hasText: 'Frieren' }).locator('img.poster')
    await expect(poster).toHaveAttribute('src', 'anime-poster://101')
    await expect
      .poll(() => poster.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)

    await playAndWait(page, cards.filter({ hasText: 'Frieren' }))
    await page.locator('.close-btn').first().click()
    await expect(page.locator('video')).toHaveCount(0)

    await playAndWait(page, cards.filter({ hasText: 'Dungeon Meshi' }))
    await page.locator('.close-btn').first().click()

    expect(tree(drive)).toEqual(before)
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
    }
  }
})
