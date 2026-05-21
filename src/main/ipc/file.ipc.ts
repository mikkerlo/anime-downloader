import { ipcMain, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({
  coldStorageService,
  skipAnalysisService,
  checkEpisodeFiles,
  invalidateFileCacheByDirName
}: AppDeps): void {
  ipcMain.handle(
    CHANNELS.FILE_CHECK_EPISODES,
    (_event, animeName: string, episodeInts: string[]) => {
      return checkEpisodeFiles(animeName, episodeInts)
    }
  )

  ipcMain.handle(CHANNELS.FILE_OPEN, async (_event, filePath: string) => {
    if (!fs.existsSync(filePath)) {
      invalidateFileCacheByDirName(path.basename(path.dirname(filePath)))
      return 'File not found'
    }
    return shell.openPath(filePath)
  })

  ipcMain.handle(CHANNELS.FILE_SHOW_IN_FOLDER, (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle(
    CHANNELS.FILE_DELETE_EPISODE,
    (_event, animeName: string, episodeInt: string, animeId?: number, translationId?: number) => {
      coldStorageService.deleteEpisodeFiles(animeName, episodeInt, animeId, translationId)
      if (animeId && animeId > 0) {
        skipAnalysisService.pruneCacheForEpisode(animeId, episodeInt)
        skipAnalysisService.dropDetectionsForEpisode(animeId, episodeInt)
      }
    }
  )
}
