// The escape hatch from #421's `missingConfiguredRoot()` guard (#440).
//
// The guard refuses to delete `downloadedEpisodes` metadata while any stored
// root is absent from disk, which is right for an unplugged drive and permanent
// for a folder the user deleted. Clearing the key is the exit, and the whole
// reason it is a channel rather than `set-setting(key, '')` is the first test
// below: `DownloadManager`'s download directory is a cached field written only
// by this handler and the two folder pickers, so a bare store write leaves the
// next download targeting the root that was just cleared — and the manager's
// recursive `mkdirSync` recreates it wherever the parent survives, putting new
// files somewhere the app no longer reads.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register } from '../../src/main/ipc/storage.ipc'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import type { AppDeps } from '../../src/main/ipc/index'

interface Wiring {
  storageMode?: string
  downloadDir?: string
  hotStorageDir?: string
  coldStorageDir?: string
  autoMoveToCold?: boolean
  downloadsFallbackDir?: string
}

describe('storage IPC — clear-root (#440)', () => {
  let tmpRoot: string
  let hotDir: string
  let coldDir: string
  /** A path under `tmpRoot` that is deliberately never created. */
  let awayDir: string
  let fallbackDir: string
  let store: InMemoryStorage
  let setDownloadDir: Mock
  let hasRootBoundWork: Mock
  let coldStorageService: ReturnType<typeof createColdStorageService>
  let invoke: (channel: string, ...args: unknown[]) => Promise<unknown>

  function wire(wiring: Wiring = {}): void {
    ;(ipcMain.handle as Mock).mockClear()

    store = new InMemoryStorage({
      storageMode: wiring.storageMode ?? 'simple',
      downloadDir: wiring.downloadDir ?? hotDir,
      hotStorageDir: wiring.hotStorageDir ?? '',
      coldStorageDir: wiring.coldStorageDir ?? '',
      autoMoveToCold: wiring.autoMoveToCold ?? false
    })

    coldStorageService = createColdStorageService({
      store,
      downloadsFallbackDir: wiring.downloadsFallbackDir ?? fallbackDir,
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

    register({
      store,
      downloadManager: { setDownloadDir, hasRootBoundWork },
      coldStorageService,
      clearFileCache: () => {},
      broadcast: () => {}
    } as unknown as AppDeps)

    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    invoke = async (channel, ...args) => handlers.get(channel)!({}, ...args)
  }

  const clear = (key: string): Promise<StorageRootsState> =>
    invoke(CHANNELS.STORAGE_CLEAR_ROOT, key) as Promise<StorageRootsState>

  const getState = (): Promise<StorageRootsState> =>
    invoke(CHANNELS.STORAGE_GET_MISSING_ROOT) as Promise<StorageRootsState>

  beforeEach(() => {
    vi.clearAllMocks()
    tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'storage-clear-root-'))
    hotDir = join(tmpRoot, 'hot')
    coldDir = join(tmpRoot, 'cold')
    awayDir = join(tmpRoot, 'away')
    fallbackDir = join(tmpRoot, 'downloads')
    for (const dir of [hotDir, coldDir, fallbackDir]) fs.mkdirSync(dir, { recursive: true })
    setDownloadDir = vi.fn()
    hasRootBoundWork = vi.fn(() => false)
    wire()
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // The behaviour-difference pair. `set-setting` only reaches `store.set`, so a
  // plan that cleared the key through it would leave `setDownloadDir`
  // un-called — and these two are what red.
  describe('re-syncs the download manager, which set-setting cannot', () => {
    it('clearing downloadDir re-points the manager at the fallback', async () => {
      wire({ storageMode: 'simple', downloadDir: hotDir })

      await clear('downloadDir')

      expect(store.get('downloadDir')).toBe('')
      expect(setDownloadDir).toHaveBeenCalledTimes(1)
      expect(setDownloadDir).toHaveBeenCalledWith(join(fallbackDir, 'anime-dl'))
    })

    it('clearing hotStorageDir in advanced mode re-points the manager at downloadDir', async () => {
      wire({ storageMode: 'advanced', hotStorageDir: hotDir, downloadDir: coldDir })

      await clear('hotStorageDir')

      expect(store.get('hotStorageDir')).toBe('')
      // `getDownloadDir()` falls through hot → downloadDir → fallback, so the
      // manager must follow it to `downloadDir`, not stay on the cleared root.
      expect(setDownloadDir).toHaveBeenCalledWith(coldDir)
    })

    it('clearing hotStorageDir with no downloadDir set falls through to the fallback', async () => {
      wire({ storageMode: 'advanced', hotStorageDir: hotDir, downloadDir: '' })

      await clear('hotStorageDir')

      expect(setDownloadDir).toHaveBeenCalledWith(join(fallbackDir, 'anime-dl'))
    })
  })

  it('clearing coldStorageDir also forces autoMoveToCold off', async () => {
    wire({
      storageMode: 'advanced',
      hotStorageDir: hotDir,
      coldStorageDir: coldDir,
      autoMoveToCold: true
    })

    const state = await clear('coldStorageDir')

    // Same handler, not a follow-up renderer write: a switch left disabled and
    // still `true` would re-arm the moment a new cold dir is picked.
    expect(store.get('coldStorageDir')).toBe('')
    expect(store.get('autoMoveToCold')).toBe(false)
    expect(state.autoMoveToCold).toBe(false)
  })

  it('leaves autoMoveToCold alone when a different root is cleared', async () => {
    wire({
      storageMode: 'advanced',
      hotStorageDir: hotDir,
      coldStorageDir: coldDir,
      autoMoveToCold: true
    })

    await clear('hotStorageDir')

    expect(store.get('autoMoveToCold')).toBe(true)
  })

  it('ignores a key that is not a storage root, touching neither store nor manager', async () => {
    wire({ storageMode: 'simple', downloadDir: hotDir })

    const state = await clear('token')

    expect(setDownloadDir).not.toHaveBeenCalled()
    expect(state.downloadDir).toBe(hotDir)
  })

  // The issue's headline symptom: with a root away the GC is off, and before
  // this channel there was no path through the UI that reached the `''` state.
  it('re-enables the downloadedEpisodes guard that the absent root had disabled', async () => {
    wire({ storageMode: 'simple', downloadDir: hotDir, coldStorageDir: awayDir })

    expect(coldStorageService.missingConfiguredRoot()).toBe(awayDir)
    const state = await clear('coldStorageDir')

    expect(state.missingRoot).toBeNull()
    expect(coldStorageService.missingConfiguredRoot()).toBeNull()
  })

  // The spec gap the plan review flagged: `get-setting` resolves `downloadDir`
  // through `getDownloadDir()`, so the renderer can never see `''` through it
  // and cannot tell an unset root from a set one. Both of this feature's
  // channels therefore carry the unresolved values.
  describe('reports the raw stored roots, not the resolved ones', () => {
    it('reports an unset downloadDir as the empty string, unlike get-setting', async () => {
      wire({ storageMode: 'advanced', downloadDir: '', hotStorageDir: hotDir })

      const state = await getState()

      expect(state.downloadDir).toBe('')
      expect(state.hotStorageDir).toBe(hotDir)
      // What the renderer would have got instead, and why the Clear control's
      // visibility could not be gated on it.
      expect(coldStorageService.getDownloadDir()).toBe(hotDir)
    })

    it('names the missing root and leaves the rest of the state readable', async () => {
      wire({ storageMode: 'simple', downloadDir: hotDir, coldStorageDir: awayDir })

      const state = await getState()

      expect(state).toEqual({
        downloadDir: hotDir,
        hotStorageDir: '',
        coldStorageDir: awayDir,
        autoMoveToCold: false,
        missingRoot: awayDir,
        // #451. The away root here is the cold one, which is not an input to
        // `getDownloadDir()` — so the effective root is present and the re-bind
        // action is not offered, even though `missingRoot` is non-null.
        effectiveRoot: hotDir,
        effectiveRootKey: 'downloadDir',
        effectiveRootMissing: false,
        rebindOffered: false
      })
    })

    it('is read-only — the getter clears nothing and never touches the manager', async () => {
      wire({ storageMode: 'advanced', hotStorageDir: hotDir, coldStorageDir: awayDir })

      await getState()

      expect(store.get('coldStorageDir')).toBe(awayDir)
      expect(setDownloadDir).not.toHaveBeenCalled()
    })
  })

  // #421 kept the destructive, mode-scoped `dirsForScan()` separate from the
  // read-only `allConfiguredRoots()` union on purpose, because `CLEANUP_EXECUTE`
  // feeds every `dirsForScan()` entry to a recursive `fs.rmSync`. A clear must
  // not add a root to that list.
  describe('does not widen the destructive scan list', () => {
    it('clearing coldStorageDir shrinks dirsForScan to the hot root', async () => {
      wire({ storageMode: 'advanced', hotStorageDir: hotDir, coldStorageDir: coldDir })
      expect(coldStorageService.dirsForScan()).toEqual([hotDir, coldDir])

      await clear('coldStorageDir')

      expect(coldStorageService.dirsForScan()).toEqual([hotDir])
    })

    it('clearing hotStorageDir in advanced mode moves the scan root without adding one', async () => {
      // `getDownloadDir()` falls through to `downloadDir`, so the one entry
      // changes identity. That is a move, not a widening — but `CLEANUP_EXECUTE`
      // follows it, so the count is what this pins.
      wire({
        storageMode: 'advanced',
        hotStorageDir: hotDir,
        downloadDir: coldDir,
        coldStorageDir: ''
      })
      expect(coldStorageService.dirsForScan()).toEqual([hotDir])

      await clear('hotStorageDir')

      expect(coldStorageService.dirsForScan()).toEqual([coldDir])
    })

    it('clearing downloadDir in simple mode leaves one root, the fallback', async () => {
      wire({ storageMode: 'simple', downloadDir: hotDir, coldStorageDir: coldDir })
      expect(coldStorageService.dirsForScan()).toEqual([hotDir])

      await clear('downloadDir')

      expect(coldStorageService.dirsForScan()).toEqual([join(fallbackDir, 'anime-dl')])
    })
  })

  // A pin against a future tidying pass, not a behaviour this PR adds (#447).
  //
  // #446 gave `storage:set-mode` a `hasRootBoundWork()` refusal and #447 gave
  // the two folder pickers the same one. All three write a root key and all
  // three call `resyncDownloadDir()`, so `storage:clear-root` looks like the
  // fourth member of a set that is missing its guard — and it must stay
  // unguarded. Clearing is the exit from the `missingConfiguredRoot()` trap,
  // and an away drive is exactly what leaves `paused`/`failed` items bound to
  // the root being cleared: the predicate is at its most likely to hold in the
  // one situation the hatch exists for. Guarding here would re-trap the user
  // with no way out at all.
  describe('stays unguarded while the manager has root-bound work', () => {
    it.each(['downloadDir', 'hotStorageDir', 'coldStorageDir'] as const)(
      'clearing %s still writes and still re-syncs',
      async (key) => {
        wire({
          storageMode: 'advanced',
          downloadDir: coldDir,
          hotStorageDir: awayDir,
          coldStorageDir: awayDir
        })
        hasRootBoundWork.mockReturnValue(true)

        const state = await clear(key)

        expect(store.get(key)).toBe('')
        expect(state[key]).toBe('')
        expect(setDownloadDir).toHaveBeenCalledTimes(1)
      }
    )

    it('reports no refusal of any kind — the reply shape has nowhere to put one', async () => {
      wire({ storageMode: 'simple', downloadDir: awayDir })
      hasRootBoundWork.mockReturnValue(true)

      const state = await clear('downloadDir')

      expect(state).not.toHaveProperty('refusedReason')
      expect(setDownloadDir).toHaveBeenCalledWith(join(fallbackDir, 'anime-dl'))
    })
  })
})
