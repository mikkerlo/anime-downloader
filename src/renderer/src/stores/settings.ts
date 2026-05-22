// Settings / global progress + status store (Phase 4 slice 4c, #111).
//
// Owns:
// - `shortcuts` — the resolved keyboard binding map used by App.vue to match
//   keydown events. Loaded from `getSetting('keyboardShortcuts')` and refreshed
//   whenever the user leaves the Settings tab.
// - `ffmpegDownloading` / `ffmpegProgress` — drives the global "Downloading
//   ffmpeg…" overlay App.vue renders on first launch.
// - `fpcalcDownloading` / `fpcalcProgress` — parallel state for the chromaprint
//   binary; no UI surface today, plumbed for future use.
// - `updateStatus` — last seen auto-update status. Broader local UI type than
//   the IPC payload because SettingsView surfaces "idle" / "checking" states
//   that the main process never broadcasts.
//
// The three broadcast subscriptions are owned by the store and live for the
// app's lifetime (Pinia stores are singletons; the disposers are intentionally
// discarded — the listeners die with the renderer process).

import { defineStore } from 'pinia'
import { ref } from 'vue'

export type UiUpdateStatus = {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
}

export const useSettingsStore = defineStore('settings', () => {
  const shortcuts = ref<Record<string, string>>({})
  const ffmpegDownloading = ref(false)
  const ffmpegProgress = ref(0)
  const fpcalcDownloading = ref(false)
  const fpcalcProgress = ref(0)
  const updateStatus = ref<UiUpdateStatus>({ status: 'idle' })

  async function loadShortcuts(): Promise<void> {
    shortcuts.value =
      ((await window.api.getSetting('keyboardShortcuts')) as Record<string, string>) ?? {}
  }

  // Eager, lifetime-scoped subscriptions. Pinia instantiates the store exactly
  // once on first useSettingsStore() call, so this runs once for the app. The
  // returned disposers are discarded — the listeners die with the renderer.
  void window.api.onFfmpegDownloadProgress((data) => {
    if (data.status === 'downloading') {
      ffmpegDownloading.value = true
      ffmpegProgress.value = data.progress ?? 0
    } else {
      ffmpegDownloading.value = false
    }
  })
  void window.api.onFpcalcDownloadProgress((data) => {
    if (data.status === 'downloading') {
      fpcalcDownloading.value = true
      fpcalcProgress.value = data.progress ?? 0
    } else {
      fpcalcDownloading.value = false
    }
  })
  void window.api.onUpdateStatus((data) => {
    updateStatus.value = data as UiUpdateStatus
  })

  return {
    shortcuts,
    ffmpegDownloading,
    ffmpegProgress,
    fpcalcDownloading,
    fpcalcProgress,
    updateStatus,
    loadShortcuts
  }
})
