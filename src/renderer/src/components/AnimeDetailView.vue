<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { getAnimeName as _getAnimeName } from '../utils';
import CleanupModal from './CleanupModal.vue';
import { useLibraryStore } from '../stores/library';
import { usePlayerStore } from '../stores/player';
import { useShikimoriStore } from '../stores/shikimori';
import { useDownloadsStore } from '../stores/downloads';
import { useAnimeDetailPrefs } from '../composables/use-anime-detail-prefs';
import { useChronology } from '../composables/use-chronology';
import { provide } from 'vue';
import { useEpisodeList, PAGE_SIZE } from '../composables/use-episode-list';
import { useEpisodeDownloads } from '../composables/use-episode-downloads';
import { useShikimori } from '../composables/use-shikimori';
import { useSkipDetection } from '../composables/use-skip-detection';
import ChronologyPanel from './detail/ChronologyPanel.vue';
import FriendsPanel from './detail/FriendsPanel.vue';
import ShikimoriPanel from './detail/ShikimoriPanel.vue';
import SkipDetectionPanel from './detail/SkipDetectionPanel.vue';
import EpisodeList from './detail/EpisodeList.vue';
import { ShikimoriKey, SkipDetectionKey, EpisodeListKey, EpisodeDownloadsKey } from './detail/keys';
import { TRANSLATION_TYPES } from './detail/translation-types';

const props = defineProps<{
  animeId: number;
  initialPrefs?: { translationType?: string; author?: string };
  focusEpisodeInt?: string;
}>();

const libraryStore = useLibraryStore();
const playerStore = usePlayerStore();
const shikimoriStore = useShikimoriStore();
const downloadsStore = useDownloadsStore();
// syncStatus + offlineQueueLength are consumed by ShikimoriPanel directly from
// the store; the composable handles syncState/lastSyncError projections.

const anime = ref<AnimeDetail | null>(null);
const loading = ref(true);

const prefs = useAnimeDetailPrefs();
const { translationType, selectedAuthor } = prefs;

const chronology = useChronology();
const { shikiRelated, relatedLoading, relatedCollapsed } = chronology;

const dataSource = ref<'api' | 'cache' | null>(null);
const isOffline = computed(() => dataSource.value === 'cache');

let loadGeneration = 0;
let disposed = false;

let unsubFileEpisodesChanged: Unsubscribe | null = null;
let unsubSkipDetectorProgress: Unsubscribe | null = null;
let unsubSkipDetectorSignatureUpdated: Unsubscribe | null = null;
let unsubChapterInjectProgress: Unsubscribe | null = null;

const isStarred = ref(false);
const autoDlSubscription = ref<AutoDownloadSubscription | null>(null);
const autoDlSaving = ref(false);
const isDownloaded = ref(false);
const cleanupModalOpen = ref(false);

