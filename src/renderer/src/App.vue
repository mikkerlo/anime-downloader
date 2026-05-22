<script setup lang="ts">
import { ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useLibraryStore } from './stores/library';
import Sidebar from './components/Sidebar.vue';
import SearchView from './components/SearchView.vue';
import LibraryView from './components/LibraryView.vue';
import SettingsView from './components/SettingsView.vue';
import DownloadsView from './components/DownloadsView.vue';
import AnimeDetailView from './components/AnimeDetailView.vue';
import ShikimoriView from './components/ShikimoriView.vue';
import FriendsActivityView from './components/FriendsActivityView.vue';
import CalendarView from './components/CalendarView.vue';
import HomeView from './components/HomeView.vue';
import PlayerView from './components/PlayerView.vue';
import CleanupModal from './components/CleanupModal.vue';
import { formatBytes } from './utils';

const libraryStore = useLibraryStore();
const { currentView, activeAnimeId, activeFocusEpisodeInt } = storeToRefs(libraryStore);

const searchViewRef = ref<InstanceType<typeof SearchView> | null>(null);
const shortcuts = ref<Record<string, string>>({});

const shikimoriLoggedIn = ref(false);

// Reload shortcuts when leaving the settings view in case the user rebound any.
watch(currentView, (next, prev) => {
  if (prev === 'settings' && next !== 'settings') loadShortcuts();
});

// Player overlay state
const playerState = ref<{
  filePath: string;
  streamUrl: string;
  subtitleContent: string;
  animeName: string;
  episodeLabel: string;
  availableStreams: { height: number; url: string }[];
  translationId: number;
  translations: { id: number; label: string; type: string; height: number }[];
  downloadedTrIds: number[];
  allEpisodes: {
    episodeInt: string;
    episodeFull: string;
    translations: { id: number; label: string; type: string; height: number }[];
    downloadedTrIds: number[];
  }[];
  episodeIndex: number;
  animeId: number;
  malId: number;
} | null>(null);

function openPlayer(
  filePath: string,
  streamUrl: string,
  subtitleContent: string,
  animeName: string,
  episodeLabel: string,
  availableStreams: { height: number; url: string }[],
  translationId: number,
  translations: { id: number; label: string; type: string; height: number }[] = [],
  downloadedTrIds: number[] = [],
  allEpisodes: {
    episodeInt: string;
    episodeFull: string;
    translations: { id: number; label: string; type: string; height: number }[];
    downloadedTrIds: number[];
  }[] = [],
  episodeIndex: number = 0,
  animeId = 0,
  malId = 0
): void {
  playerState.value = {
    filePath,
    streamUrl,
    subtitleContent,
    animeName,
    episodeLabel,
    availableStreams,
    translationId,
    translations,
    downloadedTrIds,
    allEpisodes,
    episodeIndex,
    animeId,
    malId
  };
}

function closePlayer(): void {
  playerState.value = null;
}

// Persist translation type and author selections per anime across re-mounts
const animePrefs = ref<Record<number, { translationType?: string; author?: string }>>({});

function saveAnimePrefs(animeId: number, translationType: string, author: string): void {
  animePrefs.value[animeId] = { translationType, author };
}

const isMac = navigator.platform.toUpperCase().includes('MAC');

function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());

  const needCtrl = mods.includes('ctrl');
  const needMeta = mods.includes('meta');
  const needCmdOrCtrl = mods.includes('cmdorctrl');
  const needShift = mods.includes('shift');
  const needAlt = mods.includes('alt');

  const wantCtrl = needCtrl || (needCmdOrCtrl && !isMac);
  const wantMeta = needMeta || (needCmdOrCtrl && isMac);

  if (e.ctrlKey !== wantCtrl) return false;
  if (e.metaKey !== wantMeta) return false;
  if (e.shiftKey !== needShift) return false;
  if (e.altKey !== needAlt) return false;

  return e.key.toLowerCase() === key.toLowerCase();
}

function executeAction(action: string): void {
  switch (action) {
    case 'back':
      if (activeAnimeId.value) libraryStore.closeAnime();
      break;
    case 'focusSearch':
      libraryStore.navigate('search');
      libraryStore.animeByView.search = null;
      nextTick(() => searchViewRef.value?.focusInput());
      break;
    case 'goDownloads':
      libraryStore.navigate('downloads');
      break;
  }
}

