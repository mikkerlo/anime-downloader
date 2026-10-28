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

/**
 * Drive detection and Forget (#581). `ANIME_DL_MOUNT_PARENTS` points the mount
 * candidates at a temp folder, so moving the library in and out of it plays an
 * unplug and a re-plug (a test can't mount a real drive). A window-focus event
 * asks the poller for a tick instead of waiting for the 10 s interval.
 */
test('a library found on a drive, unplugged, re-plugged at a new path, then forgotten', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-shared-detect-' })
  const mounts = path.join(profile.root, 'mounts')
  const stick = path.join(mounts, 'STICK', 'Fixture library')
  fs.mkdirSync(path.dirname(stick), { recursive: true })
  fs.cpSync(FIXTURE, stick, { recursive: true })
  const before = tree(stick)
  const away = path.join(profile.root, 'unplugged')
  const relettered = path.join(mounts, 'KINGSTON', 'Fixture library')

  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile, { env: { ANIME_DL_MOUNT_PARENTS: mounts } })
    const { app } = launched
    await assertUserData(app, profile)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const focus = (): Promise<void> =>
      app.evaluate(({ app: electronApp }) => {
        electronApp.emit('browser-window-focus')
      })

    // An unknown library on a newly mounted drive: one toast, Open runs the identity flow.
    const toast = page.getByTestId('library-found-toast')
    await expect(toast).toContainText("Shared Library 'Fixture library' (owner) found on STICK", {
      timeout: 20_000
    })
    await toast.getByTestId('found-open').click()
    await expect(page.getByTestId('identity-warning')).toContainText('belongs to owner')
    await page.getByTestId('use-videos').click()
    await page.getByTestId('show-library').click()
    await expect(page.locator('.pill-tab', { hasText: 'Shared Libraries' })).toHaveClass(/active/)

    const section = page.getByTestId('shared-library-section')
    const dot = section.getByTestId('availability-dot')
    await expect(dot).toHaveAttribute('data-available', 'true')
    await expect(section.getByTestId('last-sync')).toHaveText('Last sync: never')

    // Unplug: the dot goes unavailable, with Last seen.
    fs.renameSync(stick, away)
    await focus()
    await expect(dot).toHaveAttribute('data-available', 'false', { timeout: 15_000 })
    await expect(section.getByTestId('last-seen')).toContainText('Last seen')

    // Back at the same path.
    fs.renameSync(away, stick)
    await focus()
    await expect(dot).toHaveAttribute('data-available', 'true', { timeout: 15_000 })

    // Unplug, then re-plug under another mount: found by libraryId at the new path.
    fs.renameSync(stick, away)
    await focus()
    await expect(dot).toHaveAttribute('data-available', 'false', { timeout: 15_000 })
    fs.mkdirSync(path.dirname(relettered), { recursive: true })
    fs.renameSync(away, relettered)
    await focus()
    await expect(dot).toHaveAttribute('data-available', 'true', { timeout: 15_000 })
    await expect(page.getByTestId('drive-title')).toHaveCount(2)
    await expect(toast).toHaveCount(0)

    // Forget: the section disappears; the drive is untouched.
    await section.getByTestId('library-menu').click()
    await page.getByTestId('menu-forget').click()
    await expect(page.getByTestId('forget-text')).toHaveText(
      "Forget Fixture library? The drive isn't changed."
    )
    await page.getByTestId('forget-confirm').click()
    await expect(page.getByTestId('shared-library-section')).toHaveCount(0)
    await expect(page.getByTestId('shared-libraries-tab')).toContainText(
      'No Shared Library is open.'
    )
    expect(tree(relettered)).toEqual(before)
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
    }
  }
})
