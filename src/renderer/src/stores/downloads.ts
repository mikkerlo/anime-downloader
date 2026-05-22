// Downloads store (Phase 4 slice 4d, #111).
//
// Owns the per-episode download queue + scan-merge + fix-metadata broadcast
// projections that DownloadsView, AnimeDetailView, and SettingsView used to
// each subscribe to independently. Components now read from the store; only
// the consumer that triggered an action calls `refreshQueue()` if it needs an
// immediate non-broadcast read.
//
// Three broadcasts move into the store:
//   onDownloadProgress     — replaces `groups` (full queue snapshot)
//   onScanMergeProgress    — sets `scanMergeProgress`
//   onFixMetadataProgress  — sets `fixMetadataProgress`
//
// Lifetime-scoped subscriptions (Pinia singleton). Disposers discarded.

import { defineStore } from 'pinia'
import { ref } from 'vue'

export type FixMetadataProgress = {
  current: number
  total: number
  file: string
}

export const useDownloadsStore = defineStore('downloads', () => {
  const groups = ref<EpisodeGroup[]>([])
  const scanMergeProgress = ref<ScanMergeProgress | null>(null)
  const fixMetadataProgress = ref<FixMetadataProgress | null>(null)

  async function refreshQueue(): Promise<void> {
    groups.value = await window.api.downloadGetQueue()
  }

  void window.api.onDownloadProgress((data) => {
    groups.value = data
  })
  void window.api.onScanMergeProgress((data) => {
    scanMergeProgress.value = data
  })
  void window.api.onFixMetadataProgress((data) => {
    fixMetadataProgress.value = data
  })

  return {
    groups,
    scanMergeProgress,
    fixMetadataProgress,
    refreshQueue
  }
})
