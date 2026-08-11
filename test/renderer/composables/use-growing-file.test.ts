// use-growing-file (#63): the seek clamp must derive from the element's
// buffered ranges (time domain), never from the byte ratio — bytes are
// display-only. Also covers the waiting flag and terminal download states.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  useGrowingFile,
  GROWING_SEEK_MARGIN_SEC
} from '../../../src/renderer/src/composables/use-growing-file'
import { useDownloadsStore } from '../../../src/renderer/src/stores/downloads'

type VideoStub = Pick<HTMLVideoElement, 'buffered' | 'currentTime'>

function noopSub(): () => void {
  return () => {}
}

beforeEach(() => {
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      onDownloadProgress: noopSub,
      onScanMergeProgress: noopSub,
      onFixMetadataProgress: noopSub
    }
  }
  setActivePinia(createPinia())
})

function makeVideo(bufferedEnd: number | null, currentTime = 0): VideoStub {
  return {
    currentTime,
    buffered:
      bufferedEnd === null
        ? ({ length: 0 } as TimeRanges)
        : ({ length: 1, start: () => 0, end: () => bufferedEnd } as unknown as TimeRanges)
  } as VideoStub
}

function makeGrowing(opts: {
  filePath?: string
  video?: VideoStub | null
  downloadStatus?: string
  bytesReceived?: number
  totalBytes?: number
  fetchSubtitles?: () => Promise<string | null>
}): ReturnType<typeof useGrowingFile> {
  const store = useDownloadsStore()
  if (opts.downloadStatus) {
    store.groups = [
      {
        translationId: 7,
        video: {
          status: opts.downloadStatus,
          bytesReceived: opts.bytesReceived ?? 0,
          totalBytes: opts.totalBytes ?? 0
        }
      } as unknown as EpisodeGroup
    ]
  }
  return useGrowingFile({
    activeFilePath: ref(opts.filePath ?? '/dl/anime/ep.mp4.part'),
    activeTranslationId: ref(7),
    getVideoEl: () => opts.video ?? null,
    fetchSubtitles: opts.fetchSubtitles,
    subtitlePollMs: 10
  })
}

describe('isPartial', () => {
  it('is true only for .part paths', () => {
    expect(makeGrowing({ filePath: '/dl/ep.mp4.part' }).isPartial.value).toBe(true)
    expect(makeGrowing({ filePath: '/dl/ep.mp4' }).isPartial.value).toBe(false)
    expect(makeGrowing({ filePath: '' }).isPartial.value).toBe(false)
  })
})

describe('clampSeekTarget — buffered-derived, never byte-derived', () => {
  it('passes targets through untouched for a normal local file', () => {
    const g = makeGrowing({ filePath: '/dl/ep.mp4', video: makeVideo(10, 0) })
    expect(g.clampSeekTarget(9999)).toBe(9999)
  })

  it('clamps to buffered end minus the margin on a growing .part', () => {
    const g = makeGrowing({
      video: makeVideo(120, 30),
      downloadStatus: 'downloading',
      bytesReceived: 999_999,
      totalBytes: 1_000_000 // byte ratio ~100% — must NOT lift the clamp
    })
    expect(g.clampSeekTarget(500)).toBe(120 - GROWING_SEEK_MARGIN_SEC)
  })

  it('leaves targets inside the buffered frontier alone', () => {
    const g = makeGrowing({ video: makeVideo(120, 30), downloadStatus: 'downloading' })
    expect(g.clampSeekTarget(60)).toBe(60)
  })

  it('never clamps below the current playhead', () => {
    const g = makeGrowing({ video: makeVideo(10, 50), downloadStatus: 'downloading' })
    expect(g.clampSeekTarget(200)).toBe(50)
  })

  // #237: these three pin the unknown-frontier pass-through. Before the fix
  // `frontier()` reported 0 for both branches of its single `return`, so the
  // limit collapsed to the playhead and every forward seek on a fresh .part was
  // snapped back to where it already was — the "skip opening does nothing"
  // symptom. The clamp resumes as soon as one buffered range exists (above).
  it('passes the target through when nothing is buffered yet', () => {
    const g = makeGrowing({ video: makeVideo(null, 0), downloadStatus: 'downloading' })
    expect(g.clampSeekTarget(42)).toBe(42) // old behavior: 0
  })

  it('passes through rather than raising the floor to a non-zero playhead', () => {
    // Looks identical to the "never clamps below the current playhead" case
    // above at a glance, but there buffered.length is 1, so its floor applies.
    const g = makeGrowing({ video: makeVideo(null, 50), downloadStatus: 'downloading' })
    expect(g.clampSeekTarget(200)).toBe(200) // old behavior: 50
  })

  it('passes the target through when there is no element at all', () => {
    // Reachable from the scrubber drag-release path (PlayerView onSeekEnd),
    // which calls clampSeekTarget without seek()'s early return.
    const g = makeGrowing({ video: null, downloadStatus: 'downloading' })
    expect(g.clampSeekTarget(42)).toBe(42) // old behavior: 0
  })

  it('lifts the clamp once the download completes', () => {
    const g = makeGrowing({ video: makeVideo(10, 0), downloadStatus: 'completed' })
    expect(g.clampSeekTarget(500)).toBe(500)
  })
})

