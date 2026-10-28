// Attached Shared Libraries (#578), mirrored from main's AttachedLibraryService.
//
// One `shared-libraries:changed` subscription for the app's lifetime (Pinia
// singleton). The ffmpeg availability is read through the existing
// `ffmpeg:check`, again on window focus and before each `.mkv` Play, so the
// missing-ffmpeg banner clears once ffmpeg is installed.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const FFMPEG_MISSING_REASON =
  "ffmpeg isn't installed on this PC, so MKV episodes can't play. Connect to the internet once to download it, or use Prepare for offline."

export function ffmpegMissingText(mkvCount: number): string {
  const n = `${mkvCount} MKV episode${mkvCount === 1 ? '' : 's'}`
  return `ffmpeg isn't installed on this PC, so ${n} can't play. MP4 episodes with .ass subtitles still play. Connect to the internet once to download it, or use Prepare for offline.`
}

export function pathOverflowText(count: number): string {
  const n = `${count} file${count === 1 ? ' is' : 's are'}`
  return `${n} past Windows' 260-character path limit at this location. They play in the app, but other players may not open them. Move the library to a shorter folder to fix this.`
}

export const useSharedLibrariesStore = defineStore('shared-libraries', () => {
  const libraries = ref<AttachedLibraryInfo[]>([])
  // Optimistic until the first check answers, so nothing flashes disabled.
  const ffmpegAvailable = ref(true)
  // Set by "Show in Library" after an open; LibraryView selects the tab and clears it.
  const focusTab = ref(false)

  const attachedCount = computed(() => libraries.value.length)

  /** animeId → the libraries holding it, in list order. */
  const librariesByAnimeId = computed(() => {
    const map = new Map<number, AttachedLibraryInfo[]>()
    for (const lib of libraries.value) {
      for (const t of lib.titles) {
        const list = map.get(t.animeId) ?? []
        list.push(lib)
        map.set(t.animeId, list)
      }
    }
    return map
  })

  async function refresh(): Promise<void> {
    const list = await window.api.sharedLibraryList()
    libraries.value = Array.isArray(list) ? list : []
  }

  async function checkFfmpeg(): Promise<boolean> {
    try {
      ffmpegAvailable.value = (await window.api.ffmpegCheck())?.available === true
    } catch {
      ffmpegAvailable.value = false
    }
    return ffmpegAvailable.value
  }

  /** The target a title's Play from drive starts, or null when nothing on it can play here. */
  function playTarget(title: AttachedLibraryTitle): AttachedPlayTarget | null {
    return ffmpegAvailable.value ? title.play.any : title.play.withoutFfmpeg
  }

  void window.api.onSharedLibrariesChanged(() => {
    void refresh().catch(() => {})
  })
  window.addEventListener('focus', () => {
    void checkFfmpeg()
  })
  void refresh().catch(() => {})
  void checkFfmpeg()

  return {
    libraries,
    ffmpegAvailable,
    focusTab,
    attachedCount,
    librariesByAnimeId,
    refresh,
    checkFfmpeg,
    playTarget
  }
})
