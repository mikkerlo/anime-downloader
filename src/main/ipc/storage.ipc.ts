import { ipcMain, dialog, BrowserWindow } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({
  store,
  downloadManager,
  coldStorageService,
  clearFileCache,
  broadcast
}: AppDeps): void {
  ipcMain.handle(CHANNELS.STORAGE_PICK_HOT_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select hot storage directory (active downloads)'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    store.set('hotStorageDir', dir)
    downloadManager.setDownloadDir(dir)
    return dir
  })

  ipcMain.handle(CHANNELS.STORAGE_PICK_COLD_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select cold storage directory (finished files)'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    store.set('coldStorageDir', dir)
    return dir
  })

  ipcMain.handle(CHANNELS.STORAGE_MOVE_TO_COLD, async () => {
    clearFileCache()
    const result = await coldStorageService.moveAllFilesToColdStorage((current, total, file) => {
      broadcast(EVENT_CHANNELS.STORAGE_MOVE_TO_COLD_PROGRESS, { current, total, file })
    })
    return result
  })

  ipcMain.handle(CHANNELS.STORAGE_GET_USAGE, async () => {
    return coldStorageService.scanUsage()
  })

  ipcMain.handle(CHANNELS.STORAGE_RUN_CLEANUP, async (_event, opts?: { force?: boolean }) => {
    return coldStorageService.runWatchedCleanup(!!opts?.force)
  })
}
