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

// #306 Phase B: the seek dep hands back a handle whose `retract()` removes
// exactly the operation it registered, so the fake has to be a factory rather
// than a bare `vi.fn()` — the land's failure path calls `retract()` on it, and a
// handle shared across registrations would make "which one was retracted"
// unanswerable. None of the call sites below read the spy; the test that does is
// `retracts exactly its own seek operation when the land write throws`, at the
// bottom of this file, which uses its own recording registry instead.
let nextFakeSeekOpId = 1
function fakeSeekOp(): { id: number; retract: ReturnType<typeof vi.fn> } {
  return { id: nextFakeSeekOpId++, retract: vi.fn() }
}

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
    const beginProgrammaticSeek = vi.fn((_t: number) => {
      seenAtMark.push(video.currentTime)
      return fakeSeekOp()
    })
    const m = useMsePlayer(
      makeDeps({
        getVideoEl: () => video as unknown as HTMLVideoElement,
        beginProgrammaticSeek
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

    expect(beginProgrammaticSeek).toHaveBeenCalledWith(600)
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
      const beginProgrammaticSeek = vi.fn(() => fakeSeekOp())
      const m = useMsePlayer(
        makeDeps({
          getVideoEl: () => video as unknown as HTMLVideoElement,
          beginProgrammaticSeek
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

      expect(beginProgrammaticSeek).not.toHaveBeenCalled()
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
  // land arms `beginProgrammaticSeek`, so the room never hears the move, and the
  // next 1 Hz state (diff > 3) seeks us back. Two unbuffered seeks, two ffmpeg
  // respawns, and a playhead that bounces room → saved → room.
  describe('resume land vs. a syncplay room (#240)', () => {
    function landHarness(opts: { at: number; resumeTarget: number; roomOwns: boolean }): {
      video: { currentTime: number }
      beginProgrammaticSeek: ReturnType<typeof vi.fn>
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
      const beginProgrammaticSeek = vi.fn(() => fakeSeekOp())
      const m = useMsePlayer(
        makeDeps({
          getVideoEl: () => video as unknown as HTMLVideoElement,
          beginProgrammaticSeek,
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
      return { video, beginProgrammaticSeek, fakeSb, m }
    }

    it('cancels the land when a remote state already owns the playhead', () => {
      // The parked state applied at `loadedmetadata` put us on the room's 120 s.
      const { video, beginProgrammaticSeek, fakeSb, m } = landHarness({
        at: 120,
        resumeTarget: 1400,
        roomOwns: true
      })

      fakeSb.buffered.ranges = [[115.08, 180.0]]
      fakeSb.dispatchEvent(new Event('updateend'))

      // The room's position survives, and nothing is marked — there is no write
      // to mark, and a latched mark would swallow the user's next real seek.
      expect(video.currentTime).toBe(120)
      expect(beginProgrammaticSeek).not.toHaveBeenCalled()

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
      const beginProgrammaticSeek = vi.fn(() => fakeSeekOp())
      const m = useMsePlayer(
        makeDeps({
          getVideoEl: () => video as unknown as HTMLVideoElement,
          beginProgrammaticSeek,
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
      expect(beginProgrammaticSeek).not.toHaveBeenCalled()

      m.resetMseState()
    })

    it('still lands when no room owns the playhead', () => {
      // The negative control: outside a room (and alone in one, where main emits
      // no `remote-state` at all) the land is exactly as before.
      const { video, beginProgrammaticSeek, fakeSb, m } = landHarness({
        at: 0,
        resumeTarget: 1400,
        roomOwns: false
      })

      fakeSb.buffered.ranges = [[1395.08, 1401.0]]
      fakeSb.dispatchEvent(new Event('updateend'))

      expect(video.currentTime).toBe(1400)
      expect(beginProgrammaticSeek).toHaveBeenCalledWith(1400)

      m.resetMseState()
    })
  })

  // #275: the resume land is the renderer half of "an open position that is not
  // inside the file is not a seek". Main refuses such a seek and spawns at 0;
  // bounding only main leaves the whole symptom intact, because the renderer
  // still holds the out-of-range `resumeTarget` and writes it to the element.
  // Chromium's seek algorithm clamps that write to the MSE seekable end, so the
  // playhead lands on exactly `duration`, `ended` fires, and `onVideoEnded`
  // starts the 5 s auto-advance — the user picks episode 7 and gets episode 8.
  //
  // #295: the renderer no longer re-derives that refusal from the request and
  // the duration — main reports it as `MseOpenResult.refusedSeek` and the
  // composable reads the flag. The cases that only exercised the deleted
  // comparison retired with it; what is left is "honours the flag", "does not
  // invent a rule of its own on top of it", and the fail-open direction.
  describe('resume land vs. an out-of-file open position (#275/#295)', () => {
    // The real Re:Zero S4 E01 [Crunchyroll] duration the #275 measurements were
    // taken against, and the buffered range an out-of-range `-ss` actually
    // produced on it (the final GOP: last keyframe 1419.418 → 1420.063).
    const DURATION = 1420.063
    const FINAL_GOP: [number, number][] = [[1419.418, DURATION]]

    // `remove()` is a no-op here: the >60 s eviction branch re-dispatches
    // `updateend` from the real fake, which loops forever once a failing
    // expectation skips the `resetMseState()` below. These cases deliberately
    // put the playhead far from the buffer start, so they would trip it.
    class NoEvictSourceBuffer extends FakeSourceBuffer {
      remove(): void {}
    }

    // Chromium clamps a `currentTime` write to the seekable range, which on an
    // MSE element is `[0, mediaSource.duration]`. Without that clamp modelled,
    // an out-of-range land would read back as its own out-of-range number and
    // the `ended`-at-`duration` symptom would be invisible.
    function clampingVideo(duration: number, at = 0): { currentTime: number } {
      let t = at
      return {
        get currentTime(): number {
          return t
        },
        set currentTime(v: number) {
          t = Math.max(0, Math.min(v, duration))
        },
        paused: true,
        error: null,
        play: vi.fn(async () => {}),
        pause: vi.fn(() => {})
      } as unknown as { currentTime: number }
    }

    function landHarness(opts: {
      at?: number
      duration?: number
      resumeTarget: number
      refusedSeek?: boolean
      timestampOffset: number
      ranges: [number, number][]
    }): {
      video: { currentTime: number }
      beginProgrammaticSeek: ReturnType<typeof vi.fn>
      m: ReturnType<typeof useMsePlayer>
    } {
      const duration = opts.duration ?? DURATION
      const fakeSb = new NoEvictSourceBuffer()
      const fakeMs = new FakeMediaSource(fakeSb)
      ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

      // An unknown duration means an empty seekable range, so there is nothing
      // to clamp against — the fail-open case must not be clamped to 0 by the
      // fake and read as a cancelled land.
      const video = clampingVideo(duration > 0 ? duration : Infinity, opts.at ?? 0)
      const beginProgrammaticSeek = vi.fn(() => fakeSeekOp())
      const m = useMsePlayer(
        makeDeps({
          getVideoEl: () => video as unknown as HTMLVideoElement,
          beginProgrammaticSeek
        })
      )
      m.startMseSession({
        sessionId: 's1',
        generation: 0,
        duration,
        mimeType: 'video/mp4',
        resumeTarget: opts.resumeTarget,
        timestampOffset: opts.timestampOffset,
        ...(opts.refusedSeek === undefined ? {} : { refusedSeek: opts.refusedSeek })
      })
      fakeMs.dispatchEvent(new Event('sourceopen'))
      fakeSb.buffered.ranges = opts.ranges
      fakeSb.dispatchEvent(new Event('updateend'))
      return { video, beginProgrammaticSeek, m }
    }

    let warn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    it('honours refusedSeek by cancelling the land', () => {
      // The reaching input: main refused `-ss 2999`, reported `refusedSeek` and
      // opened at 0, so the buffer is the head of the file — but the renderer
      // still holds `resumeTarget: 3000`. The composable reads main's decision
      // (#295); the duration is here only to make the clamp realistic.
      const { video, beginProgrammaticSeek, m } = landHarness({
        resumeTarget: 3000,
        refusedSeek: true,
        timestampOffset: 0,
        ranges: [[0, 2]]
      })

      // Today, without the renderer half of the bound: 1420.063 — i.e. exactly
      // `duration`, which is `ended`, which is the auto-advance.
      expect(video.currentTime).toBe(0)
      expect(beginProgrammaticSeek).not.toHaveBeenCalled()
      // The "Resumed at …" toast is gated on this, so a refused open must not
      // announce a resume that did not happen.
      expect(m.mseInitialSeek.value).toBe(0)

      m.resetMseState()
    })

    // The boundary window `[duration, duration + 1)` used to be pinned here too,
    // on the same two inputs `player-ipc-seek-bound.test.ts` pins on the main
    // side, because the renderer made its own copy of `>= duration`. #295 moved
    // the decision onto the reply, so the window is now pinned once, where it is
    // decided — those two rows exercised nothing but the deleted comparison.
    //
    // Characterization, so the rejected `duration - 1` margin cannot come back:
    // on this release it lands *before* the buffer start of the final GOP, and
    // the playhead sits in a gap with nothing to decode.
    it('characterizes the rejected `duration - 1` margin: the land falls in a gap', () => {
      const target = DURATION - 1
      const { video, m } = landHarness({
        resumeTarget: target,
        timestampOffset: FINAL_GOP[0][0],
        ranges: FINAL_GOP
      })

      expect(video.currentTime).toBeCloseTo(1419.063, 3)
      // Outside the only buffered range — a stall, not a resume. (On a release
      // with a 5 s GOP the same margin lands *inside* the final GOP instead and
      // auto-advances a second later; no fixed margin clears both.)
      expect(video.currentTime).toBeLessThan(FINAL_GOP[0][0])

      m.resetMseState()
    })

    // The other half of the boundary window, and the case that pins the renderer
    // *not* inventing a rule of its own on top of main's. `initialSeek =
    // resumeTarget - 1`, so a `resumeTarget` in `[duration, duration + 1)` has a
    // spawn seek *inside* the file: main accepts it, spawns, and reports
    // `refusedSeek: false`. The renderer must land. Someone writing
    // `if (refusedSeek || resumeTarget >= duration)` cancels here instead —
    // playhead at 0, buffer at the last keyframe, permanent stall — which is a
    // different bug from the one this fix removes, not a stricter version of it.
    // Landing at the end and auto-advancing is the *correct* behaviour for a
    // position within one pre-roll of the end.
    it('agrees with main and lands when main did not refuse the open', () => {
      const { video, beginProgrammaticSeek, m } = landHarness({
        resumeTarget: DURATION + 0.5,
        refusedSeek: false,
        timestampOffset: FINAL_GOP[0][0],
        ranges: FINAL_GOP
      })

      expect(beginProgrammaticSeek).toHaveBeenCalledWith(DURATION + 0.5)
      // Chromium clamps the write to the seekable end — i.e. `ended`, i.e. the
      // auto-advance. Deliberate: both sides accept this window, and agreeing is
      // the property that matters.
      expect(video.currentTime).toBe(DURATION)

      m.resetMseState()
    })

    it('leaves a legitimate mid-file resume untouched', () => {
      const { video, beginProgrammaticSeek, m } = landHarness({
        resumeTarget: 600,
        refusedSeek: false,
        timestampOffset: 595,
        ranges: [[595.08, 601.0]]
      })

      expect(video.currentTime).toBe(600)
      expect(beginProgrammaticSeek).toHaveBeenCalledWith(600)

      m.resetMseState()
    })

    it('leaves a legitimate near-end resume untouched', () => {
      // ~0.95 of duration — the loosest resume `resolveMkvSpawnTarget` will
      // hand out. It is inside the file, so it is a real resume point.
      const target = 1349.06
      const { video, beginProgrammaticSeek, m } = landHarness({
        resumeTarget: target,
        timestampOffset: 1345.0,
        ranges: [[1345.0, 1355.0]]
      })

      expect(video.currentTime).toBe(target)
      expect(beginProgrammaticSeek).toHaveBeenCalledWith(target)

      m.resetMseState()
    })

    it('is fail-open: an omitted refusedSeek leaves the land unchanged', () => {
      // `refusedSeek` is *required* on `StartMseSessionOpts`, so a typechecked
      // caller cannot omit it — but `test/**` is outside both typecheck
      // projects, so the nine other `startMseSession` call sites in this file
      // do omit it, and this pins that they still land. The runtime direction
      // is deliberate (#295): were the field ever to go missing, the
      // degradation is the pre-#275 behaviour, not a stall.
      const { video, beginProgrammaticSeek, m } = landHarness({
        resumeTarget: 600,
        timestampOffset: 595,
        ranges: [[595.08, 601.0]]
      })

      expect(video.currentTime).toBe(600)
      expect(beginProgrammaticSeek).toHaveBeenCalledWith(600)

      m.resetMseState()
    })

    // The unknown-`duration` fail-open case retired with #295: it existed
    // because the renderer's own predicate had a `duration > 0` term, and that
    // predicate is gone. `duration` no longer takes part in the decision at all.
  })
})

// The buffer-refill pause/resume pair, as programmatic playback operations
// (#306 Phase A). Under the old `markProgrammaticPlayback(paused | null)` dep,
// the refill's retraction on a rejected `play()` cleared whatever resume mark
// occupied syncplay's single slot — including one a *newer* site had installed.
// The handle makes the retraction exact, and this pins that the composable
// retracts its own operation and nothing else.
describe('useMsePlayer — refill playback operations are exact (#306)', () => {
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

  // A minimal stand-in for the registry: enough to record which operation each
  // call registered and which one a retraction actually named.
  function fakeRegistry() {
    const registered: { id: number; target: string; kind: string }[] = []
    const retracted: number[] = []
    let next = 1
    return {
      registered,
      retracted,
      begin: (target: 'play' | 'pause', kind: string = 'echo') => {
        const id = next++
        registered.push({ id, target, kind })
        return { id, retract: () => retracted.push(id) }
      }
    }
  }

  async function runRefill(playImpl: () => Promise<void>) {
    const fakeSb = new FakeSourceBuffer()
    fakeSb.buffered.ranges = [[0, 5]]
    fakeSb.onAbort = () => {
      fakeSb.buffered.ranges = [[99, 105]]
    }
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const video = {
      currentTime: 100,
      // Playing, so the refill's `pause()` really does move the element and is
      // therefore worth registering — the same rule every mark site follows.
      paused: false,
      error: null,
      play: vi.fn(async () => {
        video.paused = false
        await playImpl()
      }),
      pause: vi.fn(() => {
        video.paused = true
      })
    }
    const reg = fakeRegistry()
    setApi({
      playerStreamSeek: vi.fn(async () => ({ generation: 1, timestampOffset: 99 })),
      playerStreamStart: vi.fn(async () => {}),
      playerStreamAck: vi.fn(async () => {})
    })

    const m = useMsePlayer(
      makeDeps({
        getVideoEl: () => video as unknown as HTMLVideoElement,
        beginProgrammaticPlayback: reg.begin
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
    await m._internal.handleUnbufferedSeek()
    m.resetMseState()
    return { reg, video }
  }

  it('registers the refill pause and its resume as echo operations', async () => {
    const { reg, video } = await runRefill(async () => {})

    expect(video.pause).toHaveBeenCalled()
    expect(video.play).toHaveBeenCalled()
    expect(reg.registered).toEqual([
      { id: 1, target: 'pause', kind: 'echo' },
      { id: 2, target: 'play', kind: 'echo' }
    ])
    // Nothing rejected, so the `play` event is still owed and nothing is
    // retracted.
    expect(reg.retracted).toEqual([])
  })

  it('a rejected resume retracts only its own operation, never the refill pause', async () => {
    const { reg } = await runRefill(async () => {
      throw new DOMException('blocked', 'NotAllowedError')
    })

    // Exactly the resume, by id. The old dep took `null` and syncplay cleared
    // whichever resume mark happened to be in its single slot — including a
    // newer site's.
    expect(reg.retracted).toEqual([2])
    expect(reg.registered.find((o) => o.id === 2)?.target).toBe('play')
  })
})

// The seek twin of the block above (#306 Phase B). The resume land is the one
// seek site that holds its handle, because it is the one wrapping its
// `currentTime` write in a `catch`: an assignment that throws fires no `seeked`,
// so under the old single slot its mark latched for the full 15 s TTL and
// swallowed the user's next real seek. The handle makes the cleanup exact, and
// nothing else in the suite notices when the `retract()` call is deleted — which
// is why this test exists and why the rule it discharges ("no retraction path
// without a test") is restated in `docs/syncplay.md` and on
// `beginProgrammaticSeek`.
describe('useMsePlayer — the resume land retracts its own seek operation (#306)', () => {
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
    appendBuffer(): void {}
    remove(): void {
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')))
    }
    abort(): void {}
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

  // The seek-side stand-in for the registry, the twin of `fakeRegistry()` above:
  // a distinct spy per registration, so "which operation was retracted" is
  // answerable rather than just "something was".
  function fakeSeekRegistry() {
    const registered: { id: number; target: number; retract: ReturnType<typeof vi.fn> }[] = []
    const retracted: number[] = []
    let next = 1
    return {
      registered,
      retracted,
      begin: (target: number) => {
        const id = next++
        const retract = vi.fn(() => {
          retracted.push(id)
        })
        registered.push({ id, target, retract })
        return { id, retract }
      }
    }
  }

  it('retracts exactly its own seek operation when the land write throws', () => {
    const fakeSb = new FakeSourceBuffer()
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const reg = fakeSeekRegistry()
    let writes = 0
    // Unlike the plain-object fakes elsewhere in this file, `currentTime` needs a
    // real setter here: the `catch` the land grew only exists for a write that
    // throws, which is what a detached or torn-down element does.
    const video = {
      get currentTime(): number {
        return 0
      },
      set currentTime(_v: number) {
        writes++
        throw new DOMException('detached', 'InvalidStateError')
      },
      paused: true,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }

    const m = useMsePlayer(
      makeDeps({
        getVideoEl: () => video as unknown as HTMLVideoElement,
        beginProgrammaticSeek: reg.begin
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

    // A remote apply registered in between — the bystander. Under the old single
    // slot the land's failure cleared whatever mark occupied it, so this one's
    // echo escaped as a user seek and dragged the room back.
    const apply = reg.begin(120)

    fakeSb.buffered.ranges = [[1395.08, 1401.0]]
    fakeSb.dispatchEvent(new Event('updateend'))

    // The land really did attempt the write and really did throw.
    expect(writes).toBe(1)

    const land = reg.registered.find((o) => o.target === 1400)
    expect(land).toBeDefined()
    expect(land?.retract).toHaveBeenCalledTimes(1)

    // Exactness, which is the whole point of the handle: the bystander survives.
    expect(apply.retract).not.toHaveBeenCalled()
    expect(reg.retracted).toEqual([land?.id])

    m.resetMseState()
  })

  // The containment half of the same shape, and the reason the registration is a
  // `let` declared above the `try` with the assignment as the first statement
  // *inside* it. Declared-and-assigned outside, a throw from
  // `beginProgrammaticSeek` escapes `onSourceBufferUpdateEnd` before
  // `initialLandPending = false` runs, and the land — a once-per-session affair —
  // retries on the next append. The dep throws exactly once here so the two
  // shapes are told apart by what the *second* `updateend` does: nothing under
  // the current shape, a full land write under the reverted one.
  it('consumes the pending flag when the registration itself throws, so the land does not retry', () => {
    const fakeSb = new FakeSourceBuffer()
    const fakeMs = new FakeMediaSource(fakeSb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)

    const reg = fakeSeekRegistry()
    let begins = 0
    const begin = (target: number): { id: number; retract: ReturnType<typeof vi.fn> } => {
      begins++
      if (begins === 1) throw new Error('registry unavailable')
      return reg.begin(target)
    }

    let writes = 0
    const video = {
      get currentTime(): number {
        return 0
      },
      set currentTime(_v: number) {
        writes++
      },
      paused: true,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }

    const m = useMsePlayer(
      makeDeps({
        getVideoEl: () => video as unknown as HTMLVideoElement,
        beginProgrammaticSeek: begin
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

    fakeSb.buffered.ranges = [[1395.08, 1401.0]]
    fakeSb.dispatchEvent(new Event('updateend'))

    // The throw was contained: it took the write down with it, but it did not
    // take the handler down — nothing was registered, nothing was retracted.
    expect(begins).toBe(1)
    expect(writes).toBe(0)
    expect(reg.registered).toHaveLength(0)
    expect(reg.retracted).toEqual([])

    // The flag was consumed anyway, so the next append is not a second chance.
    fakeSb.dispatchEvent(new Event('updateend'))
    expect(begins).toBe(1)
    expect(writes).toBe(0)
    expect(reg.registered).toHaveLength(0)

    m.resetMseState()
  })
})
