// `onVideoDownloaded` and `onMergeComplete` are listener lists (#574).
//
// They used to hold one callback each, so a second registration silently
// unregistered the first: an export (S6c #576) or a pre-fetch (S6d #577)
// subscribing would have taken episode completion's metadata write, or the
// merge tail's cold move, with it. These cases drive a real `DownloadManager`
// the way the sibling suites do: `startDownload` against a stubbed `fetch` for
// the video hook, `mergeCompleted` against a stubbed private `runFfmpeg` for
// the merge hook. Each listener goes through its own `dispatchHook` call, so
// the #428 policy holds per listener.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  sanitizeFilename,
  type DownloadItem,
  type MergeCompleteInfo,
  type MergeStatus
} from '../../src/main/download-manager'

const ANIME = 'Anime'
const ANIME_DIR = sanitizeFilename(ANIME)
const VIDEO_BODY = 'video-bytes'

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  startDownload: (item: DownloadItem, retryCount?: number) => Promise<void>
  runFfmpeg: (opts: { videoPath: string; outputPath: string }) => Promise<void>
}

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: path.join(ANIME_DIR, 'Anime - 01 [X].mp4'),
    animeName: ANIME,
    episodeLabel: '1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'X',
    status: 'queued',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

/** Lets a rejected listener's `.catch` (attached by `dispatchHook`) settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('DownloadManager multi-listener hooks (#574)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let internals: Internals

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-hooks-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-hooks-dl-'))
    dm = new DownloadManager(downloadDir, { getSubtitlesUrl: () => 's' } as never, userDataDir)
    internals = dm as unknown as Internals
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch = vi.fn(
      async () =>
        new Response(VIDEO_BODY, {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(VIDEO_BODY)) }
        })
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    dm.destroy()
    vi.restoreAllMocks()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  describe('onVideoDownloaded', () => {
    it('both listeners receive (filePath, item) for one finished video', async () => {
      const first: [string, string][] = []
      const second: [string, string][] = []
      dm.onVideoDownloaded((filePath, item) => {
        first.push([filePath, item.id])
      })
      dm.onVideoDownloaded((filePath, item) => {
        second.push([filePath, item.id])
      })
      const video = makeItem()
      internals.queue = [video]
      await internals.startDownload(video)
      await settle()

      const expected: [string, string][] = [[path.join(downloadDir, video.filename), 'video-1']]
      expect(first).toEqual(expected)
      expect(second).toEqual(expected)
      expect(video.error).toBeUndefined()
    })

    it('a rejecting first listener still lets the second run, and marks item.error', async () => {
      const second = vi.fn()
      dm.onVideoDownloaded(async () => {
        throw new Error('ENOSPC: no space left on device')
      })
      dm.onVideoDownloaded(second)
      const video = makeItem()
      internals.queue = [video]
      await internals.startDownload(video)
      await settle()

      expect(second).toHaveBeenCalledTimes(1)
      expect(video.status).toBe('completed')
      expect(video.error).toBe('Post-download step failed: ENOSPC: no space left on device')
    })

    it('a throwing first listener still lets the second run (sync throw)', async () => {
      const second = vi.fn()
      dm.onVideoDownloaded(() => {
        throw new Error('sync boom')
      })
      dm.onVideoDownloaded(second)
      const video = makeItem()
      internals.queue = [video]
      await internals.startDownload(video)
      await settle()

      expect(second).toHaveBeenCalledTimes(1)
      expect(video.error).toBe('Post-download step failed: sync boom')
    })

    it('the unsubscribe removes only its own listener', async () => {
      const first = vi.fn()
      const second = vi.fn()
      const off = dm.onVideoDownloaded(first)
      dm.onVideoDownloaded(second)
      off()
      const video = makeItem()
      internals.queue = [video]
      await internals.startDownload(video)
      await settle()
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    })
  })

  describe('onMergeComplete', () => {
    function seedGroup(): void {
      const video = makeItem({ status: 'completed' })
      const sub = makeItem({
        id: 'sub-1',
        kind: 'subtitle',
        status: 'completed',
        filename: path.join(ANIME_DIR, 'Anime - 01 [X].ass')
      })
      internals.queue = [video, sub]
      internals.mergeStatuses.clear()
      for (const item of [video, sub]) {
        const abs = path.join(downloadDir, item.filename)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, `${item.kind}-bytes`)
      }
    }

    function listen(): { first: MergeCompleteInfo[]; second: MergeCompleteInfo[] } {
      const first: MergeCompleteInfo[] = []
      const second: MergeCompleteInfo[] = []
      dm.onMergeComplete((info) => {
        first.push(info)
      })
      dm.onMergeComplete((info) => {
        second.push(info)
      })
      return { first, second }
    }

    it('both listeners fire for one merged group', async () => {
      const { first, second } = listen()
      seedGroup()
      internals.runFfmpeg = async (opts) => {
        fs.writeFileSync(opts.outputPath, 'mkv-bytes')
      }
      await dm.mergeCompleted('/fake/ffmpeg', '/fake/ffprobe', 'copy')
      await settle()

      const expected = {
        animeName: ANIME,
        animeId: 100,
        episodeInt: '1',
        episodeLabel: '1',
        mkvFilename: path.join(ANIME_DIR, 'Anime - 01 [X].mkv')
      }
      expect(first).toEqual([expected])
      expect(second).toEqual([expected])
      expect(dm.getMergeStatus(1)).toBe('completed')
    })

    it('a rejecting first listener does not stop the second', async () => {
      const second = vi.fn()
      dm.onMergeComplete(async () => {
        throw new Error('cold move failed')
      })
      dm.onMergeComplete(second)
      seedGroup()
      internals.runFfmpeg = async (opts) => {
        fs.writeFileSync(opts.outputPath, 'mkv-bytes')
      }
      await dm.mergeCompleted('/fake/ffmpeg', '/fake/ffprobe', 'copy')
      await settle()
      expect(second).toHaveBeenCalledTimes(1)
      // A consumer failure is never a merge failure (#428).
      expect(dm.getMergeStatus(1)).toBe('completed')
    })

    it('neither fires for a failed merge', async () => {
      const { first, second } = listen()
      seedGroup()
      internals.runFfmpeg = async () => {
        throw new Error('ffmpeg exited with code 1')
      }
      await dm.mergeCompleted('/fake/ffmpeg', '/fake/ffprobe', 'copy')
      await settle()
      expect(dm.getMergeStatus(1)).toBe('failed')
      expect(first).toEqual([])
      expect(second).toEqual([])
    })

    it('neither fires for a cancelled merge', async () => {
      const { first, second } = listen()
      seedGroup()
      internals.runFfmpeg = async () => {
        dm.cancelMerge(1)
        throw new Error('ffmpeg was killed with signal SIGKILL')
      }
      await dm.mergeCompleted('/fake/ffmpeg', '/fake/ffprobe', 'copy')
      await settle()
      expect(dm.getMergeStatus(1)).toBeNull()
      expect(first).toEqual([])
      expect(second).toEqual([])
    })
  })
})
