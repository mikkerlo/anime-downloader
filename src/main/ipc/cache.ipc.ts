import * as fs from 'fs'
import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

const ANIME_DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export function register({ animeCacheService, offlineService }: AppDeps): void {
  // Offline (#568) the TTL doesn't apply: an expired entry is the best there is.
  ipcMain.handle(CHANNELS.GET_ANIME_CACHE, (_event, id: number): AnimeCacheResult | null => {
    const entry = animeCacheService.getEntry(id)
    if (!entry?.animeDetail || !entry.cachedAt) return null
    const expired = Date.now() - entry.cachedAt > ANIME_DETAIL_CACHE_TTL_MS
    if (expired && !offlineService?.isOffline()) return null
    return { data: entry.animeDetail, cachedAt: entry.cachedAt, stale: expired }
  })

  ipcMain.handle(CHANNELS.CACHE_GET_POSTER, (_event, animeId: number) => {
    const posterPath = animeCacheService.getPosterCachePath(animeId)
    if (fs.existsSync(posterPath)) return `file://${posterPath}`
    return null
  })
}
