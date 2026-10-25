// Merge hold (#516), at the cycle level: while a player view is open no new
// merge starts, an in-flight one finishes, the held request survives in
// `heldRequest` instead of re-entering the cycle, and the release path merges
// what was held exactly once whichever release — player lock or player view —
// lands first. Also the boot-time fallback for a truncated `.mkv`.
//
// `runFfmpeg` is replaced by a hand-settled promise, as in
// `download-manager-merge-scheduling.test.ts`; the real `runFfmpeg` body is
// exercised in `download-manager-run-ffmpeg.test.ts`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'
import { createPlayerLockService } from '../../src/main/services/player-lock'
import { createPlayerPresenceService } from '../../src/main/services/player-presence'
import {
  createEpisodeCompletionHandlers,
  type EpisodeCompletionStore
} from '../../src/main/lib/episode-completion'

const FFMPEG = '/fake/ffmpeg'
const FFPROBE = '/fake/ffprobe'

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: 'ep1.mp4',
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
  runFfmpeg: (opts: { videoPath: string; outputPath: string }) => Promise<void>
  activeFfmpegCmd: { kill: (signal: string) => void } | null
  activeMergeTranslationId: number | null
  merging: boolean
  _mergeAll: (...args: unknown[]) => Promise<boolean>
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

interface MergeCall {
  videoPath: string
  resolve: () => void
  reject: (err: Error) => void
}

/** Same shape as the merge-scheduling stub: settled by hand, kill() rejects. */
function stubFfmpeg(dm: DownloadManager): MergeCall[] {
  const internals = dm as unknown as Internals
  const calls: MergeCall[] = []
  internals.runFfmpeg = (opts) =>
    new Promise<void>((resolve, reject) => {
      const settle = (finish: () => void): void => {
        internals.activeFfmpegCmd = null
        internals.activeMergeTranslationId = null
        finish()
      }
      const call: MergeCall = {
        videoPath: opts.videoPath,
        resolve: () => settle(resolve),
        reject: (err) => settle(() => reject(err))
      }
      calls.push(call)
      internals.activeFfmpegCmd = {
        kill: () => call.reject(new Error('ffmpeg was killed with signal SIGKILL'))
      }
    })
  return calls
}

