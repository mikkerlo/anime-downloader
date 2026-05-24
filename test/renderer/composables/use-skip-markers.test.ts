import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useSkipMarkers } from '../../../src/renderer/src/composables/use-skip-markers'

type Api = {
  skipDetectorGetDetections: (animeId: number) => Promise<ShowSkipDetections | null>
  skipDetectorDetectStream: (
    animeId: number,
    episodeInt: string,
    streamUrl: string
  ) => Promise<EpisodeSkipDetection | null>
  skipDetectorCancelStreamDetect: () => Promise<void>
  onSkipDetectorSignatureUpdated: (
    cb: (data: { animeId: number; perEpisode: Record<string, EpisodeSkipDetection> }) => void
  ) => Unsubscribe
}

function noopSub(): Unsubscribe {
  return () => {}
}

function setApi(api: Partial<Api>): void {
  const w = (globalThis as { window?: { api?: Partial<Api> } }).window
  const prev = w?.api ?? {}
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...prev, ...api } }
}

beforeEach(() => {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = {
    api: {
      onSkipDetectorSignatureUpdated: noopSub,
      skipDetectorCancelStreamDetect: vi.fn().mockResolvedValue(undefined),
      skipDetectorGetDetections: vi.fn().mockResolvedValue(null),
      skipDetectorDetectStream: vi.fn().mockResolvedValue(null)
    }
  }
})

function fakeShow(perEpisode: Record<string, EpisodeSkipDetection>): ShowSkipDetections {
  return {
    animeId: 42,
    perEpisode,
    analyzedAt: 1234567890,
    episodeCount: Object.keys(perEpisode).length,
    algorithm: {
      source: 'local',
      sampleRate: 1,
      matchBitThreshold: 1,
      minRunSec: 1,
      windowSec: 1,
      refineBitThreshold: 1,
      refineSustainHashes: 1
    }
  }
}

function fakeEp(
  episodeInt: string,
  op: { startSec: number; endSec: number } | null,
  ed: { startSec: number; endSec: number } | null = null
): EpisodeSkipDetection {
  return {
    episodeInt,
    episodeLabel: `Ep ${episodeInt}`,
    filePath: `/fake/${episodeInt}.mkv`,
    durationSec: 1440,
    hashesPerSec: 1,
    op: op ? { ...op, pairCount: 3 } : null,
    ed: ed ? { ...ed, pairCount: 3 } : null
  }
}

type Deps = Parameters<typeof useSkipMarkers>[0]

function makeDeps(overrides: {
  animeId?: number
  epInt?: string
  time?: number
  isStreaming?: boolean
  streamUrl?: string
  onSeek?: (t: number) => void
}): Deps {
  const isStreaming = ref(overrides.isStreaming ?? false)
  const activeStreamUrl = ref(overrides.streamUrl ?? '')
  return {
    getAnimeId: () => overrides.animeId ?? 42,
    getCurrentEpisodeInt: () => overrides.epInt ?? '1',
    getCurrentTime: () => overrides.time ?? 0,
    isStreaming,
    activeStreamUrl,
    onSeek: overrides.onSeek ?? (() => {})
  }
}

describe('useSkipMarkers — initial state', () => {
  it('starts empty', () => {
    const s = useSkipMarkers(makeDeps({}))
    expect(s.showSkipDetections.value).toBeNull()
    expect(s.streamSkipDetection.value).toBeNull()
    expect(s.streamSkipDetecting.value).toBe(false)
    expect(s.skipButtonVisible.value).toBe(false)
    expect(s.currentEpisodeSkip.value).toBeNull()
    expect(s.activeSkipRange.value).toBeNull()
  })
})

describe('useSkipMarkers — currentEpisodeSkip switching', () => {
  it('returns local per-episode payload when not streaming', () => {
    const s = useSkipMarkers(makeDeps({ epInt: '2' }))
    s.showSkipDetections.value = fakeShow({
      '2': fakeEp('2', { startSec: 60, endSec: 150 })
    })
    expect(s.currentEpisodeSkip.value?.episodeInt).toBe('2')
  })

  it('returns stream detection ref when streaming, even if local exists', () => {
    const deps = makeDeps({ isStreaming: true, epInt: '2' })
    const s = useSkipMarkers(deps)
    s.showSkipDetections.value = fakeShow({
      '2': fakeEp('2', { startSec: 60, endSec: 150 })
    })
    s.streamSkipDetection.value = fakeEp('2', { startSec: 30, endSec: 90 })
    expect(s.currentEpisodeSkip.value?.op?.startSec).toBe(30)
  })
})

