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

describe('downloads IPC — downloadedEpisodes metadata (#412)', () => {
  let hotDir: string
  let store: InMemoryStorage
  let items: DownloadItem[]
  let activeTranslationIds: number[]
  let cancel: Mock
  let invoke: (channel: string, ...args: unknown[]) => Promise<unknown>

  const episodes = (): Record<string, { translationId: number }> =>
    store.get('downloadedEpisodes') as Record<string, { translationId: number }>

  beforeEach(() => {
    vi.clearAllMocks()
    hotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ipc-prune-'))
    items = []
    activeTranslationIds = []
    cancel = vi.fn()

    store = new InMemoryStorage({
      storageMode: 'simple',
      downloadDir: hotDir,
      coldStorageDir: '',
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
      downloadsFallbackDir: hotDir,
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
  })

  afterEach(() => {
    fs.rmSync(hotDir, { recursive: true, force: true })
  })

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
})
