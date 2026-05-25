import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useMsePlayer } from '../../../src/renderer/src/composables/use-mse-player'

type Api = {
  playerStreamStart: (sessionId: string) => Promise<void>
  playerStreamAck: (sessionId: string, bytes: number) => Promise<void>
  playerStreamSeek: (
    sessionId: string,
    seekAt: number
  ) => Promise<{ generation: number; keyframeTime: number } | { error: string }>
  onPlayerStreamChunk: (
    cb: (data: { sessionId: string; gen: number; data: Uint8Array }) => void
  ) => Unsubscribe
  onPlayerStreamEnd: (cb: (data: { sessionId: string }) => void) => Unsubscribe
  onPlayerStreamError: (cb: (data: { sessionId: string; error: string }) => void) => Unsubscribe
  onPlayerStreamProgress: (
    cb: (data: { sessionId: string; gen: number; speed: number }) => void
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
      onPlayerStreamChunk: noopSub,
      onPlayerStreamEnd: noopSub,
      onPlayerStreamError: noopSub,
      onPlayerStreamProgress: noopSub
    }
  }
})

function makeDeps(overrides: Partial<Parameters<typeof useMsePlayer>[0]> = {}) {
  return {
    getVideoEl: () => null,
    setSyncplayLocalReady: vi.fn(),
    ...overrides
  } as Parameters<typeof useMsePlayer>[0]
}

describe('useMsePlayer — initial state', () => {
  it('starts with empty session + clear flags', () => {
    const m = useMsePlayer(makeDeps())
    expect(m.streamSessionId.value).toBe('')
    expect(m.mseSrcUrl.value).toBe('')
    expect(m.mkvBuffering.value).toBe(false)
    expect(m.transcodingHevc.value).toBe(false)
    expect(m.transcodeSpeed.value).toBeNull()
    expect(m.remuxError.value).toBe('')
    expect(m.hasActiveSession.value).toBe(false)
  })

  it('hasActiveSession reflects streamSessionId.value', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'abc-123'
    expect(m.hasActiveSession.value).toBe(true)
    m.streamSessionId.value = ''
    expect(m.hasActiveSession.value).toBe(false)
  })
})

describe('useMsePlayer — transcodeLabel formatting', () => {
  it('shows the indeterminate label when speed is null', () => {
    const m = useMsePlayer(makeDeps())
    expect(m.transcodeLabel.value).toBe('Transcoding HEVC → H.264…')
    m.setTranscoding(true)
    expect(m.transcodeLabel.value).toBe('Transcoding HEVC → H.264…')
  })

  it('shows speed multiplier with one decimal once a speed arrives', () => {
    const m = useMsePlayer(makeDeps())
    m.setTranscoding(true)
    m.transcodeSpeed.value = 2.5
    expect(m.transcodeLabel.value).toBe('Transcoding HEVC → H.264 @ 2.5×')
    m.transcodeSpeed.value = 0.97
    expect(m.transcodeLabel.value).toBe('Transcoding HEVC → H.264 @ 1.0×')
  })

  it('setTranscoding(false) clears the speed and returns to indeterminate', () => {
    const m = useMsePlayer(makeDeps())
    m.setTranscoding(true)
    m.transcodeSpeed.value = 1.5
    m.setTranscoding(false)
    expect(m.transcodingHevc.value).toBe(false)
    expect(m.transcodeSpeed.value).toBeNull()
    expect(m.transcodeLabel.value).toBe('Transcoding HEVC → H.264…')
  })
})

describe('useMsePlayer — handleStreamChunk session/gen filtering', () => {
  it('ignores chunks for a different session id', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'mine'
    m._internal.handleStreamChunk('other', 0, new Uint8Array([1, 2, 3]))
    expect(m._internal.getAppendQueueLength()).toBe(0)
  })

  it('ignores chunks from an obsolete generation', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'mine'
    // currentStreamGen starts at 0; data tagged with gen=5 is ahead of us
    m._internal.handleStreamChunk('mine', 5, new Uint8Array([1]))
    expect(m._internal.getAppendQueueLength()).toBe(0)
  })

  it('queues chunks matching session + gen', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'mine'
    // currentStreamGen is 0 by default
    m._internal.handleStreamChunk('mine', 0, new Uint8Array([1, 2]))
    // sourceBuffer is null so pumpAppendQueue bails — chunk stays queued
    expect(m._internal.getAppendQueueLength()).toBe(1)
  })
})

