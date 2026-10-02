// The metadata half of the downloads router (#412).
//
// Writing the entry when the video item lands, rather than when the group
// finishes, creates an entry that did not exist before in exactly one window:
// the video is 'completed' but still parked as `.part` under the player lock,
// with a failed sibling subtitle. `download-cancel` used to run
// `pruneDownloadedEpisode` for ANY cancelled item, and the prune keeps an entry
// only when `episodeFileExists` finds a final `.mkv`/`.mp4` — never a `.part`.
// So cancelling the failed subtitle deleted the video's fresh entry, and
// `finalizeDeferredEpisodes` never writes it again.
//
// The second group pins the reviewer's other case: `downloaded-episodes-get`
// must not drop the entry while the sibling subtitle is still downloading, which
// is now the normal state for every episode. Since #423 that handler is a pure
// read — it filters its return value and never writes — so the groups below
// assert the returned rows plus the promise that invoking it leaves the store
// alone. Collection lives in `reconcileDownloadedEpisodes`, tested in
// `test/services/cold-storage.test.ts`.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register } from '../../src/main/ipc/downloads.ipc'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { sanitizeFilename, type DownloadItem } from '../../src/main/download-manager'
import type { AppDeps } from '../../src/main/ipc/index'

const ANIME_ID = 100
const ANIME_NAME = 'Anime'
const TRANSLATION_ID = 7
const ENTRY_KEY = `${ANIME_ID}:1:${TRANSLATION_ID}`

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: TRANSLATION_ID,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: path.join(ANIME_NAME, `${ANIME_NAME} - 01 [Author].mp4`),
    animeName: ANIME_NAME,
    episodeLabel: 'ep1',
    animeId: ANIME_ID,
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

/**
 * Per-test storage wiring (#421). Both the getter's filter and the cancel
 * prune depend on which roots are configured and which of them are on disk, so
 * every root the handler can look at — and the fallback behind an empty
 * `downloadDir` — is an override here rather than a second service built inside
 * a test body.
 */
interface StorageWiring {
  storageMode?: string
  downloadDir?: string
  hotStorageDir?: string
  coldStorageDir?: string
  downloadsFallbackDir?: string
}

