import * as fs from 'fs'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import { sanitizeFilename } from '../download-manager'
import type { AppDeps } from './index'
import type { AnimeSearchResult } from '../smotret-api'

export function register({
  store,
  downloadManager,
  coldStorageService,
  animeCacheService,
  skipAnalysisService,
  sumShowFiles,
  invalidateFileCache,
  getDisplayName
}: AppDeps): void {
  ipcMain.handle(CHANNELS.CLEANUP_GET_SIZE, async (_event, _animeId: number, animeName: string) => {
    return await sumShowFiles(animeName)
  })

  ipcMain.handle(CHANNELS.CLEANUP_GET_ACTIVE_DOWNLOADS, (_event, animeName: string) => {
    const groups = downloadManager.getEpisodeGroups()
    const active = groups.filter((g) => g.animeName === animeName).length
    return { active }
  })

  ipcMain.handle(CHANNELS.CLEANUP_EXECUTE, (_event, animeId: number, animeName: string) => {
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    delete downloaded[String(animeId)]
    store.set('downloadedAnime', downloaded)

    const dirName = sanitizeFilename(animeName)
    for (const dir of coldStorageService.dirsForScan()) {
      const dirPath = path.join(dir, dirName)
      try {
        fs.rmSync(dirPath, { recursive: true })
      } catch {
        /* ignore */
      }
    }

    const episodes = store.get('downloadedEpisodes') as Record<
      string,
      { translationType: string; author: string; quality: number; translationId: number }
    >
    const prefix = `${animeId}:`
    let mutated = false
    for (const key of Object.keys(episodes)) {
      if (key.startsWith(prefix)) {
        delete episodes[key]
        mutated = true
      }
    }
    if (mutated) store.set('downloadedEpisodes', episodes)

    invalidateFileCache(animeName)
    animeCacheService.deleteEntry(animeId)
    skipAnalysisService.pruneCacheForAnime(animeId)
    skipAnalysisService.dropDetectionsForAnime(animeId)
  })

  ipcMain.handle(CHANNELS.CLEANUP_GET_SNOOZED, () => {
    const snoozed = store.get('autoCleanupSnoozedAnimeIds') as Record<string, true>
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const lib = store.get('library') as Record<string, AnimeSearchResult>
    const recent = store.get('recentAnimeMeta') as Record<string, AnimeSearchResult>
    const out: Record<string, { animeName: string }> = {}
    for (const id of Object.keys(snoozed)) {
      const entry = downloaded[id] || lib[id] || recent[id]
      out[id] = { animeName: entry ? getDisplayName(entry) : `Anime ${id}` }
    }
    return out
  })

  ipcMain.handle(CHANNELS.CLEANUP_SET_SNOOZED, (_event, animeId: number, snoozed: boolean) => {
    const map = store.get('autoCleanupSnoozedAnimeIds') as Record<string, true>
    const key = String(animeId)
    if (snoozed) {
      map[key] = true
    } else {
      delete map[key]
    }
    store.set('autoCleanupSnoozedAnimeIds', map)
  })
}