const episodeMeta = ref<Record<string, EpisodeMeta[]>>({});
const fileStatus = ref<
  Record<
    string,
    { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
  >
>({});
const downloadGroups = ref<Map<string, EpisodeGroup>>(new Map());
const watchProgress = ref<Record<string, WatchProgressEntry>>({});

const episodeList = useEpisodeList({
  anime,
  getAnimeId: () => props.animeId,
  getInitialAuthor: () => props.initialPrefs?.author,
  translationType,
  selectedAuthor,
  episodeMeta,
  fileStatus,
  downloadGroups,
  watchProgress,
  libraryStore,
  checkFileStatus: () => checkFileStatus()
});
provide(EpisodeListKey, episodeList);

const {
  episodes,
  currentPage,
  focusApplied,
  loadingEpisodes,
  filteredEpisodes,
  episodeRows,
  isPaginated,
  translationTypeCounts,
  availableAuthors,
  getRealHeight,
  goToPage,
  loadPageEpisodes,
  probeSelectedQualities,
  applyFocusEpisode,
  resetEpisodeOverrides
} = episodeList;

const shikimori = useShikimori({ anime, shikimoriStore });
provide(ShikimoriKey, shikimori);
const {
  shikiUser,
  shikiRate,
  shikiEpisodes,
  shikiUserChecked,
  shikiLoading,
  friendsRates,
  friendsLoading,
  friendsCollapsed
} = shikimori;

const skipDetection = useSkipDetection({
  getAnimeId: () => props.animeId,
  filteredEpisodes,
  fileStatus
});
provide(SkipDetectionKey, skipDetection);
const {
  subscribeSkipDetectorProgress,
  subscribeSkipDetectorSignatureUpdated,
  subscribeChapterInjectProgress,
  loadSkipDetections,
  hydrateSkipStatus
} = skipDetection;

const playerMode = ref<'system' | 'builtin'>('system');

const downloads = useEpisodeDownloads({
  anime,
  getAnimeId: () => props.animeId,
  getAnimeName: () => getAnimeName(),
  episodeMeta,
  fileStatus,
  downloadGroups,
  watchProgress,
  filteredEpisodes,
  episodes,
  episodeRows,
  getRealHeight,
  currentPage,
  isPaginated,
  goToPage,
  loadingEpisodes,
  shikiRate,
  shikiUser,
  shikiEpisodes,
  shikiUserChecked,
  shikiLoading,
  downloadsStore,
  playerStore,
  playerMode,
  pageSize: PAGE_SIZE
});
provide(EpisodeDownloadsKey, downloads);

const {
  downloading,
  errorMessage,
  continueReady,
  continueLabel,
  hasActiveDownloads,
  loadWatchProgress,
  checkFileStatus,
  updateDownloadGroups,
  downloadAll,
  cancelAllDownloads,
  continueWatching,
  subscribeFileEpisodesChanged
} = downloads;

function onMouseBack(e: MouseEvent): void {
  if (e.button === 3) {
    e.preventDefault();
    libraryStore.closeAnime();
  }
}

onMounted(async () => {
  window.addEventListener('mouseup', onMouseBack);
  playerMode.value =
    ((await window.api.getSetting('playerMode')) as string as typeof playerMode.value) || 'system';
  await prefs.loadInitialTranslationType(props.initialPrefs?.translationType);

  window.api
    .libraryHas(props.animeId)
    .then((v) => {
      isStarred.value = v;
    })
    .catch(() => {});
  window.api
    .autoDlGetSubscription(props.animeId)
    .then((s) => {
      autoDlSubscription.value = s;
    })
    .catch(() => {});
  window.api
    .libraryIsDownloaded(props.animeId)
    .then((v) => {
      isDownloaded.value = v;
    })
    .catch(() => {});

  const gen = ++loadGeneration;
  let renderedFromCache = false;
  try {
    const cached = await window.api.getAnimeCache(props.animeId);
    if (cached && !disposed && gen === loadGeneration) {
      anime.value = cached.data;
      dataSource.value = 'cache';
      loading.value = false;
      renderedFromCache = true;
      await loadPageEpisodes();
      await checkFileStatus();
      if (!props.initialPrefs?.translationType) applyDownloadedTranslationDefault();
    }
  } catch (err) {
    console.error('Failed to read anime cache:', err);
  }

  try {
    const res = await window.api.getAnime(props.animeId);
    if (disposed || gen !== loadGeneration) return;
    anime.value = res.data;
    dataSource.value = res.source;
    if (res.source === 'api') {
      window.api.setAnimeCache(props.animeId, res.data).catch(() => {});
    }
    await loadPageEpisodes();
    if (disposed || gen !== loadGeneration) return;
    await checkFileStatus();
    if (disposed || gen !== loadGeneration) return;
    if (!renderedFromCache && !props.initialPrefs?.translationType) {
      applyDownloadedTranslationDefault();
    }
  } catch (err) {
    if (!renderedFromCache) console.error('Failed to load anime detail view:', err);
  } finally {
    if (!disposed && gen === loadGeneration) loading.value = false;
  }

  // Render the queue snapshot the store already holds, then watch for any
  // future updates — the store owns the onDownloadProgress subscription.
  updateDownloadGroups(downloadsStore.groups);

  // Subscribe to background file rescan updates (component-local — keyed off
  // the currently displayed anime name).
  unsubFileEpisodesChanged = subscribeFileEpisodesChanged();

  // Load Shikimori data (non-blocking — don't hold up the episode list)
  void shikimori.loadShikimoriData(chronology.loadRelated);

  // Load watch progress for episode indicators
  loadWatchProgress();
  window.addEventListener('watch-progress-updated', loadWatchProgress);

  // Hydrate the store-owned sync-status + offline-queue length on mount; later
  // updates arrive via the store's broadcasts.
  void shikimoriStore.refreshOfflineQueueLength();
  void shikimoriStore.refreshSyncStatus();

  // Skip-detector + chapter-inject progress are anime-specific, so they stay
  // as component-local subscriptions (filtered by props.animeId).
  unsubSkipDetectorProgress = subscribeSkipDetectorProgress();
  unsubSkipDetectorSignatureUpdated = subscribeSkipDetectorSignatureUpdated();
  unsubChapterInjectProgress = subscribeChapterInjectProgress();
  void loadSkipDetections();
  void hydrateSkipStatus();
});

// Mirror store-owned download progress into the local episode-row projection.
watch(
  () => downloadsStore.groups,
  (groups) => updateDownloadGroups(groups),
  { deep: false }
);

onUnmounted(() => {
  disposed = true;
  loadGeneration++;
  window.removeEventListener('mouseup', onMouseBack);
  window.removeEventListener('watch-progress-updated', loadWatchProgress);
  unsubFileEpisodesChanged?.();
  unsubSkipDetectorProgress?.();
  unsubSkipDetectorSignatureUpdated?.();
  unsubChapterInjectProgress?.();
});

// Wraps the prefs composable's helper so call sites stay terse.
function applyDownloadedTranslationDefault(): void {
  prefs.applyDownloadedTranslationDefault({
    episodeMeta: episodeMeta.value,
    availableAuthors: availableAuthors.value
  });
}

async function toggleStar(): Promise<void> {
  if (!anime.value) return;
  const stripped: AnimeSearchResult = {
    id: anime.value.id,
    title: anime.value.title,
    titles: anime.value.titles,
    posterUrlSmall: anime.value.posterUrlSmall,
    numberOfEpisodes: anime.value.numberOfEpisodes,
    type: anime.value.type,
    typeTitle: anime.value.typeTitle,
    year: anime.value.year,
    season: anime.value.season
  };
  isStarred.value = await window.api.libraryToggle(JSON.parse(JSON.stringify(stripped)));
}

const isShowFinished = computed<boolean>(() => {
  const status = shikimori.shikiDetails.value?.status;
  return status === 'released';
});

const canAutoDl = computed<boolean>(() => {
  if (!anime.value?.myAnimeListId) return false;
  if (!shikiUser.value) return false;
  if (isShowFinished.value) return false;
  return true;
});

const autoDlTooltip = computed<string>(() => {
  if (!anime.value?.myAnimeListId) return 'Auto-download requires a Shikimori entry';
  if (!shikiUser.value) return 'Connect to Shikimori to enable auto-download';
  if (isShowFinished.value) return 'Show is fully aired — no new episodes to auto-download';
  if (autoDlSubscription.value) {
    const next = autoDlSubscription.value.lastEnqueuedEpisodeInt + 1;
    return `Will auto-download new episodes from Ep ${next} onward`;
  }
  return 'Auto-download new episodes as they air';
});

async function toggleAutoDl(): Promise<void> {
  if (!anime.value || autoDlSaving.value) return;
  if (!canAutoDl.value && !autoDlSubscription.value) return;
  autoDlSaving.value = true;
  try {
    const enable = !autoDlSubscription.value;
    const result = await window.api.autoDlSetSubscription(
      anime.value.id,
      enable,
      enable && anime.value.myAnimeListId
        ? { malId: anime.value.myAnimeListId, animeName: getAnimeName() }
        : undefined
    );
    if (enable && !result) {
      alert("Couldn't read this show's airing data from Shikimori. Please try again in a moment.");
      return;
    }
    autoDlSubscription.value = result;
  } catch (err) {
    console.error('Failed to toggle auto-download:', err);
  } finally {
    autoDlSaving.value = false;
  }
}

async function onCleanupDeleted(): Promise<void> {
  isDownloaded.value = false;
  episodeMeta.value = {};
  await checkFileStatus();
}

watch(
  [() => props.focusEpisodeInt, filteredEpisodes, loadingEpisodes],
  async () => {
    const target = props.focusEpisodeInt;
    if (!target || focusApplied.value) return;
    if (loadingEpisodes.value) return;
    if (filteredEpisodes.value.length === 0) return;
    await applyFocusEpisode(target);
  },
  { immediate: true }
);

function getAnimeName(): string {
  if (!anime.value) return '';
  return _getAnimeName(anime.value);
}

watch([translationType, selectedAuthor], () => {
  resetEpisodeOverrides();
  playerStore.saveAnimePrefs(props.animeId, translationType.value, selectedAuthor.value);
  void probeSelectedQualities();
});

const posterSrc = ref('');
const posterFallbackAttempted = ref(false);

watch(
  anime,
  async (val) => {
    if (val) {
      posterSrc.value = val.posterUrl || val.posterUrlSmall;
      posterFallbackAttempted.value = false;
    }
  },
  { immediate: true }
);

async function onPosterError(): Promise<void> {
  if (posterFallbackAttempted.value) return;
  posterFallbackAttempted.value = true;
  const cached = await window.api.getCachedPoster(props.animeId);
  if (cached) posterSrc.value = cached;
}
</script>

<template>
  <main class="detail-view">
    <header class="topbar">
      <button class="back-btn" @click="libraryStore.closeAnime()">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="18"
          height="18"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
          />
        </svg>
        Back
      </button>
    </header>

    <div v-if="loading" class="status-text">Loading...</div>

    <div v-else-if="anime" class="body">
      <div class="anime-header">
        <div class="poster-col">
          <img :src="posterSrc" :alt="anime.title" class="detail-poster" @error="onPosterError" />
          <button
            class="continue-btn"
            :disabled="!continueReady"
            :title="continueReady ? 'Continue watching' : 'Loading...'"
            @click="continueWatching"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M8 5v14l11-7z" />
            </svg>
            {{ continueLabel }}
          </button>
          <button class="library-btn" :class="{ active: isStarred }" @click="toggleStar">
            <svg
              viewBox="0 0 24 24"
              :fill="isStarred ? 'currentColor' : 'none'"
              stroke="currentColor"
              stroke-width="1.5"
              width="14"
              height="14"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
              />
            </svg>
            {{ isStarred ? 'In Library' : 'Add to Library' }}
          </button>
          <button
            v-if="canAutoDl || autoDlSubscription"
            class="library-btn auto-dl-btn"
            :class="{ active: !!autoDlSubscription }"
            :disabled="autoDlSaving || (!canAutoDl && !autoDlSubscription)"
            :title="autoDlTooltip"
            @click="toggleAutoDl"
          >
            <svg
              viewBox="0 0 24 24"
              :fill="autoDlSubscription ? 'currentColor' : 'none'"
              stroke="currentColor"
              stroke-width="1.5"
              width="14"
              height="14"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M19.5 12c0 4.142-3.358 7.5-7.5 7.5S4.5 16.142 4.5 12 7.858 4.5 12 4.5c1.747 0 3.354.6 4.625 1.604M19.5 4.5v3.75h-3.75"
              />
            </svg>
            {{ autoDlSubscription ? 'Auto-download on' : 'Auto-download' }}
          </button>
          <button v-if="isDownloaded" class="cleanup-btn" @click="cleanupModalOpen = true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              width="14"
              height="14"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
              />
            </svg>
            Cleanup files…
          </button>
        </div>
        <div class="anime-info">
          <h2 class="anime-title">
            {{ getAnimeName() }}
            <span v-if="isOffline" class="offline-badge">OFFLINE</span>
          </h2>
          <div class="anime-meta">
            <span v-if="anime.typeTitle">{{ anime.typeTitle }}</span>
            <span v-if="anime.year"> · {{ anime.year }}</span>
            <span v-if="anime.numberOfEpisodes"> · {{ anime.numberOfEpisodes }} episodes</span>
          </div>
          <div v-if="anime.genres?.length" class="genres">
            <span v-for="g in anime.genres" :key="g.id" class="genre-tag">{{ g.title }}</span>
          </div>
          <p v-if="anime.descriptions?.length" class="description">
            {{ anime.descriptions[0].value }}
          </p>
        </div>
      </div>

      <ShikimoriPanel
        v-if="anime.myAnimeListId && (shikiUser || !shikiUserChecked)"
        :anime="anime"
      />

      <ChronologyPanel
        v-if="anime.myAnimeListId && (relatedLoading || shikiRelated.length > 0)"
        v-model:collapsed="relatedCollapsed"
        :shiki-related="shikiRelated"
        :related-loading="relatedLoading"
      />

      <SkipDetectionPanel :filtered-episodes="filteredEpisodes" />

      <FriendsPanel
        v-if="anime.myAnimeListId && (shikiUser || !shikiUserChecked)"
        v-model:collapsed="friendsCollapsed"
        :friends-rates="friendsRates"
        :friends-loading="friendsLoading"
        :number-of-episodes="anime.numberOfEpisodes"
      />

      <div class="controls">
        <div class="control-group">
          <label>Translation type</label>
          <select v-model="translationType" class="select">
            <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">
              {{ t.label }} ({{ translationTypeCounts.get(t.value) || 0 }}/{{
                filteredEpisodes.length
              }})
            </option>
          </select>
        </div>
        <div class="control-group">
          <label>Author</label>
          <select v-model="selectedAuthor" class="select">
            <option v-for="[author, count] in availableAuthors" :key="author" :value="author">
              {{ author }} ({{ count }}/{{ filteredEpisodes.length }})
            </option>
          </select>
        </div>
        <button
          class="download-btn"
          @click="downloadAll"
          :disabled="episodeRows.every((r) => !r.selectedTr) || downloading"
        >
          {{
            downloading
              ? 'Enqueuing...'
              : isPaginated
                ? `Download Page ${currentPage + 1}`
                : 'Download All'
          }}
        </button>
        <button v-if="hasActiveDownloads" class="cancel-all-btn" @click="cancelAllDownloads">
          Cancel All
        </button>
      </div>

      <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>

      <EpisodeList :player-mode="playerMode" :translation-type="translationType" />
    </div>
    <CleanupModal
      v-if="cleanupModalOpen && anime"
      :anime-id="props.animeId"
      :anime-name="getAnimeName()"
      @closed="cleanupModalOpen = false"
      @deleted="onCleanupDeleted"
    />
  </main>
</template>

<style scoped>
.detail-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  padding: 12px 24px;
  border-bottom: 1px solid #0f3460;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: #e94560;
  font-size: 0.9rem;
  cursor: pointer;
  padding: 4px 0;
}

