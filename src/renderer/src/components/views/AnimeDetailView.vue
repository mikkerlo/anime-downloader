<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { getAnimeName as _getAnimeName } from '../../utils';
import CleanupModal from '../shared/CleanupModal.vue';
import { useLibraryStore } from '../../stores/library';
import { usePlayerStore } from '../../stores/player';
import { useShikimoriStore } from '../../stores/shikimori';
import { useDownloadsStore } from '../../stores/downloads';
import { useAnimeDetailPrefs } from '../../composables/use-anime-detail-prefs';
import { useChronology } from '../../composables/use-chronology';
import { provide } from 'vue';
import { useEpisodeList, PAGE_SIZE } from '../../composables/use-episode-list';
import { useEpisodeDownloads } from '../../composables/use-episode-downloads';
import { useShikimori } from '../../composables/use-shikimori';
import { useSkipDetection } from '../../composables/use-skip-detection';
import ChronologyPanel from '../detail/ChronologyPanel.vue';
import FriendsPanel from '../detail/FriendsPanel.vue';
import ShikimoriPanel from '../detail/ShikimoriPanel.vue';
import SkipDetectionPanel from '../detail/SkipDetectionPanel.vue';
import EpisodeList from '../detail/EpisodeList.vue';
import {
  ShikimoriKey,
  SkipDetectionKey,
  EpisodeListKey,
  EpisodeDownloadsKey
} from '../detail/keys';
import { TRANSLATION_TYPES } from '../detail/translation-types';

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

// The hero owns the synopsis + genres. Prefer the smotret-anime data and fall
// back to the Shikimori details so titles without a smotret description/genres
// still show them (the Shikimori panel no longer renders its own copy).
const SYNOPSIS_CLAMP = 320;
const synopsisExpanded = ref(false);

const synopsisText = computed<string>(() => {
  const local = anime.value?.descriptions?.[0]?.value?.trim();
  return local || shikimori.shikiDetailsDescription.value || '';
});

const genreTags = computed<{ key: string; label: string }[]>(() => {
  const local = anime.value?.genres;
  if (local?.length) return local.map((g) => ({ key: `a${g.id}`, label: g.title }));
  const shiki = shikimori.shikiDetails.value?.genres;
  if (shiki?.length) return shiki.map((g) => ({ key: `s${g.id}`, label: g.russian || g.name }));
  return [];
});
</script>

