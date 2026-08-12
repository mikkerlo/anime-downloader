import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useMsePlayer } from '../../../src/renderer/src/composables/use-mse-player'

type Api = {
  playerStreamStart: (sessionId: string) => Promise<void>
  playerStreamAck: (sessionId: string, bytes: number) => Promise<void>
  playerStreamSeek: (
    sessionId: string,
    seekAt: number
  ) => Promise<{ generation: number; timestampOffset: number } | { error: string }>
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
    const seekSpy = vi.fn(async () => ({ generation: 1, timestampOffset: 99 }))
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
      timestampOffset: 0
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))
    expect(m._internal.getSourceBuffer()).not.toBeNull()
    expect(m.transcodingHevc.value).toBe(false)

    await m._internal.handleUnbufferedSeek()

    // Respawn happened… (the seek passes the user's exact target).
    expect(seekSpy).toHaveBeenCalledWith('s1', 100)
    // …and the buffer-ahead gate executed on this stream-copy session.
    expect(setSyncplayLocalReady).toHaveBeenCalledWith(false)
    expect(setSyncplayLocalReady).toHaveBeenCalledWith(true)
    // Gate cleared once enough lead buffered; no lingering buffering state.
    expect(m.mkvBuffering.value).toBe(false)

    m.resetMseState()
  })
})

