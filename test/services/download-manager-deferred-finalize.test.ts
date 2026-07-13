// Watch-while-downloading (#63): subtitle-first queue ordering, the
// player-lock gate on the completion-path .part rename, finalizeDeferred,
// and 'deferred' surviving a queue.json round-trip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: path.join('anime', 'file.mp4'),
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
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  activeCount: number
  startDownload: (item: DownloadItem) => Promise<void>
  processQueue: () => void
  finishDownloadedFile: (item: DownloadItem, filePath: string, partPath: string) => void
  persistQueue: () => void
}

function seed(
  dm: DownloadManager,
  items: DownloadItem[],
  merges: [number, { status: MergeStatus }][] = []
): void {
  const internals = dm as unknown as Internals
  internals.queue = items
  internals.mergeStatuses.clear()
  for (const [tid, ms] of merges) internals.mergeStatuses.set(tid, ms)
}

/** Replaces the network-bound startDownload with a recorder. */
function recordStarts(dm: DownloadManager): string[] {
  const started: string[] = []
  const internals = dm as unknown as Internals
  internals.startDownload = async (item) => {
    started.push(item.id)
    item.status = 'downloading'
    internals.activeCount++
  }
  return started
}

describe('DownloadManager — watch while downloading (#63)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-defer-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-defer-dl-'))
    const stubApi = {} as never
    dm = new DownloadManager(downloadDir, stubApi, userDataDir)
  })

  afterEach(() => {
    dm.destroy()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  const videoPath = (): string => path.join(downloadDir, 'anime', 'file.mp4')
  const partPath = (): string => videoPath() + '.part'
  const putPartOnDisk = (): void => {
    fs.mkdirSync(path.dirname(videoPath()), { recursive: true })
    fs.writeFileSync(partPath(), 'partial-bytes')
  }

  describe('subtitle priority in processQueue', () => {
    it('starts the queued subtitle before the queued video', () => {
      seed(dm, [
        makeItem({ id: 'video-1', kind: 'video', status: 'queued' }),
        makeItem({
          id: 'sub-1',
          kind: 'subtitle',
          status: 'queued',
          filename: path.join('anime', 'file.ass')
        })
      ])
      const started = recordStarts(dm)
      ;(dm as unknown as Internals).processQueue()
      expect(started).toEqual(['sub-1', 'video-1'])
    })

    it('gives the only slot to the subtitle when concurrency is 1', () => {
      const single = new DownloadManager(
        downloadDir,
        {} as never,
        userDataDir,
        () => 0,
        () => 1
      )
      try {
        seed(single, [
          makeItem({ id: 'video-1', kind: 'video', status: 'queued' }),
          makeItem({
            id: 'sub-1',
            kind: 'subtitle',
            status: 'queued',
            filename: path.join('anime', 'file.ass')
          })
        ])
        const started = recordStarts(single)
        ;(single as unknown as Internals).processQueue()
        expect(started).toEqual(['sub-1'])
      } finally {
        single.destroy()
      }
    })
  })

  describe('completion-path rename gate', () => {
    it('defers the .part rename while the player holds the file (regression: pre-#63 renamed unconditionally)', () => {
      putPartOnDisk()
      const item = makeItem({ status: 'downloading' })
      seed(dm, [item])
      dm.setFileLockCheck(() => true)
      ;(dm as unknown as Internals).finishDownloadedFile(item, videoPath(), partPath())

      expect(fs.existsSync(partPath())).toBe(true)
      expect(fs.existsSync(videoPath())).toBe(false)
      expect(dm.getMergeStatus(1)).toBe('deferred')
    })

    it('renames .part → final when nothing holds the file', () => {
      putPartOnDisk()
      const item = makeItem({ status: 'downloading' })
      seed(dm, [item])
      ;(dm as unknown as Internals).finishDownloadedFile(item, videoPath(), partPath())

      expect(fs.existsSync(partPath())).toBe(false)
      expect(fs.existsSync(videoPath())).toBe(true)
      expect(dm.getMergeStatus(1)).toBeNull()
    })

    it('never defers subtitle items — only the video is player-locked', () => {
      const assPath = path.join(downloadDir, 'anime', 'file.ass')
      fs.mkdirSync(path.dirname(assPath), { recursive: true })
      fs.writeFileSync(assPath + '.part', 'sub')
      const item = makeItem({
        id: 'sub-1',
        kind: 'subtitle',
        status: 'downloading',
        filename: path.join('anime', 'file.ass')
      })
      seed(dm, [item])
      dm.setFileLockCheck(() => true)
      ;(dm as unknown as Internals).finishDownloadedFile(item, assPath, assPath + '.part')

      expect(fs.existsSync(assPath)).toBe(true)
      expect(dm.getMergeStatus(1)).toBeNull()
    })
  })

  describe('finalizeDeferred', () => {
    it('renames the .part and flips deferred → pending once unlocked', () => {
      putPartOnDisk()
      seed(dm, [makeItem({ status: 'completed' })], [[1, { status: 'deferred' }]])

      const ready = dm.finalizeDeferred()

      expect(ready).toEqual([1])
      expect(fs.existsSync(partPath())).toBe(false)
      expect(fs.existsSync(videoPath())).toBe(true)
      expect(dm.getMergeStatus(1)).toBe('pending')
    })

    it('leaves still-locked episodes deferred', () => {
      putPartOnDisk()
      seed(dm, [makeItem({ status: 'completed' })], [[1, { status: 'deferred' }]])
      dm.setFileLockCheck(() => true)

      expect(dm.finalizeDeferred()).toEqual([])
      expect(fs.existsSync(partPath())).toBe(true)
      expect(dm.getMergeStatus(1)).toBe('deferred')
    })

    it('drops markers whose video item vanished from the queue', () => {
      seed(dm, [], [[1, { status: 'deferred' }]])

      expect(dm.finalizeDeferred()).toEqual([])
      expect(dm.getMergeStatus(1)).toBeNull()
    })
  })

  it("'deferred' survives a queue.json round-trip (crash recovery)", () => {
    seed(dm, [makeItem({ status: 'completed' })], [[1, { status: 'deferred' }]])
    ;(dm as unknown as Internals).persistQueue()

    const restored = new DownloadManager(downloadDir, {} as never, userDataDir)
    try {
      restored.loadQueue()
      expect(restored.getMergeStatus(1)).toBe('deferred')
    } finally {
      restored.destroy()
    }
  })

  it('mergeCompleted never touches a deferred episode (file is still .part)', async () => {
    putPartOnDisk()
    seed(dm, [makeItem({ status: 'completed' })], [[1, { status: 'deferred' }]])

    await dm.mergeCompleted('/nonexistent/ffmpeg', '/nonexistent/ffprobe')

    expect(dm.getMergeStatus(1)).toBe('deferred')
    expect(fs.existsSync(partPath())).toBe(true)
  })

  it('mergeCompleted re-defers an episode the player grabbed after finalize (two-way lock)', async () => {
    // Finalized: the video sits at its final path, merge would normally run —
    // but the player opened it in the finalize → merge window.
    fs.mkdirSync(path.dirname(videoPath()), { recursive: true })
    fs.writeFileSync(videoPath(), 'video-bytes')
    seed(dm, [makeItem({ status: 'completed' })], [[1, { status: 'pending' }]])
    dm.setFileLockCheck(() => true)

    await dm.mergeCompleted('/nonexistent/ffmpeg', '/nonexistent/ffprobe')

    // Without the lock check this would be 'failed' (ffmpeg path is fake) —
    // 'deferred' proves the group was skipped before any merge attempt.
    expect(dm.getMergeStatus(1)).toBe('deferred')
    expect(fs.readFileSync(videoPath(), 'utf-8')).toBe('video-bytes')

    // Lock released → finalizeDeferred re-queues it (nothing left to rename).
    dm.setFileLockCheck(() => false)
    expect(dm.finalizeDeferred()).toEqual([1])
    expect(dm.getMergeStatus(1)).toBe('pending')
  })

  describe('path/queue lookups for the protocol handler and player', () => {
    it('getActiveDownloadByPath resolves both the .part and the final path', () => {
      seed(dm, [makeItem({ status: 'downloading', bytesReceived: 10, totalBytes: 100 })])
      for (const p of [partPath(), videoPath()]) {
        const hit = dm.getActiveDownloadByPath(p)
        expect(hit).toEqual({ bytesReceived: 10, totalBytes: 100, status: 'downloading' })
      }
      expect(dm.getActiveDownloadByPath(path.join(downloadDir, 'other.mp4'))).toBeNull()
    })

    it('getPartialVideoPath returns the queue-derived .part path with the expected size', () => {
      seed(dm, [makeItem({ status: 'downloading', totalBytes: 100 })])
      expect(dm.getPartialVideoPath(1)).toEqual({
        partPath: partPath(),
        totalBytes: 100,
        status: 'downloading'
      })
    })

    it('getPartialVideoPath refuses dead or size-unknown downloads', () => {
      seed(dm, [makeItem({ status: 'failed', totalBytes: 100 })])
      expect(dm.getPartialVideoPath(1)).toBeNull()

      seed(dm, [makeItem({ status: 'downloading', totalBytes: 0 })])
      expect(dm.getPartialVideoPath(1)).toBeNull()
    })
  })
})
