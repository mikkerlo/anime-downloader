<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Sidebar from './components/Sidebar.vue'
import SearchView from './components/SearchView.vue'
import LibraryView from './components/LibraryView.vue'
import SettingsView from './components/SettingsView.vue'
import DownloadsView from './components/DownloadsView.vue'
import AnimeDetailView from './components/AnimeDetailView.vue'
import ShikimoriView from './components/ShikimoriView.vue'
import FriendsActivityView from './components/FriendsActivityView.vue'
import PlayerView from './components/PlayerView.vue'

const currentView = ref('search')
const searchViewRef = ref<InstanceType<typeof SearchView> | null>(null)
const shortcuts = ref<Record<string, string>>({})
const animeByView = ref<Record<string, number | null>>({
  search: null,
  library: null,
  shikimori: null,
  friends: null
})

const shikimoriLoggedIn = ref(false)

// Player overlay state
const playerState = ref<{
  filePath: string
  streamUrl: string
  subtitleContent: string
  animeName: string
  episodeLabel: string
  availableStreams: { height: number; url: string }[]
  translationId: number
  translations: { id: number; label: string; type: string; height: number }[]
  downloadedTrIds: number[]
  allEpisodes: { episodeInt: string; episodeFull: string; translations: { id: number; label: string; type: string; height: number }[]; downloadedTrIds: number[] }[]
  episodeIndex: number
  animeId: number
  malId: number
} | null>(null)

function openPlayer(filePath: string, streamUrl: string, subtitleContent: string, animeName: string, episodeLabel: string, availableStreams: { height: number; url: string }[], translationId: number, translations: { id: number; label: string; type: string; height: number }[] = [], downloadedTrIds: number[] = [], allEpisodes: { episodeInt: string; episodeFull: string; translations: { id: number; label: string; type: string; height: number }[]; downloadedTrIds: number[] }[] = [], episodeIndex: number = 0, animeId = 0, malId = 0): void {
  playerState.value = { filePath, streamUrl, subtitleContent, animeName, episodeLabel, availableStreams, translationId, translations, downloadedTrIds, allEpisodes, episodeIndex, animeId, malId }
}

function closePlayer(): void {
  playerState.value = null
}

// Persist translation type and author selections per anime across re-mounts
const animePrefs = ref<Record<number, { translationType?: string; author?: string }>>({})

const activeAnimeId = computed(() => animeByView.value[currentView.value] ?? null)

function openAnime(id: number): void {
  animeByView.value[currentView.value] = id
}

function closeAnime(): void {
  animeByView.value[currentView.value] = null
}

function saveAnimePrefs(animeId: number, translationType: string, author: string): void {
  animePrefs.value[animeId] = { translationType, author }
}

function navigate(view: string): void {
  if (currentView.value === 'settings' && view !== 'settings') loadShortcuts()
  currentView.value = view
}

const isMac = navigator.platform.toUpperCase().includes('MAC')

function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase())

  const needCtrl = mods.includes('ctrl')
  const needMeta = mods.includes('meta')
  const needCmdOrCtrl = mods.includes('cmdorctrl')
  const needShift = mods.includes('shift')
  const needAlt = mods.includes('alt')

  const wantCtrl = needCtrl || (needCmdOrCtrl && !isMac)
  const wantMeta = needMeta || (needCmdOrCtrl && isMac)

  if (e.ctrlKey !== wantCtrl) return false
  if (e.metaKey !== wantMeta) return false
  if (e.shiftKey !== needShift) return false
  if (e.altKey !== needAlt) return false

  return e.key.toLowerCase() === key.toLowerCase()
}

function executeAction(action: string): void {
  switch (action) {
    case 'back':
      if (activeAnimeId.value) closeAnime()
      break
    case 'focusSearch':
      navigate('search')
      animeByView.value.search = null
      nextTick(() => searchViewRef.value?.focusInput())
      break
    case 'goDownloads':
      navigate('downloads')
      break
  }
}

function handleKeydown(e: KeyboardEvent): void {
  // Don't intercept shortcuts when the player overlay is active
  if (playerState.value) return

  const tag = (e.target as HTMLElement).tagName
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

  for (const [action, binding] of Object.entries(shortcuts.value)) {
    if (!binding) continue
    if (matchesBinding(e, binding)) {
      if (action === 'back' && isInput) continue
      e.preventDefault()
      executeAction(action)
      return
    }
  }
}