describe('useMsePlayer — handleStreamEnd / Error', () => {
  it('handleStreamEnd ignores other sessions', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'mine'
    m._internal.handleStreamEnd('other')
    // No-op; session id unchanged + no buffering/transcode flag flips
    expect(m.streamSessionId.value).toBe('mine')
  })

  it('handleStreamError sets remuxError + resets session', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'mine'
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    m._internal.handleStreamError('mine', 'ffmpeg crashed')
    expect(m.remuxError.value).toBe('ffmpeg crashed')
    expect(m.streamSessionId.value).toBe('')
    expect(m.hasActiveSession.value).toBe(false)
    consoleErr.mockRestore()
  })

  it('handleStreamError ignores other sessions', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'mine'
    m._internal.handleStreamError('other', 'unrelated')
    expect(m.remuxError.value).toBe('')
    expect(m.streamSessionId.value).toBe('mine')
  })
})

describe('useMsePlayer — resetMseState', () => {
  it('clears every reactive field + session id', () => {
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'abc'
    m.transcodeSpeed.value = 1.5
    m.setTranscoding(true)
    m.mkvBuffering.value = true
    m.mseSrcUrl.value = 'blob:fake'
    m.resetMseState()
    expect(m.streamSessionId.value).toBe('')
    expect(m.mseSrcUrl.value).toBe('')
    expect(m.transcodingHevc.value).toBe(false)
    expect(m.transcodeSpeed.value).toBeNull()
  })

  it('is idempotent', () => {
    const m = useMsePlayer(makeDeps())
    m.resetMseState()
    m.resetMseState()
    expect(m.streamSessionId.value).toBe('')
  })
})

describe('useMsePlayer — subscribeStreamEvents', () => {
  it('routes incoming chunk events to handleStreamChunk', () => {
    let capturedChunkCb:
      | ((d: { sessionId: string; gen: number; data: Uint8Array }) => void)
      | null = null
    setApi({
      onPlayerStreamChunk: (cb) => {
        capturedChunkCb = cb
        return noopSub()
      }
    })
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'live'
    const dispose = m.subscribeStreamEvents()
    capturedChunkCb!({ sessionId: 'live', gen: 0, data: new Uint8Array([1, 2]) })
    expect(m._internal.getAppendQueueLength()).toBe(1)
    dispose()
  })

  it('routes end events', () => {
    let capturedEndCb: ((d: { sessionId: string }) => void) | null = null
    setApi({
      onPlayerStreamEnd: (cb) => {
        capturedEndCb = cb
        return noopSub()
      }
    })
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'live'
    m.subscribeStreamEvents()
    // Should not throw + flip an internal flag (verifiable by handleStreamEnd
    // path running — observable only via subsequent behavior; here we just
    // ensure no crash).
    expect(() => capturedEndCb!({ sessionId: 'live' })).not.toThrow()
  })

  it('routes error events into remuxError', () => {
    let capturedErrCb: ((d: { sessionId: string; error: string }) => void) | null = null
    setApi({
      onPlayerStreamError: (cb) => {
        capturedErrCb = cb
        return noopSub()
      }
    })
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'live'
    m.subscribeStreamEvents()
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    capturedErrCb!({ sessionId: 'live', error: 'pipe broken' })
    expect(m.remuxError.value).toBe('pipe broken')
    consoleErr.mockRestore()
  })

  it('routes progress events into transcodeSpeed (when session+gen match)', () => {
    let capturedProgressCb:
      | ((d: { sessionId: string; gen: number; speed: number }) => void)
      | null = null
    setApi({
      onPlayerStreamProgress: (cb) => {
        capturedProgressCb = cb
        return noopSub()
      }
    })
    const m = useMsePlayer(makeDeps())
    m.streamSessionId.value = 'live'
    m.subscribeStreamEvents()
    // currentStreamGen starts at 0
    capturedProgressCb!({ sessionId: 'live', gen: 0, speed: 1.8 })
    expect(m.transcodeSpeed.value).toBe(1.8)
    // Different session — ignored
    capturedProgressCb!({ sessionId: 'other', gen: 0, speed: 9 })
    expect(m.transcodeSpeed.value).toBe(1.8)
    // Different generation — ignored
    capturedProgressCb!({ sessionId: 'live', gen: 99, speed: 0.5 })
    expect(m.transcodeSpeed.value).toBe(1.8)
  })

  it('returns a disposer that unsubscribes all four', () => {
    const disposers = {
      chunk: vi.fn(),
      end: vi.fn(),
      err: vi.fn(),
      prog: vi.fn()
    }
    setApi({
      onPlayerStreamChunk: () => disposers.chunk,
      onPlayerStreamEnd: () => disposers.end,
      onPlayerStreamError: () => disposers.err,
      onPlayerStreamProgress: () => disposers.prog
    })
    const m = useMsePlayer(makeDeps())
    const dispose = m.subscribeStreamEvents()
    dispose()
    expect(disposers.chunk).toHaveBeenCalled()
    expect(disposers.end).toHaveBeenCalled()
    expect(disposers.err).toHaveBeenCalled()
    expect(disposers.prog).toHaveBeenCalled()
  })
})

