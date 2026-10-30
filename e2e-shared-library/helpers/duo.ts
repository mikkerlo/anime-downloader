// Two built app instances, "PC A" and "PC B", sharing one Shared Library on a
// temp "drive" (#587). The launch follows the Syncplay rig (`e2e-syncplay/
// helpers/duo.ts`): each instance gets its own profile from
// `e2e/helpers/profile.ts` (#562), muted (`playerVolume: 0` / `playerMuted:
// true` and `--mute-audio`), unthrottled in the background, and the whole run
// is expected under `xvfb-run -a` (`npm run test:e2e:shared-library`), so no
// window takes focus. `userData` is asserted right after launch, and no
// first-launch binary download may start. Teardown is by recorded pid.
//
// A drive is a folder: `plug()` / `unplug()` rename it in and out of a mount
// parent the instance watches through `ANIME_DL_MOUNT_PARENTS`, and
// `pollNow()` asks its poller for a tick (a window-focus event) instead of
// waiting 10 s.

import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp,
  type Profile
} from '../../e2e/helpers/profile'
import { readLibrary } from '../../src/main/lib/shared-library/read'

export interface Instance {
  readonly name: string
  readonly app: ElectronApplication
  readonly page: Page
  readonly profile: Profile
  readonly pid: number | undefined
  /** The main process's last sync and error lines. */
  readonly log: string[]
  /** The persisted electron-store (`config.json`), read fresh. */
  config(): Record<string, unknown>
  /** Asks the availability poller for a tick (#581). */
  pollNow(): Promise<void>
  /** Resolves once no S9 (#584) run is in flight (`sync:get-status`). */
  syncIdle(): Promise<void>
  close(): Promise<void>
}

export function seedProfile(
  parent: string,
  name: string,
  config: Record<string, unknown>
): Profile {
  return makeProfile({
    parent,
    prefix: `pc-${name}-`,
    // Never a real next-episode fetch, whatever the playback does.
    config: { playerMode: 'builtin', prefetchNextEpisode: 'off', ...config }
  })
}

export async function launchInstance(
  name: string,
  profile: Profile,
  env: Record<string, string>
): Promise<Instance> {
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile, {
      args: [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'
      ],
      env
    })
    await assertUserData(launched.app, profile)
  } catch (e) {
    await launched?.app.close().catch(() => {})
    throw e
  }
  const { app } = launched
  const pid = app.process().pid
  // The main process's sync lines, for a failure message.
  const log: string[] = []
  const onMain = (buf: Buffer): void => {
    for (const line of String(buf).split('\n')) {
      if (/^\[sync\]|^\[shared-library\]|^\[attached-library\]|rror/.test(line)) {
        log.push(line.trim().slice(0, 400))
        if (log.length > 200) log.shift()
      }
    }
  }
  app.process().stdout?.on('data', onMain)
  app.process().stderr?.on('data', onMain)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const configPath = path.join(profile.userData, 'config.json')
  let closed = false
  return {
    name,
    app,
    page,
    profile,
    pid,
    log,
    config: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
    pollNow: () =>
      app.evaluate(({ app: electronApp }) => {
        electronApp.emit('browser-window-focus')
      }),
    syncIdle: () =>
      expect
        .poll(() => page.evaluate(async () => (await window.api.syncGetStatus()).running), {
          timeout: 30_000
        })
        .toEqual([]),
    close: async () => {
      if (closed) return
      closed = true
      try {
        assertNoDownloads(launched!)
      } finally {
        await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000))])
        if (pid) {
          try {
            process.kill(pid, 0)
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    }
  }
}

/** Clicks a sidebar entry. */
export async function nav(page: Page, name: string): Promise<void> {
  await page.locator('.sidebar').getByRole('button', { name, exact: true }).click()
}

/** Library → Shared Libraries. */
export async function sharedTab(page: Page): Promise<void> {
  await nav(page, 'Library')
  // A title's page opened from the tab stays open under the Library entry.
  const back = page.locator('.detail-view').getByRole('button', { name: 'Back', exact: true })
  if (await back.isVisible()) await back.click()
  // A PC whose only titles are on a drive may already be on the tab, with no pill row.
  if (await page.getByTestId('shared-libraries-tab').isVisible()) return
  await page.locator('.library-view .pill-tab', { hasText: 'Shared Libraries' }).click()
  await expect(page.getByTestId('shared-libraries-tab')).toBeVisible()
}

/** Makes the next folder picker in main return `dir`. */
export async function pickNext(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as never
  }, dir)
}

/** The drive's state `generation`, through S5's reader. */
export async function stateGeneration(root: string): Promise<number> {
  const read = await readLibrary(root)
  if (read.status !== 'ok' || !read.state) throw new Error(`no state at ${root}: ${read.status}`)
  return read.state.generation
}

/** The drive's `SyncDoc`, through S5's reader. */
export async function stateDoc(root: string): Promise<SyncDoc> {
  const read = await readLibrary(root)
  if (read.status !== 'ok' || !read.state) throw new Error(`no state at ${root}: ${read.status}`)
  return read.state.doc as unknown as SyncDoc
}

/**
 * A tiny H.264 clip of `seconds`, long enough for the player's watched rule
 * (80% of the duration and 180 s of playback) to be reachable with the
 * renderer clock sped up (`speedUpClock`). `e2e/fixtures/test-pattern.mp4` is
 * 1 s long, so it can't be watched to completion.
 */
export function makeClip(file: string, seconds: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const r = spawnSync(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=5'],
      ...['-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast'],
      ...['-g', '5', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]
    ],
    { encoding: 'utf-8' }
  )
  if (r.status !== 0) throw new Error(`ffmpeg failed to build ${file}: ${r.stderr}`)
}

/**
 * Runs the renderer's `Date.now()` `factor` times faster until `restore` is
 * called. The player counts playback with `Date.now()` deltas between
 * `timeupdate`s and ignores any delta of 2 s or more (`PlayerView.vue`
 * `trackProgressDelta`), so `factor` stays small enough that a 250 ms
 * `timeupdate` gap still counts. Main's clock, which stamps every field clock,
 * is untouched.
 */
export async function speedUpClock(
  page: Page,
  factor: number
): Promise<{ restore(): Promise<void> }> {
  await page.evaluate((k) => {
    const w = window as unknown as { __realNow?: () => number }
    const real = w.__realNow ?? Date.now.bind(Date)
    w.__realNow = real
    const t0 = real()
    Date.now = () => t0 + (real() - t0) * k
  }, factor)
  return {
    restore: () =>
      page.evaluate(() => {
        const w = window as unknown as { __realNow?: () => number }
        if (w.__realNow) Date.now = w.__realNow
      })
  }
}

/** Every file under `dir`. */
export function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? filesUnder(p) : [p]
  })
}