<template>
  <main class="detail-view">
    <div v-if="loading" class="status-text">Loading…</div>

    <div v-else-if="anime" class="body">
      <div class="detail-hero">
        <div class="detail-backdrop">
          <div class="bd-fill" :style="{ backgroundImage: `url(${posterSrc})` }"></div>
        </div>
        <div class="detail-top">
          <div class="detail-poster">
            <img :src="posterSrc" :alt="anime.title" @error="onPosterError" />
          </div>
          <div class="detail-meta">
            <button class="btn btn-ghost btn-sm back-btn" @click="libraryStore.closeAnime()">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                width="15"
                height="15"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
                />
              </svg>
              Back
            </button>
            <h1>{{ getAnimeName() }}</h1>
            <div v-if="anime.titles?.romaji || anime.titles?.ja" class="detail-romaji">
              {{ anime.titles.romaji || anime.titles.ja }}
            </div>
            <div class="detail-tags">
              <span v-if="isOffline" class="chip offline">OFFLINE</span>
              <span v-if="anime.typeTitle" class="chip neutral">{{ anime.typeTitle }}</span>
              <span v-for="g in genreTags" :key="g.key" class="chip outline">{{ g.label }}</span>
            </div>
            <div class="detail-facts">
              <div v-if="anime.year" class="fact">
                <span class="f-label">Year</span><span class="f-value">{{ anime.year }}</span>
              </div>
              <div v-if="anime.numberOfEpisodes" class="fact">
                <span class="f-label">Episodes</span
                ><span class="f-value">{{ anime.numberOfEpisodes }}</span>
              </div>
              <div v-if="anime.season" class="fact">
                <span class="f-label">Season</span
                ><span class="f-value" style="font-family: var(--font-ui)">{{
                  anime.season
                }}</span>
              </div>
            </div>
            <template v-if="synopsisText">
              <p class="detail-synopsis" :class="{ clamped: !synopsisExpanded }">
                {{ synopsisText }}
              </p>
              <button
                v-if="synopsisText.length > SYNOPSIS_CLAMP"
                type="button"
                class="synopsis-toggle"
                @click="synopsisExpanded = !synopsisExpanded"
              >
                {{ synopsisExpanded ? 'Show less' : 'Show more' }}
              </button>
            </template>
            <div class="detail-actions">
              <button
                class="btn btn-primary"
                :disabled="!continueReady"
                :title="continueReady ? 'Continue watching' : 'Loading…'"
                @click="continueWatching"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M8 5v14l11-7z" />
                </svg>
                {{ continueLabel }}
              </button>
              <button class="btn btn-outline" :class="{ active: isStarred }" @click="toggleStar">
                <svg
                  viewBox="0 0 24 24"
                  :fill="isStarred ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="1.5"
                  width="16"
                  height="16"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
                  />
                </svg>
                {{ isStarred ? 'In library' : 'Add to library' }}
              </button>
              <button
                v-if="canAutoDl || autoDlSubscription"
                class="btn"
                :class="autoDlSubscription ? 'btn-primary' : 'btn-outline'"
                :disabled="autoDlSaving || (!canAutoDl && !autoDlSubscription)"
                :title="autoDlTooltip"
                @click="toggleAutoDl"
              >
                <svg
                  viewBox="0 0 24 24"
                  :fill="autoDlSubscription ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="1.5"
                  width="16"
                  height="16"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M19.5 12c0 4.142-3.358 7.5-7.5 7.5S4.5 16.142 4.5 12 7.858 4.5 12 4.5c1.747 0 3.354.6 4.625 1.604M19.5 4.5v3.75h-3.75"
                  />
                </svg>
                {{ autoDlSubscription ? 'Auto-download on' : 'Auto-download' }}
              </button>
              <button v-if="isDownloaded" class="btn btn-ghost" @click="cleanupModalOpen = true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  width="16"
                  height="16"
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
            <div v-if="autoDlSubscription" class="autodl-note">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                <path
                  d="M19.5 12c0 4.142-3.358 7.5-7.5 7.5S4.5 16.142 4.5 12 7.858 4.5 12 4.5c1.747 0 3.354.6 4.625 1.604M19.5 4.5v3.75h-3.75"
                />
              </svg>
              <span>{{ autoDlTooltip }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="detail-cols">
        <div class="ep-section">
          <div class="ep-toolbar">
            <div>
              <span class="select-label">Translation type</span>
              <div class="select-wrap">
                <select v-model="translationType">
                  <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">
                    {{ t.label }} ({{ translationTypeCounts.get(t.value) || 0 }}/{{
                      filteredEpisodes.length
                    }})
                  </option>
                </select>
                <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </div>
            <div>
              <span class="select-label">Author</span>
              <div class="select-wrap">
                <select v-model="selectedAuthor">
                  <option v-for="[author, count] in availableAuthors" :key="author" :value="author">
                    {{ author }} ({{ count }}/{{ filteredEpisodes.length }})
                  </option>
                </select>
                <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </div>
            <div class="grow"></div>
            <button
              class="btn btn-primary"
              @click="downloadAll"
              :disabled="episodeRows.every((r) => !r.selectedTr) || downloading"
            >
              {{
                downloading
                  ? 'Enqueuing…'
                  : isPaginated
                    ? `Download page ${currentPage + 1}`
                    : 'Download all'
              }}
            </button>
            <button v-if="hasActiveDownloads" class="btn btn-outline danger" @click="cancelAllDownloads">
              Cancel all
            </button>
          </div>

          <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>

          <div class="section-head">
            <h3>Episodes</h3>
            <span class="muted">{{ filteredEpisodes.length }} total</span>
          </div>

          <EpisodeList
            :player-mode="playerMode"
            :translation-type="translationType"
            :poster-url="posterSrc"
          />

          <SkipDetectionPanel :filtered-episodes="filteredEpisodes" />
        </div>

        <aside class="detail-side">
          <ShikimoriPanel
            v-if="anime.myAnimeListId && (shikiUser || !shikiUserChecked)"
            :anime="anime"
          />

          <FriendsPanel
            v-if="anime.myAnimeListId && (shikiUser || !shikiUserChecked)"
            v-model:collapsed="friendsCollapsed"
            :friends-rates="friendsRates"
            :friends-loading="friendsLoading"
            :number-of-episodes="anime.numberOfEpisodes"
          />

          <ChronologyPanel
            v-if="anime.myAnimeListId && (relatedLoading || shikiRelated.length > 0)"
            v-model:collapsed="relatedCollapsed"
            :shiki-related="shikiRelated"
            :related-loading="relatedLoading"
          />
        </aside>
      </div>
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
  min-width: 0;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 0 0 48px;
}

