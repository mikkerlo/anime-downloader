import { test, expect, type Locator, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
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

const FIXTURE_ID = '5d7c1f3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f'

/** Submits `q` in Search and returns its local cards (#583: drive titles among them). */
async function searchLocal(page: Page, q: string): Promise<Locator> {
  await page.locator('.sidebar').getByRole('button', { name: 'Search', exact: true }).click()
  const input = page.locator('.search-input')
  await input.fill(q)
  await input.press('Enter')
  return page.locator('.search-view').getByTestId('local-card')
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
    // Offline, as on the never-online PC: Search has only the drive's titles (#583).
    config: { playerMode: 'builtin', workOffline: true }
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
    // The tab header's Sync now (#584) is shown, not hidden with S10's empty slots.
    await expect(page.getByTestId('sync-now')).toBeVisible()
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

    // Search finds the drive's title (#583), with the drive badge and the
    // library's own poster; a click opens the attached title.
    const hit = await searchLocal(page, 'frieren')
    await expect(hit).toHaveCount(1)
    await expect(hit.getByTestId('drive-badge')).toHaveText('On Fixture library')
    const hitPoster = hit.locator('img.poster')
    await expect(hitPoster).toHaveAttribute('src', `anime-poster://shared/${FIXTURE_ID}/101`)
    await expect
      .poll(() => hitPoster.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    await hit.locator('.acard').click()
    await expect(page.getByTestId('attached-detail')).toBeVisible()
    await expect(page.getByTestId('attached-detail').locator('h1')).toHaveText('Frieren')

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
 * Copy to this PC (#579): the title is copied from the drive under this PC's
 * own name (the drive's folder is shortened), shows in Library, and plays from
 * the local copy once the drive is "unplugged" (its folder renamed away).
 * Nothing on the drive changes.
 */
test('Copy to this PC: the title lands in Library and plays with the drive unplugged', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-shared-copy-' })
  const downloads = path.join(profile.root, 'downloads')
  fs.mkdirSync(downloads)
  fs.writeFileSync(
    path.join(profile.userData, 'config.json'),
    JSON.stringify({
      playerVolume: 0,
      playerMuted: true,
      playerMode: 'builtin',
      workOffline: true,
      downloadDir: downloads
    }),
    { mode: 0o600 }
  )
  const drive = path.join(profile.root, 'drive', 'Fixture library')
  fs.cpSync(FIXTURE, drive, { recursive: true })
  const before = tree(drive)
  const away = path.join(profile.root, 'unplugged')
  const local = path.join(
    downloads,
    'Sousou no Frieren',
    'Sousou no Frieren - 01 [Crunchyroll].mp4'
  )

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
    await page.getByTestId('use-videos').click()
    await page.getByTestId('show-library').click()

    const frieren = page.getByTestId('drive-title').filter({ hasText: 'Frieren' })
    await expect(frieren.getByTestId('on-this-pc')).toHaveCount(0)
    await frieren.getByTestId('copy-to-pc').click()
    const dialog = page.getByTestId('import-dialog')
    await expect(dialog).toContainText('Sousou no Frieren')
    await dialog.getByTestId('import-start').click()
    await expect(dialog).toHaveCount(0)
    await expect(frieren.getByTestId('on-this-pc')).toBeVisible({ timeout: 20_000 })
    expect(fs.existsSync(local)).toBe(true)
    expect(fs.readFileSync(local)).toEqual(
      fs.readFileSync(path.join(drive, 'Frieren~3f2a1c', 'Frieren~3f2a1c - 01 [Crunchyroll].mp4'))
    )
    expect(tree(drive)).toEqual(before)

    // The drive goes away; the copy is this PC's own download now.
    fs.renameSync(drive, away)
    await page.locator('.pill-tab', { hasText: 'All' }).click()
    const card = page.locator('.library-view .acard', { hasText: 'Sousou no Frieren' })
    await expect(card).toHaveCount(1)
    await card.click()
    // The detail page from the cached details the copy registered, offline.
    await page.locator('button[title="Open file"]').first().click()
    const video = page.locator('video').first()
    await expect
      .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)
    expect(await video.evaluate((v) => (v as HTMLVideoElement).src)).toContain(
      encodeURIComponent('Sousou no Frieren - 01 [Crunchyroll].mp4')
    )
    await page.locator('.close-btn').first().click()
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
  // Offline, so Search runs over the local corpus only and never the network (#583).
  const profile = makeProfile({ prefix: 'anime-dl-shared-detect-', config: { workOffline: true } })
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

    // Search finds the drive's title while it is plugged in (#583).
    const sharedTab = async (): Promise<void> => {
      await page.locator('.sidebar').getByRole('button', { name: 'Library', exact: true }).click()
      await page.locator('.pill-tab', { hasText: 'Shared Libraries' }).click()
    }
    await expect(await searchLocal(page, 'frieren')).toHaveCount(1)
    await sharedTab()

    // Unplug: the dot goes unavailable, with Last seen.
    fs.renameSync(stick, away)
    await focus()
    await expect(dot).toHaveAttribute('data-available', 'false', { timeout: 15_000 })
    await expect(section.getByTestId('last-seen')).toContainText('Last seen')

    // Unplugged, its titles drop out of Search; this PC has nothing else.
    await expect(await searchLocal(page, 'frieren')).toHaveCount(0)
    await expect(page.locator('.search-view').getByTestId('offline-notice')).toBeVisible()
    await sharedTab()

    // Back at the same path.
    fs.renameSync(away, stick)
    await focus()
    await expect(dot).toHaveAttribute('data-available', 'true', { timeout: 15_000 })
    const back = await searchLocal(page, 'frieren')
    await expect(back).toHaveCount(1)
    await expect(back.getByTestId('drive-badge')).toHaveText('On Fixture library')
    await sharedTab()

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

/**
 * A drive pulled mid-episode (#582). Renaming the library dir doesn't break the
 * ffmpeg run that is already reading (its fd stays open), so the spec seeks
 * past what the player has buffered: the respawn on the gone file fails, main
 * classifies it as `drive-disconnected`, and the player shows the overlay
 * instead of an error or a hang. Renamed back, Retry re-resolves the episode
 * and reopens it at the position saved when the drive went away.
 *
 * The `.mkv` is a 140 s synthetic file at about 15 Mbit/s (noise doesn't
 * compress). Main stops sending 64 MB past what the player has appended, which
 * is then about 35 s of it, so 130 s has not reached the renderer: the seek
 * must respawn ffmpeg. A small file would be sent whole, and the seek would
 * land in the append queue instead.
 */
test('a drive disconnected mid-episode: the overlay, then Retry once it is back', async () => {
  const profile = makeProfile({
    prefix: 'anime-dl-shared-disconnect-',
    config: { playerMode: 'builtin' }
  })
  const drive = path.join(profile.root, 'drive', 'Fixture library')
  fs.cpSync(FIXTURE, drive, { recursive: true })
  const mkv = path.join(drive, 'Dungeon Meshi', 'Dungeon Meshi - 01 [AniLibria].mkv')
  const built = spawnSync(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      ...['-t', '140', '-vf', 'noise=alls=30:allf=t', '-c:v', 'libx264'],
      ...['-preset', 'ultrafast', '-crf', '26', '-g', '48', '-threads', '4'],
      ...['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', mkv]
    ],
    { encoding: 'utf-8' }
  )
  expect(built.status, built.stderr).toBe(0)
  const away = path.join(profile.root, 'unplugged')

  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile)
    const { app } = launched
    await assertUserData(app, profile)
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
    }, path.dirname(drive))
    const page = await app.firstWindow()
    // The player's own lines, for the failure message.
    const playerLog: string[] = []
    page.on('console', (m) => {
      if (m.text().startsWith('[player]')) playerLog.push(m.text())
    })
    await page.waitForLoadState('domcontentloaded')
    const focus = (): Promise<void> =>
      app.evaluate(({ app: electronApp }) => {
        electronApp.emit('browser-window-focus')
      })

    await page.locator('.sidebar').getByRole('button', { name: 'Library', exact: true }).click()
    await page.locator('.library-view').getByTestId('open-shared-library').click()
    await page.getByTestId('use-videos').click()
    await page.getByTestId('show-library').click()
    const cards = page.getByTestId('drive-title')
    await playAndWait(page, cards.filter({ hasText: 'Dungeon Meshi' }))
    const video = page.locator('video').first()
    const time = (): Promise<number> => video.evaluate((v) => (v as HTMLVideoElement).currentTime)
    const buffered = (): Promise<number> =>
      video.evaluate((v) => {
        const b = (v as HTMLVideoElement).buffered
        return b.length ? b.end(b.length - 1) : 0
      })

    // Unplugged mid-episode, then a seek outside the buffer: the next open fails.
    // Paused first, as the @mkv-sync spec does, so no timeupdate pumps the
    // append queue during the respawn's debounce.
    await video.evaluate((v) => (v as HTMLVideoElement).pause())
    await page.waitForTimeout(500)
    expect(await buffered()).toBeLessThan(120)
    fs.renameSync(drive, away)
    await video.evaluate((v) => {
      ;(v as HTMLVideoElement).currentTime = 130
    })
    const overlay = page.getByTestId('drive-disconnected')
    await expect(overlay)
      .toContainText('The drive was disconnected. Reconnect it to continue.', { timeout: 20_000 })
      .catch((err: Error) => {
        throw new Error(`${err.message}\n--- player log ---\n${playerLog.join('\n')}`)
      })
    await expect(
      page.locator('.remux-error-title', { hasText: 'Failed to prepare MKV' })
    ).toHaveCount(0)

    // The poller sees it gone: Retry stays off until the drive is back.
    await focus()
    const retry = overlay.getByTestId('drive-retry')
    await expect(retry).toBeDisabled({ timeout: 15_000 })
    fs.renameSync(away, drive)
    await focus()
    await expect(retry).toBeEnabled({ timeout: 15_000 })
    await retry.click()
    await expect(overlay).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)
    // Back at the position saved when the drive went away.
    await expect.poll(time, { timeout: 15_000 }).toBeGreaterThanOrEqual(129)
    await page.locator('.close-btn').first().click()
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
    }
  }
})
