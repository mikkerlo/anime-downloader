// `storage:rebind-root` — the validated root move a relocated drive needs
// (#451).
//
// #440's missing-root notice promises "re-pick the folder to resume". #449 keeps
// that promise only for a drive that returns at the **same** path:
// `rootMoveRefusal()` exempts a re-pick that resolves to the root already in
// force and refuses every other move while `hasRootBoundWork()` holds — which is
// exactly what an away drive leaves behind. A drive that comes back as
// `/media/user/DISK1_` is a genuine move, so it is refused, and the only exits
// are to cancel the stranded work or to clear the root. Neither is "resume".
//
// This channel is the path *through* that guard rather than a relaxation of it:
// the pickers keep refusing unvalidated moves, and this one writes only after
// proving the files are actually under the candidate root
// (`verifyRootBoundFilesUnder`, whose per-state table is pinned in
// `test/services/download-manager-root-rebind.test.ts`).
//
// Four decisions from the plan review and its follow-up are pinned here.
//
//   - **Shape (1)**: a validated root move, not the per-item root #443 declined.
//     So there is nothing to "re-bind" per item and `queue.json` does not
//     change: the write is `store.set(<effective root key>, dir)` followed by
//     `resyncDownloadDir()`, and on the next start the root comes back through
//     the store. The last group below is what that claim actually means — a
//     *fresh* manager built from the resolver resolving work under the new root.
//   - **All-or-nothing**: any unmatched file refuses the whole move and writes
//     nothing. "Re-bind the matched ones" is not representable with one root for
//     the whole queue.
//   - **Busy refuses**: anything `downloading` or `merging` holds paths in
//     locals under the old root, and `mkdirSync(…, { recursive: true })` can
//     recreate a dead mount path, so a live write may be landing somewhere that
//     is neither root. Checked after the dialog returns and before the write,
//     for the reason `rootMoveRefusal` gives.
//   - **The effective root, tested directly.** The review first said "offer it
//     only when `missingRootKey` is the effective-root key" and then corrected
//     itself: there is no key in the reply, `StorageRootsState.missingRoot` is a
//     path, and `missingConfiguredRoot()` returns the *first* missing stored
//     root — so in advanced mode with a stale `downloadDir` and a missing
//     `hotStorageDir` it answers `downloadDir`, and a comparison against it
//     would never offer the action for the one case it exists for. The reply
//     carries `effectiveRootMissing` (`!fs.existsSync(getDownloadDir())`) and
//     `effectiveRootKey` instead, derived from the same rule
//     `resolveDownloadDir` uses, so the renderer re-derives nothing.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { join } from 'path'
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register as registerStorage } from '../../src/main/ipc/storage.ipc'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import {
  DownloadManager,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'
import type { AppDeps } from '../../src/main/ipc/index'

const ANIME_DIR = 'Anime'
const VIDEO = path.join(ANIME_DIR, 'Anime - 01 [X].mp4')
const SUBTITLE = path.join(ANIME_DIR, 'Anime - 01 [X].ass')
const MKV = path.join(ANIME_DIR, 'Anime - 01 [X].mkv')

const FFMPEG = '/fake/ffmpeg'
const FFPROBE = '/fake/ffprobe'

interface Wiring {
  storageMode?: string
  downloadDir?: string
  hotStorageDir?: string
  coldStorageDir?: string
}

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  runFfmpeg: (opts: { videoPath: string; outputPath: string }) => Promise<void>
}

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: VIDEO,
    animeName: 'Anime',
    episodeLabel: '1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'X',
    status: 'paused',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