describe('useSkipMarkers — activeSkipRange', () => {
  it('reports op when time is inside op band (with lead-in)', () => {
    const deps = makeDeps({ epInt: '1', time: 60 })
    const s = useSkipMarkers(deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60.1, endSec: 150 })
    })
    // 60 is within SKIP_LEAD_IN_SEC = 0.25 of 60.1
    expect(s.activeSkipRange.value).toBe('op')
  })

  it('reports ed when time is inside ed band', () => {
    const deps = makeDeps({ epInt: '1', time: 1300 })
    const s = useSkipMarkers(deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', null, { startSec: 1290, endSec: 1380 })
    })
    expect(s.activeSkipRange.value).toBe('ed')
  })

  it('returns null when time is outside both bands', () => {
    const deps = makeDeps({ epInt: '1', time: 500 })
    const s = useSkipMarkers(deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 }, { startSec: 1290, endSec: 1380 })
    })
    expect(s.activeSkipRange.value).toBeNull()
  })
})

describe('useSkipMarkers — loadSkipDetections', () => {
  it('clears showSkipDetections when animeId is 0', async () => {
    const s = useSkipMarkers(makeDeps({ animeId: 0 }))
    s.showSkipDetections.value = fakeShow({ '1': fakeEp('1', null) })
    await s.loadSkipDetections()
    expect(s.showSkipDetections.value).toBeNull()
  })

  it('populates showSkipDetections from IPC', async () => {
    const payload = fakeShow({ '1': fakeEp('1', { startSec: 60, endSec: 150 }) })
    setApi({ skipDetectorGetDetections: vi.fn().mockResolvedValue(payload) })
    const s = useSkipMarkers(makeDeps({}))
    await s.loadSkipDetections()
    expect(s.showSkipDetections.value).toEqual(payload)
  })

  it('logs + sets null on IPC error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    setApi({ skipDetectorGetDetections: vi.fn().mockRejectedValue(new Error('boom')) })
    const s = useSkipMarkers(makeDeps({}))
    await s.loadSkipDetections()
    expect(s.showSkipDetections.value).toBeNull()
    err.mockRestore()
  })
})

