import * as fs from 'fs'
import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'
import type { AnimeDetail, AnimeSearchResult } from '../smotret-api'

const ANIME_DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export function register({ store, animeCacheService }: AppDeps): void {
  ipcMain.handle(CHANNELS.GET_ANIME_CACHE, (_event, id: number) => {
    const entry = animeCacheService.getEntry(id)
    if (!entry?.animeDetail || !entry.cachedAt) return null
    if (Date.now() - entry.cachedAt > ANIME_DETAIL_CACHE_TTL_MS) return null
    return { data: entry.animeDetail, cachedAt: entry.cachedAt }
  })

  ipcMain.handle(CHANNELS.SET_ANIME_CACHE, (_event, id: number, data: AnimeDetail) => {
    const lib = store.get('library') as Record<string, AnimeSearchResult>
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const cachable = !!lib[String(id)] || !!downloaded[String(id)]
    if (!cachable) return false
    animeCacheService.updateAnimeDetail(id, data)
    return true
  })

  ipcMain.handle(CHANNELS.CACHE_GET_POSTER, (_event, animeId: number) => {
    const posterPath = animeCacheService.getPosterCachePath(animeId)
    if (fs.existsSync(posterPath)) return `file://${posterPath}`
    return null
  })
}