.back-btn:hover {
  color: #ff6b81;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.anime-header {
  display: flex;
  gap: 24px;
  margin-bottom: 24px;
}

.poster-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
}

.detail-poster {
  width: 200px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
}

.continue-btn {
  width: 200px;
  padding: 10px 14px;
  background: #e94560;
  border: none;
  border-radius: 8px;
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}

.continue-btn:hover:not(:disabled) {
  background: #d63651;
}

.continue-btn:disabled {
  background: #2a2a4a;
  color: #6a6a8a;
  cursor: not-allowed;
}

.library-btn {
  width: 200px;
  padding: 10px 14px;
  background: transparent;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  color: #a0a0c0;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.library-btn:hover {
  background: #16213e;
  border-color: #3a3a5e;
  color: #fbbf24;
}

.library-btn.active {
  color: #fbbf24;
  border-color: #fbbf24;
}

.cleanup-btn {
  width: 200px;
  padding: 10px 14px;
  background: transparent;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  color: #a0a0c0;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.cleanup-btn:hover {
  background: #16213e;
  border-color: #5a3a4e;
  color: #f0a070;
}

.anime-info {
  flex: 1;
  min-width: 0;
}

.anime-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: #e0e0e0;
  margin-bottom: 6px;
}

.offline-badge {
  display: inline-block;
  padding: 2px 8px;
  background-color: rgba(243, 156, 18, 0.15);
  border: 1px solid #f39c12;
  border-radius: 4px;
  color: #f39c12;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  margin-left: 10px;
  vertical-align: middle;
}

.anime-meta {
  color: #6a6a8a;
  font-size: 0.9rem;
  margin-bottom: 10px;
}

.genres {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.genre-tag {
  background-color: #0f3460;
  color: #a0a0b8;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 0.75rem;
}

.description {
  color: #8a8aa8;
  font-size: 0.85rem;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}

.controls {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.control-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.control-group label {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.select {
  padding: 8px 12px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 0.85rem;
  outline: none;
  min-width: 200px;
}

.select:focus {
  border-color: #e94560;
}

.download-btn {
  padding: 8px 20px;
  background-color: #6ab04c;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.download-btn:hover {
  background-color: #5a9a3c;
}

.download-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cancel-all-btn {
  padding: 8px 20px;
  background-color: #e94560;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.cancel-all-btn:hover {
  background-color: #d63851;
}

.error-banner {
  padding: 10px 16px;
  background-color: rgba(233, 69, 96, 0.15);
  border: 1px solid #e94560;
  border-radius: 8px;
  color: #e94560;
  font-size: 0.85rem;
  margin-bottom: 16px;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}
</style>
