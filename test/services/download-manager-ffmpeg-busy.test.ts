// What Prepare for offline's repair gate reads (#592): a merge holding the
// ffmpeg mutex, and the busy counter around the two IPC handlers that run
// ffmpeg/ffprobe outside the queue (Fix metadata, chapter injection).
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { DownloadManager } from '../../src/main/download-manager'
import { register as registerDownloads } from '../../src/main/ipc/downloads.ipc'
import { register as registerSkipDetector } from '../../src/main/ipc/skip-detector.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { InMemoryStorage } from '../helpers/in-memory-storage'

type Internals = { ffmpegMutex: { acquire(): Promise<() => void> } }

describe('DownloadManager.ffmpegUser / isFfmpegBusy', () => {
  let dir: string
  let dm: DownloadManager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-busy-'))
    dm = new DownloadManager(dir, { getSubtitlesUrl: () => 's' } as never, dir)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('idle: no user', () => {
    expect(dm.ffmpegUser()).toBeNull()
    expect(dm.isFfmpegBusy()).toBe(false)
  })

  it('a merge holding the ffmpeg mutex is a merge', async () => {
    const release = await (dm as unknown as Internals).ffmpegMutex.acquire()
    expect(dm.ffmpegUser()).toBe('merge')
    expect(dm.isFfmpegBusy()).toBe(true)
    release()
    expect(dm.isFfmpegBusy()).toBe(false)
  })

  it('beginFfmpegTask counts until released; the release is idempotent', () => {
    const a = dm.beginFfmpegTask()
    const b = dm.beginFfmpegTask()
    expect(dm.ffmpegUser()).toBe('task')
    a()
    a()
    expect(dm.isFfmpegBusy()).toBe(true)
    b()
    expect(dm.isFfmpegBusy()).toBe(false)
  })
})

describe('the IPC handlers that run ffmpeg outside the queue hold the busy counter', () => {
  let dir: string
  let dm: DownloadManager
  let handlers: Map<string, (...args: unknown[]) => unknown>

  beforeEach(() => {
    ;(ipcMain.handle as Mock).mockClear?.()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-busy-ipc-'))
    dm = new DownloadManager(dir, { getSubtitlesUrl: () => 's' } as never, dir)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function registerWith(seenBusy: boolean[]): void {
    const deps = {
      store: new InMemoryStorage({
        downloadedEpisodes: {},
        downloadedAnime: {},
        skipDetections: {}
      }),
      downloadManager: dm,
      // Read inside each handler body: records whether the counter was held.
      getFfmpegPath: () => {
        seenBusy.push(dm.isFfmpegBusy())
        return ''
      },
      getFfprobePath: () => '',
      coldStorageService: { getDownloadDir: () => dir },
      skipAnalysisService: {},
      broadcast: vi.fn()
    } as unknown as AppDeps
    registerDownloads(deps)
    registerSkipDetector(deps)
    handlers = new Map(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
  }

  it.each([
    [CHANNELS.DOWNLOAD_FIX_METADATA, [] as unknown[]],
    [CHANNELS.DOWNLOAD_INJECT_CHAPTERS, [1, []] as unknown[]]
  ])('%s: busy while its body runs, idle after, even when it throws', async (channel, args) => {
    const seen: boolean[] = []
    registerWith(seen)
    await expect(handlers.get(channel)!({}, ...args)).rejects.toThrow(/not (found|available)/)
    expect(seen).toEqual([true])
    expect(dm.isFfmpegBusy()).toBe(false)
  })
})