async function loadShortcuts(): Promise<void> {
  shortcuts.value = (await window.api.getSetting('keyboardShortcuts')) as Record<string, string>
}

const ffmpegDownloading = ref(false)
const ffmpegProgress = ref(0)

onMounted(async () => {
  await loadShortcuts()
  const shikiUser = await window.api.shikimoriGetUser()
  shikimoriLoggedIn.value = !!shikiUser
  window.addEventListener('keydown', handleKeydown)
  window.api.onFfmpegDownloadProgress((data) => {
    if (data.status === 'downloading') {
      ffmpegDownloading.value = true
      ffmpegProgress.value = data.progress ?? 0
    } else {
      ffmpegDownloading.value = false
    }
  })
  // Expose test hook for Playwright screenshot script
  ;(window as any).__openTestPlayer = openPlayer
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.api.offFfmpegDownloadProgress()
})
</script>

<template>
  <div class="app">
    <Sidebar :current-view="currentView" :shikimori-logged-in="shikimoriLoggedIn" @navigate="navigate" />
    <AnimeDetailView v-if="activeAnimeId" :key="activeAnimeId" :anime-id="activeAnimeId" :initial-prefs="animePrefs[activeAnimeId]" @back="closeAnime" @prefs-changed="saveAnimePrefs" @play-file="openPlayer" />
    <SearchView ref="searchViewRef" v-show="currentView === 'search' && !activeAnimeId" @open-anime="openAnime" />
    <LibraryView v-if="currentView === 'library' && !activeAnimeId" @open-anime="openAnime" />
    <ShikimoriView v-show="currentView === 'shikimori' && !activeAnimeId" @open-anime="openAnime" />
    <FriendsActivityView v-show="currentView === 'friends' && !activeAnimeId" @open-anime="openAnime" />
    <SettingsView v-if="currentView === 'settings'" />
    <DownloadsView v-if="currentView === 'downloads'" />
    <PlayerView v-if="playerState" :file-path="playerState.filePath" :stream-url="playerState.streamUrl" :subtitle-content="playerState.subtitleContent" :anime-name="playerState.animeName" :episode-label="playerState.episodeLabel" :available-streams="playerState.availableStreams" :translation-id="playerState.translationId" :translations="playerState.translations" :downloaded-tr-ids="playerState.downloadedTrIds" :all-episodes="playerState.allEpisodes" :episode-index="playerState.episodeIndex" :anime-id="playerState.animeId" :mal-id="playerState.malId" @close="closePlayer" />
    <div v-if="ffmpegDownloading" class="ffmpeg-overlay">
      <div class="ffmpeg-modal">
        <div class="ffmpeg-spinner"></div>
        <p class="ffmpeg-title">Downloading ffmpeg...</p>
        <div class="ffmpeg-progress-bar">
          <div class="ffmpeg-progress-fill" :style="{ width: ffmpegProgress + '%' }"></div>
        </div>
        <p class="ffmpeg-percent">{{ ffmpegProgress }}%</p>
        <p class="ffmpeg-hint">Required for merging video and subtitles</p>
      </div>
    </div>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background-color: #1a1a2e;
  color: #e0e0e0;
  overflow: hidden;
}

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: #1a1a2e; }
::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #3a3a5a; }
::-webkit-scrollbar-corner { background: #1a1a2e; }

.app {
  display: flex;
  height: 100vh;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4a4a6a;
  font-size: 1.2rem;
}

.ffmpeg-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.ffmpeg-modal {
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 12px;
  padding: 2rem 2.5rem;
  text-align: center;
  min-width: 320px;
}

.ffmpeg-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #0f3460;
  border-top-color: #e94560;
  border-radius: 50%;
  margin: 0 auto 1rem;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.ffmpeg-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.ffmpeg-progress-bar {
  width: 100%;
  height: 6px;
  background: #0f3460;
  border-radius: 3px;
  overflow: hidden;
}

.ffmpeg-progress-fill {
  height: 100%;
  background: #e94560;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.ffmpeg-percent {
  margin-top: 0.5rem;
  font-size: 0.9rem;
  color: #a0a0c0;
}

.ffmpeg-hint {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: #6a6a8a;
}
</style>
