// The player's disconnect overlay (#582): an attached Shared Library's drive
// went away while one of its episodes was playing.
//
// - MSE (`.mkv`): main classifies the ffmpeg exit and the stream error carries
//   `reason: 'drive-disconnected'`; `use-mse-player` saves the position, resets,
//   then calls `onMseDisconnected`. An open that finds the drive already gone
//   returns the same reason.
// - `anime-video://`: the protocol can't hand the renderer a typed result, so a
//   `<video>` error on an attached title waits up to one poll interval for the
//   store to report the library unavailable (at once if it already does), and
//   only then raises the overlay. A drive that stays available, such as a
//   sleeping one that woke up, is a generic playback error.
//
// The overlay never retries by itself. Retry is enabled once the library is
// available again, and re-resolves the episode through `player:find-local-file`,
// since the drive may come back at another path.

import { computed, ref, type ComputedRef, type Ref } from 'vue'

/** One poll interval of the availability poller (`POLL_INTERVAL_MS`, #581). */
export const DISCONNECT_WAIT_MS = 10_000

export const DRIVE_DISCONNECTED_TEXT = 'The drive was disconnected. Reconnect it to continue.'

export function useDriveDisconnect(deps: {
  /** The attached library the playing file is on, or '' for any other file. */
  getLibraryId: () => string
  isAvailable: (libraryId: string) => boolean | null
  waitForUnavailable: (libraryId: string, timeoutMs: number) => Promise<boolean>
  savePosition: () => void
  pause: () => void
  /** Re-resolves and reopens the episode; true when it plays again. */
  reopen: () => Promise<boolean>
  waitMs?: number
}): {
  disconnected: Ref<boolean>
  libraryId: Ref<string>
  retrying: Ref<boolean>
  retryError: Ref<string>
  retryEnabled: ComputedRef<boolean>
  onMseDisconnected: () => void
  onVideoError: () => Promise<'overlay' | 'generic' | 'ignored'>
  retry: () => Promise<void>
} {
  const disconnected = ref(false)
  const libraryId = ref('')
  const retrying = ref(false)
  const retryError = ref('')
  const retryEnabled = computed(
    () =>
      disconnected.value &&
      !retrying.value &&
      !!libraryId.value &&
      deps.isAvailable(libraryId.value) === true
  )

  function show(id: string): void {
    deps.pause()
    libraryId.value = id
    retryError.value = ''
    disconnected.value = true
  }

  /** Main said so; the MSE composable saved the position before its reset. */
  function onMseDisconnected(): void {
    show(deps.getLibraryId())
  }

  async function onVideoError(): Promise<'overlay' | 'generic' | 'ignored'> {
    const id = deps.getLibraryId()
    if (!id || disconnected.value) return 'ignored'
    if (!(await deps.waitForUnavailable(id, deps.waitMs ?? DISCONNECT_WAIT_MS))) return 'generic'
    // The source has errored but still holds its clock.
    deps.savePosition()
    show(id)
    return 'overlay'
  }

  async function retry(): Promise<void> {
    if (!retryEnabled.value) return
    retrying.value = true
    retryError.value = ''
    try {
      if (await deps.reopen()) {
        disconnected.value = false
        libraryId.value = ''
      } else {
        retryError.value = "The episode still can't be opened from the drive."
      }
    } catch {
      retryError.value = "The episode still can't be opened from the drive."
    } finally {
      retrying.value = false
    }
  }

  return {
    disconnected,
    libraryId,
    retrying,
    retryError,
    retryEnabled,
    onMseDisconnected,
    onVideoError,
    retry
  }
}
