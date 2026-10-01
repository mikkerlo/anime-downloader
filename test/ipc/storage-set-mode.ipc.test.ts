// Switching `storageMode` has to move `DownloadManager` with it (#443).
//
// The mode is an input to `getDownloadDir()`, and the manager holds its download
// root in a cached field written only by a handful of handlers. Persisting the
// mode through `set-setting` — which is what the Storage tab did — moved the
// effective root and left the manager where it was until the next restart, so
// every path it re-derives afterwards pointed into the root the user had just
// stopped using. `mkdirSync(…, { recursive: true })` then recreated that root
// rather than failing, putting new files somewhere the UI in the new mode never
// scans.
//
// Two decisions from the plan review are pinned below. The mode gets a channel
// of its own and the resolution lives in one helper that every root writer calls
// (`resyncDownloadDir`), rather than each writer pushing its own idea of the
// root; and a switch is **refused** while the manager still has root-bound work,
// rather than applied with each item's root pinned — pinning would change the
// persisted queue format.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { join } from 'path'
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register as registerStorage } from '../../src/main/ipc/storage.ipc'
import { register as registerDownloads } from '../../src/main/ipc/downloads.ipc'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import {
  DownloadManager,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'
import type { AppDeps } from '../../src/main/ipc/index'

interface Wiring {
  storageMode?: string
  downloadDir?: string
  hotStorageDir?: string
  coldStorageDir?: string
  /** Swap the stub manager for a real one (the end-to-end group). */
  downloadManager?: unknown
}

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: path.join('Anime', 'file.mp4'),
    animeName: 'Anime',
    episodeLabel: 'ep1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'Author',
    status: 'completed',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus }>
}

function seed(
  dm: DownloadManager,
  items: DownloadItem[],
  merges: [number, MergeStatus][] = []
): void {
  const internals = dm as unknown as Internals
  internals.queue = items
  internals.mergeStatuses.clear()
  for (const [tid, status] of merges) internals.mergeStatuses.set(tid, { status })
}

