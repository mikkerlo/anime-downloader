import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { safeEvictEnd, useMsePlayer } from '../../../src/renderer/src/composables/use-mse-player'
import {
  NON_SYNC,
  SYNC,
  concat,
  fragment,
  initSegment,
  topLevelBoxes
} from '../../helpers/fmp4-boxes'

// Hand-built fMP4 for the keyframe tracker the evictions read (#653): a video
// track at 16 kHz with 24 fps frames, flagged the way ffmpeg's mux flags them.
const FMP4_TS = 16000
const FMP4_FRAME = 667
const fmp4Init = (): Uint8Array =>
  initSegment([
    { id: 1, handler: 'vide', timescale: FMP4_TS },
    { id: 2, handler: 'soun', timescale: 48000 }
  ])
const videoFragment = (seconds: number, keyframe: boolean): Uint8Array =>
  fragment([
    {
      trackId: 1,
      tfdt: Math.round(seconds * FMP4_TS),
      tfhdFlags: NON_SYNC,
      ...(keyframe ? { firstSampleFlags: SYNC } : {}),
      samples: Array.from({ length: 24 }, () => ({ duration: FMP4_FRAME, size: 8 }))
    }
  ])
const keyframeFragment = (seconds: number): Uint8Array => videoFragment(seconds, true)
const nonKeyframe = (seconds: number): Uint8Array => videoFragment(seconds, false)
/** An init segment plus `count` keyframe fragments every `step` seconds from `start`. */
const keyframeRun = (start: number, step: number, count: number): Uint8Array =>
  concat([
    fmp4Init(),
    ...Array.from({ length: count }, (_, i) => keyframeFragment(start + i * step))
  ])
