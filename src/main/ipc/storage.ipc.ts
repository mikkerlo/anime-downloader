import { ipcMain, dialog, BrowserWindow } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

/**
 * Re-point `DownloadManager` at the root `getDownloadDir()` now resolves to.
 *
 * The single place the mode→root resolution is allowed to happen (#443). The
 * manager keeps its download directory in a cached field, so every writer of a
 * root-affecting key has to follow it here: `storage:set-mode`,
 * `storage:clear-root`, and both folder pickers (`storage:pick-hot-dir` and
 * `download:pick-dir`, which lives in `downloads.ipc.ts` and imports this).
 *
 * The pickers used to push their raw picked directory straight into the manager.
 * That agreed with `getDownloadDir()` only because the Storage tab hides each
 * picker outside its own mode — picking a hot dir with `storageMode` still
 * `simple` would have moved the manager somewhere the scanner never looks.
 * Routing them through the resolver instead makes the agreement structural.
 */
export function resyncDownloadDir({ downloadManager, coldStorageService }: AppDeps): void {
  downloadManager.setDownloadDir(coldStorageService.getDownloadDir())
}

export function register(deps: AppDeps): void {
  const { store, downloadManager, coldStorageService, clearFileCache, broadcast } = deps
  const ROOT_KEYS: readonly StorageRootKey[] = ['downloadDir', 'hotStorageDir', 'coldStorageDir']
  const resync = (): void => resyncDownloadDir(deps)

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
    resync()
    return rootsState()
  })

  /**
   * The reason `storage:set-mode` gives the renderer when it refuses. Prose,
   * not a code: the Storage tab shows it verbatim.
   */
  const ROOT_BOUND_REASON =
    'Downloads are still in progress or waiting to merge. ' +
    'Finish or cancel them before switching storage mode — they would otherwise ' +
    'look for their files under the new folder and not find them.'

  /**
   * Write `storageMode` and re-sync the download manager with it (#443).
   *
   * A channel of its own rather than `SET_SETTING('storageMode', …)`, for the
   * reason `storage:clear-root` is one: the mode is an input to
   * `getDownloadDir()`, so writing it moves the *effective* root while the
   * manager's cached field stays where it was. Until the next restart — which
   * re-reads the root at construction — the manager keeps resolving paths under
   * the root the user just stopped using, and `mkdirSync(…, { recursive: true })`
   * recreates it rather than failing, so new files land where the UI in the new
   * mode never scans.
   *
   * The switch is **refused**, not applied-and-patched, while
   * `hasRootBoundWork()` holds. Blocking rather than pinning a root per item is
   * #443's decision: the alternative changes `DownloadItem` and the persisted
   * queue format. Refusing writes nothing — not the store, not the manager —
   * and reports the mode still in force, so the renderer has something
   * unambiguous to adopt.
   */
  ipcMain.handle(CHANNELS.STORAGE_SET_MODE, (_event, mode: StorageMode): StorageSetModeResult => {
    const current = ((store.get('storageMode') as StorageMode) || 'simple') as StorageMode
    if (mode !== 'simple' && mode !== 'advanced') {
      return { mode: current, refusedReason: null, roots: rootsState() }
    }
    if (mode !== current && downloadManager.hasRootBoundWork()) {
      return { mode: current, refusedReason: ROOT_BOUND_REASON, roots: rootsState() }
    }
    store.set('storageMode', mode)
    resync()
    return { mode, refusedReason: null, roots: rootsState() }
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
    // Not `setDownloadDir(dir)`: in simple mode `getDownloadDir()` ignores
    // `hotStorageDir` entirely, and the manager has to follow the resolver.
    resync()
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
