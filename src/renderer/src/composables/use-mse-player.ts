// Headless MSE / SourceBuffer state machine for the PlayerView MKV streaming
// pipeline. Phase 5 slice 5d.1 (#118 — decision 5 of the epic).
//
// Owns the low-level MSE engine: MediaSource lifecycle, SourceBuffer feed,
// chunk eviction, ack backpressure, the unbuffered-seek → ffmpeg-respawn
// state machine, and the HEVC transcode-on-stream session flag. Does NOT own
// orchestration (asking the user "MSE? transcode? external?", picking which
// IPC to call to open the session, the legacy full-remux fallback) — that
// stays in PlayerView because it touches subtitle state, watch-progress
// resume, episode index, and the close emit.
//
// Lifecycle hooks (onMounted/onUnmounted) are NOT registered here — the
// component wires `subscribeStreamEvents()` from its own onMounted and calls
// `resetMseState()` from onBeforeUnmount. Keeps the composable callable
// from Vitest without a Vue component context.

import { computed, ref, type ComputedRef, type Ref } from 'vue'

const STREAM_ACK_THRESHOLD = 1 * 1024 * 1024
const MAX_BUFFER_AHEAD = 60
const RESPAWN_DEBOUNCE_MS = 250

export interface StartMseSessionOpts {
  sessionId: string
  generation: number
  duration: number
  mimeType: string
  resumeTarget: number
  keyframeTime: number
}

