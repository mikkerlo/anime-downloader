// Watch-while-downloading (#63) — playback state for a growing `.part` file.
//
// The main-process anime-video:// handler tail-streams the file as it
// downloads, so the <video> element's `buffered` ranges track the true
// time-domain download frontier. The seek clamp derives from `buffered` plus
// a conservative margin; the byte ratio from the downloads store is
// display-only (bytes are not time — VBR would make a byte-based clamp
// overshoot into un-downloaded territory).

import { computed, ref, type Ref } from 'vue'
import { useDownloadsStore } from '../stores/downloads'

export const GROWING_SEEK_MARGIN_SEC = 2
export const SUBTITLE_POLL_MS = 3000

export interface UseGrowingFileDeps {
  activeFilePath: Ref<string>
  activeTranslationId: Ref<number>
  getVideoEl: () => Pick<HTMLVideoElement, 'buffered' | 'currentTime'> | null
  /** Late subtitle load (#63): fetch the sibling `.ass` of the active file. */
  fetchSubtitles?: () => Promise<string | null>
  subtitlePollMs?: number
}

export function useGrowingFile(deps: UseGrowingFileDeps): {
  isPartial: Ref<boolean>
  downloadProgressPct: Ref<number>
  downloadCompleted: Ref<boolean>
  downloadDead: Ref<boolean>
  waitingForDownload: Ref<boolean>
  clampSeekTarget: (t: number) => number
  onWaiting: () => void
  onPlaying: () => void
  startSubtitlePolling: (onFound: (content: string) => void) => void
  stopSubtitlePolling: () => void
} {
  const downloadsStore = useDownloadsStore()

  const isPartial = computed(() => deps.activeFilePath.value.toLowerCase().endsWith('.part'))

  const activeDownload = computed(() => {
    if (!isPartial.value) return null
    const group = downloadsStore.groups.find(
      (g) => g.translationId === deps.activeTranslationId.value
    )
    return group?.video ?? null
  })

  const downloadCompleted = computed(() => activeDownload.value?.status === 'completed')
  const downloadDead = computed(
    () =>
      isPartial.value &&
      (activeDownload.value?.status === 'failed' || activeDownload.value?.status === 'cancelled')
  )

  // Display-only fill for the seek bar — never used for clamping.
  const downloadProgressPct = computed(() => {
    const item = activeDownload.value
    if (!item || item.totalBytes <= 0) return 0
    return Math.min(100, (item.bytesReceived / item.totalBytes) * 100)
  })

  // True while playback has caught the download frontier and is stalled
  // waiting for new bytes. Set by the video's `waiting` event, cleared once
  // it plays again.
  const waitingForDownload = ref(false)

  // `null` means the frontier is unknown — no element, or nothing buffered yet.
  // Reporting `0` there collapsed `clampSeekTarget`'s limit to the playhead, so
  // every forward seek before the first buffered range landed was clamped to
  // where we already are (#237).
  function frontier(): number | null {
    const video = deps.getVideoEl()
    if (!video || video.buffered.length === 0) return null
    return video.buffered.end(video.buffered.length - 1)
  }

  function clampSeekTarget(t: number): number {
    if (!isPartial.value || downloadCompleted.value) return t
    const end = frontier()
    // Unknown frontier: pass the target through rather than snapping the user
    // back. An unreachable target stalls at the download frontier and surfaces
    // the "Waiting for download…" affordance; the clamp resumes on the next
    // seek, since `frontier()` is re-read on every call.
    if (end === null) return t
    const video = deps.getVideoEl()
    // Never clamp below the current position — the playhead is by definition
    // inside parseable data.
    const limit = Math.max(end - GROWING_SEEK_MARGIN_SEC, video?.currentTime ?? 0)
    return Math.min(t, limit)
  }

  function onWaiting(): void {
    if (isPartial.value && !downloadCompleted.value && !downloadDead.value) {
      waitingForDownload.value = true
    }
  }

  function onPlaying(): void {
    waitingForDownload.value = false
  }

  // Late subtitle load (#63): the subtitle queues before its video, but a
  // session opened in the first seconds after enqueue can still beat the .ass
  // to disk. Poll for it and hand it to the caller to hot-attach, instead of
  // leaving the whole watch subtitle-less.
  let subtitleTimer: ReturnType<typeof setInterval> | null = null
  let subtitleFetchInFlight = false

  function stopSubtitlePolling(): void {
    if (subtitleTimer) {
      clearInterval(subtitleTimer)
      subtitleTimer = null
    }
  }

  function startSubtitlePolling(onFound: (content: string) => void): void {
    stopSubtitlePolling()
    const fetchSubtitles = deps.fetchSubtitles
    if (!fetchSubtitles || !isPartial.value) return
    const tick = async (): Promise<void> => {
      if (subtitleFetchInFlight || !subtitleTimer) return
      subtitleFetchInFlight = true
      try {
        const content = await fetchSubtitles()
        if (content) {
          stopSubtitlePolling()
          onFound(content)
        } else if (downloadCompleted.value || downloadDead.value) {
          // Subtitle-first ordering: once the video is done (or dead), a
          // still-missing .ass will never arrive — stop asking.
          stopSubtitlePolling()
        }
      } catch {
        /* transient IPC failure — next tick retries */
      } finally {
        subtitleFetchInFlight = false
      }
    }
    subtitleTimer = setInterval(() => void tick(), deps.subtitlePollMs ?? SUBTITLE_POLL_MS)
  }

  return {
    isPartial,
    downloadProgressPct,
    downloadCompleted,
    downloadDead,
    waitingForDownload,
    clampSeekTarget,
    onWaiting,
    onPlaying,
    startSubtitlePolling,
    stopSubtitlePolling
  }
}