/** What the tracker records for a keyframe fragment at `seconds` of run time. */
const recordedKeyframe = (seconds: number, offset = 0): number =>
  (Math.round(seconds * FMP4_TS) - FMP4_FRAME) / FMP4_TS + offset

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
  playerDiagReport: (line: string) => Promise<void>
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
      onPlayerStreamProgress: noopSub,
      // Every session runs the stall watchdog (#653).
      playerDiagReport: async () => {}
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

  describe('drive-disconnected (#582)', () => {
    function rig() {
      const calls: string[] = []
      // `resetMseState()` revokes the source and clears the session id; each
      // callback records what it saw, which pins the order.
      const seen = (what: string): string =>
        `${what}:${m.streamSessionId.value}:${m.mseSrcUrl.value}`
      const deps = makeDeps({
        savePosition: vi.fn(() => void calls.push(seen('save'))),
        onDriveDisconnected: vi.fn(() => void calls.push(seen('overlay')))
      })
      const m = useMsePlayer(deps)
      m.streamSessionId.value = 'mine'
      m.mseSrcUrl.value = 'blob:live'
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      return { m, deps, calls }
    }

    it('saves the position before resetMseState(), then raises the overlay', () => {
      const { m, calls } = rig()
      m._internal.handleStreamError('mine', 'ffmpeg exited with code 254', 'drive-disconnected')
      expect(calls).toEqual(['save:mine:blob:live', 'overlay::'])
      expect(m.remuxError.value).toBe('')
      expect(m.hasActiveSession.value).toBe(false)
    })

    it('without a reason it behaves as today: remuxError, a reset, no save, no overlay', () => {
      const { m, deps, calls } = rig()
      m._internal.handleStreamError('mine', 'ffmpeg crashed')
      expect(calls).toEqual([])
      expect(deps.savePosition).not.toHaveBeenCalled()
      expect(m.remuxError.value).toBe('ffmpeg crashed')
      expect(m.streamSessionId.value).toBe('')
    })

    it('the subscription passes the reason through as the third argument', () => {
      let cb: ((d: PlayerStreamErrorPayload) => void) | undefined
      setApi({
        onPlayerStreamError: ((fn: (d: PlayerStreamErrorPayload) => void) => {
          cb = fn
          return () => {}
        }) as Api['onPlayerStreamError']
      })
      const { m, calls } = rig()
      m.subscribeStreamEvents()
      cb!({ sessionId: 'mine', error: 'x', reason: 'drive-disconnected' })
      expect(calls).toEqual(['save:mine:blob:live', 'overlay::'])
    })
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
    expect(m.mkvBuffering.value).toBe(false)
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
      timestampOffset: 0,
      refusedSeek: false
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
      timestampOffset: 0,
      refusedSeek: false
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
      timestampOffset: 0,
      refusedSeek: false
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
      timestampOffset: 595,
      refusedSeek: false
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
      timestampOffset: 0,
      refusedSeek: false
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))

    fakeSb.buffered.ranges = [[0.0, 2.0]]
    fakeSb.dispatchEvent(new Event('updateend'))

    // resumeTarget 0 → no landing; plays from 0.
    expect(video.currentTime).toBe(0)

    m.resetMseState()
  })

  // #560: an open at 0 on a B-frame source has a negative offset (the keyframe
  // is emitted at the B-frame delay). The open used to apply only `> 0`, which
  // left the whole session 83 ms late; the playhead still never goes below 0,
  // on a plain open or a refused one (#295).
  it.each([
    { label: 'play-from-start', resumeTarget: 0, refusedSeek: false },
    { label: 'a refused open', resumeTarget: 3000, refusedSeek: true }
  ])('applies a negative open offset — $label', ({ resumeTarget, refusedSeek }) => {
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
    const beginProgrammaticSeek = vi.fn(() => fakeSeekOp())
    const m = useMsePlayer(
      makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement, beginProgrammaticSeek })
    )
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 1421,
      mimeType: 'video/mp4',
      resumeTarget,
      timestampOffset: -0.083,
      refusedSeek
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))
    expect(fakeSb.timestampOffset).toBe(-0.083)

    // The pre-zero frames fall outside the default appendWindowStart of 0.
    fakeSb.buffered.ranges = [[0.0, 2.0]]
    fakeSb.dispatchEvent(new Event('updateend'))

    expect(video.currentTime).toBe(0)
    expect(beginProgrammaticSeek).not.toHaveBeenCalled()

    m.resetMseState()
  })

  // #239: no wall clock gates the renderer's sends any more (#304 removed the
  // last of it), so this land is only kept off the wire by the marker.
  // Unmarked, syncplay reads it as the user seeking and the reference server
  // drags every peer onto our resume point.
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
      timestampOffset: 595,
      refusedSeek: false
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
  // `ranges` is annotated because `SourceBuffer.buffered.ranges` wants pairs, and
  // an inferred table would widen `[[0, 2]]` to `number[][]`.
  it.each<{
    label: string
    resumeTarget: number
    offset: number
    at: number
    ranges: [number, number][]
  }>([
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
        timestampOffset: offset,
        refusedSeek: false
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
        timestampOffset: 1395,
        refusedSeek: false
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
        timestampOffset: 1395,
        refusedSeek: false
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
      // @ts-expect-error `refusedSeek` is required on `StartMseSessionOpts`, and this
      // one harness has to be able to leave it genuinely absent: the fail-open case
      // below asserts what the runtime does with no value at all, which no
      // type-satisfying argument can express. Every other call site in this file
      // passes it.
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
      // caller cannot omit it — `landHarness` above carries the one
      // `@ts-expect-error` in this file so that this case can hand the
      // composable no value at all. The runtime direction is deliberate (#295):
      // were the field ever to go missing, the degradation is the pre-#275
      // behaviour, not a stall.
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
      timestampOffset: 0,
      refusedSeek: false
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
      timestampOffset: 1395,
      refusedSeek: false
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
      timestampOffset: 1395,
      refusedSeek: false
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

// #607: main holds a run's `player:stream-end` until `player:stream-start` has
// flushed the prelude, so after an unbuffered seek the renderer sees the reply,
// then the new run's chunks, then its end. The first case is that contract; the
// second is why main has to hold the end at all — the reply clears
// `streamEnded`, so an end that beats it is lost.
describe('useMsePlayer — stream end vs. the seek reply (#607)', () => {
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
    constructor(private log: string[]) {
      super()
    }
    appendBuffer(chunk: Uint8Array): void {
      this.updating = true
      this.log.push(`append:${chunk[0]}`)
      queueMicrotask(() => {
        this.updating = false
        this.dispatchEvent(new Event('updateend'))
      })
    }
    remove(): void {
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')))
    }
    abort(): void {
      // The fresh run's range, already wide enough for the buffer-ahead gate.
      this.buffered.ranges = [[1395, 1410]]
    }
  }

  class FakeMediaSource extends EventTarget {
    readyState = 'closed'
    duration = 0
    endOfStream = vi.fn(() => {
      this.log.push('endOfStream')
      this.readyState = 'ended'
    })
    constructor(
      public sb: FakeSourceBuffer,
      private log: string[]
    ) {
      super()
    }
    addSourceBuffer(): FakeSourceBuffer {
      this.readyState = 'open'
      return this.sb
    }
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
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).MediaSource = origMediaSource
    ;(globalThis as Record<string, unknown>).URL = origURL
    vi.restoreAllMocks()
  })

  const settle = (): Promise<void> => new Promise((res) => setTimeout(res, 0))

  function openAndSeek() {
    const log: string[] = []
    const fakeSb = new FakeSourceBuffer(log)
    fakeSb.buffered.ranges = [[0, 5]]
    const fakeMs = new FakeMediaSource(fakeSb, log)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => fakeMs)
    const video = {
      currentTime: 1400,
      paused: true,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }
    let reply: (r: { generation: number; timestampOffset: number }) => void = () => {}
    const startSpy = vi.fn(async () => {})
    setApi({
      playerStreamSeek: vi.fn(
        () => new Promise<{ generation: number; timestampOffset: number }>((res) => (reply = res))
      ),
      playerStreamStart: startSpy,
      playerStreamAck: vi.fn(async () => {})
    })
    const m = useMsePlayer(makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement }))
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 1421,
      mimeType: 'video/mp4',
      resumeTarget: 0,
      timestampOffset: 0,
      refusedSeek: false
    })
    fakeMs.dispatchEvent(new Event('sourceopen'))
    expect(startSpy).toHaveBeenCalledTimes(1)
    const seekDone = m._internal.handleUnbufferedSeek()
    return {
      m,
      log,
      fakeMs,
      seekDone,
      replyAndHandshake: async (): Promise<void> => {
        reply({ generation: 1, timestampOffset: 1395 })
        await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2))
      }
    }
  }

  it('an end that follows the new run’s chunks ends the stream once, after the drain', async () => {
    const { m, log, fakeMs, seekDone, replyAndHandshake } = openAndSeek()
    await replyAndHandshake()

    // The order main's hold guarantees: the prelude chunks, then the end, on
    // one sender — so they can land while the queue is still draining.
    m._internal.handleStreamChunk('s1', 1, new Uint8Array([1]))
    m._internal.handleStreamChunk('s1', 1, new Uint8Array([2]))
    m._internal.handleStreamEnd('s1')
    expect(fakeMs.endOfStream).not.toHaveBeenCalled()
    await settle()

    expect(fakeMs.endOfStream).toHaveBeenCalledTimes(1)
    expect(log).toEqual(['append:1', 'append:2', 'endOfStream'])

    await seekDone
    m.resetMseState()
  })

  it('an end that beats the seek reply is dropped; only a later end ends the stream', async () => {
    const { m, log, fakeMs, seekDone, replyAndHandshake } = openAndSeek()

    // The #607 red order, which main no longer produces: the new run's end
    // arrives while the reply is still outstanding.
    m._internal.handleStreamEnd('s1')
    await replyAndHandshake()
    m._internal.handleStreamChunk('s1', 1, new Uint8Array([1]))
    m._internal.handleStreamChunk('s1', 1, new Uint8Array([2]))
    await settle()

    // Every chunk is in, the source is still open, and nothing re-arms the end
    // the reply cleared (`streamEnded = false` in `handleUnbufferedSeek`).
    expect(log).toEqual(['append:1', 'append:2'])
    expect(fakeMs.endOfStream).not.toHaveBeenCalled()
    expect(fakeMs.readyState).toBe('open')

    m._internal.handleStreamEnd('s1')
    await settle()
    expect(fakeMs.endOfStream).toHaveBeenCalledTimes(1)

    await seekDone
    m.resetMseState()
  })
})