describe('download state projections', () => {
  it('byte ratio is exposed as a display percentage', () => {
    const g = makeGrowing({
      downloadStatus: 'downloading',
      bytesReceived: 25,
      totalBytes: 100
    })
    expect(g.downloadProgressPct.value).toBe(25)
  })

  it('shows 0% when the total size is unknown', () => {
    const g = makeGrowing({ downloadStatus: 'downloading', bytesReceived: 25, totalBytes: 0 })
    expect(g.downloadProgressPct.value).toBe(0)
  })

  it('flags a dead download (failed / cancelled)', () => {
    expect(makeGrowing({ downloadStatus: 'failed' }).downloadDead.value).toBe(true)
    expect(makeGrowing({ downloadStatus: 'cancelled' }).downloadDead.value).toBe(true)
    expect(makeGrowing({ downloadStatus: 'downloading' }).downloadDead.value).toBe(false)
  })
})

describe('waiting-for-download flag', () => {
  it('sets on waiting while partial and clears on playing', () => {
    const g = makeGrowing({ downloadStatus: 'downloading' })
    g.onWaiting()
    expect(g.waitingForDownload.value).toBe(true)
    g.onPlaying()
    expect(g.waitingForDownload.value).toBe(false)
  })

  it('does not set for a normal file, a completed download, or a dead one', () => {
    const normal = makeGrowing({ filePath: '/dl/ep.mp4' })
    normal.onWaiting()
    expect(normal.waitingForDownload.value).toBe(false)

    const done = makeGrowing({ downloadStatus: 'completed' })
    done.onWaiting()
    expect(done.waitingForDownload.value).toBe(false)

    const dead = makeGrowing({ downloadStatus: 'failed' })
    dead.onWaiting()
    expect(dead.waitingForDownload.value).toBe(false)
  })
})

describe('late subtitle load — polling for the sibling .ass', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hot-attaches the subtitle once it lands, then stops polling', async () => {
    const results: (string | null)[] = [null, null, 'Dialogue: subs']
    const fetchSubtitles = vi.fn(async () => results.shift() ?? null)
    const onFound = vi.fn()
    const g = makeGrowing({ downloadStatus: 'downloading', fetchSubtitles })

    g.startSubtitlePolling(onFound)
    await vi.advanceTimersByTimeAsync(35)

    expect(onFound).toHaveBeenCalledExactlyOnceWith('Dialogue: subs')
    const calls = fetchSubtitles.mock.calls.length
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchSubtitles).toHaveBeenCalledTimes(calls)
  })

  it('gives up once the download is done and the .ass still is not there', async () => {
    const fetchSubtitles = vi.fn(async () => null)
    const onFound = vi.fn()
    const g = makeGrowing({ downloadStatus: 'completed', fetchSubtitles })

    g.startSubtitlePolling(onFound)
    await vi.advanceTimersByTimeAsync(50)

    expect(onFound).not.toHaveBeenCalled()
    expect(fetchSubtitles).toHaveBeenCalledTimes(1)
  })

  it('never starts for a non-partial session', async () => {
    const fetchSubtitles = vi.fn(async () => 'subs')
    const g = makeGrowing({ filePath: '/dl/ep.mp4', fetchSubtitles })

    g.startSubtitlePolling(vi.fn())
    await vi.advanceTimersByTimeAsync(50)

    expect(fetchSubtitles).not.toHaveBeenCalled()
  })

  it('stopSubtitlePolling halts the poll (player unmount / file switch)', async () => {
    const fetchSubtitles = vi.fn(async () => null)
    const g = makeGrowing({ downloadStatus: 'downloading', fetchSubtitles })

    g.startSubtitlePolling(vi.fn())
    await vi.advanceTimersByTimeAsync(25)
    expect(fetchSubtitles.mock.calls.length).toBeGreaterThan(0)

    g.stopSubtitlePolling()
    const calls = fetchSubtitles.mock.calls.length
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchSubtitles).toHaveBeenCalledTimes(calls)
  })
})