describe('useMsePlayer — maybeRespawnForUnbufferedPosition (no-op without active session)', () => {
  it('is a no-op when no video element', () => {
    const m = useMsePlayer(makeDeps({ getVideoEl: () => null }))
    expect(() => m.maybeRespawnForUnbufferedPosition()).not.toThrow()
  })

  it('is a no-op when no active session', () => {
    const m = useMsePlayer(makeDeps({ getVideoEl: () => ({}) as HTMLVideoElement }))
    expect(() => m.maybeRespawnForUnbufferedPosition()).not.toThrow()
  })
})

// Regression coverage for #127. Before the fix the post-respawn buffer-ahead
// pause (mkvBuffering + waitForBufferAhead) ran ONLY on the HEVC transcode
// path. On the stream-copy path the element resumed the instant the first
// fragment landed — before the SourceBuffer parser had settled — which on
// Linux/WSL produced repeated readyState=1 stalls and audio dropout. The gate
// now runs on both paths; waitForBufferAhead calls setSyncplayLocalReady(false)
// only when it actually executes, so that call is the behavior differentiator:
// it never fired on a stream-copy respawn under the old code.
describe('useMsePlayer — buffer-ahead gate on respawn (#127)', () => {
  class FakeBuffered {
    ranges: [number, number][] = []
    get length(): number {
      return this.ranges.length
    }
    start(i: number): number {
      return this.ranges[i][0]
    }
    end(i: number): number {
      return this.ranges[i][1]
    }
  }

  class FakeSourceBuffer extends EventTarget {
    updating = false
    timestampOffset = 0
    buffered = new FakeBuffered()
    onAbort: (() => void) | null = null
    appendBuffer(): void {}
    remove(): void {
      // The composable adds its `updateend` listener synchronously right after
      // calling remove(); a microtask fires after that listener is attached.
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')))
    }
    abort(): void {
      this.onAbort?.()
    }
  }

  class FakeMediaSource extends EventTarget {
    readyState = 'closed'
    duration = 0
    constructor(public sb: FakeSourceBuffer) {
      super()
    }
    addSourceBuffer(): FakeSourceBuffer {
      this.readyState = 'open'
      return this.sb
    }
    endOfStream(): void {}
  }

  let origMediaSource: unknown
  let origURL: unknown

  beforeEach(() => {
    origMediaSource = (globalThis as Record<string, unknown>).MediaSource
    origURL = (globalThis as Record<string, unknown>).URL
    ;(globalThis as Record<string, unknown>).URL = {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {}
    }
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).MediaSource = origMediaSource
    ;(globalThis as Record<string, unknown>).URL = origURL
  })

  it('runs the buffer-ahead pause on the stream-copy path (not just transcode)', async () => {
    const fakeSb = new FakeSourceBuffer()
    // Initial buffered range does NOT contain the seek target (100), so the
    // respawn path is taken rather than the "already buffered" early return.
    fakeSb.buffered.ranges = [[0, 5]]
    // After abort() the fresh ffmpeg run's fragments cover the target with
    // ample lead, so waitForBufferAhead returns on its first poll.
    fakeSb.onAbort = () => {
      fakeSb.buffered.ranges = [[99, 105]]
    }
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const video = {
      currentTime: 100,
      paused: true,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }
    const setSyncplayLocalReady = vi.fn()
    const seekSpy = vi.fn(async () => ({ generation: 1, keyframeTime: 99 }))
    setApi({
      playerStreamSeek: seekSpy,
      playerStreamStart: vi.fn(async () => {}),
      playerStreamAck: vi.fn(async () => {})
    })

    const m = useMsePlayer(
      makeDeps({
        getVideoEl: () => video as unknown as HTMLVideoElement,
        setSyncplayLocalReady
      })
    )
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 200,
      mimeType: 'video/mp4',
      resumeTarget: 0,
      keyframeTime: 0
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))
    expect(m._internal.getSourceBuffer()).not.toBeNull()
    expect(m.transcodingHevc.value).toBe(false)

    await m._internal.handleUnbufferedSeek()

    // Respawn happened…
    expect(seekSpy).toHaveBeenCalledWith('s1', 99)
    // …and the buffer-ahead gate executed on this stream-copy session.
    expect(setSyncplayLocalReady).toHaveBeenCalledWith(false)
    expect(setSyncplayLocalReady).toHaveBeenCalledWith(true)
    // Gate cleared once enough lead buffered; no lingering buffering state.
    expect(m.mkvBuffering.value).toBe(false)

    m.resetMseState()
  })
})