describe('storage IPC — rebind-root (#451)', () => {
  let tmpRoot: string
  /** The root the drive used to be mounted at — deleted, so it is "away". */
  let awayDir: string
  /** The path the same drive came back at. */
  let newDir: string
  /** A second live root, for the advanced-mode cases. */
  let hotDir: string
  let fallbackDir: string
  let userDataDir: string
  let store: InMemoryStorage
  let setStoreValue: Mock
  let dm: DownloadManager
  let setDownloadDir: Mock
  let coldStorageService: ReturnType<typeof createColdStorageService>
  let invoke: (channel: string, ...args: unknown[]) => Promise<unknown>

  function wire(wiring: Wiring = {}): void {
    ;(ipcMain.handle as Mock).mockClear()

    store = new InMemoryStorage({
      storageMode: wiring.storageMode ?? 'simple',
      downloadDir: wiring.downloadDir ?? awayDir,
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

    // The real manager throughout: the validation is the feature, and a stub
    // predicate would assert the handler against a fixture of itself.
    dm = new DownloadManager(coldStorageService.getDownloadDir(), {} as never, userDataDir)
    setDownloadDir = vi.spyOn(dm, 'setDownloadDir') as unknown as Mock

    const deps = {
      store,
      downloadManager: dm,
      coldStorageService,
      clearFileCache: () => {},
      broadcast: () => {}
    } as unknown as AppDeps

    registerStorage(deps)

    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    invoke = async (channel, ...args) => handlers.get(channel)!({}, ...args)
  }

  const rebind = (): Promise<StorageRebindRootResult> =>
    invoke(CHANNELS.STORAGE_REBIND_ROOT) as Promise<StorageRebindRootResult>

  const rootsState = (): Promise<StorageRootsState> =>
    invoke(CHANNELS.STORAGE_GET_MISSING_ROOT) as Promise<StorageRootsState>

  function seed(items: DownloadItem[], merges: [number, MergeStatus][] = []): void {
    const internals = dm as unknown as Internals
    internals.queue = items
    internals.mergeStatuses.clear()
    for (const [tid, status] of merges) internals.mergeStatuses.set(tid, { status })
  }

  /** Arm the folder dialog to answer with `dir`. */
  function pickerReturns(dir: string): void {
    ;(BrowserWindow.getFocusedWindow as Mock).mockReturnValue({})
    ;(dialog.showOpenDialog as Mock).mockResolvedValue({ canceled: false, filePaths: [dir] })
  }

  function put(root: string, rel: string, bytes = 5): string {
    const abs = join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, Buffer.alloc(bytes, 1))
    return abs
  }

  const names = (reports: RootBoundFileReport[]): string[] => reports.map((r) => r.filename)

  beforeEach(() => {
    vi.clearAllMocks()
    tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'storage-rebind-'))
    awayDir = join(tmpRoot, 'media', 'DISK1')
    newDir = join(tmpRoot, 'media', 'DISK1_')
    hotDir = join(tmpRoot, 'hot')
    fallbackDir = join(tmpRoot, 'downloads')
    userDataDir = join(tmpRoot, 'userdata')
    // `awayDir` is deliberately never created: that is what "the drive is gone"
    // means to `missingConfiguredRoot()` and to `existsSync(getDownloadDir())`.
    for (const dir of [newDir, hotDir, fallbackDir, userDataDir]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    wire()
  })

  afterEach(() => {
    dm.destroy()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // The headline. Everything the issue asked for in one pass: a drive back at a
  // new path, a paused download whose `.part` travelled with it, and a resume
  // that works afterwards.
  describe('a validated move writes the effective root key and re-syncs the manager', () => {
    it('accepts a relocated root whose .part matches, and reports what matched', async () => {
      put(newDir, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeNull()
      expect(result.dir).toBe(newDir)
      expect(names(result.matched)).toEqual([VIDEO])
      expect(result.unmatched).toEqual([])
      expect(store.get('downloadDir')).toBe(newDir)
      expect(setDownloadDir).toHaveBeenCalledWith(newDir)
    })

    it('reports the fresh root state, with the effective root no longer missing', async () => {
      put(newDir, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.roots.downloadDir).toBe(newDir)
      expect(result.roots.effectiveRootMissing).toBe(false)
      expect(result.roots.effectiveRootKey).toBe('downloadDir')
    })

    // #421 turns the `downloadedEpisodes` GC off while any stored root is
    // absent, which is what keeps a stranded episode's metadata alive. A
    // successful move releases that guard, and it should: the files are visible
    // again, so a GC pass now tells the truth. Pinned so the release is
    // intentional rather than a side effect nobody chose.
    it('releases the #421 GC guard, because the files are visible again', async () => {
      put(newDir, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      expect(coldStorageService.missingConfiguredRoot()).toBe(awayDir)

      const result = await rebind()

      expect(result.roots.missingRoot).toBeNull()
      expect(coldStorageService.missingConfiguredRoot()).toBeNull()
    })

    // Nothing is on disk for a queue that never started, so there is nothing to
    // validate — and demanding a file would make "queue filled, drive unplugged
    // before the first byte" unrecoverable for no gain.
    it('accepts a queue of zero-byte queued items with no file present at all', async () => {
      seed([
        makeItem({ status: 'queued', bytesReceived: 0 }),
        makeItem({ id: 'video-2', translationId: 2, status: 'queued', bytesReceived: 0 })
      ])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeNull()
      expect(result.matched).toEqual([])
      expect(result.unmatched).toEqual([])
      expect(store.get('downloadDir')).toBe(newDir)
    })

    it('writes hotStorageDir in advanced mode, which is the key the resolver reads', async () => {
      wire({ storageMode: 'advanced', downloadDir: hotDir, hotStorageDir: awayDir })
      put(newDir, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeNull()
      expect(store.get('hotStorageDir')).toBe(newDir)
      // The other root is untouched: only the effective one moved.
      expect(store.get('downloadDir')).toBe(hotDir)
      expect(setDownloadDir).toHaveBeenCalledWith(newDir)
    })

    it('reports a cancelled dialog as dir null, writing nothing', async () => {
      ;(BrowserWindow.getFocusedWindow as Mock).mockReturnValue({})
      ;(dialog.showOpenDialog as Mock).mockResolvedValue({ canceled: true, filePaths: [] })

      const result = await rebind()

      expect(result.dir).toBeNull()
      expect(result.refusedReason).toBeNull()
      expect(setStoreValue).not.toHaveBeenCalled()
      expect(setDownloadDir).not.toHaveBeenCalled()
    })
  })

  // The refusal half, asserted the way `test/ipc/storage-set-mode.ipc.test.ts`
  // asserts the mode switch's: a refusal writes **nothing**, so both the store
  // and the manager have to be checked, not just the reply.
  describe('a refusal writes nothing at all', () => {
    // THE test for the wrong-files protection. The file is there and the name
    // is right, and resuming onto it would append from its own length — the
    // `.part` is appended to with `Range: bytes=<size>-` and nothing anywhere
    // reports an error. Re-binding here converts a clear refusal into a corrupt
    // file, which is worse than today's over-blocking.
    //
    // The `.part` is *longer* than the counter: short by a little is now our own
    // file mid-abort (`PART_IN_FLIGHT_SLACK`, #455 review), and only a size the
    // in-flight window cannot explain is still evidence of a foreign file.
    it('refuses a .part whose size differs from bytesReceived', async () => {
      put(newDir, VIDEO + '.part', 2048)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeTruthy()
      expect(result.dir).toBeNull()
      expect(names(result.unmatched)).toEqual([VIDEO])
      expect(store.get('downloadDir')).toBe(awayDir)
      expect(setStoreValue).not.toHaveBeenCalled()
      expect(setDownloadDir).not.toHaveBeenCalled()
    })

    it('refuses when the expected .part is not under the picked folder', async () => {
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeTruthy()
      expect(names(result.unmatched)).toEqual([VIDEO])
      expect(setStoreValue).not.toHaveBeenCalled()
    })

    // All-or-nothing. One root for the whole queue means a partial move cannot
    // be represented, so the reply names what is missing and the user cancels
    // those items and retries.
    it('refuses the whole move for one unmatched file among matches', async () => {
      put(newDir, VIDEO + '.part', 1024)
      seed([
        makeItem({ status: 'paused', bytesReceived: 1024 }),
        makeItem({
          id: 'video-2',
          translationId: 2,
          filename: path.join(ANIME_DIR, 'Anime - 02 [X].mp4'),
          status: 'failed',
          bytesReceived: 2048
        })
      ])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeTruthy()
      expect(names(result.matched)).toEqual([VIDEO])
      expect(names(result.unmatched)).toEqual([path.join(ANIME_DIR, 'Anime - 02 [X].mp4')])
      expect(setStoreValue).not.toHaveBeenCalled()
      expect(setDownloadDir).not.toHaveBeenCalled()
    })

    it('refuses while an item is downloading, however good the files look', async () => {
      put(newDir, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'downloading', bytesReceived: 1024 })])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeTruthy()
      expect(result.dir).toBeNull()
      expect(setStoreValue).not.toHaveBeenCalled()
      expect(setDownloadDir).not.toHaveBeenCalled()
    })

    it('refuses while a merge is running', async () => {
      put(newDir, VIDEO)
      seed([makeItem({ status: 'completed' })], [[1, 'merging']])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.refusedReason).toBeTruthy()
      expect(setStoreValue).not.toHaveBeenCalled()
      expect(setDownloadDir).not.toHaveBeenCalled()
    })

    it('still carries the raw root state when it refuses, so the tab can re-adopt it', async () => {
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      const result = await rebind()

      expect(result.roots.downloadDir).toBe(awayDir)
      expect(result.roots.effectiveRootMissing).toBe(true)
    })
  })

  // The corrected rule, tested directly against `getDownloadDir()` rather than
  // against `missingRoot`. Both of the two-root cases below answer `downloadDir`
  // from `missingConfiguredRoot()`, so the plan review's key comparison would
  // have got the first one right by luck and the second one — the real relocated
  // hot drive — wrong.
  describe('the action is offered for the effective root, and only for it', () => {
    it('offers it in simple mode when downloadDir is away', async () => {
      wire({ storageMode: 'simple', downloadDir: awayDir })
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])

      const state = await rootsState()

      expect(state.effectiveRootMissing).toBe(true)
      expect(state.effectiveRootKey).toBe('downloadDir')
      expect(state.effectiveRoot).toBe(awayDir)
      expect(state.rebindOffered).toBe(true)
    })

    // The case the review's own correction is about. `missingConfiguredRoot()`
    // walks the keys in order and answers `downloadDir`, so comparing it against
    // the effective key would never offer the action for the hot drive that
    // actually went away.
    it('offers it for hotStorageDir in advanced mode even when downloadDir is stale too', async () => {
      wire({ storageMode: 'advanced', downloadDir: awayDir, hotStorageDir: newDir })
      fs.rmSync(newDir, { recursive: true, force: true })
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])

      const state = await rootsState()

      expect(state.missingRoot).toBe(awayDir)
      expect(state.effectiveRootKey).toBe('hotStorageDir')
      expect(state.effectiveRoot).toBe(newDir)
      expect(state.effectiveRootMissing).toBe(true)
      expect(state.rebindOffered).toBe(true)
    })

    // The mirror image, and the "two roots" risk the issue lists: a stale
    // `downloadDir` behind a live hot root strands nothing, so the notice stays
    // and the action does not appear.
    it('does not offer it in advanced mode when only the inactive downloadDir is away', async () => {
      wire({ storageMode: 'advanced', downloadDir: awayDir, hotStorageDir: hotDir })
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])

      const state = await rootsState()

      expect(state.missingRoot).toBe(awayDir)
      expect(state.effectiveRootKey).toBe('hotStorageDir')
      expect(state.effectiveRootMissing).toBe(false)
      expect(state.rebindOffered).toBe(false)
    })

    // Advanced mode with no hot dir picked falls through to `downloadDir`, so
    // the key the resolver reads is still `downloadDir` and that is the one a
    // move has to write.
    it('names downloadDir in advanced mode with no hot dir set', async () => {
      wire({ storageMode: 'advanced', downloadDir: awayDir, hotStorageDir: '' })

      const state = await rootsState()

      expect(state.effectiveRootKey).toBe('downloadDir')
      expect(state.effectiveRootMissing).toBe(true)
    })

    it('reports a live root as present, and names no action', async () => {
      wire({ storageMode: 'simple', downloadDir: hotDir })

      const state = await rootsState()

      expect(state.effectiveRootMissing).toBe(false)
      expect(state.effectiveRootKey).toBe('downloadDir')
      expect(state.rebindOffered).toBe(false)
    })
  })

  // `effectiveRootMissing` is the plain fact and is **not** the offer's gate
  // (#455 review). The issue scoped the offer to "a root is missing *and* there
  // is root-bound work", which is what `rebindOffered` reports; gating the row
  // on the bare fact put the action in front of every fresh install, because an
  // unset `downloadDir` resolves to `<Downloads>/anime-dl` and nothing creates
  // that folder until the first download's `mkdirSync`.
  describe('the offer needs root-bound work as well as a missing root', () => {
    it('is not offered on a fresh install: downloadDir unset, the fallback absent, queue empty', async () => {
      wire({ storageMode: 'simple', downloadDir: '' })
      fs.rmSync(fallbackDir, { recursive: true, force: true })

      const state = await rootsState()

      // The fallback is what an unset `downloadDir` resolves to, and it is not
      // on disk — so the bare fact holds and would have shown the row.
      expect(state.downloadDir).toBe('')
      expect(state.effectiveRoot).toBe(join(fallbackDir, 'anime-dl'))
      expect(state.effectiveRootMissing).toBe(true)
      expect(state.rebindOffered).toBe(false)
    })

    it('is not offered for an away root with nothing bound to it', async () => {
      wire({ storageMode: 'simple', downloadDir: awayDir })

      const state = await rootsState()

      expect(state.effectiveRootMissing).toBe(true)
      expect(state.rebindOffered).toBe(false)
    })

    // The whole population `hasRootBoundWork()` covers, so the offer cannot
    // depend on which flavour of stranded work the user happens to hold.
    it.each([
      [
        'a paused download',
        (): DownloadItem[] => [makeItem({ status: 'paused', bytesReceived: 9 })]
      ],
      [
        'a failed download',
        (): DownloadItem[] => [makeItem({ status: 'failed', bytesReceived: 9 })]
      ],
      ['a queued download', (): DownloadItem[] => [makeItem({ status: 'queued' })]],
      ['an unmerged finished episode', (): DownloadItem[] => [makeItem({ status: 'completed' })]]
    ])('is offered for an away root holding %s', async (_label, items) => {
      wire({ storageMode: 'simple', downloadDir: awayDir })
      seed(items())

      expect((await rootsState()).rebindOffered).toBe(true)
    })

    it('is not offered once the work is inert, even with the root still away', async () => {
      wire({ storageMode: 'simple', downloadDir: awayDir })
      seed([makeItem({ status: 'cancelled', bytesReceived: 1024 })])

      const state = await rootsState()

      expect(state.effectiveRootMissing).toBe(true)
      expect(state.rebindOffered).toBe(false)
    })

    // An accepted move is what takes the row off screen, and it does so through
    // the root half rather than the work half: the queue is untouched.
    it('stops being offered after a move that went through', async () => {
      put(newDir, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])
      pickerReturns(newDir)

      expect((await rootsState()).rebindOffered).toBe(true)

      const result = await rebind()

      expect(result.refusedReason).toBeNull()
      expect(result.roots.rebindOffered).toBe(false)
      expect((await rootsState()).rebindOffered).toBe(false)
    })
  })

  // What shape (1) actually promises, and the test that replaces the issue
  // body's "the binding survived `loadQueue()`" — there is no per-item binding
  // to survive. The root comes back through the store, so the proof is that a
  // manager built the way `src/main/index.ts` builds it, from
  // `coldStorageService.getDownloadDir()`, resolves the stranded work under the
  // new root.
  describe('a fresh manager built from the resolver resolves the work under the new root', () => {
    /** Rebind to `newDir`, then build the manager the next app start would. */
    async function rebindAndRestart(items: DownloadItem[]): Promise<DownloadManager> {
      pickerReturns(newDir)
      const result = await rebind()
      expect(result.refusedReason).toBeNull()

      const restartedUserData = join(tmpRoot, 'userdata-restarted')
      fs.mkdirSync(restartedUserData, { recursive: true })
      const restarted = new DownloadManager(
        coldStorageService.getDownloadDir(),
        {} as never,
        restartedUserData
      )
      const internals = restarted as unknown as Internals
      internals.queue = items
      internals.mergeStatuses.clear()
      return restarted
    }

    it('merges from the new root, writing the .mkv beside the sources it read', async () => {
      const items = [
        makeItem({ status: 'completed' }),
        makeItem({ id: 'sub-1', kind: 'subtitle', filename: SUBTITLE, status: 'completed' })
      ]
      put(newDir, VIDEO)
      put(newDir, SUBTITLE)
      seed(items)

      const restarted = await rebindAndRestart(items)
      try {
        const internals = restarted as unknown as Internals
        const seen: string[] = []
        internals.runFfmpeg = (opts) => {
          seen.push(opts.videoPath)
          fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
          fs.writeFileSync(opts.outputPath, 'mkv-bytes')
          return Promise.resolve()
        }

        await restarted.mergeCompleted(FFMPEG, FFPROBE, 'copy')

        // Not "the merge was attempted": `_mergeAll` skips a video it cannot
        // find with a silent `continue`, so a manager still on the away root
        // leaves the status untouched and nothing on disk.
        expect(seen).toEqual([join(newDir, VIDEO)])
        expect(restarted.getMergeStatus(1)).toBe('completed')
        expect(fs.existsSync(join(newDir, MKV))).toBe(true)
      } finally {
        restarted.destroy()
      }
    })

    it('cancels against the new root, deleting the real file rather than missing it', async () => {
      const items = [makeItem({ status: 'paused', bytesReceived: 1024 })]
      const part = put(newDir, VIDEO + '.part', 1024)
      seed(items)

      const restarted = await rebindAndRestart(items)
      try {
        restarted.cancel('video-1')

        expect(fs.existsSync(part)).toBe(false)
      } finally {
        restarted.destroy()
      }
    })
  })
})
