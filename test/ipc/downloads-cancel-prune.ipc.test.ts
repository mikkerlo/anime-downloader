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
// The second group pins the reviewer's other case: the GC in
// `downloaded-episodes-get` must not reap the entry while the sibling subtitle
// is still downloading, which is now the normal state for every episode.

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
 * Per-test storage wiring (#421). The GC's behaviour depends on which roots are
 * configured and which of them are on disk, so every root the handler can look
 * at — and the fallback behind an empty `downloadDir` — is an override here
 * rather than a second service built inside a test body.
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

  describe('downloaded-episodes-get GC', () => {
    it('keeps the fresh entry while the sibling subtitle is still downloading', async () => {
      items = [makeItem({ id: 'video-1', status: 'completed' })]
      activeTranslationIds = [TRANSLATION_ID]
      putPartOnDisk()

      const result = (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<
        string,
        unknown[]
      >

      // No final file yet (deferred), so the entry survives only because the
      // group is still in `getEpisodeGroups()` — which skips 'cancelled' only.
      expect(result['1']).toHaveLength(1)
      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })

    it('reaps the entry once the group has left the queue with no file on disk', async () => {
      items = []
      activeTranslationIds = []

      const result = (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<
        string,
        unknown[]
      >

      expect(result).toEqual({})
      expect(episodes()).toEqual({})
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

  // The GC persists its verdict, so a false `false` from `episodeFileExists` is
  // bulk, irreversible metadata loss for files that are sitting on disk. Two
  // independent causes, measured independently: the search scope used to move
  // with `storageMode`, and a root that is away answers `false` for everything
  // inside it. Each test below is reddened by exactly one of the four guard
  // mutations listed in #421's Testing Strategy.
  describe('downloaded-episodes-get GC — scan-root safety (#421)', () => {
    /** The folder a cold move leaves behind: present, and empty. */
    const putAnimeDirIn = (root: string): void => {
      fs.mkdirSync(path.join(root, ANIME_NAME), { recursive: true })
    }

    const getEpisodes = async (): Promise<Record<string, unknown[]>> =>
      (await invoke(CHANNELS.DOWNLOADED_EPISODES_GET, ANIME_ID)) as Record<string, unknown[]>

    it('keeps every entry when the cold drive is away, advanced mode (setup 3)', async () => {
      // No settings change at all: `hot/<anime>/` is the folder the cold move
      // left behind, so a folder-existence guard would pass here and still wipe.
      wireStorage({
        storageMode: 'advanced',
        hotStorageDir: hotDir,
        coldStorageDir: awayDir
      })
      putAnimeDirIn(hotDir)

      await getEpisodes()

      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })

    it('keeps a cold-resident entry after an advanced → simple flip (setup 2)', async () => {
      // `hotStorageDir` is empty, so the flip does not move the first scan root —
      // the cold root simply drops out of `dirsForScan()`, and every cold-resident
      // entry was collected. Nothing rewrites the store when the mode comes back.
      wireStorage({
        storageMode: 'simple',
        downloadDir: hotDir,
        hotStorageDir: '',
        coldStorageDir: coldDir
      })
      putAnimeDirIn(hotDir)
      putFinalFileIn(coldDir)

      await getEpisodes()

      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })

    it('keeps a downloadDir-resident entry after a simple → advanced flip (setup 4)', async () => {
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

      await getEpisodes()

      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
    })

    it('still collects a genuinely absent file while the roots are readable', async () => {
      // The case that stops the fix from being "disable the GC": both roots are
      // on disk, episode 1 is there, episode 2 is nowhere. Deliberately kept
      // insensitive to which root the survivor sits in, so it measures only that
      // the GC still runs — the union's shape is what the three tests above pin.
      wireStorage({
        storageMode: 'advanced',
        hotStorageDir: hotDir,
        coldStorageDir: coldDir
      })
      const staleKey = `${ANIME_ID}:2:${TRANSLATION_ID}`
      store.set('downloadedEpisodes', {
        ...episodes(),
        [staleKey]: {
          translationType: 'subRu',
          author: 'Author',
          quality: 720,
          translationId: TRANSLATION_ID
        }
      })
      putFinalFileIn(hotDir)

      const result = await getEpisodes()

      expect(Object.keys(episodes())).toEqual([ENTRY_KEY])
      expect(Object.keys(result)).toEqual(['1'])
    })

    it('still collects when only the unused downloadsFallbackDir is missing', async () => {
      // The exemption that keeps the GC alive on a straight-to-advanced profile:
      // `downloadDir` is `''` by default and `<downloads>/anime-dl` was never
      // created, so checking the fallback would report a missing root forever.
      wireStorage({
        storageMode: 'advanced',
        downloadDir: '',
        hotStorageDir: hotDir,
        coldStorageDir: '',
        downloadsFallbackDir: awayDir
      })
      putAnimeDirIn(hotDir)

      const result = await getEpisodes()

      expect(episodes()).toEqual({})
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
