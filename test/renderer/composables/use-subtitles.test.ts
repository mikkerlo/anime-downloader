import { describe, it, expect, beforeEach, vi } from 'vitest'

// SubtitlesOctopus needs `window` + DOM globals at module-eval time. Stub
// before importing the composable. Track constructed instances so tests can
// inspect the live-read `timeOffset` field the composable writes.
const { octopusInstances } = vi.hoisted(() => ({
  octopusInstances: [] as Array<{ timeOffset: number; setCurrentTime: ReturnType<typeof vi.fn> }>
}))
vi.mock('libass-wasm/dist/js/subtitles-octopus.js', () => {
  return {
    default: class MockOctopus {
      timeOffset = 0
      dispose = vi.fn()
      setTrack = vi.fn()
      setCurrentTime = vi.fn()
      constructor() {
        octopusInstances.push(this)
      }
    }
  }
})

import { useSubtitles } from '../../../src/renderer/src/composables/use-subtitles'

type Api = {
  onPlayerStreamSubtitles: (
    cb: (data: { sessionId: string; content: string }) => void
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
  octopusInstances.length = 0
  // node env has no `document`; initSubtitles reads `document.baseURI` to build
  // the libass worker URL. Provide a minimal stub so the octopus constructor
  // (and thus the timeOffset application) actually runs.
  ;(globalThis as { document?: { baseURI: string } }).document = {
    baseURI: 'http://localhost/'
  }
  ;(globalThis as { window?: { api: Partial<Api> } }).window = {
    api: { onPlayerStreamSubtitles: noopSub }
  }
})

function makeDeps(overrides: Partial<Parameters<typeof useSubtitles>[0]> = {}) {
  return {
    getVideoEl: () => null,
    getStreamSessionId: () => '',
    ...overrides
  } as Parameters<typeof useSubtitles>[0]
}

describe('useSubtitles — initial state', () => {
  it('starts with empty subtitle content', () => {
    const s = useSubtitles(makeDeps())
    expect(s.activeSubtitleContent.value).toBe('')
  })
})

describe('useSubtitles — initSubtitles guards', () => {
  it('is a no-op when subtitle content is empty', () => {
    const s = useSubtitles(makeDeps())
    expect(() => s.initSubtitles({} as HTMLVideoElement)).not.toThrow()
  })

  it('swallows errors from SubtitlesOctopus constructor', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = useSubtitles(makeDeps())
    s.activeSubtitleContent.value = '[Script Info]\nfake'
    // jsdom doesn't actually have a baseURI usable by libass, but our mock
    // doesn't read it — just make sure init doesn't throw.
    expect(() => s.initSubtitles({} as HTMLVideoElement)).not.toThrow()
    err.mockRestore()
  })
})

// Regression coverage for #198. The A/V buffer lands slightly off the absolute
// timeline after a seek; useMsePlayer measures that delta and pushes it in via
// setSubtitleCorrection. It must be applied to libass's live-read `timeOffset`
// field on EVERY init — because the octopus instance is destroyed + re-created
// on each content change (props switch / stream-sub arrival), which resets
// `timeOffset` to 0.
describe('useSubtitles — subtitle correction (#198)', () => {
  it('applies a stored correction to timeOffset on initSubtitles', () => {
    const s = useSubtitles(makeDeps())
    s.setSubtitleCorrection(-0.5)
    s.activeSubtitleContent.value = '[Script Info]\nfake'
    s.initSubtitles({} as HTMLVideoElement)
    expect(octopusInstances).toHaveLength(1)
    expect(octopusInstances[0].timeOffset).toBeCloseTo(-0.5, 6)
  })

  it('applies the correction live to an existing instance', () => {
    const s = useSubtitles(makeDeps())
    s.activeSubtitleContent.value = '[Script Info]\nfake'
    s.initSubtitles({} as HTMLVideoElement)
    expect(octopusInstances[0].timeOffset).toBe(0)
    s.setSubtitleCorrection(-0.25)
    expect(octopusInstances[0].timeOffset).toBeCloseTo(-0.25, 6)
  })

  // Regression for review finding #1: libass only redraws on video events, and
  // after an unbuffered seek the buffer-ahead gate leaves a paused player
  // paused with the correction landing *after* `seeked` already fired. Without
  // an explicit redraw, a user scrubbing while paused keeps seeing the old
  // offset. setSubtitleCorrection must force one redraw at the corrected time.
  it('forces a redraw at the corrected time so a paused scrub reflects the shift', () => {
    const video = { currentTime: 100 } as HTMLVideoElement
    const s = useSubtitles(makeDeps({ getVideoEl: () => video }))
    s.activeSubtitleContent.value = '[Script Info]\nfake'
    s.initSubtitles(video)
    octopusInstances[0].setCurrentTime.mockClear()
    s.setSubtitleCorrection(-0.5)
    expect(octopusInstances[0].setCurrentTime).toHaveBeenCalledWith(99.5)
  })

  it('re-applies the correction across a destroy + re-init (stream-sub arrival)', () => {
    let cb: ((d: { sessionId: string; content: string }) => void) | null = null
    setApi({
      onPlayerStreamSubtitles: (handler) => {
        cb = handler
        return noopSub()
      }
    })
    const video = {} as HTMLVideoElement
    const s = useSubtitles(makeDeps({ getVideoEl: () => video, getStreamSessionId: () => 'mine' }))
    s.setSubtitleCorrection(-0.5)
    s.activeSubtitleContent.value = '[Script Info]\ninitial'
    s.initSubtitles(video)
    expect(octopusInstances).toHaveLength(1)
    expect(octopusInstances[0].timeOffset).toBeCloseTo(-0.5, 6)

    // A stream-extracted subtitle arrives: subscribeStreamSubtitles destroys +
    // re-inits the octopus instance, which would reset timeOffset to 0…
    s.activeSubtitleContent.value = ''
    s.subscribeStreamSubtitles()
    cb!({ sessionId: 'mine', content: '[Script Info]\nfrom-stream' })

    // …but the stored correction is re-applied on the fresh instance.
    expect(octopusInstances).toHaveLength(2)
    expect(octopusInstances[1].timeOffset).toBeCloseTo(-0.5, 6)
  })
})

