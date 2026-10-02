// Settings / global progress + status store (Phase 4 slice 4c, #111).
//
// Owns:
// - `shortcuts` — the resolved keyboard binding map used by App.vue to match
//   keydown events. Loaded from `getSetting('keyboardShortcuts')` and refreshed
//   whenever the user leaves the Settings tab.
// - `ffmpegDownloading` / `ffmpegProgress` / `ffmpegError` — drives the global
//   "Downloading ffmpeg…" overlay App.vue renders on first launch. A `'failed'`
//   broadcast used to fall into the catch-all branch and just hide the overlay,
//   so a broken install looked exactly like a successful one (#469); it now
//   parks the reason in `ffmpegError` and the overlay stays up until the user
//   dismisses it or a later `'downloading'` tick supersedes it.
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
  /** Portable build: "download" opens the GitHub release page instead of self-updating. */
  manual?: boolean
}

export const useSettingsStore = defineStore('settings', () => {
  const shortcuts = ref<Record<string, string>>({})
  const ffmpegDownloading = ref(false)
  const ffmpegProgress = ref(0)
  const ffmpegError = ref('')
  const fpcalcDownloading = ref(false)
  const fpcalcProgress = ref(0)
  const updateStatus = ref<UiUpdateStatus>({ status: 'idle' })

  /** Dismiss button on the ffmpeg error overlay; session-scoped, not persisted. */
  function clearFfmpegError(): void {
    ffmpegError.value = ''
  }

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
      // A retry that gets going must not keep painting the previous failure.
      ffmpegError.value = ''
    } else if (data.status === 'failed') {
      ffmpegDownloading.value = false
      ffmpegError.value = data.message ?? 'ffmpeg installation failed.'
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
    ffmpegError,
    fpcalcDownloading,
    fpcalcProgress,
    updateStatus,
    clearFfmpegError,
    loadShortcuts
  }
})