/** Counts merge passes without changing them. */
function countPasses(dm: DownloadManager): { passes: number } {
  const internals = dm as unknown as Internals
  const counter = { passes: 0 }
  const original = internals._mergeAll.bind(dm)
  internals._mergeAll = (...args) => {
    counter.passes++
    return original(...args)
  }
  return counter
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * A hold check that throws once it has been asked more often than any finite
 * pass could ask it. A held pass that re-entered the cycle would spin on
 * microtasks — which starves timers, so a timeout could never fire — and this
 * turns that spin into a rejection instead of a hung run.
 */
function spinGuardedHold(): { held: boolean; isHeld: () => boolean } {
  const state: { held: boolean; isHeld: () => boolean } = {
    held: false,
    isHeld: spinGuard((): boolean => state.held)
  }
  return state
}

function spinGuard(isHeld: () => boolean): () => boolean {
  let checks = 0
  return () => {
    if (++checks > 50) throw new Error('merge cycle spun on the hold check')
    return isHeld()
  }
}

describe('DownloadManager merge hold (#516)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-hold-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-hold-dl-'))
    dm = new DownloadManager(downloadDir, {} as never, userDataDir)
  })

  afterEach(() => {
    dm.destroy()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  const putFile = (rel: string): string => {
    const abs = path.join(downloadDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'bytes')
    return abs
  }

  const episodeA = (): DownloadItem =>
    makeItem({ id: 'video-1', translationId: 1, filename: 'ep1.mp4', episodeLabel: 'ep1' })
  const episodeB = (): DownloadItem =>
    makeItem({
      id: 'video-2',
      translationId: 2,
      filename: 'ep2.mp4',
      episodeLabel: 'ep2',
      episodeInt: '2'
    })

  const statusOf = (tid: number): MergeStatus | undefined =>
    dm.getEpisodeGroups().find((g) => g.translationId === tid)?.mergeStatus

  it('resolves under the hold without starting ffmpeg, and records the held request', async () => {
    putFile('ep1.mp4')
    seed(dm, [episodeA()])
    const calls = stubFfmpeg(dm)
    const hold = spinGuardedHold()
    hold.held = true
    dm.setMergeHoldCheck(hold.isHeld)
    const passes = countPasses(dm)

    await dm.mergeCompleted(FFMPEG, FFPROBE)

    expect(calls).toHaveLength(0)
    expect((dm as unknown as Internals).merging).toBe(false)
    expect(passes.passes).toBe(1)
    expect(statusOf(1)).toBe('pending')
    expect(dm.takeHeldRequest()).toBe(true)
    // Taking it clears it.
    expect(dm.takeHeldRequest()).toBe(false)
  })

  it('records no held request when nothing eligible was waiting', async () => {
    seed(dm, [])
    const hold = spinGuardedHold()
    hold.held = true
    dm.setMergeHoldCheck(hold.isHeld)
    await dm.mergeCompleted(FFMPEG, FFPROBE)
    expect(dm.takeHeldRequest()).toBe(false)
  })

  it('lets the in-flight merge finish, starts nothing after it, and ends the cycle held', async () => {
    const aPath = putFile('ep1.mp4')
    putFile('ep2.mp4')
    seed(dm, [episodeA(), episodeB()])
    const calls = stubFfmpeg(dm)
    const hold = spinGuardedHold()
    dm.setMergeHoldCheck(hold.isHeld)
    const passes = countPasses(dm)
    const completed: string[] = []
    dm.onMergeComplete((info) => {
      completed.push(info.mkvFilename)
    })

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    expect(calls.map((c) => c.videoPath)).toEqual([aPath])

    // The player opens mid-merge, and another episode's completion arrives.
    hold.held = true
    await dm.mergeCompleted(FFMPEG, FFPROBE)
    calls[0].resolve()
    await cycle

    expect(dm.getMergeStatus(1)).toBe('completed')
    expect(fs.existsSync(aPath)).toBe(false)
    expect(completed).toEqual(['ep1.mkv'])
    expect(calls).toHaveLength(1)
    expect(statusOf(2)).toBe('pending')
    // One pass: the requested rerun did not re-enter a held cycle.
    expect(passes.passes).toBe(1)
    expect(dm.takeHeldRequest()).toBe(true)
  })

  it('drains a requested rerun normally once the hold is down again', async () => {
    const aPath = putFile('ep1.mp4')
    const bPath = putFile('ep2.mp4')
    seed(dm, [episodeA(), episodeB()])
    const calls = stubFfmpeg(dm)
    const hold = spinGuardedHold()
    dm.setMergeHoldCheck(hold.isHeld)

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    calls[0].resolve()
    await flush()
    calls[1].resolve()
    await cycle
    expect(calls.map((c) => c.videoPath)).toEqual([aPath, bPath])
    expect(dm.takeHeldRequest()).toBe(false)
  })

  describe('scanAndMerge', () => {
    it('stops before the first file under the hold and reports what it left', async () => {
      putFile(path.join('Show', 'a.mp4'))
      putFile(path.join('Show', 'b.mp4'))
      const calls = stubFfmpeg(dm)
      dm.setMergeHoldCheck(spinGuard(() => true))

      const result = await dm.scanAndMerge(FFMPEG, FFPROBE)

      expect(calls).toHaveLength(0)
      expect(result).toEqual({
        merged: 0,
        failed: ['Merging is paused while the player is open: 2 files left']
      })
      expect(dm.takeHeldRequest()).toBe(true)
    })

    it('finishes the file in flight and stops before the next one', async () => {
      putFile(path.join('Show', 'a.mp4'))
      putFile(path.join('Show', 'b.mp4'))
      const calls = stubFfmpeg(dm)
      let held = false
      dm.setMergeHoldCheck(spinGuard(() => held))

      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await flush()
      expect(calls).toHaveLength(1)
      held = true
      calls[0].resolve()
      const result = await scan

      expect(calls).toHaveLength(1)
      expect(result).toEqual({
        merged: 1,
        failed: ['Merging is paused while the player is open: 1 file left']
      })
    })
  })

  describe('a runFfmpeg that settles after destroy()', () => {
    // The real runFfmpeg rejects on 'end' once destroyed (see the run-ffmpeg
    // test); these pin the loop guards on their own, with that guard absent.
    it('starts no further group in the pass', async () => {
      putFile('ep1.mp4')
      putFile('ep2.mp4')
      seed(dm, [episodeA(), episodeB()])
      const calls = stubFfmpeg(dm)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      ;(dm as unknown as Internals).activeFfmpegCmd = null
      dm.destroy()
      calls[0].resolve()
      await flush()
      // Before awaiting the cycle: a second merge would leave it pending.
      expect(calls).toHaveLength(1)
      await cycle
    })

    it('does not re-enter the cycle on a request that arrived during the merge', async () => {
      putFile('ep1.mp4')
      seed(dm, [episodeA()])
      const calls = stubFfmpeg(dm)
      const passes = countPasses(dm)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      ;(dm as unknown as Internals).activeFfmpegCmd = null
      dm.destroy()
      calls[0].resolve()
      await cycle
      expect(passes.passes).toBe(1)
    })

    it('starts no new cycle once destroyed', async () => {
      putFile('ep1.mp4')
      seed(dm, [episodeA()])
      const calls = stubFfmpeg(dm)
      const passes = countPasses(dm)
      dm.destroy()
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      expect(passes.passes).toBe(0)
      expect(calls).toHaveLength(0)
    })

    it('starts no further scan file', async () => {
      putFile(path.join('Show', 'a.mp4'))
      putFile(path.join('Show', 'b.mp4'))
      const calls = stubFfmpeg(dm)

      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await flush()
      ;(dm as unknown as Internals).activeFfmpegCmd = null
      dm.destroy()
      calls[0].resolve()
      await flush()
      expect(calls).toHaveLength(1)
      await scan
    })
  })

  describe('release order — player lock and player view (#63 + #516)', () => {
    // A is the episode being watched: deferred under the player lock. B
    // finished while the player was open and stopped at the hold. Wired the
    // way `src/main/index.ts` wires them, with the real lock and presence
    // services and the real completion handlers.
    function setup(): {
      calls: MergeCall[]
      aFile: string
      releaseLock: () => void
      releaseView: () => void
    } {
      const aFile = path.join(downloadDir, 'ep1.mp4')
      putFile('ep1.mp4.part')
      putFile('ep2.mp4')
      seed(dm, [episodeA(), episodeB()], [[1, 'deferred']])
      const calls = stubFfmpeg(dm)

      const lock = createPlayerLockService()
      const presence = createPlayerPresenceService()
      const store = {
        get: ((key: string) =>
          key === 'autoMerge' ? true : key === 'videoCodec' ? 'copy' : undefined) as never,
        set: () => {}
      } as unknown as EpisodeCompletionStore
      const handlers = createEpisodeCompletionHandlers({
        store,
        downloadManager: dm,
        fileScanner: { invalidate: () => {} },
        coldStorageService: {
          isAdvanced: () => false,
          moveEpisodeToColdStorage: async () => {},
          moveFileToColdByRelPath: async () => {}
        },
        skipAnalysisService: { scheduleAutoSkipAnalysis: () => {} },
        mp4StatsService: { recordCheck: async () => {} },
        ffmpegReady: Promise.resolve({ available: true }),
        getFfmpegPath: () => FFMPEG,
        getFfprobePath: () => FFPROBE,
        notify: () => {}
      })
      dm.setFileLockCheck(lock.isLocked)
      dm.setMergeHoldCheck(spinGuard(presence.isOpen))
      lock.onRelease(() => void handlers.finalizeDeferredEpisodes())
      presence.onRelease(() => void handlers.resumeHeldMerges())

      const sender = { id: 7, once: () => {}, on: () => {} }
      presence.open(sender as never)
      lock.open(aFile)
      return {
        calls,
        aFile,
        releaseLock: () => lock.close(aFile),
        releaseView: () => presence.close(7)
      }
    }

    /** Settles every merge as it starts, until the queue is quiet. */
    async function drain(calls: MergeCall[]): Promise<void> {
      let settled = 0
      for (let i = 0; i < 10; i++) {
        await flush()
        while (settled < calls.length) calls[settled++].resolve()
      }
    }

    const merged = (calls: MergeCall[]): string[] =>
      calls.map((c) => path.basename(c.videoPath)).sort()

    it('lock release first, then view release: each episode merges once', async () => {
      const { calls, aFile, releaseLock, releaseView } = setup()
      // B's completion arrived while the player was open.
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      expect(calls).toHaveLength(0)

      releaseLock()
      await flush()
      // The finalize pass ran under the view hold: A renamed, nothing merged.
      expect(fs.existsSync(aFile)).toBe(true)
      expect(dm.getMergeStatus(1)).toBe('pending')
      expect(calls).toHaveLength(0)

      releaseView()
      await drain(calls)
      expect(merged(calls)).toEqual(['ep1.mp4', 'ep2.mp4'])
      expect(dm.getMergeStatus(1)).toBe('completed')
      expect(dm.getMergeStatus(2)).toBe('completed')
    })

    it('view release first, then lock release: each episode merges once', async () => {
      const { calls, aFile, releaseLock, releaseView } = setup()
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      expect(calls).toHaveLength(0)

      releaseView()
      await flush()
      // The resumed pass merges B and skips A, which is still deferred.
      expect(merged(calls)).toEqual(['ep2.mp4'])
      expect(dm.getMergeStatus(1)).toBe('deferred')

      releaseLock()
      await drain(calls)
      expect(fs.existsSync(aFile)).toBe(false)
      expect(merged(calls)).toEqual(['ep1.mp4', 'ep2.mp4'])
      expect(dm.getMergeStatus(1)).toBe('completed')
      expect(dm.getMergeStatus(2)).toBe('completed')
    })
  })

  describe('boot-time fallback for a truncated .mkv', () => {
    function writeQueue(status: MergeStatus): void {
      fs.writeFileSync(
        path.join(userDataDir, 'queue.json'),
        JSON.stringify({
          queue: [makeItem({ filename: path.join('Show', 'ep1.mp4') })],
          mergeStatuses: { '1': { status, percent: 40 } }
        })
      )
    }

    it('removes the .mkv and resets to pending when the source .mp4 is still there', () => {
      putFile(path.join('Show', 'ep1.mp4'))
      const mkv = putFile(path.join('Show', 'ep1.mkv'))
      writeQueue('merging')

      const booted = new DownloadManager(downloadDir, {} as never, userDataDir)
      booted.loadQueue()
      booted.destroy()

      expect(fs.existsSync(mkv)).toBe(false)
      expect(booted.getMergeStatus(1)).toBe('pending')
    })

    it('leaves the .mkv alone when the .mp4 is gone', () => {
      const mkv = putFile(path.join('Show', 'ep1.mkv'))
      writeQueue('merging')

      const booted = new DownloadManager(downloadDir, {} as never, userDataDir)
      booted.loadQueue()
      booted.destroy()

      expect(fs.existsSync(mkv)).toBe(true)
      expect(booted.getMergeStatus(1)).toBe('pending')
    })

    it('touches nothing for a merge that was not in flight', () => {
      putFile(path.join('Show', 'ep1.mp4'))
      const mkv = putFile(path.join('Show', 'ep1.mkv'))
      writeQueue('failed')

      const booted = new DownloadManager(downloadDir, {} as never, userDataDir)
      booted.loadQueue()
      booted.destroy()

      expect(fs.existsSync(mkv)).toBe(true)
      expect(booted.getMergeStatus(1)).toBe('failed')
    })
  })
})
