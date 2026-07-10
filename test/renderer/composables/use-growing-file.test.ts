// use-growing-file (#63): the seek clamp must derive from the element's
// buffered ranges (time domain), never from the byte ratio — bytes are
// display-only. Also covers the waiting flag and terminal download states.

import { describe, it, expect, beforeEach } from 'vitest'
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
    getVideoEl: () => opts.video ?? null
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

  it('clamps to the playhead when nothing is buffered yet', () => {
    const g = makeGrowing({ video: makeVideo(null, 0), downloadStatus: 'downloading' })
    expect(g.clampSeekTarget(42)).toBe(0)
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
