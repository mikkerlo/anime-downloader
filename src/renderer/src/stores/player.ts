// Player overlay + per-anime translation prefs store (Phase 4 slice 4c, #111).
//
// Owns the payload App.vue used to assemble for the PlayerView overlay and the
// per-anime translation/author cache that survives across AnimeDetailView
// re-mounts. The settings/library stores own other cross-view state; the player
// store is scoped to "what is currently playing + what did the user pick last
// time."

import { defineStore } from 'pinia'
import { ref } from 'vue'

export type PlayerTranslation = {
  id: number
  label: string
  type: string
  height: number
}

export type PlayerEpisode = {
  episodeInt: string
  episodeFull: string
  translations: PlayerTranslation[]
  downloadedTrIds: number[]
}

export type PlayerStream = { height: number; url: string }

export type PlayerPayload = {
  filePath: string
  streamUrl: string
  subtitleContent: string
  animeName: string
  episodeLabel: string
  availableStreams: PlayerStream[]
  translationId: number
  translations: PlayerTranslation[]
  downloadedTrIds: number[]
  allEpisodes: PlayerEpisode[]
  episodeIndex: number
  animeId: number
  malId: number
}

export type AnimePrefs = { translationType?: string; author?: string }

export const usePlayerStore = defineStore('player', () => {
  const playerState = ref<PlayerPayload | null>(null)
  const animePrefs = ref<Record<number, AnimePrefs>>({})

  function openPlayer(payload: PlayerPayload): void {
    playerState.value = payload
  }

  function closePlayer(): void {
    playerState.value = null
  }

  function saveAnimePrefs(animeId: number, translationType: string, author: string): void {
    animePrefs.value[animeId] = { translationType, author }
  }

  return {
    playerState,
    animePrefs,
    openPlayer,
    closePlayer,
    saveAnimePrefs
  }
})
