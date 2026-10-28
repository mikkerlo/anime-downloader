const DAY_MS = 24 * 60 * 60 * 1000

export const RECENT_WATCH_WINDOW_MS = 90 * DAY_MS
export const RECENT_WATCH_TTL_MS = 10 * 60 * 1000

export interface RecentWatchIndexDeps {
  /** The whole `watchProgress` map, keyed `<animeId>:<episodeInt>`. */
  readWatchProgress: () => Record<string, { updatedAt: number }>
  now?: () => number
  windowMs?: number
  /** How long a built set is reused before the next lookup rebuilds it. */
  ttlMs?: number
}

export interface RecentWatchIndex {
  /** Whether the title has a `watchProgress` entry updated inside the window. */
  has(animeId: number): boolean
  /** A save just now: the title counts at once, without a re-read. */
  touch(animeId: number): void
}

/**
 * The titles watched in the last 90 days, for the anime-cache scope (#570).
 * `isCachableAnime` runs on hot paths and `store.get` clones the whole map, so
 * the set is built once and rebuilt lazily after `ttlMs`, which also ages
 * entries out of the window.
 */
export function createRecentWatchIndex(deps: RecentWatchIndexDeps): RecentWatchIndex {
  const now = deps.now ?? Date.now
  const windowMs = deps.windowMs ?? RECENT_WATCH_WINDOW_MS
  const ttlMs = deps.ttlMs ?? RECENT_WATCH_TTL_MS
  let ids: Set<number> | null = null
  let builtAt = 0

  function current(): Set<number> {
    const t = now()
    if (ids && t - builtAt < ttlMs) return ids
    const cutoff = t - windowMs
    const next = new Set<number>()
    for (const [key, entry] of Object.entries(deps.readWatchProgress())) {
      const colon = key.indexOf(':')
      if (colon <= 0 || !(entry?.updatedAt >= cutoff)) continue
      const id = Number(key.slice(0, colon))
      if (Number.isInteger(id) && id > 0) next.add(id)
    }
    ids = next
    builtAt = t
    return ids
  }

  return {
    has: (animeId) => current().has(animeId),
    touch: (animeId) => {
      current().add(animeId)
    }
  }
}
