// The one place an e2e run launches the app (#562); `test/e2e-launch-guard.test.ts`
// fails on `_electron` anywhere else under `e2e*/`.
//
// Playwright starts `out/main/index.js` as a bare script, so the app keeps
// Electron's default name and would read `<XDG_CONFIG_HOME>/Electron`, not the
// `anime-dl-app` dir that `npm run dev` and the packaged build use. Rather than
// guess the name, `launchApp()` passes `--user-data-dir=<root>/userData`, and
// `assertUserData()` checks the app really reads the dir `makeProfile()` seeded.
// The temp XDG variables stay set as well: `--user-data-dir` moves only
// `userData`, and PulseAudio, Mesa, fontconfig and NSS would otherwise write
// under `$HOME`.
//
// A seeded profile links ffmpeg + ffprobe from `PATH` and stubs fpcalc, so the
// first-launch binary download never starts; `assertNoDownloads()` fails if one
// did. `cold-start.spec.ts` opts out, because that download is what it tests.
// Seeding is POSIX-only (symlinks, a `/bin/false` stub, no `PATHEXT` lookup),
// so it throws on Windows; an unseeded profile like cold-start's runs anywhere.

import { _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_MAIN = path.resolve(__dirname, '..', '..', 'out', 'main', 'index.js')
const DOWNLOAD_LINE = /^\[(ffmpeg|fpcalc)\] Downloading/
const FPCALC_STUB = '/bin/false'

export interface ProfileOpts {
  /** Where the temp root is created (default `os.tmpdir()`). */
  parent?: string
  prefix?: string
  /** Merged over the muted defaults, `playerVolume: 0` / `playerMuted: true`. */
  config?: Record<string, unknown>
  /** `'path'` (default) links ffmpeg and ffprobe from `PATH`; the app downloads
   *  both unless both exist. `'none'` leaves the first-launch download on. */
  ffmpeg?: 'path' | 'none'
  /** `'stub'` (default) puts a placeholder fpcalc in place, which nothing in
   *  e2e runs; `'none'` leaves the first-launch download on. */
  fpcalc?: 'stub' | 'none'
}

export interface Profile {
  /** Canonical (realpath'd) temp root; everything the app writes is under it. */
  readonly root: string
  /** `<root>/userData`, which `--user-data-dir` hands the app. */
  readonly userData: string
  readonly env: Record<string, string>
  /** Each seeded binary link and the target it must still point at. */
  readonly links: readonly { path: string; target: string }[]
  cleanup(): void
}

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly profile: Profile
  /** `[ffmpeg]` / `[fpcalc]` `Downloading` lines seen on the main process. */
  readonly downloads: string[]
}

function findOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* next */
    }
  }
  return null
}

export function makeProfile(opts: ProfileOpts = {}): Profile {
  const seeds = (opts.ffmpeg ?? 'path') === 'path' || (opts.fpcalc ?? 'stub') === 'stub'
  if (seeds && process.platform === 'win32') {
    throw new Error(
      'e2e profile seeding is POSIX-only (symlinks, a /bin/false fpcalc stub, no PATHEXT lookup); ' +
        "on Windows only an unseeded profile ({ ffmpeg: 'none', fpcalc: 'none' }) is supported"
    )
  }
  // Electron resolves symlinks in `--user-data-dir` (macOS's /var is one), so
  // the root is canonicalised before any path is built from it.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(opts.parent ?? os.tmpdir(), opts.prefix ?? 'anime-dl-e2e-'))
  )
  const userData = path.join(root, 'userData')
  const env = {
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache')
  }
  for (const dir of [userData, ...Object.values(env)]) fs.mkdirSync(dir)
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ playerVolume: 0, playerMuted: true, ...opts.config }),
    { mode: 0o600 }
  )

  const links: { path: string; target: string }[] = []
  const link = (dir: string, name: string, target: string): void => {
    fs.mkdirSync(path.join(userData, dir), { recursive: true })
    const p = path.join(userData, dir, name)
    fs.symlinkSync(target, p)
    links.push({ path: p, target })
  }
  if ((opts.ffmpeg ?? 'path') === 'path') {
    const ffmpeg = findOnPath('ffmpeg')
    const ffprobe = findOnPath('ffprobe')
    if (!ffmpeg || !ffprobe) {
      fs.rmSync(root, { recursive: true, force: true })
      throw new Error(
        'e2e profiles link ffmpeg and ffprobe from PATH (apt-get install ffmpeg); ' +
          `found ffmpeg=${ffmpeg}, ffprobe=${ffprobe}`
      )
    }
    link('ffmpeg', 'ffmpeg', ffmpeg)
    link('ffmpeg', 'ffprobe', ffprobe)
  }
  if ((opts.fpcalc ?? 'stub') === 'stub') link('fpcalc', 'fpcalc', FPCALC_STUB)

  return {
    root,
    userData,
    env,
    links,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Launches the built app on `profile`, muted, with the download watcher on. */
export async function launchApp(
  profile: Profile,
  opts: { args?: string[]; env?: Record<string, string> } = {}
): Promise<LaunchedApp> {
  const args = ['--mute-audio', `--user-data-dir=${profile.userData}`, ...(opts.args ?? [])]
  // GitHub runners can't use the Electron SUID sandbox under xvfb.
  if (process.env.CI && !args.includes('--no-sandbox')) args.unshift('--no-sandbox')
  const app = await electron.launch({
    args: [...args, APP_MAIN],
    env: { ...process.env, ...profile.env, ...opts.env } as Record<string, string>
  })
  // Playwright reads the child's stdout from spawn time and drops it, so a line
  // printed before this listener attaches is lost; the symlink check in
  // `assertNoDownloads()` is the deterministic half.
  const downloads: string[] = []
  const watch = (buf: Buffer): void => {
    for (const line of String(buf).split('\n'))
      if (DOWNLOAD_LINE.test(line)) downloads.push(line.trim())
  }
  app.process().stdout?.on('data', watch)
  app.process().stderr?.on('data', watch)
  return { app, profile, downloads }
}

/** Fails unless the app's `userData` is exactly the dir the profile seeded. */
export async function assertUserData(app: ElectronApplication, profile: Profile): Promise<void> {
  const got = await app.evaluate(({ app }) => app.getPath('userData'))
  if (got !== profile.userData) {
    throw new Error(
      `userData is ${got}, but the profile was seeded at ${profile.userData}: the seed would be ignored`
    )
  }
}

/** Fails if a first-launch binary download started: either the watcher saw it,
 *  or a seeded link is no longer the link it was seeded as. */
export function assertNoDownloads({ downloads, profile }: LaunchedApp): void {
  if (downloads.length) throw new Error(`first-launch download started: ${downloads.join(' | ')}`)
  for (const l of profile.links) {
    let target: string | null = null
    try {
      target = fs.readlinkSync(l.path)
    } catch {
      /* gone, or no longer a link */
    }
    if (target !== l.target) {
      throw new Error(`${l.path} is no longer the seeded link to ${l.target}: the app replaced it`)
    }
  }
}