// #634: a stream error tears the session down while `handleUnbufferedSeek` is
// parked on an await. PlayerView then drops the `<video>` src, which detaches
// the MediaSource and removes its SourceBuffers, so every later `buffered` read
// or `timestampOffset` write on the captured `sb` throws. The continuation must
// notice the teardown after each await and stop touching the old session.
describe('useMsePlayer — a stream error during the seek continuation (#634)', () => {
  type SeekReply = { generation: number; timestampOffset: number } | { error: string }

  const removedError = (): DOMException =>
    new DOMException(
      'This SourceBuffer has been removed from the parent media source.',
      'InvalidStateError'
    )

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

  // A SourceBuffer that can be removed from its MediaSource. `remove()` never
  // finishes on its own, so each test decides when (or whether) the drain ends.
  class DetachableSourceBuffer extends EventTarget {
    updating = false
    detached = false
    removeCalls: [number, number][] = []
    afterAbort: [number, number][] | null = null
    ranges = new FakeBuffered()
    private offset = 0
    get buffered(): FakeBuffered {
      if (this.detached) throw removedError()
      return this.ranges
    }
    get timestampOffset(): number {
      return this.offset
    }
    set timestampOffset(v: number) {
      if (this.detached) throw removedError()
      this.offset = v
    }
    appendBuffer(): void {}
    remove(start: number, end: number): void {
      this.removeCalls.push([start, end])
      this.updating = true
    }
    finishRemove(): void {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    }
    abort(): void {
      if (this.afterAbort) this.ranges.ranges = this.afterAbort
    }
    // What the MSE spec does to a SourceBuffer removed mid-`remove()`.
    detach(): void {
      this.detached = true
      this.updating = false
      this.dispatchEvent(new Event('abort'))
      this.dispatchEvent(new Event('updateend'))
    }
  }

  class FakeMediaSource extends EventTarget {
    readyState = 'closed'
    duration = 0
    constructor(public sb: DetachableSourceBuffer) {
      super()
    }
    addSourceBuffer(): DetachableSourceBuffer {
      this.readyState = 'open'
      return this.sb
    }
    endOfStream(): void {
      this.readyState = 'ended'
    }
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
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).MediaSource = origMediaSource
    ;(globalThis as Record<string, unknown>).URL = origURL
    vi.restoreAllMocks()
  })

  function rig() {
    const video = {
      currentTime: 100,
      paused: false,
      error: null,
      play: vi.fn(async () => {
        video.paused = false
      }),
      pause: vi.fn(() => {
        video.paused = true
      })
    }
    const replies: ((r: SeekReply) => void)[] = []
    const seekSpy = vi.fn(() => new Promise<SeekReply>((res) => replies.push(res)))
    const startSpy = vi.fn<(sessionId: string) => Promise<void>>(async () => {})
    setApi({
      playerStreamSeek: seekSpy,
      playerStreamStart: startSpy,
      playerStreamAck: vi.fn(async () => {})
    })
    const setSyncplayLocalReady = vi.fn()
    const m = useMsePlayer(
      makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement, setSyncplayLocalReady })
    )
    function open(sessionId: string): DetachableSourceBuffer {
      const sb = new DetachableSourceBuffer()
      const ms = new FakeMediaSource(sb)
      ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => ms)
      m.startMseSession({
        sessionId,
        generation: 0,
        duration: 1400,
        mimeType: 'video/mp4',
        resumeTarget: 0,
        timestampOffset: 0,
        refusedSeek: false
      })
      ms.dispatchEvent(new Event('sourceopen'))
      return sb
    }
    const sb = open('s1')
    // The target (100) is outside what is buffered, so the respawn path runs.
    sb.ranges.ranges = [[0, 5]]
    return {
      m,
      video,
      sb,
      open,
      seekSpy,
      startSpy,
      setSyncplayLocalReady,
      // Resolves the oldest outstanding seek.
      reply: (r: SeekReply): void => replies.shift()!(r)
    }
  }

  it('an error during the remove drain abandons the continuation (T1)', async () => {
    const { m, video, sb, startSpy, setSyncplayLocalReady, reply } = rig()
    const seekDone = m._internal.handleUnbufferedSeek()
    reply({ generation: 1, timestampOffset: 99 })
    await vi.waitFor(() => expect(sb.removeCalls).toHaveLength(1))

    m._internal.handleStreamError('s1', 'ffmpeg exited with code 183')
    // Stands in for PlayerView's `src` patch: the composable never removes the
    // SourceBuffer itself.
    sb.detach()

    await expect(seekDone).resolves.toBeUndefined()
    expect(startSpy.mock.calls).toEqual([['s1']])
    expect(m.mkvBuffering.value).toBe(false)
    expect(video.pause).not.toHaveBeenCalled()
    expect(setSyncplayLocalReady).not.toHaveBeenCalledWith(false)
    expect(m.remuxError.value).toBe('ffmpeg exited with code 183')
    expect(m.hasActiveSession.value).toBe(false)
  })

  // Parks the continuation in the buffer-ahead gate: the fresh run's range is
  // short of the 1.5 s lead, so the gate polls.
  async function seekIntoGate(r: ReturnType<typeof rig>): Promise<{ seekDone: Promise<void> }> {
    r.sb.afterAbort = [[99, 99.5]]
    const seekDone = r.m._internal.handleUnbufferedSeek()
    r.reply({ generation: 1, timestampOffset: 99 })
    await vi.waitFor(() => expect(r.sb.removeCalls).toHaveLength(1))
    r.sb.finishRemove()
    await vi.waitFor(() => expect(r.m.mkvBuffering.value).toBe(true))
    // Wrapped, or the async return would adopt `seekDone` and wait out the gate.
    return { seekDone }
  }

  it('an error during the buffer-ahead poll clears the toast and leaves the gate (T2)', async () => {
    const r = rig()
    const { m, video, sb, startSpy, setSyncplayLocalReady } = r
    const { seekDone } = await seekIntoGate(r)
    expect(video.pause).toHaveBeenCalledTimes(1)

    m._internal.handleStreamError('s1', 'ffmpeg exited with code 183')
    sb.detach()
    expect(m.mkvBuffering.value).toBe(false)

    await expect(seekDone).resolves.toBeUndefined()
    expect(video.play).not.toHaveBeenCalled()
    expect(setSyncplayLocalReady).toHaveBeenLastCalledWith(true)
    expect(startSpy.mock.calls).toEqual([['s1'], ['s1']])
    expect(m.mkvBuffering.value).toBe(false)
  })

  it('an error during the last poll before the deadline does not resume the element (T2b)', async () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const r = rig()
    const { m, video, sb } = r
    const { seekDone } = await seekIntoGate(r)

    // The gate is asleep in a poll; the deadline passes before it wakes, so
    // the `while` exits without another in-loop check.
    clock += 5000
    m._internal.handleStreamError('s1', 'ffmpeg exited with code 183')
    sb.detach()

    await expect(seekDone).resolves.toBeUndefined()
    expect(video.play).not.toHaveBeenCalled()
    expect(m.mkvBuffering.value).toBe(false)
  })

  it('a session opened while the old continuation is parked keeps its toast and its element (T3)', async () => {
    const { m, video, sb, open, startSpy, reply } = rig()
    const seekDone = m._internal.handleUnbufferedSeek()
    reply({ generation: 1, timestampOffset: 99 })
    await vi.waitFor(() => expect(sb.removeCalls).toHaveLength(1))
    m._internal.handleStreamError('s1', 'ffmpeg exited with code 183')

    const sb2 = open('s2')
    // PlayerView sets the toast right after `startMseSession`.
    m.mkvBuffering.value = true
    sb.detach()

    await expect(seekDone).resolves.toBeUndefined()
    expect(startSpy.mock.calls).toEqual([['s1'], ['s2']])
    expect(video.pause).not.toHaveBeenCalled()
    expect(m.mkvBuffering.value).toBe(true)
    expect(sb2.timestampOffset).toBe(0)
    m.resetMseState()
  })

  // T3 parks the stale continuation in the remove drain; this one parks it in
  // the gate, the only window that reaches the post-gate check.
  it('a session opened while the old continuation is in the gate keeps its toast (T3b)', async () => {
    const r = rig()
    const { m, sb, open } = r
    const { seekDone } = await seekIntoGate(r)
    m._internal.handleStreamError('s1', 'ffmpeg exited with code 183')
    open('s2')
    m.mkvBuffering.value = true
    sb.detach()
    await expect(seekDone).resolves.toBeUndefined()
    expect(m.mkvBuffering.value).toBe(true)
    m.resetMseState()
  })

  it('an error before the seek reply leaves nothing to undo (T5)', async () => {
    const { m, sb, startSpy, reply } = rig()
    const seekDone = m._internal.handleUnbufferedSeek()
    m._internal.handleStreamError('s1', 'ffmpeg exited with code 183')
    sb.detach()
    reply({ generation: 1, timestampOffset: 99 })

    await expect(seekDone).resolves.toBeUndefined()
    expect(sb.removeCalls).toEqual([])
    expect(startSpy.mock.calls).toEqual([['s1']])
    expect(m.mkvBuffering.value).toBe(false)
  })

  it('an { error } seek reply on a live session still releases the in-flight flag (T6)', async () => {
    const { m, video, seekSpy, reply } = rig()
    const first = m._internal.handleUnbufferedSeek()
    reply({ error: 'seek failed' })
    await first

    video.currentTime = 200
    const second = m._internal.handleUnbufferedSeek()
    expect(seekSpy.mock.calls).toEqual([
      ['s1', 100],
      ['s1', 200]
    ])
    reply({ error: 'seek failed' })
    await second
    m.resetMseState()
  })

  // The stale `finally` no longer clears the in-flight flag, so a session
  // opened without a `resetMseState()` in between must clear it itself.
  it('a new session does not inherit a parked seek’s in-flight flag (T7)', async () => {
    const { m, video, open, seekSpy, reply } = rig()
    const parked = m._internal.handleUnbufferedSeek()

    const sb2 = open('s2')
    sb2.ranges.ranges = [[0, 5]]
    video.currentTime = 300
    const next = m._internal.handleUnbufferedSeek()
    expect(seekSpy.mock.calls).toEqual([
      ['s1', 100],
      ['s2', 300]
    ])

    reply({ generation: 1, timestampOffset: 99 })
    await expect(parked).resolves.toBeUndefined()
    // s2's seek is still in flight, so the stale finally must not have released it.
    video.currentTime = 400
    void m._internal.handleUnbufferedSeek()
    expect(seekSpy).toHaveBeenCalledTimes(2)
    reply({ error: 'seek failed' })
    await next
    m.resetMseState()
  })
})

