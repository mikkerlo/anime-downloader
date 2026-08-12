// OP/ED skip-marker detection + skip button state for PlayerView (Phase 5
// slice 5d.2.c, #118).
//
// Owns the dual-mode skip detection:
//   - Local playback uses stored per-episode boundaries from
//     `skipDetectorGetDetections(animeId)`.
//   - Streamed playback asks main to fingerprint the current stream and
//     only surfaces ranges that match the locally-derived show signatures.
//
// Owns the *lifetime* of the stream-detection toast too (`streamSkipStatus`,
// #222): main's side of that IPC is unbounded, so the status is driven by a
// local deadline rather than by the promise settling.
//
// Also owns the skip button visibility state (with a small grace timer so
// scrubbing through a band doesn't flicker the button) and the
// per-session "already skipped" set so rewinding past a band doesn't
// re-show the button.
//
// Does NOT own: the seek action (caller supplies `onSeek` so the button
// click can drive the same seek path the rest of PlayerView uses), the
// episode change reset trigger (caller wires that because it also touches
// prefetch state), the `seeked` event and the element's playhead (the caller
// fans `@seeked` into `onVideoSeeked()` and supplies `getPlayheadTime` — a
// skip is committed only once the element is observed to have *arrived*,
// #238).

import { computed, ref, watch, onMounted, onBeforeUnmount, type ComputedRef, type Ref } from 'vue'

const SKIP_GRACE_MS = 250
const SKIP_LEAD_IN_SEC = 0.25
// Deliberately distinct from SKIP_LEAD_IN_SEC, and strictly greater: that one
// is the *band-entry* tolerance for `activeSkipRange`, this one is the
// *arrival* tolerance for a completed seek and must additionally absorb the
// browser's keyframe snap. Collapsing the two back together is a regression
// (#238); a landing 0.3 s before `endSec` counts as done, one 40 s short does
// not.
const SKIP_LANDING_EPSILON_SEC = 0.5

// #222. The stream-detect IPC has no upper bound of its own: main pulls two
// 8-minute audio clips off the CDN through ffmpeg and then fpcalc's every
// locally downloaded episode on a cold fingerprint cache, and none of those
// spawns resolve on anything but child `exit` — a half-open socket means the
// reply never comes and the toast is pinned for the rest of the session. The
// toast's lifetime is therefore owned here rather than by the promise.
const STREAM_DETECT_TIMEOUT_MS = 90_000
// How long the "unavailable" text holds before the toast fades. Short: it is
// purely informational, there is nothing to act on.
const STREAM_FAILURE_TOAST_MS = 3000
const STREAM_DETECT_TIMEOUT = Symbol('stream-detect-timeout')
// #263. The other way the deadline promise can settle: its timer was torn down
// under a run that is still parked on the race. Deliberately distinct from
// STREAM_DETECT_TIMEOUT so the post-race branch can tell "we gave up waiting"
// (which must raise the failure toast) from "somebody else has already taken
// over" (which must write nothing at all).
const STREAM_DETECT_SUPERSEDED = Symbol('stream-detect-superseded')

/**
 * `'failed'` names the *run*, not the message — the toast text ("OP/ED markers
 * unavailable") is derived from it in exactly one place, the PlayerView
 * template.
 */
export type StreamSkipStatus = 'idle' | 'detecting' | 'failed'