describe('storage IPC — set-mode (#443)', () => {
  let tmpRoot: string
  /** The simple-mode root. */
  let dlDir: string
  /** The advanced-mode (hot) root. */
  let hotDir: string
  let coldDir: string
  let fallbackDir: string
  let store: InMemoryStorage
  let setStoreValue: Mock
  let setDownloadDir: Mock
  let hasRootBoundWork: Mock
  let coldStorageService: ReturnType<typeof createColdStorageService>
  let invoke: (channel: string, ...args: unknown[]) => Promise<unknown>

  function wire(wiring: Wiring = {}): void {
    ;(ipcMain.handle as Mock).mockClear()

    store = new InMemoryStorage({
      storageMode: wiring.storageMode ?? 'simple',
      downloadDir: wiring.downloadDir ?? dlDir,
      hotStorageDir: wiring.hotStorageDir ?? '',
      coldStorageDir: wiring.coldStorageDir ?? '',
      autoMoveToCold: false
    })
    setStoreValue = vi.spyOn(store, 'set') as unknown as Mock

    coldStorageService = createColdStorageService({
      store,
      downloadsFallbackDir: fallbackDir,
      sanitizeFilename: (s) => s,
      parseEpisodeFromFilename: () => null,
      scanEpisodeFiles: () => ({}),
      invalidateFileCache: () => {},
      broadcast: () => {},
      usageProgressChannel: 'usage-progress',
      cleanupPendingChannel: 'cleanup-pending',
      cleanupFinishedChannel: 'cleanup-finished',
      fileEpisodesChangedChannel: 'file-episodes-changed'
    })

    const deps = {
      store,
      downloadManager: wiring.downloadManager ?? { setDownloadDir, hasRootBoundWork },
      coldStorageService,
      clearFileCache: () => {},
      broadcast: () => {}
    } as unknown as AppDeps

    registerStorage(deps)
    // The download-folder picker lives in the downloads router but writes a
    // root key, so it is part of the same contract.
    registerDownloads(deps)

    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    invoke = async (channel, ...args) => handlers.get(channel)!({}, ...args)
  }

  const setMode = (mode: string): Promise<StorageSetModeResult> =>
    invoke(CHANNELS.STORAGE_SET_MODE, mode) as Promise<StorageSetModeResult>

  /** Arm the folder-picker dialog to answer with `dir`. */
  function pickerReturns(dir: string): void {
    ;(BrowserWindow.getFocusedWindow as Mock).mockReturnValue({})
    ;(dialog.showOpenDialog as Mock).mockResolvedValue({ canceled: false, filePaths: [dir] })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'storage-set-mode-'))
    dlDir = join(tmpRoot, 'dl')
    hotDir = join(tmpRoot, 'hot')
    coldDir = join(tmpRoot, 'cold')
    fallbackDir = join(tmpRoot, 'downloads')
    for (const dir of [dlDir, hotDir, coldDir, fallbackDir]) fs.mkdirSync(dir, { recursive: true })
    setDownloadDir = vi.fn()
    hasRootBoundWork = vi.fn(() => false)
    wire()
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // The behaviour-difference group. On `main` the mode is persisted by
  // `set-setting`, which reaches `store.set` and nothing else, so every
  // `setDownloadDir` assertion below reds there.
  describe('re-points the download manager, which set-setting cannot', () => {
    it('simple → advanced follows getDownloadDir() to the hot root', async () => {
      wire({ storageMode: 'simple', downloadDir: dlDir, hotStorageDir: hotDir })

      const result = await setMode('advanced')

      expect(store.get('storageMode')).toBe('advanced')
      expect(setDownloadDir).toHaveBeenCalledTimes(1)
      expect(setDownloadDir).toHaveBeenCalledWith(hotDir)
      expect(result).toEqual({
        mode: 'advanced',
        refusedReason: null,
        roots: {
          downloadDir: dlDir,
          hotStorageDir: hotDir,
          coldStorageDir: '',
          autoMoveToCold: false,
          missingRoot: null
        }
      })
    })

    it('advanced → simple follows it back to downloadDir', async () => {
      wire({ storageMode: 'advanced', downloadDir: dlDir, hotStorageDir: hotDir })

      await setMode('simple')

      expect(store.get('storageMode')).toBe('simple')
      expect(setDownloadDir).toHaveBeenCalledWith(dlDir)
    })

    // The edge the review asked for by name. `getDownloadDir()` falls through
    // hot → downloadDir → fallback, so advanced mode with no hot dir picked
    // still resolves to `downloadDir`. A handler that read `hotStorageDir`
    // itself would hand the manager `''` and every path would become relative
    // to the process CWD.
    it('advanced with an empty hotStorageDir resolves to downloadDir, not the empty string', async () => {
      wire({ storageMode: 'simple', downloadDir: dlDir, hotStorageDir: '' })

      await setMode('advanced')

      expect(setDownloadDir).toHaveBeenCalledWith(dlDir)
      expect(setDownloadDir).not.toHaveBeenCalledWith('')
    })

    it('advanced with neither root set resolves to the downloads fallback', async () => {
      wire({ storageMode: 'simple', downloadDir: '', hotStorageDir: '' })

      await setMode('advanced')

      expect(setDownloadDir).toHaveBeenCalledWith(join(fallbackDir, 'anime-dl'))
    })
  })

  // Decision 2: block, don't pin. The states that matter are the ones that
  // outlive the switch and then re-derive a path from the manager's field.
  describe('refuses the switch while the manager has root-bound work', () => {
    it('refuses for a paused item, writing neither the store nor the manager', async () => {
      wire({ storageMode: 'simple', downloadDir: dlDir, hotStorageDir: hotDir })
      hasRootBoundWork.mockReturnValue(true)

      const result = await setMode('advanced')

      expect(result.refusedReason).toBeTruthy()
      // The mode reported back is the one still in force, so the renderer has
      // something unambiguous to adopt instead of its optimistic ref.
      expect(result.mode).toBe('simple')
      expect(store.get('storageMode')).toBe('simple')
      expect(setStoreValue).not.toHaveBeenCalled()
      expect(setDownloadDir).not.toHaveBeenCalled()
    })

    it('still reports the raw roots when it refuses, so the tab can re-adopt them', async () => {
      wire({ storageMode: 'simple', downloadDir: dlDir, hotStorageDir: hotDir })
      hasRootBoundWork.mockReturnValue(true)

      const result = await setMode('advanced')

      expect(result.roots.downloadDir).toBe(dlDir)
      expect(result.roots.hotStorageDir).toBe(hotDir)
    })

    it('does not consult the predicate for a no-op switch to the mode already in force', async () => {
      wire({ storageMode: 'advanced', downloadDir: dlDir, hotStorageDir: hotDir })
      hasRootBoundWork.mockReturnValue(true)

      const result = await setMode('advanced')

      // Nothing moves, so there is nothing to refuse — and the re-sync is
      // harmless (it resolves to the root the manager is already on).
      expect(result.refusedReason).toBeNull()
      expect(setDownloadDir).toHaveBeenCalledWith(hotDir)
    })

    it('ignores a mode that is neither simple nor advanced', async () => {
      wire({ storageMode: 'simple', downloadDir: dlDir })

      const result = await setMode('hybrid')

      expect(result.mode).toBe('simple')
      expect(setStoreValue).not.toHaveBeenCalled()
      expect(setDownloadDir).not.toHaveBeenCalled()
    })
  })

  // The predicate itself, against a real manager rather than the stub above.
  describe('DownloadManager.hasRootBoundWork()', () => {
    let userDataDir: string
    let dm: DownloadManager

    beforeEach(() => {
      userDataDir = fs.mkdtempSync(join(os.tmpdir(), 'storage-set-mode-ud-'))
      dm = new DownloadManager(dlDir, {} as never, userDataDir)
    })

    afterEach(() => {
      dm.destroy()
      fs.rmSync(userDataDir, { recursive: true, force: true })
    })

    it('is false for an empty queue', () => {
      expect(dm.hasRootBoundWork()).toBe(false)
    })

    it.each(['queued', 'downloading', 'paused', 'failed'] as const)(
      'is true for a %s item — it will re-derive its .part path after the switch',
      (status) => {
        seed(dm, [makeItem({ status })])
        expect(dm.hasRootBoundWork()).toBe(true)
      }
    )

    // A finished item only goes inert once its merge has *completed* — being
    // `completed` is not enough on its own (see the two cases below it).
    it('is false for items that are finished and merged, or gone', () => {
      seed(
        dm,
        [makeItem({ id: 'a', status: 'completed' }), makeItem({ id: 'b', status: 'cancelled' })],
        [[1, 'completed']]
      )
      expect(dm.hasRootBoundWork()).toBe(false)
    })

    // The hole the review found, and the state every finished episode sits in
    // with autoMerge off: no `mergeStatuses` entry at all. `getEpisodeGroups()`
    // defaults that to 'pending' and `_mergeAll` processes it, rebuilding the
    // video path from `this.downloadDir` — so the merge pass is still owed and
    // the item is still root-bound. The pre-fix predicate read this as inert.
    it('is true for a completed item with no merge entry — the merge pass is still owed', () => {
      seed(dm, [makeItem({ status: 'completed' })])
      expect(dm.hasRootBoundWork()).toBe(true)
    })

    // The other half of it. `_mergeAll` skips only 'completed', 'merging' and
    // 'deferred', so a 'failed' merge is retried on the very next pass and
    // re-derives the same path; 'failed' is not a settled state.
    it('is true for a completed item whose merge failed — _mergeAll retries it', () => {
      seed(dm, [makeItem({ status: 'completed' })], [[1, 'failed']])
      expect(dm.hasRootBoundWork()).toBe(true)
    })

    it.each(['pending', 'deferred', 'merging'] as const)(
      'is true for a %s merge — the merge pass looks the video up under the new root',
      (status) => {
        seed(dm, [makeItem({ status: 'completed' })], [[1, status]])
        expect(dm.hasRootBoundWork()).toBe(true)
      }
    )

    it('is false for a merge that is already settled', () => {
      seed(dm, [makeItem({ status: 'completed' })], [[1, 'completed']])
      expect(dm.hasRootBoundWork()).toBe(false)
    })

    // The boundary the widened rule keeps: `_mergeAll` iterates
    // `getEpisodeGroups()`, which is built from the queue, so a stray entry
    // with no item behind it has no path to re-derive.
    it('is false for a failed merge entry with no item left in the queue', () => {
      seed(dm, [], [[2, 'failed']])
      expect(dm.hasRootBoundWork()).toBe(false)
    })

    // The restart half of the same hazard: a paused item restored from
    // queue.json is root-bound before anything else runs.
    it('is true for work restored by loadQueue() after a restart', () => {
      fs.writeFileSync(
        join(userDataDir, 'queue.json'),
        JSON.stringify({
          queue: [makeItem({ status: 'downloading' })],
          mergeStatuses: {}
        }),
        'utf-8'
      )
      const restored = new DownloadManager(dlDir, {} as never, userDataDir)
      try {
        restored.loadQueue()
        expect(restored.hasRootBoundWork()).toBe(true)
      } finally {
        restored.destroy()
      }
    })
  })

  // Both folder pickers write a root key, and both used to push their own picked
  // path into the manager. That matched `getDownloadDir()` only because the tab
  // hides each picker outside its own mode.
  describe('the pickers re-sync through getDownloadDir(), not with the picked path', () => {
    it('picking a hot dir while the stored mode is simple leaves the manager on downloadDir', async () => {
      wire({ storageMode: 'simple', downloadDir: dlDir, hotStorageDir: '' })
      pickerReturns(hotDir)

      const picked = await invoke(CHANNELS.STORAGE_PICK_HOT_DIR)

      expect(picked).toBe(hotDir)
      expect(store.get('hotStorageDir')).toBe(hotDir)
      expect(setDownloadDir).toHaveBeenCalledWith(dlDir)
      expect(setDownloadDir).not.toHaveBeenCalledWith(hotDir)
    })

    it('picking a hot dir in advanced mode does move the manager onto it', async () => {
      wire({ storageMode: 'advanced', downloadDir: dlDir, hotStorageDir: '' })
      pickerReturns(hotDir)

      await invoke(CHANNELS.STORAGE_PICK_HOT_DIR)

      expect(setDownloadDir).toHaveBeenCalledWith(hotDir)
    })

    it('picking a download dir while the stored mode is advanced leaves the manager on the hot root', async () => {
      wire({ storageMode: 'advanced', downloadDir: '', hotStorageDir: hotDir })
      pickerReturns(dlDir)

      const picked = await invoke(CHANNELS.DOWNLOAD_PICK_DIR)

      expect(picked).toBe(dlDir)
      expect(store.get('downloadDir')).toBe(dlDir)
      expect(setDownloadDir).toHaveBeenCalledWith(hotDir)
      expect(setDownloadDir).not.toHaveBeenCalledWith(dlDir)
    })
  })

  // End to end, with the real manager wired to the real handler: what the user
  // sees is not the `setDownloadDir` call but where the files go.
  describe('with the real DownloadManager, work after a switch uses the new root', () => {
    let userDataDir: string
    let dm: DownloadManager
    const relPath = path.join('Anime', 'file.mp4')

    function putFile(root: string): string {
      const abs = join(root, relPath)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, 'bytes')
      return abs
    }

    beforeEach(() => {
      userDataDir = fs.mkdtempSync(join(os.tmpdir(), 'storage-set-mode-e2e-'))
      dm = new DownloadManager(dlDir, {} as never, userDataDir)
      wire({
        storageMode: 'simple',
        downloadDir: dlDir,
        hotStorageDir: hotDir,
        downloadManager: dm
      })
    })

    afterEach(() => {
      dm.destroy()
      fs.rmSync(userDataDir, { recursive: true, force: true })
    })

    // THE headline. `cancel` rebuilds its unlink paths from the manager's
    // cached root, so with the mode flipped it must delete the copy under hot
    // and leave the one under the root the app no longer uses. On `main` the
    // field never moves and this is exactly inverted.
    //
    // Note what this one cannot show, and why the test after it exists: the
    // seed puts a copy under *both* roots and marks the merge `completed`, so
    // the switch is legitimately allowed and the guard is never consulted. A
    // real disk has the file under one root only.
    it('deletes the file under the new root on cancel, and leaves the old root alone', async () => {
      const inDl = putFile(dlDir)
      const inHot = putFile(hotDir)
      seed(dm, [makeItem({ status: 'completed', filename: relPath })], [[1, 'completed']])

      const result = await setMode('advanced')
      expect(result.refusedReason).toBeNull()
      dm.cancel('video-1')

      expect(fs.existsSync(inHot)).toBe(false)
      expect(fs.existsSync(inDl)).toBe(true)
    })

    // The review's repro, in the shape the test above is blind to. The file
    // exists only under `dl/` — the real user's disk — and the item is
    // `completed` with no merge entry at all, which is where every episode
    // sits with autoMerge off. The switch has to be refused.
    //
    // Against the pre-fix predicate `hasRootBoundWork()` is false here: the
    // switch goes through, `mergeCompleted()` then leaves the status `null`
    // because its `existsSync` misses under `hot/` and `continue`s, and
    // `cancel` unlinks at `hot/` and leaves the real file behind.
    it('refuses the switch for a completed item that was never merged, with the file only under the old root', async () => {
      const inDl = putFile(dlDir)
      seed(dm, [makeItem({ status: 'completed', filename: relPath })])

      const result = await setMode('advanced')

      expect(result.refusedReason).toBeTruthy()
      expect(result.mode).toBe('simple')
      expect(store.get('storageMode')).toBe('simple')
      // The manager stayed on the root the file is actually under, so the
      // merge pass still finds it and `cancel` still reaches it.
      expect(dm.getActiveDownloadByPath(inDl)).not.toBeNull()
      expect(dm.getActiveDownloadByPath(join(hotDir, relPath))).toBeNull()
      dm.cancel('video-1')
      expect(fs.existsSync(inDl)).toBe(false)
    })

    // Same hazard reached through a merge that already ran and failed:
    // `_mergeAll` retries it, so it is still owed a path under the live root.
    it('refuses the switch for a failed merge, with the file only under the old root', async () => {
      const inDl = putFile(dlDir)
      seed(dm, [makeItem({ status: 'completed', filename: relPath })], [[1, 'failed']])

      const result = await setMode('advanced')

      expect(result.refusedReason).toBeTruthy()
      expect(store.get('storageMode')).toBe('simple')
      expect(dm.getActiveDownloadByPath(inDl)).not.toBeNull()
    })

    it('hands the player a .part path under the new root', async () => {
      seed(dm, [makeItem({ status: 'downloading', totalBytes: 10, filename: relPath })])
      expect(dm.getPartialVideoPath(1)?.partPath).toBe(join(dlDir, relPath) + '.part')

      // A `downloading` item is root-bound, so the switch has to be refused —
      // and the path must therefore stay on the old root.
      const refused = await setMode('advanced')
      expect(refused.refusedReason).toBeTruthy()
      expect(dm.getPartialVideoPath(1)?.partPath).toBe(join(dlDir, relPath) + '.part')

      // With the item finished *and merged* the switch goes through, and the
      // path follows. Finished alone is not enough — the merge pass would
      // still be owed a path under the old root.
      seed(
        dm,
        [makeItem({ status: 'completed', totalBytes: 10, filename: relPath })],
        [[1, 'completed']]
      )
      await setMode('advanced')

      expect(dm.getPartialVideoPath(1)?.partPath).toBe(join(hotDir, relPath) + '.part')
    })

    it('resolves a protocol-handler lookup against the new root', async () => {
      seed(dm, [makeItem({ status: 'completed', filename: relPath })], [[1, 'completed']])

      await setMode('advanced')

      expect(dm.getActiveDownloadByPath(join(hotDir, relPath))).not.toBeNull()
      expect(dm.getActiveDownloadByPath(join(dlDir, relPath))).toBeNull()
    })

    it('refuses the switch for a deferred merge, leaving the rename target put', async () => {
      seed(dm, [makeItem({ status: 'completed', filename: relPath })], [[1, 'deferred']])

      const result = await setMode('advanced')

      expect(result.refusedReason).toBeTruthy()
      expect(result.mode).toBe('simple')
      expect(store.get('storageMode')).toBe('simple')
      expect(dm.getActiveDownloadByPath(join(dlDir, relPath))).not.toBeNull()
    })
  })
})
