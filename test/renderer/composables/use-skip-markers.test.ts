import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
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
    getPlayheadTime: () => overrides.time ?? 0,
    isStreaming,
    activeStreamUrl,
    onSeek: overrides.onSeek ?? (() => {})
  }
}

/**
 * Reactive harness for anything that depends on `activeSkipRange` changing.
 * `makeDeps` reads a static `time`, so its `getCurrentTime` never invalidates
 * the computed and `watch(activeSkipRange, …)` never re-fires — the grace-timer
 * half of the button contract is unobservable through it.
 *
 * `time` is the display ref (what `activeSkipRange` reads); `playhead` is the
 * element's own `currentTime` (what the landing check reads). They are separate
 * on purpose: that split is exactly what the `getPlayheadTime` dep exists for.
 */
function makeLiveHarness(overrides: { epInt?: string } = {}): {
  deps: Deps
  time: Ref<number>
  playhead: Ref<number>
  seek: ReturnType<typeof vi.fn>
  landedShort: ReturnType<typeof vi.fn>
} {
  const time = ref(0)
  const playhead = ref(0)
  const isStreaming = ref(false)
  const activeStreamUrl = ref('')
  const seek = vi.fn()
  const landedShort = vi.fn()
  return {
    deps: {
      getAnimeId: () => 42,
      getCurrentEpisodeInt: () => overrides.epInt ?? '1',
      getCurrentTime: () => time.value,
      getPlayheadTime: () => playhead.value,
      isStreaming,
      activeStreamUrl,
      onSeek: seek,
      onSkipLandedShort: landedShort
    },
    time,
    playhead,
    seek,
    landedShort
  }
}

