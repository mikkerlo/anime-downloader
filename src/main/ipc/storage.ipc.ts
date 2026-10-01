import * as path from 'path'
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

/**
 * The raw root state every root-writing channel replies with.
 *
 * Module scope for the reason `resyncDownloadDir` is: `download:pick-dir` lives
 * in `downloads.ipc.ts` and now has to build the same reply (#447).
 */
export function storageRootsState({ store, coldStorageService }: AppDeps): StorageRootsState {
  return {
    downloadDir: (store.get('downloadDir') as string) || '',
    hotStorageDir: (store.get('hotStorageDir') as string) || '',
    coldStorageDir: (store.get('coldStorageDir') as string) || '',
    autoMoveToCold: !!store.get('autoMoveToCold'),
    missingRoot: coldStorageService.missingConfiguredRoot()
  }
}

/**
 * The reason a root move gives the renderer when it is refused. Prose, not a
 * code: the Storage tab shows it verbatim.
 *
 * It names one exit per blocking state, because no single control clears them
 * all (#447): **Clear done** (`clearCompleted()`) drops `failed`/`cancelled`
 * items and `completed` ones whose merge is absent, `completed` or `failed`,
 * but deliberately *keeps* `pending`/`deferred`/`merging` merges and never
 * touches `queued`/`downloading`/`paused`. Sending someone holding a paused
 * download to **Clear done** would be a dead end, so owed merges get pointed
 * at **Merge finished** and unfinished items at finish-or-cancel instead.
 *
 * `action` is the move the user asked for, as a gerund phrase — "switching
 * storage mode", "changing the download folder". Three channels share the
 * prose and no two of them are the same control, so the mode-specific wording
 * #443 shipped could not just be reused verbatim.
 */
export function rootBoundWorkReason(action: string): string {
  return (
    'Downloads are still in progress or waiting to merge — they would otherwise look for ' +
    'their files under the new folder and not find them. Finish or cancel anything ' +
    'downloading or paused, use "Merge finished" for episodes still waiting to merge, and ' +
    `"Clear done" for finished or failed ones, then try ${action} again.`
  )
}

/**
 * Should a picker refuse to write `key = dir`, and why (#447)?
 *
 * Called **after** the dialog returns and immediately before the write, which
 * is the only position that actually guarantees anything. A check taken before
 * `showOpenDialog` is a check against a queue the user can then leave stale for
 * as long as the native dialog stays open, and the auto-downloader enqueues on
 * a timer — so a `queued` item can appear between the check and the `store.set`
 * and the hazard is reachable with the guard apparently in place. There is no
 * pre-dialog check as well: it could only ever be advisory, and a second
 * message that sometimes disagrees with the authoritative one is worse than
 * one that is always right.
 *
 * The refusal runs only when the effective root would **actually move**. A
 * re-pick that resolves to the root the manager is already on changes nothing
 * for it, and refusing that would break the recovery #440 asks for by name:
 * the missing-root notice tells the user to "re-pick the folder to resume", and
 * an away drive is exactly the situation that leaves `paused`/`failed` items
 * bound to it, so an unconditional refusal would close the only door out.
 * Hence `path.resolve` on both sides rather than a string compare on `dir` —
 * what matters is where `getDownloadDir()` lands, not which key was written.
 */
export function rootMoveRefusal(
  deps: AppDeps,
  key: StorageRootKey,
  dir: string,
  action: string
): string | null {
  const { downloadManager, coldStorageService } = deps
  const before = path.resolve(coldStorageService.getDownloadDir())
  const after = path.resolve(coldStorageService.downloadDirWith(key, dir))
  if (before === after) return null
  return downloadManager.hasRootBoundWork() ? rootBoundWorkReason(action) : null
}

export function register(deps: AppDeps): void {
  const { store, downloadManager, coldStorageService, clearFileCache, broadcast } = deps
  const ROOT_KEYS: readonly StorageRootKey[] = ['downloadDir', 'hotStorageDir', 'coldStorageDir']
  const resync = (): void => resyncDownloadDir(deps)
  const rootsState = (): StorageRootsState => storageRootsState(deps)

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
      return {
        mode: current,
        refusedReason: rootBoundWorkReason('switching storage mode'),
        roots: rootsState()
      }
    }
    store.set('storageMode', mode)
    resync()
    return { mode, refusedReason: null, roots: rootsState() }
  })

  /**
   * Pick the hot-storage root (advanced mode's live download root).
   *
   * Refused by the same predicate as `storage:set-mode`, and for the same
   * hazard reached through a different control (#447): `hotStorageDir` is an
   * input to `getDownloadDir()`, so picking a new one moves the effective root
   * out from under every path the manager re-derives later. The check runs
   * after the dialog returns and before the write — see `rootMoveRefusal`,
   * which also explains why a re-pick that resolves to the same root is not
   * refused.
   */
  ipcMain.handle(CHANNELS.STORAGE_PICK_HOT_DIR, async (): Promise<StoragePickDirResult> => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { dir: null, refusedReason: null, roots: rootsState() }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select hot storage directory (active downloads)'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { dir: null, refusedReason: null, roots: rootsState() }
    }
    const dir = result.filePaths[0]
    const refusedReason = rootMoveRefusal(
      deps,
      'hotStorageDir',
      dir,
      'changing the hot storage folder'
    )
    if (refusedReason) return { dir: null, refusedReason, roots: rootsState() }
    store.set('hotStorageDir', dir)
    // Not `setDownloadDir(dir)`: in simple mode `getDownloadDir()` ignores
    // `hotStorageDir` entirely, and the manager has to follow the resolver.
    resync()
    return { dir, refusedReason: null, roots: rootsState() }
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
