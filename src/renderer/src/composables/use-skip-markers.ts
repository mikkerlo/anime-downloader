// OP/ED skip-marker detection + skip button state for PlayerView (Phase 5
// slice 5d.2.c, #118).
//
// Owns the dual-mode skip detection:
//   - Local playback uses stored per-episode boundaries from
//     `skipDetectorGetDetections(animeId)`.
//   - Streamed playback asks main to fingerprint the current stream and
//     only surfaces ranges that match the locally-derived show signatures.
//
// Also owns the skip button visibility state (with a small grace timer so
// scrubbing through a band doesn't flicker the button) and the
// per-session "already skipped" set so rewinding past a band doesn't
// re-show the button.
//
// Does NOT own: the seek action (caller supplies `onSeek` so the button
// click can drive the same seek path the rest of PlayerView uses), the
// episode change reset trigger (caller wires that because it also touches
// prefetch state).

import { computed, ref, watch, onMounted, onBeforeUnmount, type ComputedRef, type Ref } from 'vue'

const SKIP_GRACE_MS = 250
const SKIP_LEAD_IN_SEC = 0.25

export function useSkipMarkers(deps: {
  /** Live anime id getter (props pass-through). */
  getAnimeId: () => number
  /** Live episode int getter (computed from active episode index). */
  getCurrentEpisodeInt: () => string
  /** Live currentTime getter (the player progress ref). */
  getCurrentTime: () => number
  /** Reactive: are we playing a stream URL (vs a local file)? */
  isStreaming: Ref<boolean>
  /** Reactive: the active stream URL (when streaming). */
  activeStreamUrl: Ref<string>
  /** Caller-supplied seek action; called with the OP/ED end time on click. */
  onSeek: (timeSec: number) => void
}): {
  showSkipDetections: Ref<ShowSkipDetections | null>
  streamSkipDetection: Ref<EpisodeSkipDetection | null>
  streamSkipDetecting: Ref<boolean>
  skipButtonVisible: Ref<boolean>
  currentEpisodeSkip: ComputedRef<EpisodeSkipDetection | null>
  activeSkipRange: ComputedRef<'op' | 'ed' | null>
  loadSkipDetections: () => Promise<void>
  refreshStreamSkipDetection: () => Promise<void>
  cancelStreamDetection: () => void
  onSkipClick: () => void
  resetSkipUiState: () => void
} {
  const showSkipDetections = ref<ShowSkipDetections | null>(null)
  const streamSkipDetection = ref<EpisodeSkipDetection | null>(null)
  const streamSkipDetecting = ref(false)
  const skippedRanges = ref<Set<string>>(new Set())
  const skipButtonVisible = ref(false)

  let skipButtonGraceTimer: ReturnType<typeof setTimeout> | null = null
  let streamSkipRequestId = 0
  let unsubSignatureUpdated: Unsubscribe | null = null

  const currentEpisodeSkip = computed<EpisodeSkipDetection | null>(() => {
    if (deps.isStreaming.value) {
      return streamSkipDetection.value
    }
    const det = showSkipDetections.value
    const epInt = deps.getCurrentEpisodeInt()
    if (!det || !epInt) return null
    return det.perEpisode[epInt] ?? null
  })

  // Lead-in tolerance handles the case where the seek bar lands a few
  // hundred ms before the band edge.
  const activeSkipRange = computed<'op' | 'ed' | null>(() => {
    const ep = currentEpisodeSkip.value
    if (!ep) return null
    const t = deps.getCurrentTime()
    if (ep.op && t >= ep.op.startSec - SKIP_LEAD_IN_SEC && t < ep.op.endSec) return 'op'
    if (ep.ed && t >= ep.ed.startSec - SKIP_LEAD_IN_SEC && t < ep.ed.endSec) return 'ed'
    return null
  })

  function skipRangeKey(kind: 'op' | 'ed'): string {
    return `${deps.getAnimeId()}:${deps.getCurrentEpisodeInt()}:${kind}`
  }

  function activeSkipBounds(): { startSec: number; endSec: number; kind: 'op' | 'ed' } | null {
    const kind = activeSkipRange.value
    const ep = currentEpisodeSkip.value
    if (!ep || !kind) return null
    const range = kind === 'op' ? ep.op : ep.ed
    if (!range) return null
    return { startSec: range.startSec, endSec: range.endSec, kind }
  }

  function onSkipClick(): void {
    const bounds = activeSkipBounds()
    if (!bounds) return
    skippedRanges.value.add(skipRangeKey(bounds.kind))
    skipButtonVisible.value = false
    if (skipButtonGraceTimer) {
      clearTimeout(skipButtonGraceTimer)
      skipButtonGraceTimer = null
    }
    deps.onSeek(bounds.endSec)
  }

  // Grace-timer-gated button visibility — debounces flicker when scrubbing
  // through a band.
  watch(activeSkipRange, (kind) => {
    if (skipButtonGraceTimer) {
      clearTimeout(skipButtonGraceTimer)
      skipButtonGraceTimer = null
    }
    if (!kind) {
      skipButtonVisible.value = false
      return
    }
    if (skippedRanges.value.has(skipRangeKey(kind))) {
      // User already skipped this range this session; don't re-show on rewind.
      skipButtonVisible.value = false
      return
    }
    skipButtonGraceTimer = setTimeout(() => {
      skipButtonVisible.value = true
      skipButtonGraceTimer = null
    }, SKIP_GRACE_MS)
  })

  async function loadSkipDetections(): Promise<void> {
    if (!deps.getAnimeId()) {
      showSkipDetections.value = null
      return
    }
    try {
      showSkipDetections.value = await window.api.skipDetectorGetDetections(deps.getAnimeId())
    } catch (err) {
      console.error('Failed to load skip detections:', err)
      showSkipDetections.value = null
    }
  }

  function resetSkipUiState(): void {
    skippedRanges.value = new Set()
    if (skipButtonGraceTimer) {
      clearTimeout(skipButtonGraceTimer)
      skipButtonGraceTimer = null
    }
    skipButtonVisible.value = false
  }

  async function refreshStreamSkipDetection(): Promise<void> {
    const requestId = ++streamSkipRequestId
    streamSkipDetection.value = null
    streamSkipDetecting.value = false
    const animeId = deps.getAnimeId()
    const epInt = deps.getCurrentEpisodeInt()
    if (!deps.isStreaming.value || !animeId || !epInt || !deps.activeStreamUrl.value) return
    if (!showSkipDetections.value) return
    const source = showSkipDetections.value.algorithm?.source ?? 'local'
    if (source !== 'local') return
    try {
      await window.api.skipDetectorCancelStreamDetect()
    } catch {
      // ignore best-effort cancel races before starting a fresh request
    }
    streamSkipDetecting.value = true
    try {
      const result = await window.api.skipDetectorDetectStream(
        animeId,
        epInt,
        deps.activeStreamUrl.value
      )
      if (requestId !== streamSkipRequestId) return
      streamSkipDetection.value = result
    } catch (err) {
      if (requestId !== streamSkipRequestId) return
      console.error('Failed to detect streamed skip ranges:', err)
      streamSkipDetection.value = null
    } finally {
      if (requestId === streamSkipRequestId) {
        streamSkipDetecting.value = false
      }
    }
  }

  function cancelStreamDetection(): void {
    streamSkipRequestId++
    streamSkipDetecting.value = false
    void window.api.skipDetectorCancelStreamDetect()
  }

  // Stream-mode reactivity: when the streaming inputs or the show signature
  // change, reset UI + retry detection. On the way out (no longer streaming),
  // tear down the in-flight request.
  const streamSkipSignatureVersion = computed(() => {
    if (!deps.isStreaming.value) return 0
    return showSkipDetections.value?.analyzedAt ?? 0
  })
  const streamSkipSource = computed(() => {
    if (!deps.isStreaming.value) return ''
    return showSkipDetections.value?.algorithm?.source ?? ''
  })
  watch(
    [
      deps.isStreaming,
      deps.activeStreamUrl,
      () => deps.getCurrentEpisodeInt(),
      streamSkipSignatureVersion,
      streamSkipSource
    ],
    () => {
      if (!deps.isStreaming.value) {
        cancelStreamDetection()
        streamSkipDetection.value = null
        return
      }
      resetSkipUiState()
      void refreshStreamSkipDetection()
    }
  )

  onMounted(() => {
    // Re-load detections whenever main broadcasts that the show's signatures
    // changed (e.g. after a backfill or chapter inject).
    unsubSignatureUpdated = window.api.onSkipDetectorSignatureUpdated((data) => {
      if (data.animeId !== deps.getAnimeId()) return
      void loadSkipDetections()
    })
  })

  onBeforeUnmount(() => {
    cancelStreamDetection()
    if (skipButtonGraceTimer) {
      clearTimeout(skipButtonGraceTimer)
      skipButtonGraceTimer = null
    }
    unsubSignatureUpdated?.()
    unsubSignatureUpdated = null
  })

  return {
    showSkipDetections,
    streamSkipDetection,
    streamSkipDetecting,
    skipButtonVisible,
    currentEpisodeSkip,
    activeSkipRange,
    loadSkipDetections,
    refreshStreamSkipDetection,
    cancelStreamDetection,
    onSkipClick,
    resetSkipUiState
  }
}