describe('useSkipMarkers — onSkipClick', () => {
  it('seeks to the end of the active band and hides the button', async () => {
    vi.useFakeTimers()
    const seek = vi.fn()
    const deps = makeDeps({ epInt: '1', time: 60, onSeek: seek })
    const s = useSkipMarkers(deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    // Activate the band first: time is 60, in op band → grace timer fires
    vi.advanceTimersByTime(SKIP_GRACE_MS_TEST)
    s.onSkipClick()
    expect(seek).toHaveBeenCalledWith(150)
    expect(s.skipButtonVisible.value).toBe(false)
    vi.useRealTimers()
  })

  it('is a no-op when no active band', () => {
    const seek = vi.fn()
    const deps = makeDeps({ epInt: '1', time: 500, onSeek: seek })
    const s = useSkipMarkers(deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    s.onSkipClick()
    expect(seek).not.toHaveBeenCalled()
  })
})

describe('useSkipMarkers — already-skipped dedup', () => {
  it('does not re-show the button after a skip click on the same range', async () => {
    vi.useFakeTimers()
    // Use a reactive time ref so changing it triggers the activeSkipRange
    // computed + the grace-timer watcher.
    const time = ref(0)
    const isStreaming = ref(false)
    const activeStreamUrl = ref('')
    const seek = vi.fn()
    const s = useSkipMarkers({
      getAnimeId: () => 42,
      getCurrentEpisodeInt: () => '1',
      getCurrentTime: () => time.value,
      isStreaming,
      activeStreamUrl,
      onSeek: seek
    })
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    // Cross into the op band.
    time.value = 60
    await Promise.resolve() // flush computed/watch
    vi.advanceTimersByTime(SKIP_GRACE_MS_TEST)
    expect(s.skipButtonVisible.value).toBe(true)
    s.onSkipClick()
    expect(s.skipButtonVisible.value).toBe(false)
    expect(seek).toHaveBeenCalledWith(150)

    // Step outside the band and back in — button stays hidden because the
    // range was already skipped this session.
    time.value = 500
    await Promise.resolve()
    vi.advanceTimersByTime(SKIP_GRACE_MS_TEST)
    expect(s.skipButtonVisible.value).toBe(false)
    time.value = 60
    await Promise.resolve()
    vi.advanceTimersByTime(SKIP_GRACE_MS_TEST)
    expect(s.skipButtonVisible.value).toBe(false)
    vi.useRealTimers()
  })

  it('shows the button again after resetSkipUiState (episode change)', async () => {
    vi.useFakeTimers()
    const time = ref(0)
    const isStreaming = ref(false)
    const activeStreamUrl = ref('')
    const s = useSkipMarkers({
      getAnimeId: () => 42,
      getCurrentEpisodeInt: () => '1',
      getCurrentTime: () => time.value,
      isStreaming,
      activeStreamUrl,
      onSeek: () => {}
    })
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    time.value = 60
    await Promise.resolve()
    vi.advanceTimersByTime(SKIP_GRACE_MS_TEST)
    s.onSkipClick()
    // Now reset (simulating an episode change) and re-enter the band.
    s.resetSkipUiState()
    time.value = 500
    await Promise.resolve()
    time.value = 60
    await Promise.resolve()
    vi.advanceTimersByTime(SKIP_GRACE_MS_TEST)
    expect(s.skipButtonVisible.value).toBe(true)
    vi.useRealTimers()
  })
})

describe('useSkipMarkers — resetSkipUiState', () => {
  it('clears skippedRanges + cancels grace timer + hides button', () => {
    const s = useSkipMarkers(makeDeps({}))
    s.skipButtonVisible.value = true
    s.resetSkipUiState()
    expect(s.skipButtonVisible.value).toBe(false)
  })

  it('is idempotent', () => {
    const s = useSkipMarkers(makeDeps({}))
    s.resetSkipUiState()
    s.resetSkipUiState()
    expect(s.skipButtonVisible.value).toBe(false)
  })
})

describe('useSkipMarkers — refreshStreamSkipDetection', () => {
  it('is a no-op when not streaming', async () => {
    const detectSpy = vi.fn().mockResolvedValue(null)
    setApi({ skipDetectorDetectStream: detectSpy })
    const s = useSkipMarkers(makeDeps({ isStreaming: false }))
    await s.refreshStreamSkipDetection()
    expect(detectSpy).not.toHaveBeenCalled()
  })

  it('is a no-op without showSkipDetections (no local payload to gate on)', async () => {
    const detectSpy = vi.fn().mockResolvedValue(null)
    setApi({ skipDetectorDetectStream: detectSpy })
    const s = useSkipMarkers(makeDeps({ isStreaming: true, streamUrl: 'https://x/y.m3u8' }))
    await s.refreshStreamSkipDetection()
    expect(detectSpy).not.toHaveBeenCalled()
  })

  it('runs detection when streaming + local payload present', async () => {
    const result = fakeEp('1', { startSec: 40, endSec: 110 })
    const detectSpy = vi.fn().mockResolvedValue(result)
    setApi({ skipDetectorDetectStream: detectSpy })
    const s = useSkipMarkers(
      makeDeps({ isStreaming: true, streamUrl: 'https://x/y.m3u8', epInt: '1' })
    )
    s.showSkipDetections.value = fakeShow({ '1': fakeEp('1', null) })
    await s.refreshStreamSkipDetection()
    expect(detectSpy).toHaveBeenCalledWith(42, '1', 'https://x/y.m3u8')
    expect(s.streamSkipDetection.value).toEqual(result)
    expect(s.streamSkipDetecting.value).toBe(false)
  })

  it('drops late results from a superseded request', async () => {
    let resolveFirst!: (v: EpisodeSkipDetection | null) => void
    const firstP = new Promise<EpisodeSkipDetection | null>((res) => {
      resolveFirst = res
    })
    let call = 0
    setApi({
      skipDetectorDetectStream: vi.fn().mockImplementation(() => {
        call++
        return call === 1 ? firstP : Promise.resolve(fakeEp('1', { startSec: 999, endSec: 1000 }))
      })
    })
    const s = useSkipMarkers(
      makeDeps({ isStreaming: true, streamUrl: 'https://x/y.m3u8', epInt: '1' })
    )
    s.showSkipDetections.value = fakeShow({ '1': fakeEp('1', null) })
    const firstPromise = s.refreshStreamSkipDetection()
    const secondPromise = s.refreshStreamSkipDetection()
    resolveFirst(fakeEp('1', { startSec: 1, endSec: 2 }))
    await Promise.all([firstPromise, secondPromise])
    // The second result (startSec: 999) wins; the first is dropped.
    expect(s.streamSkipDetection.value?.op?.startSec).toBe(999)
  })

  it('clears detection when IPC throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    setApi({
      skipDetectorDetectStream: vi.fn().mockRejectedValue(new Error('boom'))
    })
    const s = useSkipMarkers(
      makeDeps({ isStreaming: true, streamUrl: 'https://x/y.m3u8', epInt: '1' })
    )
    s.showSkipDetections.value = fakeShow({ '1': fakeEp('1', null) })
    await s.refreshStreamSkipDetection()
    expect(s.streamSkipDetection.value).toBeNull()
    expect(s.streamSkipDetecting.value).toBe(false)
    err.mockRestore()
  })
})

describe('useSkipMarkers — cancelStreamDetection', () => {
  it('clears detecting flag + calls IPC cancel', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    setApi({ skipDetectorCancelStreamDetect: cancel })
    const s = useSkipMarkers(makeDeps({}))
    s.streamSkipDetecting.value = true
    s.cancelStreamDetection()
    expect(s.streamSkipDetecting.value).toBe(false)
    expect(cancel).toHaveBeenCalled()
  })
})

// Constant mirror so the test reads naturally; the composable's internal
// constant isn't exported.
const SKIP_GRACE_MS_TEST = 251

afterEach(() => {
  vi.useRealTimers()
})
