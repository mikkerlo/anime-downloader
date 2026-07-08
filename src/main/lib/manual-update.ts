// Manual-update helper for builds that cannot self-update (#189).
//
// The Windows portable exe has no installer for electron-updater to swap in,
// so its update flow compares the running version against the latest GitHub
// release and — when newer — points the user at the release page instead of
// driving the updater. Pure + fetch-injected so the version logic is unit
// testable; `app.ipc.ts` owns the wiring.

export const RELEASES_LATEST_API =
  'https://api.github.com/repos/mikkerlo/anime-downloader/releases/latest'
export const RELEASES_LATEST_PAGE = 'https://github.com/mikkerlo/anime-downloader/releases/latest'

/** Portable builds run from an unpack dir electron-builder exposes via this env var. */
export function isPortableBuild(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return platform === 'win32' && !!env.PORTABLE_EXECUTABLE_DIR
}

/**
 * Dotted numeric version compare (`v` prefix tolerated, missing segments are
 * 0, non-numeric segments compare as 0): true when `candidate` > `current`.
 * Pre-release tags compare as *newer* than their release (`4.3.0-beta.1` >
 * `4.3.0`) — harmless here because `releases/latest` never returns prereleases.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

export interface ManualUpdateCheck {
  status: 'available' | 'up-to-date'
  version?: string
  /** Release page to open in the browser instead of self-updating. */
  url: string
}

/** Compares the latest GitHub release tag against `currentVersion`. Throws on HTTP/network failure. */
export async function checkLatestRelease(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<ManualUpdateCheck> {
  const res = await fetchImpl(RELEASES_LATEST_API, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub release check failed: HTTP ${res.status}`)
  const body = (await res.json()) as { tag_name?: string; html_url?: string }
  const version = (body.tag_name ?? '').replace(/^v/, '')
  const url = body.html_url || RELEASES_LATEST_PAGE
  if (version && isNewerVersion(version, currentVersion)) {
    return { status: 'available', version, url }
  }
  return { status: 'up-to-date', url }
}