// #640: after a seek far past the buffer start, the back-eviction (every
// `updateend`) and the quota eviction read the new `currentTime` and could
// empty the buffer before the respawn debounce fired. The debounce then saw an
// empty buffer, took it for a fresh respawn, and never respawned. Both
// evictions now stand down while a respawn is pending.
describe('useMsePlayer — far seek vs. the back-eviction (#640)', () => {
  type SeekReply = { generation: number; timestampOffset: number } | { error: string }
  // Not 0, so a chunk only reaches `appendBuffer` when it carries the session's
  // real generation.
  const GEN = 7

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

  // Unlike the fakes above, `remove()` really cuts `[start, end)` out of
  // `buffered`, so an eviction can empty the buffer the debounce then reads.
  class CuttingSourceBuffer extends EventTarget {
    updating = false
    timestampOffset = 0
    buffered = new FakeBuffered()
    quota = false
    appendCalls = 0
    removeCalls: [number, number][] = []
    appendBuffer(): void {
      this.appendCalls++
      if (this.quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      this.updating = true
      queueMicrotask(() => this.finish())
    }
    remove(start: number, end: number): void {
      this.removeCalls.push([start, end])
      this.updating = true
      const kept: [number, number][] = []
      for (const [s, e] of this.buffered.ranges) {
        if (s < start) kept.push([s, Math.min(e, start)])
        if (e > end) kept.push([Math.max(s, end), e])
      }
      this.buffered.ranges = kept
      queueMicrotask(() => this.finish())
    }
    abort(): void {}
    private finish(): void {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    }
  }

  class FakeMediaSource extends EventTarget {
    readyState = 'closed'
    duration = 0
    constructor(public sb: CuttingSourceBuffer) {
      super()
    }
    addSourceBuffer(): CuttingSourceBuffer {
      this.readyState = 'open'
      return this.sb
    }
    endOfStream(): void {
      this.readyState = 'ended'
    }
  }

  let origMediaSource: unknown
  let origURL: unknown
  let teardown: (() => void)[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    origMediaSource = (globalThis as Record<string, unknown>).MediaSource
    origURL = (globalThis as Record<string, unknown>).URL
    ;(globalThis as Record<string, unknown>).URL = {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {}
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const fn of teardown) fn()
    teardown = []
    vi.useRealTimers()
    ;(globalThis as Record<string, unknown>).MediaSource = origMediaSource
    ;(globalThis as Record<string, unknown>).URL = origURL
    vi.restoreAllMocks()
  })

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  function rig(ranges: [number, number][], currentTime: number) {
    const video = {
      currentTime,
      paused: false,
      error: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(() => {})
    }
    // The seek reply is held open: the respawn stays in flight until teardown.
    const replies: ((r: SeekReply) => void)[] = []
    const seekSpy = vi.fn(
      (_sessionId: string, _seekAt: number) => new Promise<SeekReply>((res) => replies.push(res))
    )
    setApi({
      playerStreamSeek: seekSpy,
      playerStreamStart: vi.fn(async () => {}),
      playerStreamAck: vi.fn(async () => {})
    })
    const m = useMsePlayer(makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement }))
    const sb = new CuttingSourceBuffer()
    const ms = new FakeMediaSource(sb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => ms)
    m.startMseSession({
      sessionId: 's1',
      generation: GEN,
      duration: 1400,
      mimeType: 'video/mp4',
      resumeTarget: 0,
      timestampOffset: 0,
      refusedSeek: false
    })
    // Keyframes every 10 s, so the eviction has a safe end to remove to (#653)
    // and these cases still pin the respawn guard rather than an empty list.
    m._internal.handleStreamChunk('s1', GEN, keyframeRun(0, 10, 11))
    ms.dispatchEvent(new Event('sourceopen'))
    sb.buffered.ranges = ranges
    teardown.push(() => {
      m.resetMseState()
      for (const reply of replies) reply({ error: 'torn down' })
    })
    return { m, video, sb, seekSpy }
  }

  it('an updateend inside the debounce does not empty the buffer the respawn reads (T-A)', async () => {
    const { m, video, sb, seekSpy } = rig([[0, 25]], 10)
    video.currentTime = 90
    m.maybeRespawnForUnbufferedPosition()
    // The old run's append completing inside the 250 ms window.
    sb.dispatchEvent(new Event('updateend'))
    await flush()
    vi.advanceTimersByTime(250)

    expect(seekSpy.mock.calls).toEqual([['s1', 90]])
    expect(sb.removeCalls).toEqual([])
  })

  it('a QuotaExceededError inside the debounce does not empty the buffer either (T-B)', async () => {
    const { m, video, sb, seekSpy } = rig([[0, 25]], 10)
    // The rig's own append completes first, so the next chunk reaches appendBuffer.
    await flush()
    video.currentTime = 90
    m.maybeRespawnForUnbufferedPosition()
    sb.quota = true
    const appends = sb.appendCalls
    m._internal.handleStreamChunk('s1', GEN, nonKeyframe(30))
    // The chunk got as far as the append, so the quota path really ran.
    expect(sb.appendCalls).toBe(appends + 1)
    await flush()
    vi.advanceTimersByTime(250)

    expect(seekSpy.mock.calls).toEqual([['s1', 90]])
    expect(sb.removeCalls).toEqual([])
  })

  it('the back-eviction still runs in normal playback (T-C)', async () => {
    const { sb, seekSpy } = rig([[0, 110]], 100)
    sb.dispatchEvent(new Event('updateend'))
    await flush()

    // To the recorded keyframe at or below t − 30 (#653): 70 s, one frame early.
    expect(sb.removeCalls).toEqual([[0, recordedKeyframe(70)]])
    expect(sb.buffered.ranges).toEqual([[recordedKeyframe(70), 110]])
    expect(seekSpy).not.toHaveBeenCalled()
  })

  it('the same far seek with no eviction in the window respawns (control)', () => {
    const { m, video, seekSpy } = rig([[0, 25]], 10)
    video.currentTime = 90
    m.maybeRespawnForUnbufferedPosition()
    vi.advanceTimersByTime(250)

    expect(seekSpy.mock.calls).toEqual([['s1', 90]])
  })

  // While the seek IPC is pending, a back-eviction would leave a remove running
  // into the respawn's `abort()` and `timestampOffset` write, so both would
  // throw and the new run would land on the wrong offset (the #198 failure).
  it('an updateend while the respawn is in flight does not evict (T-D)', async () => {
    const { m, video, sb, seekSpy } = rig([[0, 25]], 10)
    video.currentTime = 90
    m.maybeRespawnForUnbufferedPosition()
    vi.advanceTimersByTime(250)
    expect(seekSpy.mock.calls).toEqual([['s1', 90]])

    sb.dispatchEvent(new Event('updateend'))
    await flush()

    expect(sb.removeCalls).toEqual([])
    expect(sb.buffered.ranges).toEqual([[0, 25]])
  })
})

