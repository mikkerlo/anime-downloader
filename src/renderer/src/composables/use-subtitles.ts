// ASS/SSA subtitle rendering for PlayerView (Phase 5 slice 5d.2.b, #118).
//
// Owns the SubtitlesOctopus (libass-wasm) renderer lifecycle + the subtitle
// content ref + the fullscreenchange redraw workaround + the
// `player:stream-subtitles` IPC subscription (for MKV streams that have an
// async subtitle extraction pass).
//
// Does NOT own: the <video> element itself, the activeSubtitleContent flow
// from MSE/legacy-remux/props (the caller updates the ref from those
// sources), the props passthrough on initial mount, or the streamSessionId
// gate (callers pass that in to filter the IPC events).
//
// Lifecycle hooks are NOT registered inside the composable — the consumer
// calls `subscribeStreamSubtitles()` from `onMounted` and `destroy()` from
// `onBeforeUnmount`. Keeps it callable from Vitest.

import { ref, type Ref } from 'vue'
import SubtitlesOctopus from 'libass-wasm/dist/js/subtitles-octopus.js'

export function useSubtitles(deps: {
  /** Live <video> element getter — re-resolved at init time, not captured. */
  getVideoEl: () => HTMLVideoElement | null
  /** Stream session id — IPC subtitle events are filtered against this. */
  getStreamSessionId: () => string
}): {
  activeSubtitleContent: Ref<string>
  initSubtitles: (video: HTMLVideoElement) => void
  destroySubtitles: () => void
  redrawAfterFullscreen: () => void
  setSubtitleCorrection: (seconds: number) => void
  subscribeStreamSubtitles: () => () => void
} {
  const activeSubtitleContent = ref('')

  let octopusInstance: InstanceType<typeof SubtitlesOctopus> | null = null

  // Subtitle-clock correction (seconds) measured by useMsePlayer after a seek
  // respawn / resume-from-middle. libass re-reads `octopusInstance.timeOffset`
  // every tick (`subtitles-octopus.js` applies `video.currentTime + timeOffset`)
  // so setting the field live shifts the subtitle clock without touching
  // `video.currentTime`. Stored here because the octopus instance is destroyed
  // + re-created on every content change (props switch, stream-sub arrival),
  // which resets its `timeOffset` to 0 — so it must be re-applied on each init.
  let subtitleCorrection = 0

  function initSubtitles(video: HTMLVideoElement): void {
    const content = activeSubtitleContent.value
    if (!content) return
    destroySubtitles()

    try {
      const libassBase = new URL('./libass/', document.baseURI).href
      octopusInstance = new SubtitlesOctopus({
        video,
        subContent: content,
        workerUrl: libassBase + 'subtitles-octopus-worker.js',
        legacyWorkerUrl: libassBase + 'subtitles-octopus-worker-legacy.js',
        fallbackFont: libassBase + 'default.woff2',
        lossyRender: true,
        prescaleFactor: 0.8,
        maxRenderHeight: 0
      })
      // Re-apply the stored A/V correction — the fresh instance starts at 0.
      applyCorrection()
    } catch (e) {
      console.error('Failed to initialize subtitle renderer:', e)
    }
  }

  function applyCorrection(): void {
    if (!octopusInstance) return
    try {
      // `timeOffset` isn't in the bundled typings but is a live-read field the
      // vendored libass re-applies as `video.currentTime + timeOffset` each tick
      // (subtitles-octopus.js:1009/1139/1157). Pinned vendored behavior: a
      // libass-wasm bump that renames or stops reading this field would silently
      // disable the A/V correction (a plain property write never throws) — if
      // that happens, the use-subtitles redraw test below should catch the
      // missing shift.
      ;(octopusInstance as unknown as { timeOffset: number }).timeOffset = subtitleCorrection
      // libass only redraws on video events (timeupdate/seeked/playing/…). After
      // an unbuffered seek the buffer-ahead gate leaves a paused player paused,
      // and the correction lands *after* the seek's `seeked` already fired — so
      // without an explicit redraw a user scrubbing while paused would keep
      // seeing the old, uncorrected offset until they hit play. Force one redraw
      // at the corrected time. setCurrentTime is the lib's render entrypoint
      // (subtitles-octopus.js: `self.render = self.setCurrentTime`); using it
      // here is fine because we pass the already-corrected time, and the next
      // live tick recomputes `currentTime + timeOffset` identically.
      const v = deps.getVideoEl()
      if (v) {
        ;(octopusInstance as unknown as { setCurrentTime: (t: number) => void }).setCurrentTime(
          v.currentTime + subtitleCorrection
        )
      }
    } catch {
      /* ignore */
    }
  }

  // Push the measured correction in. Stores it for future re-inits AND applies
  // it live to the current instance so an already-rendering track shifts at once.
  function setSubtitleCorrection(seconds: number): void {
    subtitleCorrection = seconds
    applyCorrection()
  }

  function destroySubtitles(): void {
    if (octopusInstance) {
      try {
        octopusInstance.dispose()
      } catch {
        /* ignore cleanup errors */
      }
      octopusInstance = null
    }
  }

  // libass's internal fullscreenchange listener resizes the canvas but does
  // not force a redraw, so a paused frame loses its subtitles. setTrack
  // makes the worker rebuild the track and emit a fresh bitmap at the new
  // canvas size. Delay past the library's own ~100ms resize so we hit
  // final geometry.
  function redrawAfterFullscreen(): void {
    setTimeout(() => {
      const content = activeSubtitleContent.value
      if (octopusInstance && content) {
        try {
          octopusInstance.setTrack(content)
        } catch {
          /* ignore */
        }
      }
    }, 200)
  }

  // Subtitles extracted from MKV streams arrive asynchronously via IPC. The
  // composable installs the subscription and applies the content if (a) the
  // session matches and (b) no subtitle is currently rendered (props /
  // legacy remux take priority). Caller wires `onMounted` / `onBeforeUnmount`.
  function subscribeStreamSubtitles(): () => void {
    return window.api.onPlayerStreamSubtitles(({ sessionId, content }) => {
      if (sessionId !== deps.getStreamSessionId()) return
      if (activeSubtitleContent.value) return
      activeSubtitleContent.value = content
      const v = deps.getVideoEl()
      if (v) {
        destroySubtitles()
        initSubtitles(v)
      }
    })
  }

  return {
    activeSubtitleContent,
    initSubtitles,
    destroySubtitles,
    redrawAfterFullscreen,
    setSubtitleCorrection,
    subscribeStreamSubtitles
  }
}