describe('downloads IPC — downloadedEpisodes metadata (#412)', () => {
  let tmpRoot: string
  let hotDir: string
  let hot2Dir: string
  let coldDir: string
  /** A path under `tmpRoot` that is deliberately never created. */
  let awayDir: string
  let store: InMemoryStorage
  let items: DownloadItem[]
  let activeTranslationIds: number[]
  let cancel: Mock
  let invoke: (channel: string, ...args: unknown[]) => Promise<unknown>

  const episodes = (): Record<string, { translationId: number }> =>
    store.get('downloadedEpisodes') as Record<string, { translationId: number }>

  function wireStorage(wiring: StorageWiring = {}): void {
    ;(ipcMain.handle as Mock).mockClear()

    store = new InMemoryStorage({
      storageMode: wiring.storageMode ?? 'simple',
      downloadDir: wiring.downloadDir ?? hotDir,
      hotStorageDir: wiring.hotStorageDir ?? '',
      coldStorageDir: wiring.coldStorageDir ?? '',
      downloadedAnime: {
        [String(ANIME_ID)]: { id: ANIME_ID, title: ANIME_NAME, titles: {} }
      },
      downloadedEpisodes: {
        [ENTRY_KEY]: {
          translationType: 'subRu',
          author: 'Author',
          quality: 720,
          translationId: TRANSLATION_ID
        }
      }
    })

    const coldStorageService = createColdStorageService({
      store,
      downloadsFallbackDir: wiring.downloadsFallbackDir ?? hotDir,
      sanitizeFilename,
      parseEpisodeFromFilename: () => null,
      scanEpisodeFiles: () => ({}),
      invalidateFileCache: () => {},
      broadcast: () => {},
      usageProgressChannel: 'usage-progress',
      cleanupPendingChannel: 'cleanup-pending',
      cleanupFinishedChannel: 'cleanup-finished',
      fileEpisodesChangedChannel: 'file-episodes-changed'
    })

    const downloadManager = {
      getItem: (id: string) => items.find((i) => i.id === id) ?? null,
      cancel,
      getEpisodeGroups: () =>
        activeTranslationIds.map((translationId) => ({ animeName: ANIME_NAME, translationId }))
    }

    register({ store, downloadManager, coldStorageService } as unknown as AppDeps)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    invoke = async (channel, ...args) => handlers.get(channel)!({}, ...args)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ipc-prune-'))
    hotDir = path.join(tmpRoot, 'hot')
    hot2Dir = path.join(tmpRoot, 'hot2')
    coldDir = path.join(tmpRoot, 'cold')
    awayDir = path.join(tmpRoot, 'away')
    for (const dir of [hotDir, hot2Dir, coldDir]) fs.mkdirSync(dir, { recursive: true })
    items = []
    activeTranslationIds = []
    cancel = vi.fn()

    wireStorage()
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  /** Write a final video file for episode 1 of `ANIME_NAME` under `root`. */
  const putFinalFileIn = (root: string): void => {
    const full = path.join(root, ANIME_NAME, `${ANIME_NAME} - 01 [Author].mp4`)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'video-bytes')
  }

  /** The deferred window: the transfer finished but the file is still `.part`. */
  const putPartOnDisk = (): void => {
    const full = path.join(hotDir, items[0].filename + '.part')
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'partial-bytes')
  }

  describe('download-cancel prune', () => {
    it('keeps the video entry when the failed subtitle is cancelled mid-defer', async () => {
      items = [
        makeItem({ id: 'video-1', kind: 'video', status: 'completed' }),
        makeItem({
          id: 'sub-1',
          kind: 'subtitle',
          status: 'failed',
          filename: path.join(ANIME_NAME, `${ANIME_NAME} - 01 [Author].ass`)
        })
      ]
      putPartOnDisk()

      await invoke(CHANNELS.DOWNLOAD_CANCEL, 'sub-1')

      expect(cancel).toHaveBeenCalledWith('sub-1')
      // `episodeFileExists` probes .mkv/.mp4 only, so without the kind guard the
      // prune would find nothing on disk and delete the video's entry.
      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })

    it('still prunes when the video itself is cancelled and left nothing on disk', async () => {
      items = [makeItem({ id: 'video-1', kind: 'video', status: 'downloading' })]

      await invoke(CHANNELS.DOWNLOAD_CANCEL, 'video-1')

      // The guard must not cost the behaviour it was added around: cancelling a
      // video cascades to its subtitle and arrives here with kind 'video'.
      expect(episodes()).toEqual({})
    })

    it('keeps the entry on a video cancel once the final file is on disk', async () => {
      items = [makeItem({ id: 'video-1', kind: 'video', status: 'completed' })]
      const full = path.join(hotDir, items[0].filename)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, 'video-bytes')

      await invoke(CHANNELS.DOWNLOAD_CANCEL, 'video-1')

      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })
  })

  describe('downloaded-episodes-get filter', () => {
    // #423: the handler is a pure read. Collection moved to
    // `coldStorageService.reconcileDownloadedEpisodes`, whose cases live in
    // `test/services/cold-storage.test.ts`; what is left here is the filter and
    // the promise that invoking it does not touch the store.
    it('does not write the store when it filters an entry whose file is absent', async () => {
      items = []
      activeTranslationIds = []

      const result = (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<
        string,
        unknown[]
      >

      // Red before #423: the handler deleted the row and committed it, so the
      // key list came back empty. The row is filtered out of the RETURN VALUE
      // and must still be in the store, where only the startup reconcile may
      // collect it. Exact key list, not a shape check — `toEqual({})` on the
      // store would also pass against a mutant that dropped a different key.
      expect(result).toEqual({})
      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })

    it('keeps the fresh entry while the sibling subtitle is still downloading', async () => {
      items = [makeItem({ id: 'video-1', status: 'completed' })]
      activeTranslationIds = [TRANSLATION_ID]
      putPartOnDisk()

      const result = (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<
        string,
        unknown[]
      >

      // No final file yet (deferred), so the entry is returned only because the
      // group is still in `getEpisodeGroups()` — which skips 'cancelled' only.
      // The exemption is not GC-only: it is why an in-progress episode shows its
      // chip and lock state before any final file exists.
      expect(result['1']).toHaveLength(1)
      expect(result['1'][0]).toMatchObject({ translationId: TRANSLATION_ID })
    })

    it('omits the entry once the group has left the queue with no file on disk', async () => {
      items = []
      activeTranslationIds = []

      const result = (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<
        string,
        unknown[]
      >

      // Return-value only since #423. The store half of this case is the purity
      // test above, and the deletion half moved to the reconcile.
      expect(result).toEqual({})
    })

    it('keeps the entry after the group is cleared, on the renamed final file', async () => {
      items = []
      activeTranslationIds = []
      const full = path.join(hotDir, `${ANIME_NAME}/${ANIME_NAME} - 01 [Author].mp4`)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, 'video-bytes')

      const result = (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<
        string,
        unknown[]
      >

      expect(result['1']).toHaveLength(1)
    })
  })

  // #421 measured a false `false` from `episodeFileExists` as bulk, irreversible
  // metadata loss, because the getter persisted its verdict. Since #423 it does
  // not, so the collection half of these cases moved to
  // `test/services/cold-storage.test.ts` (see 'scan-root safety, ported from the
  // getter'). What stays here is the half that is still the getter's: the FILTER
  // has to see the whole root union, or a `storageMode` flip hides a row whose
  // file is sitting on disk. Nothing writes the store on this path any more, so
  // the mode-flip cases assert the return value.
  describe('downloaded-episodes-get filter — scan-root safety (#421)', () => {
    /** The folder a cold move leaves behind: present, and empty. */
    const putAnimeDirIn = (root: string): void => {
      fs.mkdirSync(path.join(root, ANIME_NAME), { recursive: true })
    }

    const getEpisodes = async (): Promise<Record<string, unknown[]>> =>
      (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<string, unknown[]>

    it('returns a cold-resident entry after an advanced → simple flip (setup 2)', async () => {
      // `hotStorageDir` is empty, so the flip does not move the first scan root —
      // the cold root simply drops out of `dirsForScan()`, and every cold-resident
      // entry vanished from the UI. The filter reads `allConfiguredRoots()`.
      wireStorage({
        storageMode: 'simple',
        downloadDir: hotDir,
        hotStorageDir: '',
        coldStorageDir: coldDir
      })
      putAnimeDirIn(hotDir)
      putFinalFileIn(coldDir)

      const result = await getEpisodes()

      expect(Object.keys(result)).toEqual(['1'])
      expect(result['1']).toHaveLength(1)
    })

    it('returns a downloadDir-resident entry after a simple → advanced flip (setup 4)', async () => {
      // The counter-example to building the union from `getDownloadDir()`: it
      // returns `hotStorageDir` here, which drops `downloadDir` — the root every
      // simple-mode download landed in. Nothing migrates those files.
      wireStorage({
        storageMode: 'advanced',
        downloadDir: hotDir,
        hotStorageDir: hot2Dir,
        coldStorageDir: ''
      })
      putFinalFileIn(hotDir)

      const result = await getEpisodes()

      expect(Object.keys(result)).toEqual(['1'])
      expect(result['1']).toHaveLength(1)
    })

    it('omits a cold-resident row while the drive is away (decision 2)', async () => {
      // The getter deliberately has NO `missingConfiguredRoot()` branch — that
      // guard existed to protect a `delete`, and there is none left. So an
      // unmounted root costs the row in the UI and nothing else (a Play button
      // for an unreachable file would fail anyway). The recoverability that makes
      // that acceptable is pinned by its two owners rather than restated here:
      // the purity test above (this handler never writes, under any root config)
      // and the reconcile's root-away skip in `test/services/cold-storage.test.ts`
      // (nothing else collects while a root is missing). Asserting the store here
      // too would make this test red alongside the purity test under the
      // restored-`delete` mutation, which is what cost #421's original
      // cold-drive-away case its place in this file.
      wireStorage({
        storageMode: 'advanced',
        hotStorageDir: hotDir,
        coldStorageDir: awayDir
      })
      putAnimeDirIn(hotDir)

      const result = await getEpisodes()

      expect(result).toEqual({})
    })
  })

  describe('download-cancel prune — scan-root safety (#421)', () => {
    it('keeps the entry when a configured root is away', async () => {
      // Same false `false`, same shared guard: single-entry rather than bulk,
      // but cancelling a re-download must not prune a file on an absent drive.
      wireStorage({
        storageMode: 'advanced',
        hotStorageDir: hotDir,
        coldStorageDir: awayDir
      })
      items = [makeItem({ id: 'video-1', kind: 'video', status: 'downloading' })]

      await invoke(CHANNELS.DOWNLOAD_CANCEL, 'video-1')

      expect(cancel).toHaveBeenCalledWith('video-1')
      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })
  })
})