/** Move the display playhead and let the computed + grace watcher settle. */
async function moveTo(h: { time: Ref<number>; playhead: Ref<number> }, t: number): Promise<void> {
  h.time.value = t
  h.playhead.value = t
  await Promise.resolve()
  vi.advanceTimersByTime(SKIP_GRACE_MS_TEST)
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
  // Rebuilt for #238. The previous version of this case was vacuous: it never
  // awaited between assigning the detections and advancing the clock, so the
  // grace watcher had not run and `skipButtonVisible` was never `true` — the
  // `toBe(false)` assertion passed for the wrong reason. It is now on the
  // reactive harness with an explicit `true` precondition, and the assertion is
  // inverted, because the click no longer hides anything.
  it('seeks to the end of the active band and leaves the button up', async () => {
    vi.useFakeTimers()
    const h = makeLiveHarness()
    const s = useSkipMarkers(h.deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)

    s.onSkipClick()

    expect(h.seek).toHaveBeenCalledWith(150)
    expect(s.skipButtonVisible.value).toBe(true)
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
  // #238 changed the shape of this: the dedup no longer happens on the click,
  // it happens on the *confirmed landing*. The button then hides on its own via
  // the `activeSkipRange → null` transition, not by an explicit clear.
  it('dedups the range once the seek is observed to land, and stays hidden on rewind', async () => {
    vi.useFakeTimers()
    const h = makeLiveHarness()
    const s = useSkipMarkers(h.deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)

    s.onSkipClick()
    expect(h.seek).toHaveBeenCalledWith(150)
    // Still up: nothing has arrived yet.
    expect(s.skipButtonVisible.value).toBe(true)

    // The element arrives at the band end and reports it.
    h.playhead.value = 150
    s.onVideoSeeked()
    expect(h.landedShort).not.toHaveBeenCalled()

    // Leaving the band hides it through the watch, not through the click.
    await moveTo(h, 500)
    expect(s.skipButtonVisible.value).toBe(false)
    // Rewinding back in keeps it hidden — the range is deduped for the session.
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(false)
    vi.useRealTimers()
  })

  it('shows the button again after resetSkipUiState (episode change)', async () => {
    vi.useFakeTimers()
    const h = makeLiveHarness()
    const s = useSkipMarkers(h.deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    await moveTo(h, 60)
    s.onSkipClick()
    h.playhead.value = 150
    s.onVideoSeeked()
    // Now reset (simulating an episode change) and re-enter the band.
    s.resetSkipUiState()
    await moveTo(h, 500)
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)
    vi.useRealTimers()
  })
})

// The landing oracle (#238). A click only *requests* the skip; nothing is
// committed and nothing is hidden until the element reports where it actually
// arrived. On a growing `.part` the seek can land short — or never complete at
// all, once #237's frontier pass-through stops clamping the request.
describe('useSkipMarkers — skip landing (#238)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function armedClick(
    band: { startSec: number; endSec: number } = { startSec: 60, endSec: 150 },
    kind: 'op' | 'ed' = 'op'
  ): Promise<{ s: ReturnType<typeof useSkipMarkers>; h: ReturnType<typeof makeLiveHarness> }> {
    const h = makeLiveHarness()
    const s = useSkipMarkers(h.deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', kind === 'op' ? band : null, kind === 'ed' ? band : null)
    })
    await moveTo(h, band.startSec)
    expect(s.skipButtonVisible.value).toBe(true)
    s.onSkipClick()
    expect(h.seek).toHaveBeenCalledWith(band.endSec)
    return { s, h }
  }

  // The headline regression: short landing must not commit and must not hide.
  it('does not commit or hide when the seek lands short, and re-offers the skip', async () => {
    const { s, h } = await armedClick()

    h.playhead.value = 80
    s.onVideoSeeked()

    expect(s.skipButtonVisible.value).toBe(true)
    expect(h.landedShort).toHaveBeenCalledTimes(1)

    // Not deduped: leaving and re-entering the band re-offers it.
    await moveTo(h, 500)
    expect(s.skipButtonVisible.value).toBe(false)
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)
  })

  // The case the synchronous-return oracle would have failed: with #237's
  // pass-through the element can be asked for a position it never reaches, so
  // no `seeked` ever fires. Nothing may hide, and nothing may be committed.
  it('leaves the button up when the seek never completes', async () => {
    const { s, h } = await armedClick()

    // No onVideoSeeked() at all.
    expect(s.skipButtonVisible.value).toBe(true)
    expect(h.landedShort).not.toHaveBeenCalled()

    await moveTo(h, 500)
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)
  })

  // Pins that the landing epsilon is its own constant: 149.6 is inside the
  // 0.5 s window and outside SKIP_LEAD_IN_SEC's 0.25 s one, so re-collapsing
  // the two constants fails here.
  it('treats a keyframe-snap landing within SKIP_LANDING_EPSILON_SEC as arrived', async () => {
    const { s, h } = await armedClick()

    h.playhead.value = 149.6
    s.onVideoSeeked()

    expect(h.landedShort).not.toHaveBeenCalled()
    await moveTo(h, 500)
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(false)
  })

  it('treats a landing outside SKIP_LANDING_EPSILON_SEC as short', async () => {
    const { s, h } = await armedClick()

    h.playhead.value = 149.4
    s.onVideoSeeked()

    expect(h.landedShort).toHaveBeenCalledTimes(1)
    await moveTo(h, 500)
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)
  })

  // No special-casing by band kind.
  it('applies the same landing rule to an ED band', async () => {
    const { s, h } = await armedClick({ startSec: 1300, endSec: 1400 }, 'ed')

    h.playhead.value = 1350
    s.onVideoSeeked()

    expect(s.skipButtonVisible.value).toBe(true)
    expect(h.landedShort).toHaveBeenCalledTimes(1)
  })

  // An episode flip must not let the previous band's pending click be resolved
  // by the new episode's first seeked — this is why resetSkipUiState clears it.
  it('drops a pending landing on resetSkipUiState so the next episode is unaffected', async () => {
    const { s, h } = await armedClick()

    s.resetSkipUiState()
    h.playhead.value = 150
    s.onVideoSeeked()

    expect(h.landedShort).not.toHaveBeenCalled()
    // The band still offers its button — nothing was committed.
    await moveTo(h, 500)
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)
  })

  it('is a no-op when no skip is pending', async () => {
    const h = makeLiveHarness()
    const s = useSkipMarkers(h.deps)
    s.showSkipDetections.value = fakeShow({
      '1': fakeEp('1', { startSec: 60, endSec: 150 })
    })
    await moveTo(h, 60)

    h.playhead.value = 150
    s.onVideoSeeked()

    expect(h.landedShort).not.toHaveBeenCalled()
    // Nothing committed: the band still shows after leaving and returning.
    await moveTo(h, 500)
    await moveTo(h, 60)
    expect(s.skipButtonVisible.value).toBe(true)
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