// ---------------------------------------------------------------------------
// #653: back-eviction on long-GOP files, and the report-only stall watchdog.
// ---------------------------------------------------------------------------

class RangeList {
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

// Chromium's removal semantics: `remove(start, end)` also takes every frame up
// to the next buffered random-access point at or after `end`, or the rest of
// the range when there is none. The frames of that GOP still arriving from
// ffmpeg are then dropped, so the buffer only grows again from the next
// keyframe in the file (`land`).
class GopSourceBuffer extends EventTarget {
  updating = false
  timestampOffset = 0
  buffered = new RangeList()
  quota = false
  appended: Uint8Array[] = []
  removeCalls: [number, number][] = []
  private resumeAt: number | null = null

  constructor(private fileKeyframes: number[]) {
    super()
  }

  appendBuffer(chunk: Uint8Array): void {
    this.appended.push(chunk)
    if (this.quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    this.updating = true
    queueMicrotask(() => this.finish())
  }

  remove(start: number, end: number): void {
    this.removeCalls.push([start, end])
    this.updating = true
    const buffered = (k: number): boolean => this.buffered.ranges.some(([s, e]) => k >= s && k < e)
    const rap = this.fileKeyframes.find((k) => k >= end && buffered(k))
    if (rap === undefined) this.resumeAt = this.fileKeyframes.find((k) => k >= end) ?? Infinity
    const cutTo = rap ?? Infinity
    const kept: [number, number][] = []
    for (const [s, e] of this.buffered.ranges) {
      if (s < start) kept.push([s, Math.min(e, start)])
      if (e > cutTo) kept.push([Math.max(s, cutTo), e])
    }
    this.buffered.ranges = kept
    queueMicrotask(() => this.finish())
  }

  abort(): void {}

  /** More of the file arrives, up to `to`. */
  land(to: number): void {
    const last = this.buffered.ranges[this.buffered.ranges.length - 1]
    if (this.resumeAt !== null) {
      if (to <= this.resumeAt) return
      const from = this.resumeAt
      this.resumeAt = null
      this.buffered.ranges.push([from, to])
      return
    }
    if (last) last[1] = Math.max(last[1], to)
  }

  holds(t: number): boolean {
    return this.buffered.ranges.some(([s, e]) => t >= s && t <= e)
  }

  private finish(): void {
    this.updating = false
    this.dispatchEvent(new Event('updateend'))
  }
}

class GopMediaSource extends EventTarget {
  readyState = 'closed'
  duration = 0
  constructor(public sb: GopSourceBuffer) {
    super()
  }
  addSourceBuffer(): GopSourceBuffer {
    this.readyState = 'open'
    return this.sb
  }
  endOfStream(): void {
    this.readyState = 'ended'
  }
}

interface StallVideo {
  currentTime: number
  paused: boolean
  seeking: boolean
  readyState: number
  error: null
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
}

function stallVideo(currentTime: number, readyState = 4): StallVideo {
  return {
    currentTime,
    paused: false,
    seeking: false,
    readyState,
    error: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(() => {})
  }
}

type SeekReply653 = { generation: number; timestampOffset: number } | { error: string }

function harness653() {
  const GEN = 3
  let teardown: (() => void)[] = []
  let origMediaSource: unknown
  let origURL: unknown

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    origMediaSource = (globalThis as Record<string, unknown>).MediaSource
    origURL = (globalThis as Record<string, unknown>).URL
    ;(globalThis as Record<string, unknown>).URL = {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {}
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const fn of teardown) fn()
    teardown = []
    vi.useRealTimers()
    ;(globalThis as Record<string, unknown>).MediaSource = origMediaSource
    ;(globalThis as Record<string, unknown>).URL = origURL
    vi.restoreAllMocks()
  })