/* hero */
.detail-hero {
  position: relative;
  padding: 0 var(--pad-x);
}

.detail-backdrop {
  position: absolute;
  inset: 0 0 auto 0;
  height: 320px;
  overflow: hidden;
}

.detail-backdrop .bd-fill {
  position: absolute;
  inset: -40px;
  background-size: cover;
  background-position: center;
  filter: saturate(0.9) blur(34px);
  opacity: 0.55;
}

.detail-backdrop::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--hero-overlay);
}

.detail-top {
  position: relative;
  display: flex;
  gap: 28px;
  padding-top: 40px;
  align-items: flex-start;
}

.detail-poster {
  width: 196px;
  min-width: 196px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-card);
}

.detail-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.detail-meta {
  flex: 1;
  min-width: 0;
  padding-top: 8px;
}

.back-btn {
  margin-bottom: 14px;
}

.detail-meta h1 {
  font-family: var(--font-display);
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.08;
}

.detail-romaji {
  color: var(--text-3);
  font-size: 0.95rem;
  margin-top: 6px;
}

.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.detail-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
  margin-top: 18px;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fact .f-label {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.fact .f-value {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text);
  font-family: var(--font-data);
}

.detail-synopsis {
  margin-top: 18px;
  max-width: 720px;
  color: var(--text-2);
  font-size: 0.95rem;
  line-height: 1.6;
  white-space: pre-line;
}

.detail-synopsis.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.synopsis-toggle {
  margin-top: 8px;
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
}

.synopsis-toggle:hover {
  text-decoration: underline;
}

.detail-actions {
  display: flex;
  gap: 10px;
  margin-top: 22px;
  flex-wrap: wrap;
}

.autodl-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 14px;
  max-width: 640px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-btn);
  font-size: 0.82rem;
  color: var(--text-2);
  line-height: 1.45;
}

.autodl-note svg {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}

/* chips */
.chip {
  display: inline-flex;
  align-items: center;
  font-size: 0.74rem;
  font-weight: 600;
  padding: 3px 11px;
  border-radius: var(--radius-chip);
  line-height: 1.4;
}

.chip.neutral {
  background: var(--surface-3);
  color: var(--text-2);
}

.chip.outline {
  background: none;
  border: 1px solid var(--border-strong);
  color: var(--text-3);
}

.chip.offline {
  background: color-mix(in srgb, var(--st-orange) 16%, transparent);
  color: var(--st-orange);
  font-weight: 800;
  letter-spacing: 0.06em;
}

/* buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--radius-btn);
  border: 1px solid transparent;
  font-family: inherit;
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s var(--ease);
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-sm {
  padding: 6px 11px;
  font-size: 0.8rem;
}

.btn-primary {
  background: var(--accent);
  color: var(--accent-ink);
  border-color: var(--accent);
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.btn-ghost {
  background: var(--surface);
  color: var(--text-2);
  border-color: var(--border);
}

.btn-ghost:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}

.btn-outline {
  background: none;
  color: var(--text-2);
  border-color: var(--border-strong);
}

.btn-outline:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.btn-outline.active {
  color: var(--accent);
  border-color: var(--accent-line);
}

.btn-outline.danger:hover:not(:disabled) {
  color: var(--st-red);
  border-color: var(--st-red);
}

/* columns */
.detail-cols {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 304px;
  gap: 28px;
  padding: 32px var(--pad-x) 0;
  align-items: start;
}

@media (max-width: 1100px) {
  .detail-cols {
    grid-template-columns: 1fr;
  }
}

.ep-section {
  min-width: 0;
}

.detail-side {
  min-width: 0;
}

/* episode toolbar */
.ep-toolbar {
  display: flex;
  align-items: flex-end;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.ep-toolbar .grow {
  flex: 1;
}

.select-label {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  display: block;
  margin-bottom: 6px;
}

.select-wrap select {
  min-width: 200px;
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}

.section-head h3 {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
}

.section-head .muted {
  font-size: 0.82rem;
  color: var(--text-3);
  font-family: var(--font-data);
}

.error-banner {
  padding: 10px 16px;
  background: color-mix(in srgb, var(--st-red) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--st-red) 38%, transparent);
  border-radius: var(--radius-btn);
  color: var(--st-red);
  font-size: 0.85rem;
  margin-bottom: 16px;
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1.05rem;
  padding-top: 100px;
}
</style>
