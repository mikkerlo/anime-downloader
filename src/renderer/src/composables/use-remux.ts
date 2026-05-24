// Legacy MKV full-remux fallback state for PlayerView (Phase 5 slice 5d.2.b,
// #118).
//
// Owns the small handful of refs that drive the "Preparing MKV for playback"
// overlay + the `remuxedPath` that's fed into `videoSrc` when MSE rejected
// the codecs and we fell back to a one-shot ffmpeg stream-copy to an MP4 on
// disk. The MSE path (`useMsePlayer`) is preferred; this only runs when MSE
// negotiation fails.
//
// Does NOT own: the MSE state machine, the HEVC consent prompt, or the
// orchestration in `prepareMkvForPlayback` (those stay in PlayerView /
// `useMsePlayer`). This composable is intentionally thin — `runLegacyRemux`
// returns the IPC result + tracks the overlay flag.

import { ref, type Ref } from 'vue'

export function useRemux(): {
  remuxing: Ref<boolean>
  remuxedPath: Ref<string>
  runLegacyRemux: (
    filePath: string
  ) => Promise<{ ok: true; subtitleContent?: string } | { ok: false; error: string }>
  clear: () => void
} {
  const remuxing = ref(false)
  const remuxedPath = ref('')

  async function runLegacyRemux(
    filePath: string
  ): Promise<{ ok: true; subtitleContent?: string } | { ok: false; error: string }> {
    remuxing.value = true
    try {
      const legacy = await window.api.playerRemuxMkv(filePath)
      if ('error' in legacy) return { ok: false, error: legacy.error }
      remuxedPath.value = legacy.mp4Path
      return { ok: true, subtitleContent: legacy.subtitleContent }
    } finally {
      remuxing.value = false
    }
  }

  function clear(): void {
    remuxedPath.value = ''
  }

  return {
    remuxing,
    remuxedPath,
    runLegacyRemux,
    clear
  }
}