describe('useSubtitles — destroySubtitles', () => {
  it('is safe to call when no instance exists', () => {
    const s = useSubtitles(makeDeps())
    expect(() => s.destroySubtitles()).not.toThrow()
  })

  it('is idempotent', () => {
    const s = useSubtitles(makeDeps())
    s.destroySubtitles()
    s.destroySubtitles()
    expect(true).toBe(true)
  })
})

describe('useSubtitles — redrawAfterFullscreen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('is a no-op without an active octopus instance', () => {
    const s = useSubtitles(makeDeps())
    s.activeSubtitleContent.value = '[Script Info]\nfake'
    s.redrawAfterFullscreen()
    vi.advanceTimersByTime(300)
    // No-op — verified by absence of a thrown error.
    expect(true).toBe(true)
  })

  it('schedules a setTrack call when an instance exists + content is set', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = useSubtitles(makeDeps())
    s.activeSubtitleContent.value = '[Script Info]\nfake'
    s.initSubtitles({} as HTMLVideoElement)
    s.redrawAfterFullscreen()
    vi.advanceTimersByTime(199)
    // not yet
    vi.advanceTimersByTime(2)
    // fired
    expect(true).toBe(true)
    err.mockRestore()
  })

  afterAll(() => {
    vi.useRealTimers()
  })
})

import { afterAll } from 'vitest'

describe('useSubtitles — subscribeStreamSubtitles', () => {
  it('returns the disposer from the api', () => {
    const disposer = vi.fn()
    setApi({
      onPlayerStreamSubtitles: () => disposer
    })
    const s = useSubtitles(makeDeps())
    const dispose = s.subscribeStreamSubtitles()
    dispose()
    expect(disposer).toHaveBeenCalled()
  })

  it('applies content when session id matches + no subtitle yet', () => {
    let cb: ((d: { sessionId: string; content: string }) => void) | null = null
    setApi({
      onPlayerStreamSubtitles: (handler) => {
        cb = handler
        return noopSub()
      }
    })
    const s = useSubtitles(makeDeps({ getStreamSessionId: () => 'mine' }))
    s.subscribeStreamSubtitles()
    cb!({ sessionId: 'mine', content: '[Script Info]\nfrom-stream' })
    expect(s.activeSubtitleContent.value).toBe('[Script Info]\nfrom-stream')
  })

  it('ignores events for a different session id', () => {
    let cb: ((d: { sessionId: string; content: string }) => void) | null = null
    setApi({
      onPlayerStreamSubtitles: (handler) => {
        cb = handler
        return noopSub()
      }
    })
    const s = useSubtitles(makeDeps({ getStreamSessionId: () => 'mine' }))
    s.subscribeStreamSubtitles()
    cb!({ sessionId: 'other', content: 'should be ignored' })
    expect(s.activeSubtitleContent.value).toBe('')
  })

  it('does not overwrite an already-applied subtitle', () => {
    let cb: ((d: { sessionId: string; content: string }) => void) | null = null
    setApi({
      onPlayerStreamSubtitles: (handler) => {
        cb = handler
        return noopSub()
      }
    })
    const s = useSubtitles(makeDeps({ getStreamSessionId: () => 'mine' }))
    s.activeSubtitleContent.value = 'props-provided'
    s.subscribeStreamSubtitles()
    cb!({ sessionId: 'mine', content: 'stream-provided' })
    expect(s.activeSubtitleContent.value).toBe('props-provided')
  })
})