function handleKeydown(e: KeyboardEvent): void {
  // Don't intercept shortcuts when the player overlay is active
  if (playerState.value) return;

  const tag = (e.target as HTMLElement).tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  for (const [action, binding] of Object.entries(shortcuts.value)) {
    if (!binding) continue;
    if (matchesBinding(e, binding)) {
      if (action === 'back' && isInput) continue;
      e.preventDefault();
      executeAction(action);
      return;
    }
  }
}

async function loadShortcuts(): Promise<void> {
  shortcuts.value = (await window.api.getSetting('keyboardShortcuts')) as Record<string, string>;
}

const ffmpegDownloading = ref(false);
const ffmpegProgress = ref(0);

// Cleanup prompt (Shikimori "completed" transition)
const cleanupToast = ref<{
  animeId: number;
  animeName: string;
  bytes: number;
  files: number;
  loading: boolean;
} | null>(null);
const cleanupModal = ref<{ animeId: number; animeName: string } | null>(null);
let cleanupToastTimer: ReturnType<typeof setTimeout> | null = null;

function dismissCleanupToast(): void {
  if (cleanupToastTimer) {
    clearTimeout(cleanupToastTimer);
    cleanupToastTimer = null;
  }
  cleanupToast.value = null;
}

async function handleCleanupPrompt(data: {
  animeId: number;
  animeName: string;
  malId: number;
}): Promise<void> {
  dismissCleanupToast();
  cleanupToast.value = {
    animeId: data.animeId,
    animeName: data.animeName,
    bytes: 0,
    files: 0,
    loading: true
  };
  cleanupToastTimer = setTimeout(dismissCleanupToast, 30000);
  try {
    const size = await window.api.cleanupGetSize(data.animeId, data.animeName);
    if (cleanupToast.value && cleanupToast.value.animeId === data.animeId) {
      cleanupToast.value.bytes = size.bytes;
      cleanupToast.value.files = size.files;
      cleanupToast.value.loading = false;
    }
  } catch {
    if (cleanupToast.value && cleanupToast.value.animeId === data.animeId) {
      cleanupToast.value.loading = false;
    }
  }
}

function openCleanupModalFromToast(): void {
  if (!cleanupToast.value) return;
  cleanupModal.value = {
    animeId: cleanupToast.value.animeId,
    animeName: cleanupToast.value.animeName
  };
  dismissCleanupToast();
}

async function snoozeCleanupFromToast(): Promise<void> {
  if (!cleanupToast.value) return;
  const id = cleanupToast.value.animeId;
  dismissCleanupToast();
  try {
    await window.api.cleanupSetSnoozed(id, true);
  } catch {
    /* ignore */
  }
}

function closeCleanupModal(): void {
  cleanupModal.value = null;
}

let unsubFfmpegProgress: Unsubscribe | null = null;
let unsubCleanupPrompt: Unsubscribe | null = null;

onMounted(async () => {
  await loadShortcuts();
  const shikiUser = await window.api.shikimoriGetUser();
  shikimoriLoggedIn.value = !!shikiUser;
  window.addEventListener('keydown', handleKeydown);
  unsubFfmpegProgress = window.api.onFfmpegDownloadProgress((data) => {
    if (data.status === 'downloading') {
      ffmpegDownloading.value = true;
      ffmpegProgress.value = data.progress ?? 0;
    } else {
      ffmpegDownloading.value = false;
    }
  });
  unsubCleanupPrompt = window.api.onCleanupPrompt(handleCleanupPrompt);
  // Expose test hook for Playwright screenshot script
  (window as any).__openTestPlayer = openPlayer;
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
  unsubFfmpegProgress?.();
  unsubCleanupPrompt?.();
  if (cleanupToastTimer) clearTimeout(cleanupToastTimer);
});
</script>