export function useMsePlayer(deps: {
  /** Callback the component owns — returns the live <video> element ref or null. */
  getVideoEl: () => HTMLVideoElement | null
  /** Syncplay coordination: pause local ready-state while waiting for buffer ahead. */
  setSyncplayLocalReady: (ready: boolean) => void
}): {
  // Reactive state
  mseSrcUrl: Ref<string>
  mkvBuffering: Ref<boolean>
  transcodingHevc: Ref<boolean>
  transcodeSpeed: Ref<number | null>
  transcodeLabel: ComputedRef<string>
  streamSessionId: Ref<string>
  remuxError: Ref<string>
  mseInitialSeek: Ref<number>
  hasActiveSession: ComputedRef<boolean>
  // Actions
  startMseSession: (opts: StartMseSessionOpts) => void
  setTranscoding: (active: boolean) => void
  resetMseState: () => void
  maybeRespawnForUnbufferedPosition: () => void
  pumpAppendQueue: () => void
  isPlayheadBuffered: () => boolean
  subscribeStreamEvents: () => () => void
  // Test hooks (introspection of internal state machine; not used by component)
  _internal: {
    handleStreamChunk: (sessionId: string, gen: number, data: Uint8Array) => void
    handleStreamEnd: (sessionId: string) => void
    handleStreamError: (sessionId: string, error: string) => void
    handleUnbufferedSeek: () => Promise<void>
    getAppendQueueLength: () => number
    getSourceBuffer: () => SourceBuffer | null
  }
} {
  // Reactive state surface
  const mseSrcUrl = ref('')
  const mkvBuffering = ref(false)
  const transcodingHevc = ref(false)
  const transcodeSpeed = ref<number | null>(null)
  const streamSessionId = ref('')
  const remuxError = ref('')
  // Resume-target the MSE session was opened at. Consumers may read it to
  // align video.currentTime on first 'loadedmetadata' (the ffmpeg run already
  // started here, so a native seek would force an unbuffered-seek respawn).
  const mseInitialSeek = ref(0)

  const transcodeLabel = computed(() => {
    if (transcodeSpeed.value == null) return 'Transcoding HEVC → H.264…'
    return `Transcoding HEVC → H.264 @ ${transcodeSpeed.value.toFixed(1)}×`
  })

  const hasActiveSession = computed(() => streamSessionId.value !== '')

  // Internal mutable state (non-reactive)
  let mediaSource: MediaSource | null = null
  let sourceBuffer: SourceBuffer | null = null
  let streamEnded = false
  let pendingAckBytes = 0
  // Bumped by main on each seek so we can drop chunks from an obsolete ffmpeg
  // run that were already in the IPC queue when we asked to seek.
  let currentStreamGen = 0
  const appendQueue: Uint8Array[] = []

  let unbufferedSeekInFlight = false
  let respawnDebounceTimer: ReturnType<typeof setTimeout> | null = null

  let appendCount = 0
  let chunkRecvCount = 0
  let chunkRecvBytes = 0

  function setTranscoding(active: boolean): void {
    transcodingHevc.value = active
    if (!active) transcodeSpeed.value = null
  }

  function startMseSession(opts: StartMseSessionOpts): void {
    const { sessionId, generation, duration, mimeType, resumeTarget, keyframeTime } = opts
    streamSessionId.value = sessionId
    currentStreamGen = generation
    mseInitialSeek.value = resumeTarget
    const ms = new MediaSource()
    mediaSource = ms
    mseSrcUrl.value = URL.createObjectURL(ms)
    ms.addEventListener(
      'sourceopen',
      () => {
        try {
          console.log(
            '[player] sourceopen, adding SourceBuffer:',
            mimeType,
            'resumeTarget=',
            resumeTarget,
            'keyframeTime=',
            keyframeTime
          )
          const sb = ms.addSourceBuffer(mimeType)
          sourceBuffer = sb
          try {
            ms.duration = duration
          } catch (e) {
            console.warn('[player] set duration failed:', e)
          }
          // ffmpeg's fmp4 muxer normalizes its output PTS to start at 0
          // regardless of `-copyts`, so we have to add the keyframe-time-from-
          // file as a SourceBuffer offset to map fragments back onto the
          // absolute timeline. Without this, video.currentTime = target plays
          // the wrong content because the buffered range is shifted by
          // (target - keyframeTime).
          if (keyframeTime > 0) {
            try {
              sb.timestampOffset = keyframeTime
            } catch (e) {
              console.warn('[player] initial timestampOffset failed:', e)
            }
          }
          sb.addEventListener('updateend', onSourceBufferUpdateEnd)
          sb.addEventListener('error', (e) =>
            console.error('[player] SourceBuffer error event:', e)
          )
          sb.addEventListener('abort', () => console.warn('[player] SourceBuffer abort'))
          void window.api.playerStreamStart(sessionId)
          pumpAppendQueue()
        } catch (e) {
          console.error('[player] addSourceBuffer failed:', e)
        }
      },
      { once: true }
    )
  }

  function onSourceBufferUpdateEnd(): void {
    const sb = sourceBuffer
    if (sb && sb.buffered.length > 0) {
      appendCount++
      if (appendCount <= 5 || appendCount % 50 === 0) {
        const ranges: string[] = []
        for (let i = 0; i < sb.buffered.length; i++) {
          ranges.push(`[${sb.buffered.start(i).toFixed(2)}-${sb.buffered.end(i).toFixed(2)}]`)
        }
        const v = deps.getVideoEl()
        console.log(
          `[player] append #${appendCount} buffered=${ranges.join(',')} t=${(v?.currentTime ?? 0).toFixed(2)}`
        )
      }
      const bufStart = sb.buffered.start(0)
      const v = deps.getVideoEl()
      const t = v?.currentTime ?? 0
      if (bufStart < t - 60 && !sb.updating) {
        try {
          sb.remove(bufStart, Math.max(bufStart + 1, t - 30))
        } catch {
          /* ignore */
        }
      }
    }
    pumpAppendQueue()
  }

  function pumpAppendQueue(): void {
    const sb = sourceBuffer
    const ms = mediaSource
    if (!sb || sb.updating || !ms) return
    if (unbufferedSeekInFlight) return

    if (appendQueue.length === 0) {
      if (streamEnded && ms.readyState === 'open') {
        try {
          ms.endOfStream()
        } catch {
          /* ignore */
        }
      }
      return
    }

    // Throttle: stop pumping once we have enough lead ahead of the playhead.
    // Without this, SourceBuffer fills to the Chromium quota and eviction
    // would remove the [0, 1] keyframe the playhead is still stuck on,
    // leaving a gap.
    if (sb.buffered.length > 0) {
      const v = deps.getVideoEl()
      const t = v?.currentTime ?? 0
      const lead = sb.buffered.end(sb.buffered.length - 1) - t
      if (lead > MAX_BUFFER_AHEAD) return
    }

    const v = deps.getVideoEl()
    if (v && v.error) return
    const chunk = appendQueue.shift()!
    try {
      sb.appendBuffer(chunk as unknown as BufferSource)
      pendingAckBytes += chunk.byteLength
      if (pendingAckBytes >= STREAM_ACK_THRESHOLD && streamSessionId.value) {
        const bytes = pendingAckBytes
        pendingAckBytes = 0
        void window.api.playerStreamAck(streamSessionId.value, bytes)
      }
    } catch (e) {
      const err = e as DOMException
      if (err.name === 'QuotaExceededError') {
        appendQueue.unshift(chunk)
        // Only evict data strictly behind the playhead. Never drop the range
        // the video element is currently sitting inside, or playback stalls.
        const vv = deps.getVideoEl()
        const t = vv?.currentTime ?? 0
        if (sb.buffered.length > 0 && !sb.updating) {
          const bufStart = sb.buffered.start(0)
          const removeUntil = t - 5
          if (removeUntil > bufStart + 1) {
            try {
              sb.remove(bufStart, removeUntil)
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        console.error('[player] appendBuffer failed:', err)
      }
    }
  }

  function maybeRespawnForUnbufferedPosition(): void {
    const v = deps.getVideoEl()
    const sb = sourceBuffer
    if (!v || !sb || !streamSessionId.value) return
    // Debounce. Check `currentTime` vs buffered ranges only when the timer
    // fires, so a burst of rapid seeks coalesces into one respawn at the
    // final target.
    if (respawnDebounceTimer) clearTimeout(respawnDebounceTimer)
    respawnDebounceTimer = setTimeout(() => {
      respawnDebounceTimer = null
      if (unbufferedSeekInFlight) return
      const cur = deps.getVideoEl()
      const curSb = sourceBuffer
      if (!cur || !curSb) return
      const t = cur.currentTime
      for (let i = 0; i < curSb.buffered.length; i++) {
        if (t >= curSb.buffered.start(i) - 0.25 && t <= curSb.buffered.end(i) + 0.25) return
      }
      // Nothing buffered yet (fresh respawn) — wait for data.
      if (curSb.buffered.length === 0) return
      void handleUnbufferedSeek()
    }, RESPAWN_DEBOUNCE_MS)
  }

  async function waitForBufferAhead(
    v: HTMLVideoElement,
    sb: SourceBuffer,
    seconds: number,
    timeoutMs: number
  ): Promise<void> {
    const wasPaused = v.paused
    deps.setSyncplayLocalReady(false)
    try {
      v.pause()
    } catch {
      /* ignore */
    }
    const deadline = performance.now() + timeoutMs
    try {
      while (performance.now() < deadline) {
        const t = v.currentTime
        for (let i = 0; i < sb.buffered.length; i++) {
          if (t >= sb.buffered.start(i) - 0.25 && sb.buffered.end(i) - t >= seconds) {
            if (!wasPaused) {
              try {
                await v.play()
              } catch {
                /* ignore */
              }
            }
            return
          }
        }
        await new Promise<void>((res) => setTimeout(res, 200))
      }
      if (!wasPaused) {
        try {
          await v.play()
        } catch {
          /* ignore */
        }
      }
    } finally {
      deps.setSyncplayLocalReady(true)
    }
  }

  async function handleUnbufferedSeek(): Promise<void> {
    const v = deps.getVideoEl()
    const sb = sourceBuffer
    if (!v || !sb || !streamSessionId.value) return
    const target = v.currentTime
    // If the target falls inside any existing buffered range, the video
    // element handles the seek natively — nothing to do.
    for (let i = 0; i < sb.buffered.length; i++) {
      if (target >= sb.buffered.start(i) - 0.25 && target <= sb.buffered.end(i) + 0.25) {
        return
      }
    }
    if (unbufferedSeekInFlight) return
    unbufferedSeekInFlight = true
    const seekAt = Math.max(0, target - 1)
    console.log(
      `[player] unbuffered seek → respawn ffmpeg at ${seekAt.toFixed(2)} (target ${target.toFixed(2)})`
    )
    try {
      // Drop any queued chunks from the old ffmpeg — main will stop sending
      // new ones as soon as the seek IPC below bumps the session generation.
      appendQueue.length = 0
      pendingAckBytes = 0
      // Capture sessionId before awaiting — if resetMseState fires during
      // the IPC round-trip (e.g. unmount or episode switch), streamSessionId
      // changes underneath us and we'd otherwise stamp the OLD session's
      // generation onto the NEW session, polluting its state.
      const sessionId = streamSessionId.value
      const result = await window.api.playerStreamSeek(sessionId, seekAt)
      if (streamSessionId.value !== sessionId) return
      if ('error' in result) {
        console.error('[player] stream-seek failed:', result.error)
        return
      }
      // Switch the expected generation so any further in-flight chunks from
      // the old ffmpeg run are dropped, and drain anything stale that arrived
      // in `appendQueue` while we were awaiting the IPC round-trip.
      currentStreamGen = result.generation
      appendQueue.length = 0
      pendingAckBytes = 0
      streamEnded = false
      // Reset the SourceBuffer segment parser. Without this, an interrupted
      // append leaves the parser in PARSING_MEDIA_SEGMENT and any subsequent
      // timestampOffset change or appendBuffer throws. abort() also cancels
      // any in-flight update, so no updateend wait is needed.
      try {
        sb.abort()
      } catch (e) {
        console.warn('[player] sb.abort failed:', e)
      }
      // Drop old buffered data so the previous audio ahead of us doesn't
      // keep playing while the new fragments arrive and decode. Wait until
      // `sb.updating` is genuinely false before continuing — `sb.abort()`
      // above queues its own async `updateend` event, and a naïve
      // `{ once: true }` listener can grab the abort's updateend *while*
      // `sb.remove()` is still running. Resolving the Promise early would
      // let the next `sb.timestampOffset = …` assignment throw
      // InvalidStateError, leaving fragments on the wrong timeline and
      // starving the playhead — the rapid-seek stutter pattern.
      try {
        if (sb.buffered.length > 0) {
          sb.remove(sb.buffered.start(0), sb.buffered.end(sb.buffered.length - 1))
          await new Promise<void>((res) => {
            const listener = (): void => {
              if (!sb.updating) {
                sb.removeEventListener('updateend', listener)
                res()
              }
            }
            sb.addEventListener('updateend', listener)
          })
        }
      } catch (e) {
        console.warn('[player] buffer clear failed:', e)
      }
      if (v.error) {
        console.error('[player] video element errored during seek:', v.error.code, v.error.message)
        return
      }
      // ffmpeg's fmp4 muxer always normalizes output PTS to start at 0 (the
      // `tfdt.baseMediaDecodeTime` is written relative to track start, not
      // absolute file PTS, even with -copyts). So map the new run's PTS=0 to
      // the actual keyframe time we asked ffmpeg to start at — main probed it
      // with ffprobe so the buffered range lines up with the absolute file
      // timeline. video.currentTime keeps the user's exact target.
      try {
        sb.timestampOffset = result.keyframeTime
      } catch (e) {
        console.warn('[player] timestampOffset set failed:', e)
      }
      // Release main's buffered prelude for the new ffmpeg run.
      void window.api.playerStreamStart(streamSessionId.value)
      // Clear the in-flight flag *before* awaiting the buffer-ahead gate
      // below, otherwise pumpAppendQueue refuses to drain incoming chunks
      // (it bails early while the flag is set), the buffer never fills, and
      // the wait times out — manifesting as a ~15s post-seek freeze on
      // transcode.
      unbufferedSeekInFlight = false
      pumpAppendQueue()

      // Pause playback until a margin of fresh data is buffered ahead, then
      // let the element resume. The transcode path needs a deep margin because
      // ffmpeg runs at ~real-time with almost no headroom, so the buffer stays
      // razor-thin and any encoder hiccup stalls the video. Stream-copy fills
      // far faster than real-time, but it still benefits from a short gate:
      // resuming the instant the first fragment lands lets the video element
      // try to render before the SourceBuffer parser has settled the new
      // segment, which on Linux/WSL produces repeated `readyState=1` stalls
      // and audio dropout after a respawn (#127). A 1.5 s margin is met almost
      // immediately on stream-copy yet still lets the decoder bed in.
      mkvBuffering.value = true
      const aheadSeconds = transcodingHevc.value ? 3.0 : 1.5
      const aheadTimeoutMs = transcodingHevc.value ? 15000 : 5000
      await waitForBufferAhead(v, sb, aheadSeconds, aheadTimeoutMs)
      mkvBuffering.value = false
    } finally {
      unbufferedSeekInFlight = false
      // If the user kept seeking while the respawn was in flight, the
      // playhead may now be outside the fresh buffered range too — re-check.
      maybeRespawnForUnbufferedPosition()
    }
  }

  function handleStreamChunk(sessionId: string, gen: number, data: Uint8Array): void {
    if (sessionId !== streamSessionId.value) return
    // Drop chunks from an obsolete ffmpeg run. Main bumped its generation on
    // the last seek; anything still arriving with an older `gen` was already
    // in the IPC queue at that point and is now stale media with PTS
    // unrelated to the current timestampOffset.
    if (gen !== currentStreamGen) return
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
    chunkRecvCount++
    chunkRecvBytes += u8.byteLength
    if (chunkRecvCount === 1 || chunkRecvCount % 200 === 0) {
      console.log(
        `[player] recv chunk #${chunkRecvCount} total=${(chunkRecvBytes / 1024 / 1024).toFixed(1)}MB queue=${appendQueue.length}`
      )
    }
    appendQueue.push(u8)
    pumpAppendQueue()
  }

  function handleStreamEnd(sessionId: string): void {
    if (sessionId !== streamSessionId.value) return
    streamEnded = true
    pumpAppendQueue()
  }

  function handleStreamError(sessionId: string, error: string): void {
    if (sessionId !== streamSessionId.value) return
    console.error('[player] stream error:', error)
    remuxError.value = error
    resetMseState()
  }

  function resetMseState(): void {
    // Drop the pending respawn debounce — without this, the timer can fire
    // after a teardown and call into `handleUnbufferedSeek` on a disposed
    // session, ack the old generation, or mutate a SourceBuffer that's
    // already been removed.
    if (respawnDebounceTimer) {
      clearTimeout(respawnDebounceTimer)
      respawnDebounceTimer = null
    }
    unbufferedSeekInFlight = false
    streamEnded = false
    pendingAckBytes = 0
    appendQueue.length = 0
    mseInitialSeek.value = 0
    currentStreamGen = 0
    transcodingHevc.value = false
    transcodeSpeed.value = null
    if (sourceBuffer) {
      try {
        sourceBuffer.removeEventListener('updateend', onSourceBufferUpdateEnd)
      } catch {
        /* ignore */
      }
      sourceBuffer = null
    }
    if (mediaSource && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream()
      } catch {
        /* ignore */
      }
    }
    mediaSource = null
    if (mseSrcUrl.value) {
      try {
        URL.revokeObjectURL(mseSrcUrl.value)
      } catch {
        /* ignore */
      }
      mseSrcUrl.value = ''
    }
    streamSessionId.value = ''
  }

  // Returns true when either there's no active session/buffer (so a "seek"
  // has nothing to do here and won't trigger an ffmpeg respawn) OR the
  // playhead currently sits inside a buffered range (with a small tolerance).
  // PlayerView uses this from `pausePrefetchForSeek` to decide whether to
  // pause concurrent prefetch downloads — only disk-heavy unbuffered seeks
  // need that.
  function isPlayheadBuffered(): boolean {
    const v = deps.getVideoEl()
    const sb = sourceBuffer
    if (!v || !sb) return true
    if (sb.buffered.length === 0) return true
    const t = v.currentTime
    for (let i = 0; i < sb.buffered.length; i++) {
      if (t >= sb.buffered.start(i) - 0.25 && t <= sb.buffered.end(i) + 0.25) return true
    }
    return false
  }

  function subscribeStreamEvents(): () => void {
    const unsubChunk = window.api.onPlayerStreamChunk(({ sessionId, gen, data }) =>
      handleStreamChunk(sessionId, gen, data)
    )
    const unsubEnd = window.api.onPlayerStreamEnd(({ sessionId }) => handleStreamEnd(sessionId))
    const unsubErr = window.api.onPlayerStreamError(({ sessionId, error }) =>
      handleStreamError(sessionId, error)
    )
    const unsubProgress = window.api.onPlayerStreamProgress(({ sessionId, gen, speed }) => {
      if (sessionId !== streamSessionId.value) return
      if (gen !== currentStreamGen) return
      if (typeof speed === 'number' && isFinite(speed)) transcodeSpeed.value = speed
    })
    return () => {
      unsubChunk()
      unsubEnd()
      unsubErr()
      unsubProgress()
    }
  }

  return {
    mseSrcUrl,
    mkvBuffering,
    transcodingHevc,
    transcodeSpeed,
    transcodeLabel,
    streamSessionId,
    remuxError,
    mseInitialSeek,
    hasActiveSession,
    startMseSession,
    setTranscoding,
    resetMseState,
    maybeRespawnForUnbufferedPosition,
    pumpAppendQueue,
    isPlayheadBuffered,
    subscribeStreamEvents,
    _internal: {
      handleStreamChunk,
      handleStreamEnd,
      handleStreamError,
      handleUnbufferedSeek,
      getAppendQueueLength: () => appendQueue.length,
      getSourceBuffer: () => sourceBuffer
    }
  }
}
