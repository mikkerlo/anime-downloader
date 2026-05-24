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
  subscribeStreamSubtitles: () => () => void
} {
  const activeSubtitleContent = ref('')

  let octopusInstance: InstanceType<typeof SubtitlesOctopus> | null = null

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
    } catch (e) {
      console.error('Failed to initialize subtitle renderer:', e)
    }
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
    subscribeStreamSubtitles
  }
}
