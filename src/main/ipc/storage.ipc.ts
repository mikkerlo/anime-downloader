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
  const ROOT_KEYS: readonly StorageRootKey[] = ['downloadDir', 'hotStorageDir', 'coldStorageDir']

  function rootsState(): StorageRootsState {
    return {
      downloadDir: (store.get('downloadDir') as string) || '',
      hotStorageDir: (store.get('hotStorageDir') as string) || '',
      coldStorageDir: (store.get('coldStorageDir') as string) || '',
      autoMoveToCold: !!store.get('autoMoveToCold'),
      missingRoot: coldStorageService.missingConfiguredRoot()
    }
  }

  ipcMain.handle(CHANNELS.STORAGE_GET_MISSING_ROOT, () => rootsState())

  /**
   * Clear one storage root (#440) — the only exit from the `missingConfiguredRoot()`
   * guard for a root that is gone for good rather than merely unplugged.
   *
   * Not expressible as `SET_SETTING(key, '')`, which is why this is a channel of
   * its own. `DownloadManager`'s download directory is a cached field written
   * only here and by the two folder pickers, and every path the manager builds
   * comes from it. After a bare store write the next download would still target
   * the root just cleared, and the manager's recursive `mkdirSync` would recreate
   * it wherever the parent survives (a dead `/media/<user>/<drive>/…` on Linux) —
   * putting new files somewhere the app no longer reads. So the clear re-syncs
   * the manager the same way the pickers do.
   *
   * Clearing is not metadata-neutral, and the renderer's confirm copy says so: a
   * root that was only unmounted still holds files, and the next GC pass drops
   * their `downloadedEpisodes` entries. That loss is exactly what the guard was
   * preventing, and clearing is the user opting back into it.
   */
  ipcMain.handle(CHANNELS.STORAGE_CLEAR_ROOT, (_event, key: StorageRootKey) => {
    if (!ROOT_KEYS.includes(key)) return rootsState()
    store.set(key, '')
    // A disabled switch that is still `true` would re-arm itself the moment a
    // new cold dir is picked. The mover already no-ops on an empty cold dir, so
    // this is about a coherent stored state, not about safety.
    if (key === 'coldStorageDir') store.set('autoMoveToCold', false)
    downloadManager.setDownloadDir(coldStorageService.getDownloadDir())
    return rootsState()
  })

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
