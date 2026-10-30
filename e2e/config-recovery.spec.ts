import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  runAppToExit,
  type LaunchedApp,
  type Profile
} from './helpers/profile'

/**
 * #648: a `config.json` that doesn't parse used to throw while the main module
 * was still being evaluated, so no window ever opened. Each case rewrites the
 * seeded profile's `config.json` before the launch.
 */

const SETTINGS = '{"playerVolume":0,"playerMuted":true,"workOffline":true}'

function writeConfig(profile: Profile, contents: string | Buffer): void {
  fs.writeFileSync(path.join(profile.userData, 'config.json'), contents, { mode: 0o600 })
}

function corruptFiles(profile: Profile): string[] {
  return fs.readdirSync(profile.userData).filter((f) => f.includes('.corrupt-'))
}

async function open(profile: Profile): Promise<{ launched: LaunchedApp; page: Page }> {
  const launched = await launchApp(profile)
  await assertUserData(launched.app, profile)
  const page = await launched.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.title()).toContain('Anime DL')
  return { launched, page }
}

async function close(launched: LaunchedApp | undefined, profile: Profile): Promise<void> {
  try {
    if (launched) assertNoDownloads(launched)
  } finally {
    await launched?.app.close()
    profile.cleanup()
  }
}

test('a BOM-prefixed config.json loads its values and shows no notice', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-config-bom-' })
  writeConfig(profile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SETTINGS)]))
  let launched: LaunchedApp | undefined
  try {
    const opened = await open(profile)
    launched = opened.launched
    const { page } = opened

    // `workOffline: true` came from the file, not the defaults.
    await expect(page.getByTestId('offline-pill')).toHaveText('Offline (manual)')
    expect(await page.evaluate(() => window.api.getStartupNotice())).toBeNull()
    await expect(page.getByTestId('startup-notice')).toHaveCount(0)
    expect(corruptFiles(profile)).toEqual([])
  } finally {
    await close(launched, profile)
  }
})

test('a truncated config.json opens the window, keeps the file, and says so', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-config-truncated-' })
  const truncated = SETTINGS.slice(0, 30)
  writeConfig(profile, truncated)
  let launched: LaunchedApp | undefined
  try {
    const opened = await open(profile)
    launched = opened.launched
    const { page } = opened

    const kept = corruptFiles(profile)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/^config\.corrupt-\d{8}-\d{6}\.json$/)
    expect(fs.readFileSync(path.join(profile.userData, kept[0]), 'utf-8')).toBe(truncated)
    const banner = page.getByTestId('startup-notice')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('started with default settings')
    await expect(banner).toContainText(`The unreadable file was kept as ${kept[0]}.`)
  } finally {
    await close(launched, profile)
  }
})

test('a missing config.json next to a backup is restored from it, not reset', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-config-missing-' })
  const backup = path.join(profile.userData, 'config.backup.json')
  fs.writeFileSync(backup, SETTINGS, { mode: 0o600 })
  fs.rmSync(path.join(profile.userData, 'config.json'))
  let launched: LaunchedApp | undefined
  try {
    const opened = await open(profile)
    launched = opened.launched
    const { page } = opened

    // `workOffline: true` came from the backup, not the defaults.
    await expect(page.getByTestId('offline-pill')).toHaveText('Offline (manual)')
    const banner = page.getByTestId('startup-notice')
    await expect(banner).toContainText("Anime DL couldn't find its settings file")
    expect(JSON.parse(fs.readFileSync(backup, 'utf-8')).workOffline).toBe(true)
    expect(corruptFiles(profile)).toEqual([])
  } finally {
    await close(launched, profile)
  }
})

test('a config.json the app cannot read at all exits 1 and names the file', async () => {
  const profile = makeProfile({ prefix: 'anime-dl-config-eisdir-' })
  const configPath = path.join(profile.userData, 'config.json')
  try {
    fs.rmSync(configPath)
    fs.mkdirSync(configPath)

    const exited = await runAppToExit(profile)
    expect(exited.code).toBe(1)
    expect(exited.stderr).toContain(`Anime DL can't read its settings file (${configPath})`)
    expect(fs.statSync(configPath).isDirectory()).toBe(true)
  } finally {
    profile.cleanup()
  }
})