  function rig(o: {
    offset: number
    t: number
    fileKeyframes?: number[]
    readyState?: number
    deps?: Partial<Parameters<typeof useMsePlayer>[0]>
    open?: boolean
  }) {
    const video = stallVideo(o.t, o.readyState)
    const replies: ((r: SeekReply653) => void)[] = []
    const seekSpy = vi.fn(
      (_sessionId: string, _seekAt: number) => new Promise<SeekReply653>((res) => replies.push(res))
    )
    const diag = vi.fn(async (_line: string) => {})
    setApi({
      playerStreamSeek: seekSpy,
      playerStreamStart: vi.fn(async () => {}),
      playerStreamAck: vi.fn(async () => {}),
      playerDiagReport: diag
    })
    const m = useMsePlayer(
      makeDeps({ getVideoEl: () => video as unknown as HTMLVideoElement, ...o.deps })
    )
    const sb = new GopSourceBuffer(o.fileKeyframes ?? [])
    const ms = new GopMediaSource(sb)
    ;(globalThis as Record<string, unknown>).MediaSource = vi.fn(() => ms)
    const start = (sessionId = 's1'): void =>
      m.startMseSession({
        sessionId,
        generation: GEN,
        duration: 1500,
        mimeType: 'video/mp4',
        resumeTarget: 0,
        timestampOffset: o.offset,
        refusedSeek: false
      })
    if (o.open !== false) {
      start()
      ms.dispatchEvent(new Event('sourceopen'))
    }
    teardown.push(() => {
      m.resetMseState()
      for (const reply of replies) reply({ error: 'torn down' })
    })
    return { m, video, sb, seekSpy, replies, diag, start }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  async function feed(
    m: ReturnType<typeof useMsePlayer>,
    bytes: Uint8Array,
    gen = GEN
  ): Promise<void> {
    m._internal.handleStreamChunk('s1', gen, bytes)
    await flush()
  }

  return { GEN, rig, flush, feed }
}

describe('safeEvictEnd (#653)', () => {
  it('gives no removal for a seek inside a long GOP, where t − 30 gave 406.6 (B1)', () => {
    expect(safeEvictEnd(330, 436.6 - 30, [330, 490])).toBeNull()
    expect(
      safeEvictEnd(330, 436.6 - 30, [recordedKeyframe(0, 329.917), recordedKeyframe(160, 329.917)])
    ).toBeNull()
  })

  it('ends a playback eviction on the recorded keyframe, not at t − 30 = 350.1 (A1)', () => {
    const keyframes = [300, 310, 320, 330, 490].map((s) => recordedKeyframe(s))
    expect(safeEvictEnd(320, 380.1 - 30, keyframes)).toBe(recordedKeyframe(330))
  })

  it('takes the largest K with bufStart < K ≤ limit', () => {
    expect(safeEvictEnd(10, 50, [5, 10, 20, 40, 50, 60])).toBe(50)
    expect(safeEvictEnd(10, 49.99, [5, 10, 20, 40, 50, 60])).toBe(40)
    expect(safeEvictEnd(40, 45, [5, 10, 20, 40, 50])).toBeNull()
    expect(safeEvictEnd(0, 100, [])).toBeNull()
  })
})

describe('useMsePlayer — GOP-aware eviction in a long GOP (#653)', () => {
  const { GEN, rig, flush, feed } = harness653()
  const SEEK_OFFSET = 329.917
  const tenSecond = (from: number, to: number): number[] =>
    Array.from({ length: (to - from) / 10 + 1 }, (_, i) => from + i * 10)

  it('a seek inside the gap never removes the GOP the playhead is on (B1, updateend site)', async () => {
    const { m, video, sb } = rig({ offset: SEEK_OFFSET, t: 436.6, fileKeyframes: [330, 490] })
    video.seeking = true
    sb.buffered.ranges = [[330, 336]]
    // The respawn landed on the keyframe at 330: its first fragment, then 1 s ones.
    await feed(m, concat([fmp4Init(), keyframeFragment(0), ...[1, 2, 3, 4, 5].map(nonKeyframe)]))

    expect(sb.removeCalls).toEqual([])
    sb.land(470)
    expect(sb.buffered.ranges).toEqual([[330, 470]])
    expect(sb.holds(436.6)).toBe(true)
  })

  it('plays from 0 into the gap without removing the GOP it is on (A1, updateend site)', async () => {
    const { m, video, sb } = rig({
      offset: 0,
      t: 380.1,
      fileKeyframes: [...tenSecond(0, 330), ...tenSecond(490, 590)]
    })
    // Under the 60 s lead, so the append (and its updateend) goes through.
    sb.buffered.ranges = [[320, 440]]
    await feed(
      m,
      concat([fmp4Init(), ...[300, 310, 320, 330].map(keyframeFragment), nonKeyframe(331)])
    )

    expect(sb.removeCalls).toEqual([[320, recordedKeyframe(330)]])
    expect(sb.buffered.ranges).toEqual([[330, 440]])
    expect(sb.holds(380.1)).toBe(true)

    // Past the gap's end + 30 the long GOP is evictable, up to its closing keyframe.
    video.currentTime = 520.1
    sb.land(530)
    await feed(m, concat([keyframeFragment(490), nonKeyframe(491)]))
    expect(sb.removeCalls).toEqual([
      [320, recordedKeyframe(330)],
      [330, recordedKeyframe(490)]
    ])
    expect(sb.buffered.ranges).toEqual([[490, 530]])
  })

  it('a QuotaExceededError inside the gap waits for a safe end instead of evicting (G3, quota site)', async () => {
    const { m, video, sb } = rig({ offset: SEEK_OFFSET, t: 479, fileKeyframes: [330, 490] })
    sb.buffered.ranges = [[330, 538.9]]
    await feed(m, concat([fmp4Init(), keyframeFragment(0), nonKeyframe(1), keyframeFragment(160)]))
    expect(sb.removeCalls).toEqual([])

    sb.quota = true
    const chunk = nonKeyframe(161)
    m._internal.handleStreamChunk('s1', GEN, chunk)
    await flush()
    // Put back at the head of the queue, and nothing removed: no keyframe in
    // (330, t − 5] yet, and the GOP at 330 is the one the playhead is on.
    expect(sb.appended.at(-1)).toBe(chunk)
    expect(m._internal.getAppendQueueLength()).toBe(1)
    expect(sb.removeCalls).toEqual([])
    expect(sb.holds(479)).toBe(true)

    // The `timeupdate` pump retries; still nothing until the playhead is 5 s
    // past the next keyframe.
    video.currentTime = 494
    m.pumpAppendQueue()
    expect(sb.removeCalls).toEqual([])

    video.currentTime = 495.1
    m.pumpAppendQueue()
    expect(sb.appended.at(-1)).toBe(chunk)
    expect(sb.removeCalls).toEqual([[330, recordedKeyframe(160, SEEK_OFFSET)]])
    await flush()
    expect(sb.buffered.ranges).toEqual([[490, 538.9]])
    expect(sb.holds(495.1)).toBe(true)
  })

  it('starts the keyframe list empty after a respawn, so a re-seek never evicts against the old run (B-reseek)', async () => {
    const { m, video, sb, seekSpy, replies } = rig({
      offset: 0,
      t: 10,
      fileKeyframes: [330, 490]
    })
    sb.buffered.ranges = [[0, 20]]
    // The previous run, on its own timeline: two keyframes inside (330, 406.6].
    await feed(m, concat([fmp4Init(), keyframeFragment(350), keyframeFragment(400)]))
    expect(m._internal.getKeyframes()).toHaveLength(2)

    video.currentTime = 436.6
    m.maybeRespawnForUnbufferedPosition()
    vi.advanceTimersByTime(250)
    expect(seekSpy.mock.calls).toEqual([['s1', 436.6]])
    replies[0]({ generation: GEN + 1, timestampOffset: SEEK_OFFSET })
    await flush()
    expect(m._internal.getKeyframes()).toEqual([])
    // The respawn's own clear of the old buffer.
    expect(sb.removeCalls).toEqual([[0, 20]])

    sb.buffered.ranges = [[330, 336]]
    await feed(m, concat([fmp4Init(), keyframeFragment(0), nonKeyframe(1)]), GEN + 1)
    expect(m._internal.getKeyframes()).toEqual([recordedKeyframe(0, SEEK_OFFSET)])
    expect(sb.removeCalls).toEqual([[0, 20]])
    expect(sb.buffered.ranges).toEqual([[330, 336]])
  })

  it('drops keyframes parsed from old-run chunks that arrived during the seek IPC', async () => {
    const { m, video, sb, replies } = rig({ offset: 0, t: 10, fileKeyframes: [330, 490] })
    sb.buffered.ranges = [[0, 20]]
    await feed(m, fmp4Init())
    video.currentTime = 436.6
    m.maybeRespawnForUnbufferedPosition()
    vi.advanceTimersByTime(250)
    // Still the old generation: accepted and parsed until the reply switches it.
    m._internal.handleStreamChunk('s1', GEN, keyframeFragment(400))
    expect(m._internal.getKeyframes()).toEqual([recordedKeyframe(400)])
    replies[0]({ generation: GEN + 1, timestampOffset: SEEK_OFFSET })
    await flush()
    expect(m._internal.getKeyframes()).toEqual([])
  })

  // A mux the tracker cannot read: no `trak` has a `vide` handler, so it never
  // records a keyframe. Strict, nothing would ever be evicted and every file
  // would freeze at the quota; instead the run evicts by time, as before #653,
  // and reports it once per run.
  it('falls back to the time-based ends when the tracker records nothing, and reports it once per run', async () => {
    const { m, video, sb, replies, diag } = rig({
      offset: 0,
      t: 100,
      fileKeyframes: tenSecond(0, 590)
    })
    const unreadable = (): Uint8Array =>
      initSegment([
        { id: 1, handler: 'soun', timescale: FMP4_TS },
        { id: 2, handler: 'soun', timescale: 48000 }
      ])
    const fallbackLines = (): string[] =>
      diag.mock.calls.map((c) => c[0]).filter((l) => l.startsWith('tracker-empty fallback'))

    sb.buffered.ranges = [[0, 150]]
    await feed(m, concat([unreadable(), keyframeFragment(0), keyframeFragment(10)]))
    expect(m._internal.getKeyframes()).toEqual([])
    // updateend: max(bufStart + 1, t − 30).
    expect(sb.removeCalls).toEqual([[0, 70]])
    expect(fallbackLines()).toHaveLength(1)
    expect(fallbackLines()[0]).toContain('site=updateend remove=[0.000, 70.000)')

    video.currentTime = 140
    sb.land(190)
    await feed(m, nonKeyframe(20))
    expect(sb.removeCalls).toEqual([
      [0, 70],
      [70, 110]
    ])

    // Quota: t − 5.
    video.currentTime = 175
    sb.quota = true
    await feed(m, nonKeyframe(21))
    expect(sb.removeCalls.at(-1)).toEqual([110, 170])
    expect(fallbackLines()).toHaveLength(1)

    // A respawn is a new run: the latch resets with the list.
    sb.quota = false
    video.currentTime = 436.6
    m.maybeRespawnForUnbufferedPosition()
    vi.advanceTimersByTime(250)
    replies[0]({ generation: GEN + 1, timestampOffset: SEEK_OFFSET })
    await flush()
    const beforeRun2 = sb.removeCalls.length
    sb.buffered.ranges = [[330, 380]]
    await feed(m, concat([unreadable(), keyframeFragment(0), nonKeyframe(1)]), GEN + 1)
    expect(sb.removeCalls.slice(beforeRun2)).toEqual([[330, 436.6 - 30]])
    expect(fallbackLines()).toHaveLength(2)
    expect(diag).toHaveBeenCalledTimes(2)
  })
})

describe('useMsePlayer — keyframes from a real ffmpeg capture (#653)', () => {
  const { rig } = harness653()
  // test/fixtures/fmp4/make-long-gop-copy.sh: the copy run of a 40 s file with
  // keyframes at 0, 5, 10, 30 and 35 s, seeked to 20, lands on 10. Its offset is
  // what main probes for it (the keyframe at 10 is emitted at 0.083). Only
  // times are asserted, never bytes, so the file can be regenerated.
  const CAPTURE = new Uint8Array(
    readFileSync(resolve(__dirname, '../../fixtures/fmp4/long-gop-copy.mp4'))
  )
  const OFFSET = 9.917
  const KEYFRAME_PTS = [10, 30, 35]

  function recorded(chunks: Uint8Array[]): number[] {
    const { m } = rig({ offset: OFFSET, t: 0, open: false })
    m.startMseSession({
      sessionId: 's1',
      generation: 0,
      duration: 40,
      mimeType: 'video/mp4',
      resumeTarget: 0,
      timestampOffset: OFFSET,
      refusedSeek: false
    })
    for (const c of chunks) m._internal.handleStreamChunk('s1', 0, c)
    return [...m._internal.getKeyframes()]
  }

  // Each keyframe just below where the SourceBuffer labels it, and no others.
  function expectKeyframes(times: number[]): void {
    expect(times).toHaveLength(KEYFRAME_PTS.length)
    times.forEach((t, i) => {
      expect(t).toBeLessThan(KEYFRAME_PTS[i])
      expect(t).toBeGreaterThan(KEYFRAME_PTS[i] - 0.2)
    })
  }

  it('records the three keyframes of the whole capture', () => {
    expectKeyframes(recorded([CAPTURE]))
  })

  it('records them with the capture split at an arbitrary byte offset', () => {
    const at = Math.floor(CAPTURE.byteLength * 0.37)
    expectKeyframes(recorded([CAPTURE.subarray(0, at), CAPTURE.subarray(at)]))
  })

  it('records the keyframe of a moof split across two handleStreamChunk calls', () => {
    const moofs = topLevelBoxes(CAPTURE).filter((b) => b.type === 'moof')
    expect(moofs.length).toBeGreaterThan(KEYFRAME_PTS.length)
    // The first moof is the keyframe at 10; then every other one in turn.
    for (const { start, end } of moofs) {
      const at = start + Math.floor((end - start) / 2)
      expectKeyframes(recorded([CAPTURE.subarray(0, at), CAPTURE.subarray(at)]))
    }
  })
})

describe('useMsePlayer — report-only stall watchdog (#653)', () => {
  const { rig, flush, feed } = harness653()
  const MINUTE = 60_000

  it('fires exactly once on the eviction-stall shape: buffered [490, …], t = 436.6, readyState 1', () => {
    const { m, video, sb, diag } = rig({ offset: 329.917, t: 436.6, readyState: 1 })
    video.seeking = true
    sb.buffered.ranges = [[490, 497.929]]
    vi.advanceTimersByTime(MINUTE)

    expect(diag).toHaveBeenCalledTimes(1)
    expect(m.playbackStalled.value).toBe(true)
    const line = diag.mock.calls[0][0]
    expect(line).toContain('t=436.600 readyState=1 seeking=true')
    expect(line).toContain('sb.buffered=[[490.000, 497.929]]')
    expect(line).toContain('lastEviction=none')
  })

  it('fires exactly once on the quota-deadlock shape: t at buffered.end, readyState 2', () => {
    const { m, sb, diag } = rig({ offset: 329.917, t: 538.8, readyState: 2 })
    sb.buffered.ranges = [[330, 538.935]]
    // Inside the tolerance the respawn check uses, so "outside buffered" never holds.
    expect(m.isPlayheadBuffered()).toBe(true)
    vi.advanceTimersByTime(MINUTE)

    expect(diag).toHaveBeenCalledTimes(1)
    expect(m.playbackStalled.value).toBe(true)
  })

  it('names the last eviction and the recorded keyframes either side of the playhead', async () => {
    const { m, video, sb, diag } = rig({ offset: 0, t: 380.1, fileKeyframes: [320, 330, 490] })
    sb.buffered.ranges = [[320, 440]]
    await feed(m, concat([fmp4Init(), ...[310, 320, 330].map(keyframeFragment)]))
    expect(sb.removeCalls).toEqual([[320, recordedKeyframe(330)]])
    await feed(m, keyframeFragment(490))
    video.readyState = 2
    vi.advanceTimersByTime(MINUTE)

    expect(diag).toHaveBeenCalledTimes(1)
    const line = diag.mock.calls[0][0]
    const k330 = recordedKeyframe(330).toFixed(3)
    expect(line).toContain(`lastEviction=updateend [320.000, ${k330}) before=[[320.000, 440.000]]`)
    expect(line).toContain(
      `keyframeBelow=${k330} keyframeAbove=${recordedKeyframe(490).toFixed(3)}`
    )
  })

  it('re-arms when currentTime moves: playbackStalled clears, and a new stall reports again', () => {
    const { m, video, diag } = rig({ offset: 0, t: 100, readyState: 2 })
    vi.advanceTimersByTime(MINUTE)
    expect(diag).toHaveBeenCalledTimes(1)
    expect(m.playbackStalled.value).toBe(true)

    video.currentTime = 100.5
    vi.advanceTimersByTime(1000)
    expect(m.playbackStalled.value).toBe(false)
    expect(diag).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(MINUTE)
    expect(diag).toHaveBeenCalledTimes(2)
  })

  it('a session switch without resetMseState still gives one line, not two', () => {
    const { m, video, diag, start } = rig({ offset: 0, t: 100, readyState: 2 })
    vi.advanceTimersByTime(5000)
    start('s2')
    video.currentTime = 50
    // A leaked first interval would tick the shared count twice a second.
    vi.advanceTimersByTime(14_000)
    expect(diag).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MINUTE)
    expect(diag).toHaveBeenCalledTimes(1)

    // And nothing outlives the session: a leaked interval would report again.
    m.resetMseState()
    video.currentTime = 60
    vi.advanceTimersByTime(MINUTE)
    expect(diag).toHaveBeenCalledTimes(1)
  })

  it('resetMseState stops it and clears the message', () => {
    const { m, diag } = rig({ offset: 0, t: 100, readyState: 2 })
    vi.advanceTimersByTime(MINUTE)
    expect(m.playbackStalled.value).toBe(true)
    m.resetMseState()
    expect(m.playbackStalled.value).toBe(false)
    vi.advanceTimersByTime(MINUTE * 2)
    expect(diag).toHaveBeenCalledTimes(1)
  })

  describe('stays quiet', () => {
    it('while the element is paused', () => {
      const { video, diag } = rig({ offset: 0, t: 100, readyState: 1 })
      video.paused = true
      vi.advanceTimersByTime(MINUTE)
      expect(diag).not.toHaveBeenCalled()
    })

    it('while mkvBuffering is set', () => {
      const { m, diag } = rig({ offset: 0, t: 100, readyState: 1 })
      m.mkvBuffering.value = true
      vi.advanceTimersByTime(MINUTE)
      expect(diag).not.toHaveBeenCalled()
      expect(m.playbackStalled.value).toBe(false)
    })

    it('while a respawn is pending', async () => {
      const { m, video, sb, seekSpy, diag } = rig({ offset: 0, t: 10, readyState: 1 })
      sb.buffered.ranges = [[0, 20]]
      video.currentTime = 436.6
      m.maybeRespawnForUnbufferedPosition()
      vi.advanceTimersByTime(250)
      await flush()
      // The seek reply is held, so the respawn stays in flight.
      expect(seekSpy).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(MINUTE)
      expect(diag).not.toHaveBeenCalled()
    })

    it('while currentTime keeps advancing', () => {
      const { video, diag } = rig({ offset: 0, t: 100, readyState: 2 })
      for (let i = 0; i < 60; i++) {
        video.currentTime += 0.25
        vi.advanceTimersByTime(1000)
      }
      expect(diag).not.toHaveBeenCalled()
    })

    it('with no MSE session, as for a growing file waiting at its end', () => {
      const { m, diag } = rig({ offset: 0, t: 100, readyState: 1, open: false })
      vi.advanceTimersByTime(MINUTE)
      expect(diag).not.toHaveBeenCalled()
      expect(m.playbackStalled.value).toBe(false)
    })

    it('while syncplay holds local readiness', () => {
      const { diag } = rig({
        offset: 0,
        t: 100,
        readyState: 1,
        deps: { isSyncplayHolding: () => true }
      })
      vi.advanceTimersByTime(MINUTE)
      expect(diag).not.toHaveBeenCalled()
    })

    it('while the element has enough data (readyState HAVE_FUTURE_DATA)', () => {
      const { diag } = rig({ offset: 0, t: 100, readyState: 3 })
      vi.advanceTimersByTime(MINUTE)
      expect(diag).not.toHaveBeenCalled()
    })
  })
})
