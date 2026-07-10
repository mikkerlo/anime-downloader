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

export interface UseGrowingFileDeps {
  activeFilePath: Ref<string>
  activeTranslationId: Ref<number>
  getVideoEl: () => Pick<HTMLVideoElement, 'buffered' | 'currentTime'> | null
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

  function frontier(): number {
    const video = deps.getVideoEl()
    if (!video || video.buffered.length === 0) return 0
    return video.buffered.end(video.buffered.length - 1)
  }

  function clampSeekTarget(t: number): number {
    if (!isPartial.value || downloadCompleted.value) return t
    const video = deps.getVideoEl()
    // Never clamp below the current position — the playhead is by definition
    // inside parseable data.
    const limit = Math.max(frontier() - GROWING_SEEK_MARGIN_SEC, video?.currentTime ?? 0)
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

  return {
    isPartial,
    downloadProgressPct,
    downloadCompleted,
    downloadDead,
    waitingForDownload,
    clampSeekTarget,
    onWaiting,
    onPlaying
  }
}
