import type { StorageService } from '../../store/types'
import { createRecentWatchIndex, type RecentWatchIndex } from '../../lib/recent-watch'

export interface CacheScope {
  recentWatch: RecentWatchIndex
  /** Starred, downloaded, or watched in the last 90 days (#570). */
  isCachable(animeId: number): boolean
}

/**
 * The one anime-cache scope: cache writes, `cleanupStale`, and every eviction
 * site ask it. Sub-key reads, because it runs per cache write and per entry in
 * `cleanupStale`, and a whole-map read would clone the library each time.
 */
export function createCacheScope(store: StorageService, now?: () => number): CacheScope {
  const recentWatch = createRecentWatchIndex({
    readWatchProgress: () => store.get('watchProgress') as Record<string, WatchProgressEntry>,
    now
  })
  return {
    recentWatch,
    isCachable: (animeId) =>
      !!store.get(`downloadedAnime.${animeId}`) ||
      !!store.get(`library.${animeId}`) ||
      recentWatch.has(animeId)
  }
}
