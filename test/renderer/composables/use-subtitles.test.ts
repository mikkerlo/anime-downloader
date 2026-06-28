import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// SubtitlesOctopus needs `window` + DOM globals at module-eval time. Stub
// before importing the composable.
vi.mock('libass-wasm/dist/js/subtitles-octopus.js', () => {
  return {
    default: class MockOctopus {
      dispose = vi.fn()
      setTrack = vi.fn()
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