export function useSkipMarkers(deps: {
  /** Live anime id getter (props pass-through). */
  getAnimeId: () => number
  /** Live episode int getter (computed from active episode index). */
  getCurrentEpisodeInt: () => string
  /** Live currentTime getter (the player progress ref). */
  getCurrentTime: () => number
  /**
   * Live playhead getter reading the **element's** `currentTime`, not the
   * display ref. The display ref is written only from `timeupdate` and is
   * frozen while the scrubber-drag latch is set, so it cannot be trusted to
   * describe where a `seeked` actually landed (#238).
   */
  getPlayheadTime: () => number
  /** Reactive: are we playing a stream URL (vs a local file)? */
  isStreaming: Ref<boolean>
  /** Reactive: the active stream URL (when streaming). */
  activeStreamUrl: Ref<string>
  /** Caller-supplied seek action; called with the OP/ED end time on click. */
  onSeek: (timeSec: number) => void
  /**
   * Fired when a skip seek completed short of the band end (the download
   * frontier clamped it). The caller surfaces the "can't skip past the
   * download" toast; nothing is committed and the button stays up.
   */
  onSkipLandedShort?: () => void
}): {
  showSkipDetections: Ref<ShowSkipDetections | null>
  streamSkipDetection: Ref<EpisodeSkipDetection | null>
  streamSkipStatus: Ref<StreamSkipStatus>
  skipButtonVisible: Ref<boolean>
  currentEpisodeSkip: ComputedRef<EpisodeSkipDetection | null>
  activeSkipRange: ComputedRef<'op' | 'ed' | null>
  loadSkipDetections: () => Promise<void>
  refreshStreamSkipDetection: () => Promise<void>
  cancelStreamDetection: () => void
  onSkipClick: () => void
  onVideoSeeked: () => void
  resetSkipUiState: () => void
} {
  const showSkipDetections = ref<ShowSkipDetections | null>(null)
  const streamSkipDetection = ref<EpisodeSkipDetection | null>(null)
  const streamSkipStatus = ref<StreamSkipStatus>('idle')
  const skippedRanges = ref<Set<string>>(new Set())
  const skipButtonVisible = ref(false)

  let skipButtonGraceTimer: ReturnType<typeof setTimeout> | null = null
  // Single-shot: armed by a skip click, resolved by the first `seeked` that
  // follows it. Until it resolves, nothing is committed and nothing is hidden.
  // `key` already encodes the kind (`skipRangeKey`), so the kind is not carried
  // separately — a second copy could only drift out of sync with it.
  let pendingSkipLanding: { key: string; endSec: number } | null = null
  let streamSkipRequestId = 0
  // Both are #222 state: the deadline that bounds the in-flight IPC, and the
  // hold on the failure text. Every path that retires a request clears them,
  // otherwise a timer outlives its generation and fires against a new episode.
  let streamDeadlineTimer: ReturnType<typeof setTimeout> | null = null
  // The deadline promise's resolver, held alongside its timer handle so that
  // tearing the timer down can also settle the race parked on it (#263).
  // In the composable's closure, not module scope: one player's teardown must
  // not settle another instance's run.
  let resolveStreamDeadline: ((outcome: typeof STREAM_DETECT_SUPERSEDED) => void) | null = null
  let streamFailureTimer: ReturnType<typeof setTimeout> | null = null
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

  // The click only *requests* the skip. On a growing `.part` the seek can be
  // clamped to the download frontier, or never complete at all, so committing
  // the range (or hiding the button) here left both stuck for the rest of the
  // episode — the range was marked and `activeSkipRange` never changed, so the
  // visibility watch could not re-arm it. Both now wait for a confirmed
  // landing in `onVideoSeeked` (#238). Not hiding is what makes the
  // never-completes case safe: there is nothing to restore.
  function onSkipClick(): void {
    const bounds = activeSkipBounds()
    if (!bounds) return
    pendingSkipLanding = { key: skipRangeKey(bounds.kind), endSec: bounds.endSec }
    deps.onSeek(bounds.endSec)
  }

  // Caller fans the element's `seeked` here. No-op unless a skip click is
  // pending; single-shot, so an unrelated later seek can never re-resolve it.
  function onVideoSeeked(): void {
    const pending = pendingSkipLanding
    if (!pending) return
    pendingSkipLanding = null
    if (deps.getPlayheadTime() >= pending.endSec - SKIP_LANDING_EPSILON_SEC) {
      // Arrived: dedupe the range so rewinding into it doesn't re-offer the
      // skip. The button hides on its own once the playhead leaves the band.
      skippedRanges.value.add(pending.key)
      return
    }
    deps.onSkipLandedShort?.()
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
    // An episode/stream flip must not let the previous band's pending click be
    // resolved by the new episode's first `seeked`.
    pendingSkipLanding = null
    if (skipButtonGraceTimer) {
      clearTimeout(skipButtonGraceTimer)
      skipButtonGraceTimer = null
    }
    skipButtonVisible.value = false
  }

  function clearStreamTimers(): void {
    if (streamDeadlineTimer) {
      clearTimeout(streamDeadlineTimer)
      streamDeadlineTimer = null
    }
    // #263. `clearTimeout` drops the callback, and that callback was the
    // deadline promise's only resolver — so clearing alone leaves a run that is
    // still awaiting `Promise.race([<the IPC>, deadline])` with nothing left
    // that can settle either side (the IPC is unbounded; that is why the
    // deadline exists). Its returned promise, its closure and the pending IPC
    // promise would then be retained for the rest of the session, one per
    // restart. Settle the race here instead; the run is retired either way.
    if (resolveStreamDeadline) {
      resolveStreamDeadline(STREAM_DETECT_SUPERSEDED)
      resolveStreamDeadline = null
    }
    if (streamFailureTimer) {
      clearTimeout(streamFailureTimer)
      streamFailureTimer = null
    }
  }

  // Terminal transition for a run that gave up (deadline or a rejected IPC).
  //
  // The cancel IPC is what actually drops main's ffmpeg/fpcalc children: the
  // renderer has stopped waiting, but nothing over there notices on its own —
  // `detectStream` swallows abort errors and resolves as `null`, or, on a warm
  // fingerprint cache, with real ranges.
  //
  // It is the *raw* IPC rather than `cancelStreamDetection()` on purpose: that
  // helper also drives the composable's own "idle" terminal state, and this
  // function owns a different one. Routing through it would make the 'failed'
  // below depend on running after the reset rather than being independent of
  // it — the two are equivalent today only because of that statement order.
  function failStreamDetection(): void {
    // The rejection is expected, not exceptional: this runs precisely when main
    // has stopped answering, which is the state most likely to reject the cancel
    // too. Without a handler that would surface as an `unhandledrejection`.
    void window.api.skipDetectorCancelStreamDetect().catch(() => {})
    clearStreamTimers()
    streamSkipStatus.value = 'failed'
    streamFailureTimer = setTimeout(() => {
      streamFailureTimer = null
      streamSkipStatus.value = 'idle'
    }, STREAM_FAILURE_TOAST_MS)
  }

  async function refreshStreamSkipDetection(): Promise<void> {
    const requestId = ++streamSkipRequestId
    // Before the early returns: a stream→local flip during the failure hold
    // would otherwise leave a timer that fires against the new state.
    clearStreamTimers()
    streamSkipDetection.value = null
    streamSkipStatus.value = 'idle'
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
    // #222: that cancel is a real IPC round-trip, so a newer request — or a
    // `cancelStreamDetection()` from the stream→local flip — can land while we
    // are suspended in it. Without this re-check a superseded run turns the
    // toast back *on* after the newer path turned it off, and then declines to
    // turn it off again at its own exit (that exit is generation-gated, and the
    // generation is stale) — the toast is pinned for the rest of the session.
    if (requestId !== streamSkipRequestId) return
    streamSkipStatus.value = 'detecting'

    const deadline = new Promise<typeof STREAM_DETECT_TIMEOUT | typeof STREAM_DETECT_SUPERSEDED>(
      (resolve) => {
        streamDeadlineTimer = setTimeout(
          () => resolve(STREAM_DETECT_TIMEOUT),
          STREAM_DETECT_TIMEOUT_MS
        )
        resolveStreamDeadline = resolve
      }
    )
    const ownDeadlineTimer = streamDeadlineTimer
    const ownResolveDeadline = resolveStreamDeadline
    try {
      // A genuine race, not a side-effect-only timer: the promise this function
      // returns has to settle at the deadline too, or every caller awaiting it
      // inherits the unbounded wait. `clearStreamTimers()` settles `deadline`
      // early when a restart or teardown retires this run (#263), so that
      // holds even when the deadline never gets to fire.
      const outcome = await Promise.race([
        window.api.skipDetectorDetectStream(animeId, epInt, deps.activeStreamUrl.value),
        deadline
      ])
      // Checked ahead of the generation guard rather than behind it: every path
      // that settles the race this way does bump the generation today, so the
      // guard would also catch it — but that makes the *ordering* of two
      // unrelated bookkeeping fields load-bearing. This sentinel says on its own
      // that the run was retired from outside.
      if (outcome === STREAM_DETECT_SUPERSEDED) return
      if (requestId !== streamSkipRequestId) return
      if (outcome === STREAM_DETECT_TIMEOUT) {
        // Returning here is what retires the run: the IPC promise is still
        // pending, but racing it means it has no continuation left that could
        // write `streamSkipDetection` or reset the status behind the failure
        // message. `Promise.race` has already attached a rejection handler to
        // it, so a late rejection can't surface as an unhandled one either.
        failStreamDetection()
        return
      }
      streamSkipDetection.value = outcome
      streamSkipStatus.value = 'idle'
    } catch (err) {
      if (requestId !== streamSkipRequestId) return
      console.error('Failed to detect streamed skip ranges:', err)
      streamSkipDetection.value = null
      failStreamDetection()
    } finally {
      if (ownDeadlineTimer) clearTimeout(ownDeadlineTimer)
      if (streamDeadlineTimer === ownDeadlineTimer) streamDeadlineTimer = null
      // Same ownership test as the timer above: a superseded run must not null
      // the newer run's resolver on its way out, or the newer run becomes
      // exactly the leak this pairing exists to close.
      if (resolveStreamDeadline === ownResolveDeadline) resolveStreamDeadline = null
    }
  }

  function cancelStreamDetection(): void {
    streamSkipRequestId++
    clearStreamTimers()
    streamSkipStatus.value = 'idle'
    // Same reason as the failure path's cancel: a stream→local flip or an
    // unmount while main is wedged enough to reject the cancel would put an
    // `unhandledrejection` on the renderer. Best-effort either way.
    void window.api.skipDetectorCancelStreamDetect().catch(() => {})
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
    streamSkipStatus,
    skipButtonVisible,
    currentEpisodeSkip,
    activeSkipRange,
    loadSkipDetections,
    refreshStreamSkipDetection,
    cancelStreamDetection,
    onSkipClick,
    onVideoSeeked,
    resetSkipUiState
  }
}