// Regression coverage for #198. An unbuffered (skip) seek respawns ffmpeg at the
// user's exact target. Main returns the TRUE content start (`timestampOffset`) —
// the keyframe the copy run actually lands on, which is at-or-*before* the target
// (the fmp4 muxer normalizes PTS to 0, so the buffer must be offset by it). The
// renderer sets that offset and KEEPS the playhead on the target: the buffer
// starts at a keyframe, so Chromium decodes from it and presents the target in
// sync. The earlier bug snapped the playhead onto a (mislabeled) keyframe, which
// desynced subtitles by ~one GOP — this test fails against that behavior.
describe('useMsePlayer — unbuffered seek keeps playhead on target (#198)', () => {
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

  it('sends the raw target, offsets the buffer by the content start, and keeps the playhead on the target', async () => {
    const fakeSb = new FakeSourceBuffer()
    // Target 100 is not buffered → respawn path.
    fakeSb.buffered.ranges = [[0, 5]]
    // Fresh run: copy landed on keyframe 95 (before the target), buffer spans it
    // through past the target with lead.
    fakeSb.onAbort = () => {
      fakeSb.buffered.ranges = [[95, 112]]
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
    // main probes where the copy run actually lands: keyframe 95, at-or-before 100.
    const seekSpy = vi.fn(async () => ({ generation: 1, timestampOffset: 95 }))
    setApi({
      playerStreamSeek: seekSpy,
      playerStreamStart: vi.fn(async () => {}),
      playerStreamAck: vi.fn(async () => {})
    })

    const m = useMsePlayer(makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement }))
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 200,
      mimeType: 'video/mp4',
      resumeTarget: 0,
      timestampOffset: 0
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))

    await m._internal.handleUnbufferedSeek()

    // The user's exact target is sent.
    expect(seekSpy).toHaveBeenCalledWith('s1', 100)
    // Buffer offset by the true content start (95)…
    expect(fakeSb.timestampOffset).toBe(95)
    // …and the playhead stays on the target (100), NOT snapped to the keyframe.
    // (The old code moved it to the keyframe, desyncing subs by a GOP.)
    expect(video.currentTime).toBe(100)

    m.resetMseState()
  })

  it('does not respawn when the target is already buffered (native seek)', async () => {
    const fakeSb = new FakeSourceBuffer()
    fakeSb.buffered.ranges = [[90, 130]]
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const video = {
      currentTime: 100,
      paused: false,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }
    const seekSpy = vi.fn(async () => ({ generation: 1, timestampOffset: 0 }))
    setApi({ playerStreamSeek: seekSpy, playerStreamStart: vi.fn(async () => {}) })

    const m = useMsePlayer(makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement }))
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 200,
      mimeType: 'video/mp4',
      resumeTarget: 0,
      timestampOffset: 0
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))

    await m._internal.handleUnbufferedSeek()

    // In-buffer seek → no respawn, no snap; the element handles it natively.
    expect(seekSpy).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(100)

    m.resetMseState()
  })

  it('resume-from-middle lands the playhead on the resume target (not stalled at 0)', () => {
    const fakeSb = new FakeSourceBuffer()
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const video = {
      currentTime: 0,
      paused: true,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }
    const m = useMsePlayer(makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement }))
    // Resume at 600 → copy landed on keyframe 595; buffer begins there while
    // currentTime is still 0, and the offset maps it onto the file timeline.
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 1421,
      mimeType: 'video/mp4',
      resumeTarget: 600,
      timestampOffset: 595
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))

    // First fragment lands (buffer starts ~595, far from 0).
    fakeSb.buffered.ranges = [[595.08, 601.0]]
    fakeSb.dispatchEvent(new Event('updateend'))

    // Playhead moved off 0 onto the real resume target (600) — inside the buffered
    // range that starts at the keyframe, so it plays the correct content in sync.
    // Landing on the keyframe (595) instead would replay ~5s and (with the old
    // mislabeled offset) desync subs; landing on the target is the fix.
    expect(video.currentTime).toBe(600)

    m.resetMseState()
  })

  it('play-from-start does not move the playhead', () => {
    const fakeSb = new FakeSourceBuffer()
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const video = {
      currentTime: 0,
      paused: true,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }
    const m = useMsePlayer(makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement }))
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 1421,
      mimeType: 'video/mp4',
      resumeTarget: 0,
      timestampOffset: 0
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))

    fakeSb.buffered.ranges = [[0.0, 2.0]]
    fakeSb.dispatchEvent(new Event('updateend'))

    // resumeTarget 0 → no landing; plays from 0.
    expect(video.currentTime).toBe(0)

    m.resetMseState()
  })

  // #239: with the 1500 ms wall-clock gate gone for seeks, this land is only
  // kept off the wire by the marker. Unmarked, syncplay reads it as the user
  // seeking and the reference server drags every peer onto our resume point.
  it('marks the resume land as programmatic before writing currentTime (#239)', () => {
    const fakeSb = new FakeSourceBuffer()
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const video = {
      currentTime: 0,
      paused: true,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }
    // Records the playhead at call time, so "before" is asserted rather than
    // merely "at some point" — a call after the write would record 600.
    const seenAtMark: number[] = []
    const markProgrammaticSeek = vi.fn((_t: number) => {
      seenAtMark.push(video.currentTime)
    })
    const m = useMsePlayer(
      makeDeps({
        getVideoEl: () => video as unknown as HTMLVideoElement,
        markProgrammaticSeek
      })
    )
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 1421,
      mimeType: 'video/mp4',
      resumeTarget: 600,
      timestampOffset: 595
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))

    fakeSb.buffered.ranges = [[595.08, 601.0]]
    fakeSb.dispatchEvent(new Event('updateend'))

    expect(markProgrammaticSeek).toHaveBeenCalledWith(600)
    expect(seenAtMark).toEqual([0])
    expect(video.currentTime).toBe(600)

    m.resetMseState()
  })

  // The mark must track the *write*, not the intent to land: a mark armed for a
  // write that never happens has no `seeked` to consume it and latches, so the
  // user's next real seek is swallowed for the whole TTL.
  it.each([
    // resumeTarget 0 → no land pending at all.
    { label: 'play-from-start', resumeTarget: 0, offset: 0, at: 0, ranges: [[0.0, 2.0]] },
    // Land pending, but the playhead already sits past the target, so the
    // `t < resumeLandTarget` guard skips the write. The range starts within
    // 60 s of the playhead on purpose — a wider one trips the eviction branch,
    // whose remove() re-dispatches `updateend` and loops.
    {
      label: 'playhead already past the target',
      resumeTarget: 600,
      offset: 595,
      at: 700,
      ranges: [[660.0, 720.0]]
    }
  ])(
    'does not mark when no currentTime write happens — $label',
    ({ resumeTarget, offset, at, ranges }) => {
      const fakeSb = new FakeSourceBuffer()
      const fakeMs = new FakeMediaSource(fakeSb)
      ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

      const video = {
        currentTime: at,
        paused: true,
        error: null,
        play: vi.fn(async () => {}),
        pause: vi.fn(() => {})
      }
      const markProgrammaticSeek = vi.fn()
      const m = useMsePlayer(
        makeDeps({
          getVideoEl: () => video as unknown as HTMLVideoElement,
          markProgrammaticSeek
        })
      )
      m.startMseSession({
        sessionId: 's1',
        generation: 0,
        duration: 1421,
        mimeType: 'video/mp4',
        resumeTarget,
        timestampOffset: offset
      })
      fakeMs.dispatchEvent(new Event('sourceopen'))

      fakeSb.buffered.ranges = ranges
      fakeSb.dispatchEvent(new Event('updateend'))

      expect(markProgrammaticSeek).not.toHaveBeenCalled()
      expect(video.currentTime).toBe(at)

      m.resetMseState()
    }
  )

  // #240: on an MSE session this land is the *only* thing that moves the
  // playhead for a resume — `resumeFromSavedPosition`'s MKV branch deliberately
  // writes no `currentTime` (#198) and only toasts. So the "the room outranks
  // the saved position" rule has to be enforced here, not just at the toast:
  // the syncplay apply has already put the element on the room's position by
  // `loadedmetadata`, and landing on the saved target over it is silent — the
  // land arms `markProgrammaticSeek`, so the room never hears the move, and the
  // next 1 Hz state (diff > 3) seeks us back. Two unbuffered seeks, two ffmpeg
  // respawns, and a playhead that bounces room → saved → room.
  describe('resume land vs. a syncplay room (#240)', () => {
    function landHarness(opts: { at: number; resumeTarget: number; roomOwns: boolean }): {
      video: { currentTime: number }
      markProgrammaticSeek: ReturnType<typeof vi.fn>
      fakeSb: FakeSourceBuffer
      m: ReturnType<typeof useMsePlayer>
    } {
      const fakeSb = new FakeSourceBuffer()
      const fakeMs = new FakeMediaSource(fakeSb)
      ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

      const video = {
        currentTime: opts.at,
        paused: true,
        error: null,
        play: vi.fn(async () => {}),
        pause: vi.fn(() => {})
      }
      const markProgrammaticSeek = vi.fn()
      const m = useMsePlayer(
        makeDeps({
          getVideoEl: () => video as unknown as HTMLVideoElement,
          markProgrammaticSeek,
          hasRemoteStateApplied: () => opts.roomOwns
        })
      )
      // The common case: 23 min of saved progress on a local .mkv, joined to a
      // room that just started. main probed keyframe 1395 for the copy run.
      m.startMseSession({
        sessionId: 's1',
        generation: 0,
        duration: 1421,
        mimeType: 'video/mp4',
        resumeTarget: opts.resumeTarget,
        timestampOffset: 1395
      })
      fakeMs.dispatchEvent(new Event('sourceopen'))
      return { video, markProgrammaticSeek, fakeSb, m }
    }

    it('cancels the land when a remote state already owns the playhead', () => {
      // The parked state applied at `loadedmetadata` put us on the room's 120 s.
      const { video, markProgrammaticSeek, fakeSb, m } = landHarness({
        at: 120,
        resumeTarget: 1400,
        roomOwns: true
      })

      fakeSb.buffered.ranges = [[115.08, 180.0]]
      fakeSb.dispatchEvent(new Event('updateend'))

      // The room's position survives, and nothing is marked — there is no write
      // to mark, and a latched mark would swallow the user's next real seek.
      expect(video.currentTime).toBe(120)
      expect(markProgrammaticSeek).not.toHaveBeenCalled()

      m.resetMseState()
    })

    it('consumes the pending land rather than retrying it on a later append', () => {
      // Once-per-session, like the write it replaces: leaving the flag armed
      // would land on the saved position at whatever append happens to follow a
      // reset of the room tracking (a disconnect mid-open), long after the
      // element settled — the same silent overwrite, just later.
      let roomOwns = true
      const fakeSb = new FakeSourceBuffer()
      const fakeMs = new FakeMediaSource(fakeSb)
      ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)
      const video = {
        currentTime: 120,
        paused: true,
        error: null,
        play: vi.fn(async () => {}),
        pause: vi.fn(() => {})
      }
      const markProgrammaticSeek = vi.fn()
      const m = useMsePlayer(
        makeDeps({
          getVideoEl: () => video as unknown as HTMLVideoElement,
          markProgrammaticSeek,
          hasRemoteStateApplied: () => roomOwns
        })
      )
      m.startMseSession({
        sessionId: 's1',
        generation: 0,
        duration: 1421,
        mimeType: 'video/mp4',
        resumeTarget: 1400,
        timestampOffset: 1395
      })
      fakeMs.dispatchEvent(new Event('sourceopen'))

      fakeSb.buffered.ranges = [[115.08, 180.0]]
      fakeSb.dispatchEvent(new Event('updateend'))
      expect(video.currentTime).toBe(120)

      roomOwns = false
      fakeSb.buffered.ranges = [[115.08, 240.0]]
      fakeSb.dispatchEvent(new Event('updateend'))

      expect(video.currentTime).toBe(120)
      expect(markProgrammaticSeek).not.toHaveBeenCalled()

      m.resetMseState()
    })

    it('still lands when no room owns the playhead', () => {
      // The negative control: outside a room (and alone in one, where main emits
      // no `remote-state` at all) the land is exactly as before.
      const { video, markProgrammaticSeek, fakeSb, m } = landHarness({
        at: 0,
        resumeTarget: 1400,
        roomOwns: false
      })

      fakeSb.buffered.ranges = [[1395.08, 1401.0]]
      fakeSb.dispatchEvent(new Event('updateend'))

      expect(video.currentTime).toBe(1400)
      expect(markProgrammaticSeek).toHaveBeenCalledWith(1400)

      m.resetMseState()
    })
  })
})