<template>
  <div class="app">
    <Sidebar :shikimori-logged-in="shikimoriLoggedIn" />
    <AnimeDetailView
      v-if="activeAnimeId"
      :key="activeAnimeId"
      :anime-id="activeAnimeId"
      :initial-prefs="animePrefs[activeAnimeId]"
      :focus-episode-int="activeFocusEpisodeInt"
      @prefs-changed="saveAnimePrefs"
      @play-file="openPlayer"
    />
    <HomeView v-show="currentView === 'home' && !activeAnimeId" />
    <SearchView ref="searchViewRef" v-show="currentView === 'search' && !activeAnimeId" />
    <LibraryView v-if="currentView === 'library' && !activeAnimeId" />
    <ShikimoriView v-show="currentView === 'shikimori' && !activeAnimeId" />
    <FriendsActivityView v-show="currentView === 'friends' && !activeAnimeId" />
    <CalendarView v-if="currentView === 'calendar' && !activeAnimeId" />
    <SettingsView v-if="currentView === 'settings'" />
    <DownloadsView v-if="currentView === 'downloads'" />
    <PlayerView
      v-if="playerState"
      :file-path="playerState.filePath"
      :stream-url="playerState.streamUrl"
      :subtitle-content="playerState.subtitleContent"
      :anime-name="playerState.animeName"
      :episode-label="playerState.episodeLabel"
      :available-streams="playerState.availableStreams"
      :translation-id="playerState.translationId"
      :translations="playerState.translations"
      :downloaded-tr-ids="playerState.downloadedTrIds"
      :all-episodes="playerState.allEpisodes"
      :episode-index="playerState.episodeIndex"
      :anime-id="playerState.animeId"
      :mal-id="playerState.malId"
      @close="closePlayer"
    />
    <CleanupModal
      v-if="cleanupModal"
      :anime-id="cleanupModal.animeId"
      :anime-name="cleanupModal.animeName"
      @closed="closeCleanupModal"
    />
    <div v-if="cleanupToast" class="cleanup-toast">
      <div class="cleanup-toast-body">
        <div class="cleanup-toast-title">✓ You finished «{{ cleanupToast.animeName }}»</div>
        <div class="cleanup-toast-size">
          <template v-if="cleanupToast.loading">Calculating size…</template>
          <template v-else-if="cleanupToast.files === 0">No local files</template>
          <template v-else
            >{{ cleanupToast.files }} file{{ cleanupToast.files === 1 ? '' : 's' }} ·
            {{ formatBytes(cleanupToast.bytes) }} on disk</template
          >
        </div>
      </div>
      <div class="cleanup-toast-actions">
        <button class="cleanup-toast-btn primary" @click="openCleanupModalFromToast">
          Cleanup files
        </button>
        <button class="cleanup-toast-btn" @click="dismissCleanupToast">Keep</button>
        <button class="cleanup-toast-btn subtle" @click="snoozeCleanupFromToast">
          Don't ask for this show
        </button>
      </div>
    </div>
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

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: #1a1a2e;
}
::-webkit-scrollbar-thumb {
  background: #2a2a4a;
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: #3a3a5a;
}
::-webkit-scrollbar-corner {
  background: #1a1a2e;
}

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
  to {
    transform: rotate(360deg);
  }
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

.cleanup-toast {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 360px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  z-index: 8000;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cleanup-toast-title {
  font-size: 0.92rem;
  font-weight: 600;
  color: #e0e0e0;
  margin-bottom: 4px;
}

.cleanup-toast-size {
  font-size: 0.8rem;
  color: #a0a0b8;
}

.cleanup-toast-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.cleanup-toast-btn {
  padding: 5px 10px;
  font-size: 0.78rem;
  border-radius: 5px;
  border: 1px solid #0f3460;
  background: transparent;
  color: #c0c0d0;
  cursor: pointer;
}

.cleanup-toast-btn:hover {
  background: rgba(15, 52, 96, 0.4);
}

.cleanup-toast-btn.primary {
  background: #e94560;
  border-color: #e94560;
  color: #ffffff;
}

.cleanup-toast-btn.primary:hover {
  background: #f25670;
}

.cleanup-toast-btn.subtle {
  color: #7a7a98;
  border-color: transparent;
}

.cleanup-toast-btn.subtle:hover {
  color: #c0c0d0;
}
</style>
