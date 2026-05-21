import * as fs from 'fs'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import { sanitizeFilename } from '../download-manager'
import type { AppDeps } from './index'
import type { AnimeSearchResult } from '../smotret-api'

export function register({
  store,
  coldStorageService,
  animeCacheService,
  skipAnalysisService
}: AppDeps): void {
  ipcMain.handle(CHANNELS.DOWNLOADED_ANIME_ADD, (_event, anime: AnimeSearchResult) => {
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    downloaded[String(anime.id)] = anime
    store.set('downloadedAnime', downloaded)
  })

  ipcMain.handle(CHANNELS.DOWNLOADED_ANIME_DELETE, (_event, animeId: number, animeName: string) => {
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    delete downloaded[String(animeId)]
    store.set('downloadedAnime', downloaded)

    const dirName = sanitizeFilename(animeName)
    const dirsToCheck = [coldStorageService.getDownloadDir()]
    if (coldStorageService.isAdvanced()) {
      const coldDir = coldStorageService.getColdStorageDir()
      if (coldDir) dirsToCheck.push(coldDir)
    }
    for (const dir of dirsToCheck) {
      const dirPath = path.join(dir, dirName)
      try {
        fs.rmSync(dirPath, { recursive: true })
      } catch {
        /* ignore */
      }
    }

    animeCacheService.deleteEntry(animeId)
    skipAnalysisService.pruneCacheForAnime(animeId)
    skipAnalysisService.dropDetectionsForAnime(animeId)
  })
}
