// Merge scheduling (#410): a completion that arrives while a merge pass is
// running must not be dropped, and the two cancel semantics — global Cancel
// ends the whole cycle, a per-episode cancel only skips its own translation —
// must not bleed into each other.
//
// Every case here drives the real `mergeCompleted` / `_mergeAll` / `cancelMerge`
// with `runFfmpeg` replaced by a deferred promise that also publishes a
// `kill()`-able command, so the cancel paths reject the same way a SIGKILL'd
// ffmpeg does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'

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
  /** Where the pass told ffmpeg to write the `.mkv` — the file the catch unlinks. */
  outputPath: string
  resolve: () => void
  reject: (err: Error) => void
}

/**
 * Replaces `runFfmpeg` with a promise the test settles by hand. Mirrors the
 * real one's bookkeeping: `activeFfmpegCmd` is published while the "merge" runs
 * and cleared when it settles, and `kill()` rejects the promise the way
 * fluent-ffmpeg's 'error' event does, so `cancelMerge` exercises its real path.
 */
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
        outputPath: opts.outputPath,
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

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('DownloadManager merge scheduling (#410)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-merge-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-merge-dl-'))
    dm = new DownloadManager(downloadDir, {} as never, userDataDir)
  })

  afterEach(() => {
    dm.destroy()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  /** Writes a video file where the merge pass expects to find it. */
  const putVideo = (rel: string): string => {
    const abs = path.join(downloadDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'video-bytes')
    return abs
  }

  const episodeA = (): DownloadItem =>
    makeItem({ id: 'video-1', translationId: 1, filename: 'ep1.mp4', episodeLabel: 'ep1' })
  const episodeB = (status: DownloadItem['status'] = 'completed'): DownloadItem =>
    makeItem({
      id: 'video-2',
      translationId: 2,
      filename: 'ep2.mp4',
      episodeLabel: 'ep2',
      episodeInt: '2',
      status
    })

  it('merges an episode that finished while another episode was merging (regression: the completion was dropped)', async () => {
    // B is still downloading when the pass starts, so it is absent from the
    // pass's frozen snapshot — the shape of the reported bug. A second pass
    // that reused that snapshot would still miss B.
    const a = episodeA()
    const b = episodeB('downloading')
    const aPath = putVideo('ep1.mp4')
    const bPath = putVideo('ep2.mp4')
    seed(dm, [a, b])
    const calls = stubFfmpeg(dm)

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    expect(calls.map((c) => c.videoPath)).toEqual([aPath])

    // B's download finishes mid-pass: the queue item flips to completed and the
    // episode-complete hook calls mergeCompleted again.
    b.status = 'completed'
    await dm.mergeCompleted(FFMPEG, FFPROBE)
    calls[0].resolve()
    await flush()
    // The follow-up pass re-reads the groups, so B is eligible now.
    expect(calls).toHaveLength(2)
    calls[1].resolve()
    await cycle

    expect(calls.map((c) => c.videoPath)).toEqual([aPath, bPath])
    expect(dm.getMergeStatus(1)).toBe('completed')
    expect(dm.getMergeStatus(2)).toBe('completed')
  })

  it('retries a persistently failing group exactly once per requested rerun, not unboundedly', async () => {
    const a = episodeA()
    putVideo('ep1.mp4')
    seed(dm, [a])
    const calls = stubFfmpeg(dm)

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    // One rerun requested while the pass runs (e.g. another episode finished).
    await dm.mergeCompleted(FFMPEG, FFPROBE)
    calls[0].reject(new Error('nvenc unavailable'))
    await flush()
    expect(calls).toHaveLength(2)
    calls[1].reject(new Error('nvenc unavailable'))
    await cycle

    // 'failed' is eligible again on the next pass, so the bound comes from the
    // requested-rerun count and nothing else.
    expect(calls).toHaveLength(2)
    expect(dm.getMergeStatus(1)).toBe('failed')
  })

  it('ends the cycle on a global Cancel instead of resuming with the requested rerun', async () => {
    const a = episodeA()
    const b = episodeB()
    const aPath = putVideo('ep1.mp4')
    putVideo('ep2.mp4')
    seed(dm, [a, b], [[2, 'pending']])
    const calls = stubFfmpeg(dm)

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    await dm.mergeCompleted(FFMPEG, FFPROBE)
    dm.cancelMerge()
    await flush()
    // Asserted before awaiting the cycle: a follow-up pass that ignored the
    // cancel would leave B's merge in flight, and this pins that as a failed
    // expectation rather than a hang.
    expect(calls.map((c) => c.videoPath)).toEqual([aPath])
    await cycle

    expect(calls.map((c) => c.videoPath)).toEqual([aPath])
    expect(dm.getMergeStatus(1)).toBeNull()
    expect(dm.getMergeStatus(2)).toBe('pending')
  })

  it('honours a global Cancel raised between two groups, with no ffmpeg to kill', async () => {
    const a = episodeA()
    const b = episodeB()
    const aPath = putVideo('ep1.mp4')
    putVideo('ep2.mp4')
    seed(dm, [a, b], [[2, 'pending']])
    const calls = stubFfmpeg(dm)

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    // A's merge has settled, so no command is active; the loop has not yet
    // resumed into B. Cancel here used to be swallowed entirely.
    calls[0].resolve()
    dm.cancelMerge()
    await flush()
    // Asserted before awaiting the cycle: a Cancel that goes missing leaves B's
    // merge in flight, and this pins the miss rather than hanging on it.
    expect(calls.map((c) => c.videoPath)).toEqual([aPath])
    await cycle

    expect(calls.map((c) => c.videoPath)).toEqual([aPath])
    expect(dm.getMergeStatus(1)).toBe('completed')
    expect(dm.getMergeStatus(2)).toBe('pending')
  })

  it('cancelling one episode still merges the rest of the pass, and does not record the cancelled one as failed', async () => {
    const a = episodeA()
    const aSub = makeItem({
      id: 'sub-1',
      translationId: 1,
      kind: 'subtitle',
      filename: 'ep1.ass',
      episodeLabel: 'ep1',
      status: 'downloading'
    })
    const b = episodeB()
    const aPath = putVideo('ep1.mp4')
    const bPath = putVideo('ep2.mp4')
    seed(dm, [a, aSub, b])
    const calls = stubFfmpeg(dm)

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    // The UI path: cancelling episode A while its merge runs. The still
    // downloading subtitle is what carries cancelByEpisode into cancelMerge.
    dm.cancelByEpisode('Anime', 'ep1')
    await flush()
    expect(calls).toHaveLength(2)
    calls[1].resolve()
    await cycle

    expect(calls.map((c) => c.videoPath)).toEqual([aPath, bPath])
    expect(dm.getMergeStatus(2)).toBe('completed')
    // Absent, not 'failed': a 'failed' entry would be eligible again on the
    // next pass and re-merge exactly what the user cancelled.
    expect(dm.getMergeStatus(1)).toBeNull()
  })

  it('hardening: cancelMerge(queued translation) keeps that group out of this pass and the next (no live caller reaches this today)', async () => {
    // cancelByEpisode only calls cancelMerge for a translation whose status is
    // already 'merging', which is always the active one — so this is a contract
    // test for the direct call, not a reproduction of a user-visible bug.
    const a = episodeA()
    const b = episodeB()
    const aPath = putVideo('ep1.mp4')
    putVideo('ep2.mp4')
    seed(dm, [a, b])
    const calls = stubFfmpeg(dm)

    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()
    dm.cancelMerge(2)
    // A rerun request as well, so "neither pass merged B" is a real claim.
    await dm.mergeCompleted(FFMPEG, FFPROBE)
    calls[0].resolve()
    await flush()
    // Same reason as above: if B is merged anyway its stub call never settles.
    expect(calls.map((c) => c.videoPath)).toEqual([aPath])
    await cycle

    expect(calls.map((c) => c.videoPath)).toEqual([aPath])
    expect(dm.getMergeStatus(2)).toBeNull()
  })

  describe('scanAndMerge', () => {
    /** An orphaned .mp4 in an anime subdirectory is what the scan looks for. */
    const putScannable = (): string => {
      const abs = path.join(downloadDir, 'Scanned', 'ep99.mp4')
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, 'video-bytes')
      return abs
    }

    it('reports that a merge is already running instead of a silent zero-merged success', async () => {
      const a = episodeA()
      putVideo('ep1.mp4')
      seed(dm, [a])
      const calls = stubFfmpeg(dm)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      const result = await dm.scanAndMerge(FFMPEG, FFPROBE)
      calls[0].resolve()
      await cycle

      expect(result).toEqual({ merged: 0, failed: ['A merge is already running'] })
    })

    it('merges an episode that finished during the scan, once the scan is done', async () => {
      // B's video sits in the download dir root, which the scan (which walks
      // anime subdirectories) does not see — so only the drain can merge it.
      const b = episodeB('downloading')
      const bPath = putVideo('ep2.mp4')
      const scanned = putScannable()
      seed(dm, [b])
      const calls = stubFfmpeg(dm)

      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await flush()
      expect(calls.map((c) => c.videoPath)).toEqual([scanned])

      b.status = 'completed'
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      calls[0].resolve()
      await flush()
      expect(calls).toHaveLength(2)
      calls[1].resolve()
      const result = await scan

      expect(result.merged).toBe(1)
      expect(calls.map((c) => c.videoPath)).toEqual([scanned, bPath])
      expect(dm.getMergeStatus(2)).toBe('completed')
    })

    it('does not turn a cancelled scan into a resumed auto-merge', async () => {
      const b = episodeB('downloading')
      putVideo('ep2.mp4')
      const scanned = putScannable()
      seed(dm, [b], [[2, 'pending']])
      const calls = stubFfmpeg(dm)

      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await flush()
      b.status = 'completed'
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      dm.cancelMerge()
      await flush()
      // Asserted before awaiting the scan: an unguarded drain starts B's merge
      // here, and its stub never settles, so this pins the resume as a failed
      // expectation rather than a hang.
      expect(calls.map((c) => c.videoPath)).toEqual([scanned])
      await scan

      expect(calls.map((c) => c.videoPath)).toEqual([scanned])
      expect(dm.getMergeStatus(2)).toBe('pending')
    })

    it('drains a completion from the scan even when an earlier cycle ended on a global Cancel (regression: the stale flag skipped the drain)', async () => {
      // Only _mergeAll resets mergeCancelled, so a cycle that ends on a global
      // Cancel leaves the flag up after it returns. A scan that does not reset
      // it reads the stale flag as "this scan was cancelled" and skips the
      // drain, leaving the episode sitting with mergeRequested up.
      const a = episodeA()
      const b = episodeB('downloading')
      const aPath = putVideo('ep1.mp4')
      const bPath = putVideo('ep2.mp4')
      const scanned = putScannable()
      seed(dm, [a, b])
      const calls = stubFfmpeg(dm)

      const cancelled = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      expect(calls.map((c) => c.videoPath)).toEqual([aPath])
      dm.cancelMerge()
      await cancelled
      // The user clears the episode whose merge they just cancelled, so A is
      // out of the drain's eligible set and the assertions below are about B.
      dm.cancel(a.id)

      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await flush()
      expect(calls.map((c) => c.videoPath)).toEqual([aPath, scanned])

      // B finishes mid-scan: mergeCompleted can only record the request,
      // because the scan holds `merging`.
      b.status = 'completed'
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      calls[1].resolve()
      await flush()
      // Asserted before settling: on the stale flag there is no third call and
      // this pins the skipped drain rather than hanging on an unsettled stub.
      expect(calls).toHaveLength(3)
      calls[2].resolve()
      await scan

      expect(calls.map((c) => c.videoPath)).toEqual([aPath, scanned, bPath])
      expect(dm.getMergeStatus(2)).toBe('completed')
    })

    it('hardening: a per-translation cancel raised during the scan does not outlive it (no live caller reaches this today)', async () => {
      // cancelMerge(trId) joins cancelledMerges whenever a cycle is in flight,
      // and a scan counts. cancelByEpisode only reaches it for a translation
      // already 'merging' and the scan never sets that status, so this is a
      // contract test for the direct call: the set must be empty by the drain.
      const b = episodeB('downloading')
      const bPath = putVideo('ep2.mp4')
      const scanned = putScannable()
      seed(dm, [b])
      const calls = stubFfmpeg(dm)

      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await flush()
      dm.cancelMerge(2)

      b.status = 'completed'
      await dm.mergeCompleted(FFMPEG, FFPROBE)
      calls[0].resolve()
      await flush()
      // An entry that survived the scan would skip B's group for this drain.
      expect(calls).toHaveLength(2)
      calls[1].resolve()
      await scan

      expect(calls.map((c) => c.videoPath)).toEqual([scanned, bPath])
      expect(dm.getMergeStatus(2)).toBe('completed')
    })
  })

  // The merge-complete dispatch used to sit inside the ffmpeg try, whose catch
  // `unlinkSync`es the output and records the merge as 'failed'. That made the
  // disposition of a consumer failure depend on one keyword on the far side of
  // a slot typed `=> void`: a rejection from an `async` consumer floated away
  // as an unhandled rejection, while a *synchronous* throw destroyed a
  // successfully merged file and blamed ffmpeg for it. #428 moved the dispatch
  // out of the try and behind a `merged` flag, and routed it through
  // `dispatchHook` so both throw shapes land in the same handler.
  //
  // The two blocks below are the two halves of that. This one is the gate — the
  // dispatch must fire on the success path and on nothing else; the next is the
  // consumer's own failure, which must not come back as a merge failure.
  describe('merge-complete dispatch gate (#428)', () => {
    /** Collects the `mkvFilename` of every merge the hook is told about. */
    const watchHook = (): string[] => {
      const seen: string[] = []
      dm.onMergeComplete((info) => {
        seen.push(info.mkvFilename)
      })
      return seen
    }

    it('fires exactly once for a successful merge (positive control for the gate)', async () => {
      // Without this, every assertion below is satisfied by a gate that is
      // simply always false.
      const seen = watchHook()
      const a = episodeA()
      putVideo('ep1.mp4')
      seed(dm, [a])
      const calls = stubFfmpeg(dm)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      calls[0].resolve()
      await cycle

      expect(seen).toEqual(['ep1.mkv'])
      expect(dm.getMergeStatus(1)).toBe('completed')
    })

    it('does not fire when ffmpeg rejects, and still records the merge as failed', async () => {
      // The reason the dispatch is gated on a flag rather than left as a
      // fall-through after the catch: out here, "the try finished" no longer
      // means "the merge succeeded".
      const seen = watchHook()
      const a = episodeA()
      putVideo('ep1.mp4')
      seed(dm, [a])
      const calls = stubFfmpeg(dm)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      calls[0].reject(new Error('nvenc unavailable'))
      await cycle

      expect(seen).toEqual([])
      expect(dm.getMergeStatus(1)).toBe('failed')
    })

    it('does not fire for a per-translation cancel, and still fires for the rest of the pass', async () => {
      // The cancel lands in the catch's `mergeCancelled || cancelledMerges`
      // branch, which deletes the status rather than recording 'failed' — so
      // the gate has to hold for that branch too, while B still completes.
      const seen = watchHook()
      const a = episodeA()
      const aSub = makeItem({
        id: 'sub-1',
        translationId: 1,
        kind: 'subtitle',
        filename: 'ep1.ass',
        episodeLabel: 'ep1',
        status: 'downloading'
      })
      const b = episodeB()
      putVideo('ep1.mp4')
      putVideo('ep2.mp4')
      seed(dm, [a, aSub, b])
      const calls = stubFfmpeg(dm)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      dm.cancelByEpisode('Anime', 'ep1')
      await flush()
      expect(calls).toHaveLength(2)
      calls[1].resolve()
      await cycle

      expect(seen).toEqual(['ep2.mkv'])
      expect(dm.getMergeStatus(1)).toBeNull()
      expect(dm.getMergeStatus(2)).toBe('completed')
    })

    it('does not fire for a global cancel', async () => {
      const seen = watchHook()
      const a = episodeA()
      putVideo('ep1.mp4')
      seed(dm, [a])
      // `cancelMerge()` kills the active command, which rejects the stub — so
      // the cycle settles without the test resolving anything by hand.
      stubFfmpeg(dm)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      dm.cancelMerge()
      await cycle

      expect(seen).toEqual([])
      expect(dm.getMergeStatus(1)).toBeNull()
    })
  })

  describe('merge-complete consumer failures (#428)', () => {
    /**
     * Collects process-level unhandled rejections for the duration of one test.
     * Vitest fails a run on an unhandled rejection anyway, but asserting it
     * here says which dispatch is responsible instead of failing the file.
     */
    function captureUnhandled(): { seen: unknown[]; stop: () => void } {
      const seen: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        seen.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      return { seen, stop: () => process.off('unhandledRejection', onUnhandled) }
    }

    /** Runs one group to a successful merge with `consumer` in the hook slot. */
    async function mergeWith(
      consumer: (info: { mkvFilename: string }) => void | Promise<void>
    ): Promise<{ outputPath: string }> {
      const a = episodeA()
      putVideo('ep1.mp4')
      seed(dm, [a])
      const calls = stubFfmpeg(dm)
      dm.onMergeComplete(consumer)

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      // What ffmpeg would have left behind. The point of these two cases is
      // that this file is still here afterwards.
      fs.writeFileSync(calls[0].outputPath, 'merged-bytes')
      calls[0].resolve()
      await cycle
      // Let a rejected consumer promise settle into dispatchHook's `.catch`.
      await flush()
      return { outputPath: calls[0].outputPath }
    }

    it('keeps the merged .mkv and the completed status when the consumer throws synchronously', async () => {
      const watch = captureUnhandled()
      try {
        const { outputPath } = await mergeWith(() => {
          throw new Error('cold move exploded')
        })

        // Before #428 this is the destructive case: the throw fell into the
        // ffmpeg catch, which unlinked the .mkv and recorded 'failed'.
        expect(fs.existsSync(outputPath)).toBe(true)
        expect(dm.getMergeStatus(1)).toBe('completed')
        expect(watch.seen).toEqual([])
      } finally {
        watch.stop()
      }
    })

    it('keeps the merged .mkv and the completed status when the consumer rejects', async () => {
      const watch = captureUnhandled()
      try {
        const { outputPath } = await mergeWith(async () => {
          throw new Error('cold move rejected')
        })

        expect(fs.existsSync(outputPath)).toBe(true)
        expect(dm.getMergeStatus(1)).toBe('completed')
        // The half that was never destructive but was never observed either:
        // an un-awaited rejection used to escape the manager entirely.
        expect(watch.seen).toEqual([])
      } finally {
        watch.stop()
      }
    })

    it('still merges the next group after a consumer failure', async () => {
      // The failure is the consumer's, not the pass's — a cycle that aborted on
      // it would strand every queued merge behind one broken handler.
      const a = episodeA()
      const b = episodeB()
      const aPath = putVideo('ep1.mp4')
      const bPath = putVideo('ep2.mp4')
      seed(dm, [a, b])
      const calls = stubFfmpeg(dm)
      dm.onMergeComplete(() => {
        throw new Error('cold move exploded')
      })

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      calls[0].resolve()
      await flush()
      expect(calls).toHaveLength(2)
      calls[1].resolve()
      await cycle

      expect(calls.map((c) => c.videoPath)).toEqual([aPath, bPath])
      expect(dm.getMergeStatus(1)).toBe('completed')
      expect(dm.getMergeStatus(2)).toBe('completed')
    })
  })
})
