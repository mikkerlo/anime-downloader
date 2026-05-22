<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { formatSpeed, formatEta, getAnimeName as _getAnimeName } from '../utils';
import CleanupModal from './CleanupModal.vue';
import { useLibraryStore } from '../stores/library';
import { usePlayerStore } from '../stores/player';
import { useShikimoriStore } from '../stores/shikimori';
import { useDownloadsStore } from '../stores/downloads';
import { storeToRefs } from 'pinia';
import { useAnimeDetailPrefs } from '../composables/use-anime-detail-prefs';
import { useChronology } from '../composables/use-chronology';
import { useEpisodeList, PAGE_SIZE } from '../composables/use-episode-list';
import { useEpisodeDownloads } from '../composables/use-episode-downloads';
import ChronologyPanel from './detail/ChronologyPanel.vue';
import FriendsPanel from './detail/FriendsPanel.vue';

const props = defineProps<{
  animeId: number;
  initialPrefs?: { translationType?: string; author?: string };
  focusEpisodeInt?: string;
}>();

const libraryStore = useLibraryStore();
const playerStore = usePlayerStore();
const shikimoriStore = useShikimoriStore();
const downloadsStore = useDownloadsStore();
const { syncStatus, offlineQueueLength } = storeToRefs(shikimoriStore);

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

const {
  episodes,
  currentPage,
  focusApplied,
  loadingEpisodes,
  filteredEpisodes,
  episodeRows,
  totalPages,
  isPaginated,
  translationTypeCounts,
  availableAuthors,
  getRealHeight,
  qualityLabel,
  goToPage,
  loadPageEpisodes,
  probeSelectedQualities,
  onEpisodeTranslationChange,
  applyFocusEpisode,
  resetEpisodeOverrides
} = episodeList;

// Shikimori state
const shikiUser = ref<ShikiUser | null>(null);
const shikiRate = ref<ShikiUserRate | null>(null);
const shikiStatus = ref<ShikiUserRateStatus>('planned');
const shikiEpisodes = ref(0);
const shikiScore = ref(0);
const shikiRewatches = ref(0);
const shikiLoading = ref(false);
const shikiSaving = ref(false);
const shikiError = ref('');
// syncState + lastSyncError are projections of `shikimoriStore.syncStatus`.
const syncState = computed(() => syncStatus.value.state);
const lastSyncError = computed(() => syncStatus.value.lastSyncError);

// Friends state
const friendsRates = ref<ShikiFriendRate[]>([]);
const friendsLoading = ref(false);
const friendsCollapsed = ref(false);
const shikiUserChecked = ref(false);

// Shikimori detailed info (description / genres) — cached in main process
const shikiDetails = ref<ShikiAnimeDetails | null>(null);
const descExpanded = ref(false);

// Skip detection (Chromaprint local fingerprinting — debug panel only for now)
const skipPanelCollapsed = ref(true);
const skipDetections = ref<ShowSkipDetections | null>(null);
const skipAnalyzing = ref(false);
const skipProgress = ref<SkipDetectorProgress | null>(null);
const skipError = ref<string>('');
const chapterInjecting = ref(false);
const chapterInjectProgress = ref<ChapterInjectProgress | null>(null);
const chapterInjectError = ref<string>('');
const chapterInjectResult = ref<{
  written: number;
  skipped: number;
  failed: number;
  total: number;
} | null>(null);

const shikiDetailsDescription = computed<string>(() => {
  if (!shikiDetails.value) return '';
  const src = shikiDetails.value.description;
  if (src) {
    return src
      .replace(/\[\/?[a-zA-Z][^\]]*\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const html = shikiDetails.value.description_html;
  if (!html) return '';
  let stripped = html.replace(/<br\s*\/?>/gi, ' ');
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== prev);
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&nbsp;': ' ',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'"
  };
  return stripped
    .replace(/&(?:amp|nbsp|lt|gt|quot|#39);/gi, (m) => entities[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
});

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

const {
  downloading,
  errorMessage,
  continueReady,
  continueLabel,
  hasActiveDownloads,
  episodeProgressPercent,
  isEpisodeWatched,
  getFileForTranslation,
  hasAnyFile,
  selectedTrHasFile,
  dlProgress,
  getGroup,
  loadWatchProgress,
  checkFileStatus,
  updateDownloadGroups,
  downloadAll,
  downloadEpisode,
  cancelEpisodeDownload,
  cancelAllDownloads,
  openFile,
  playStream,
  showInFolder,
  deleteFile,
  continueWatching,
  subscribeFileEpisodesChanged
} = downloads;

const TRANSLATION_TYPES = [
  { value: 'subRu', label: 'Russian Subtitles', short: 'RU SUB', color: '#6ab04c' },
  { value: 'subEn', label: 'English Subtitles', short: 'EN SUB', color: '#3498db' },
  { value: 'voiceRu', label: 'Russian Voice', short: 'RU DUB', color: '#e94560' },
  { value: 'voiceEn', label: 'English Voice', short: 'EN DUB', color: '#9b59b6' },
  { value: 'raw', label: 'RAW', short: 'RAW', color: '#6a6a8a' }
];

function onMouseBack(e: MouseEvent): void {
  if (e.button === 3) {
    e.preventDefault();
    libraryStore.closeAnime();
  }
}

async function loadShikimoriData(): Promise<void> {
  try {
    shikiUser.value = await window.api.shikimoriGetUser();
  } catch (err) {
    console.error('Failed to load Shikimori user:', err);
  } finally {
    shikiUserChecked.value = true;
  }
  if (!anime.value?.myAnimeListId) return;

  const relatedPromise = chronology.loadRelated(anime.value.myAnimeListId);

  if (!shikiUser.value) {
    await relatedPromise;
    return;
  }

  shikiLoading.value = true;
  friendsLoading.value = true;

  // Load rate and friends in parallel, neither blocks the other
  const ratePromise = window.api
    .shikimoriGetRate(anime.value.myAnimeListId)
    .then((rate) => {
      shikiRate.value = rate;
      if (rate) {
        shikiStatus.value = rate.status;
        shikiEpisodes.value = rate.episodes;
        shikiScore.value = rate.score;
        shikiRewatches.value = rate.rewatches ?? 0;
      }
    })
    .catch((err) => console.error('Failed to load Shikimori rate:', err))
    .finally(() => {
      shikiLoading.value = false;
    });

  const friendsPromise = window.api
    .shikimoriGetFriendsRates(anime.value.myAnimeListId)
    .then((rates) => {
      friendsRates.value = rates;
    })
    .catch((err) => console.error('Failed to load friends rates:', err))
    .finally(() => {
      friendsLoading.value = false;
    });

  const detailsPromise = window.api
    .shikimoriGetAnimeDetails(anime.value.myAnimeListId)
    .then((details) => {
      shikiDetails.value = details;
    })
    .catch((err) => console.error('Failed to load Shikimori details:', err));

  await Promise.all([ratePromise, friendsPromise, detailsPromise, relatedPromise]);
}

// --- Skip Detection (debug) -------------------------------------------------

interface SkipEpisodeInput {
  episodeInt: string;
  episodeLabel: string;
  filePath: string;
}

const skipEpisodeInputs = computed<SkipEpisodeInput[]>(() => {
  const inputs: SkipEpisodeInput[] = [];
  const seen = new Set<string>();
  // Walk filteredEpisodes to keep an ordered, label-aware list. fileStatus is keyed by episodeInt.
  for (const ep of filteredEpisodes.value) {
    const files = fileStatus.value[ep.episodeInt];
    if (!files || files.length === 0) continue;
    // Prefer .mkv (merged) over .mp4 (raw); first match wins.
    const mkv = files.find((f) => f.type === 'mkv');
    const pick = mkv || files[0];
    if (!pick || !pick.filePath) continue;
    if (seen.has(ep.episodeInt)) continue;
    seen.add(ep.episodeInt);
    inputs.push({
      episodeInt: ep.episodeInt,
      episodeLabel: ep.episodeFull || `Episode ${ep.episodeInt}`,
      filePath: pick.filePath
    });
  }
  return inputs;
});

function formatSkipTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const skipProgressLabel = computed<string>(() => {
  const p = skipProgress.value;
  if (!p) return '';
  if (p.phase === 'fingerprinting') {
    const label = p.episodeLabel ? ` — ${p.episodeLabel}` : '';
    return `Fingerprinting ${p.current}/${p.total}${label}`;
  }
  if (p.phase === 'comparing') {
    return `Comparing pairs ${p.current}/${p.total}`;
  }
  return 'Done';
});

async function loadSkipDetections(): Promise<void> {
  try {
    const res = await window.api.skipDetectorGetDetections(props.animeId);
    skipDetections.value = res;
  } catch (err) {
    console.error('Failed to load skip detections:', err);
  }
}

// Recover the analyzing state if the user navigated away mid-analysis and
// came back. Without this, the panel would show idle even though main is
// still chewing on fingerprints — and a fresh "Analyze" click for this
// same animeId would dedupe onto the in-flight promise (good), while a
// click on a different anime's panel would now reject (also good).
async function hydrateSkipStatus(): Promise<void> {
  try {
    const status = await window.api.skipDetectorGetStatus();
    if (status && status.animeId === props.animeId) {
      skipAnalyzing.value = true;
      skipProgress.value = status.lastProgress;
    }
  } catch (err) {
    console.error('Failed to hydrate skip status:', err);
  }
}

async function runSkipAnalysis(): Promise<void> {
  if (skipAnalyzing.value) return;
  const inputs = skipEpisodeInputs.value;
  if (inputs.length < 2) {
    skipError.value = 'Need at least 2 downloaded episodes';
    return;
  }
  skipError.value = '';
  skipAnalyzing.value = true;
  skipProgress.value = {
    animeId: props.animeId,
    phase: 'fingerprinting',
    current: 0,
    total: inputs.length
  };
  try {
    const result = await window.api.skipDetectorAnalyzeShow(props.animeId, inputs);
    skipDetections.value = result;
  } catch (err) {
    skipError.value = err instanceof Error ? err.message : String(err);
  } finally {
    skipAnalyzing.value = false;
    skipProgress.value = null;
  }
}

async function cancelSkipAnalysis(): Promise<void> {
  try {
    await window.api.skipDetectorCancel();
  } catch (err) {
    console.error('Failed to cancel skip analysis:', err);
  }
}

const skipMkvEpisodeCount = computed<number>(
  () => skipEpisodeInputs.value.filter((e) => e.filePath.toLowerCase().endsWith('.mkv')).length
);

const chapterInjectProgressLabel = computed<string>(() => {
  const p = chapterInjectProgress.value;
  if (!p) return '';
  if (p.phase === 'analyzing') return 'Analyzing fingerprints…';
  if (p.phase === 'writing') {
    const label = p.episodeLabel ? ` — ${p.episodeLabel}` : '';
    return `Writing chapters ${p.current + 1}/${p.total}${label}`;
  }
  return 'Done';
});

async function injectChaptersToMkv(): Promise<void> {
  if (chapterInjecting.value) return;
  if (skipMkvEpisodeCount.value < 3) {
    chapterInjectError.value = 'Need at least 3 downloaded MKV episodes';
    return;
  }
  chapterInjectError.value = '';
  chapterInjectResult.value = null;
  chapterInjecting.value = true;
  chapterInjectProgress.value = {
    animeId: props.animeId,
    phase: 'writing',
    current: 0,
    total: skipMkvEpisodeCount.value
  };
  try {
    const res = await window.api.injectChapters(props.animeId, skipEpisodeInputs.value);
    chapterInjectResult.value = res;
  } catch (err) {
    chapterInjectError.value = err instanceof Error ? err.message : String(err);
  } finally {
    chapterInjecting.value = false;
    chapterInjectProgress.value = null;
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
  loadShikimoriData();

  // Load watch progress for episode indicators
  loadWatchProgress();
  window.addEventListener('watch-progress-updated', loadWatchProgress);

  // Hydrate the store-owned sync-status + offline-queue length on mount; later
  // updates arrive via the store's broadcasts.
  void shikimoriStore.refreshOfflineQueueLength();
  void shikimoriStore.refreshSyncStatus();

  // Skip-detector + chapter-inject progress are anime-specific, so they stay
  // as component-local subscriptions (filtered by props.animeId).
  unsubSkipDetectorProgress = window.api.onSkipDetectorProgress((data) => {
    if (data.animeId !== props.animeId) return;
    skipProgress.value = data;
    skipAnalyzing.value = data.phase !== 'done';
  });
  unsubSkipDetectorSignatureUpdated = window.api.onSkipDetectorSignatureUpdated((data) => {
    if (data.animeId !== props.animeId) return;
    loadSkipDetections();
  });
  unsubChapterInjectProgress = window.api.onChapterInjectProgress((data) => {
    if (data.animeId !== props.animeId) return;
    chapterInjectProgress.value = data;
    chapterInjecting.value = data.phase !== 'done';
  });
  loadSkipDetections();
  hydrateSkipStatus();
});

// Sync the editable shiki* refs whenever the store's rate cache for this
// anime's malId changes (broadcast-driven by the store).
watch(
  () => (anime.value?.myAnimeListId ? shikimoriStore.rateByMalId(anime.value.myAnimeListId) : null),
  (entry) => {
    if (!entry) return;
    shikiRate.value = {
      id: entry.rate.id,
      score: entry.rate.score,
      status: entry.rate.status,
      episodes: entry.rate.episodes,
      rewatches: entry.rate.rewatches ?? 0,
      target_id: entry.rate.target_id,
      target_type: 'Anime'
    };
    shikiStatus.value = entry.rate.status;
    shikiEpisodes.value = entry.rate.episodes;
    shikiScore.value = entry.rate.score;
    shikiRewatches.value = entry.rate.rewatches ?? 0;
  }
);

// Sync shikiDetails from the store's per-malId cache.
watch(
  () =>
    anime.value?.myAnimeListId
      ? shikimoriStore.animeDetailsByMalId(anime.value.myAnimeListId)
      : null,
  (details) => {
    if (details) shikiDetails.value = details;
  }
);

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

async function triggerSyncNow(): Promise<void> {
  await shikimoriStore.triggerSync();
}

const SHIKI_STATUSES: { value: ShikiUserRateStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'watching', label: 'Watching' },
  { value: 'rewatching', label: 'Rewatching' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'dropped', label: 'Dropped' }
];

watch(shikiEpisodes, (eps) => {
  if (anime.value?.numberOfEpisodes && eps >= anime.value.numberOfEpisodes) {
    shikiStatus.value = 'completed';
  } else if (eps > 0) {
    if (shikiStatus.value === 'completed') {
      shikiStatus.value = 'rewatching';
    } else if (shikiStatus.value === 'planned') {
      shikiStatus.value = 'watching';
    }
  }
});

async function shikiSave(): Promise<void> {
  if (!anime.value?.myAnimeListId) return;
  shikiSaving.value = true;
  shikiError.value = '';
  try {
    const rate = await window.api.shikimoriUpdateRate(
      anime.value.myAnimeListId,
      shikiEpisodes.value,
      shikiStatus.value,
      shikiScore.value,
      shikiRewatches.value
    );
    shikiRate.value = rate;
    shikiRewatches.value = rate.rewatches ?? shikiRewatches.value;
  } catch (err) {
    shikiError.value = String(err);
  } finally {
    shikiSaving.value = false;
  }
}

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
  const status = shikiDetails.value?.status;
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

function translationTypeLabel(type: string): string {
  const t = TRANSLATION_TYPES.find((tt) => tt.value === type);
  return t ? t.label : type;
}

function typeChip(type: string): { short: string; color: string } {
  const t = TRANSLATION_TYPES.find((tt) => tt.value === type);
  return t ? { short: t.short, color: t.color } : { short: type, color: '#6a6a8a' };
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

      <div v-if="anime.myAnimeListId && (shikiUser || !shikiUserChecked)" class="shiki-panel">
        <template v-if="shikiUser">
          <div class="shiki-header">
            <span class="shiki-label">Shikimori</span>
            <a
              :href="`https://shikimori.one/animes/${anime.myAnimeListId}`"
              target="_blank"
              class="shiki-link"
            >
              Open on Shikimori
            </a>
          </div>
          <div v-if="shikiLoading" class="shiki-loading">Loading...</div>
          <div v-else class="shiki-controls">
            <select v-model="shikiStatus" class="select shiki-select">
              <option v-for="s in SHIKI_STATUSES" :key="s.value" :value="s.value">
                {{ s.label }}
              </option>
            </select>
            <div class="shiki-episodes">
              <span>Episodes:</span>
              <input
                v-model.number="shikiEpisodes"
                type="number"
                min="0"
                :max="anime.numberOfEpisodes || undefined"
                class="shiki-ep-input"
              />
              <span v-if="anime.numberOfEpisodes" class="shiki-ep-total"
                >/ {{ anime.numberOfEpisodes }}</span
              >
            </div>
            <div class="shiki-episodes">
              <span>Score:</span>
              <select v-model.number="shikiScore" class="select shiki-score-select">
                <option :value="0">—</option>
                <option v-for="n in 10" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div class="shiki-episodes" title="Number of times you've rewatched this anime">
              <span>Rewatches:</span>
              <input v-model.number="shikiRewatches" type="number" min="0" class="shiki-ep-input" />
            </div>
            <button class="shiki-save-btn" :disabled="shikiSaving" @click="shikiSave">
              {{ shikiSaving ? 'Saving...' : 'Save' }}
            </button>
          </div>
          <div v-if="shikiError" class="shiki-error">{{ shikiError }}</div>
          <div
            v-if="offlineQueueLength > 0"
            class="shiki-offline"
            :class="{ 'shiki-syncing': syncState === 'syncing' }"
            :title="lastSyncError || ''"
          >
            <svg
              v-if="syncState === 'syncing'"
              class="shiki-offline-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="14"
              height="14"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-6.219-8.56" />
            </svg>
            <svg
              v-else
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="14"
              height="14"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M3 3l18 18M12 5a7 7 0 016.95 6.155A4 4 0 0118 19H9m-3-2a4 4 0 01-1.9-7.516"
              />
            </svg>
            <span v-if="syncState === 'syncing'">
              Syncing {{ offlineQueueLength }} change{{ offlineQueueLength > 1 ? 's' : '' }}…
            </span>
            <span v-else>
              Working offline — {{ offlineQueueLength }} change{{
                offlineQueueLength > 1 ? 's' : ''
              }}
              queued
            </span>
            <button
              v-if="syncState === 'idle'"
              type="button"
              class="shiki-offline-retry"
              @click="triggerSyncNow"
            >
              Retry now
            </button>
          </div>
          <div v-if="shikiDetails" class="shiki-details">
            <div v-if="shikiDetails.genres?.length" class="shiki-genres">
              <span v-for="g in shikiDetails.genres" :key="g.id" class="shiki-genre-tag">
                {{ g.russian || g.name }}
              </span>
            </div>
            <p
              v-if="shikiDetailsDescription"
              class="shiki-description"
              :class="{ collapsed: !descExpanded }"
            >
              {{ shikiDetailsDescription }}
            </p>
            <button
              v-if="shikiDetailsDescription && shikiDetailsDescription.length > 320"
              type="button"
              class="shiki-desc-toggle"
              @click="descExpanded = !descExpanded"
            >
              {{ descExpanded ? 'Show less' : 'Show more' }}
            </button>
          </div>
        </template>
        <div v-else class="shiki-loading">Loading...</div>
      </div>

      <ChronologyPanel
        v-if="anime.myAnimeListId && (relatedLoading || shikiRelated.length > 0)"
        v-model:collapsed="relatedCollapsed"
        :shiki-related="shikiRelated"
        :related-loading="relatedLoading"
      />

      <div class="skip-panel">
        <div class="skip-header" @click="skipPanelCollapsed = !skipPanelCollapsed">
          <div class="skip-header-left">
            <svg
              class="skip-chevron"
              :class="{ collapsed: skipPanelCollapsed }"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="14"
              height="14"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
            </svg>
            <span class="skip-label">Skip Detection (experimental)</span>
          </div>
          <span v-if="skipAnalyzing" class="skip-summary">{{ skipProgressLabel }}</span>
          <span v-else-if="skipDetections" class="skip-summary">
            {{ Object.keys(skipDetections.perEpisode).length }} episodes analyzed
          </span>
          <span v-else class="skip-summary">{{ skipEpisodeInputs.length }} downloaded</span>
        </div>
        <div v-if="!skipPanelCollapsed" class="skip-body">
          <div v-if="skipEpisodeInputs.length < 2" class="skip-disabled">
            Need at least 2 downloaded episodes to analyze. Currently downloaded:
            {{ skipEpisodeInputs.length }}.
          </div>
          <template v-else>
            <div class="skip-actions">
              <button v-if="!skipAnalyzing" class="skip-button" @click="runSkipAnalysis">
                {{ skipDetections ? 'Re-analyze' : `Analyze ${skipEpisodeInputs.length} episodes` }}
              </button>
              <button v-else class="skip-button skip-button-cancel" @click="cancelSkipAnalysis">
                Cancel
              </button>
              <span v-if="skipAnalyzing" class="skip-progress-text">{{ skipProgressLabel }}</span>
              <button
                v-if="skipMkvEpisodeCount >= 3"
                class="skip-button"
                :disabled="chapterInjecting || skipAnalyzing"
                @click="injectChaptersToMkv"
              >
                {{ chapterInjecting ? 'Saving chapters…' : 'Save chapters to MKV' }}
              </button>
              <span v-if="chapterInjecting" class="skip-progress-text">{{
                chapterInjectProgressLabel
              }}</span>
            </div>
            <div v-if="skipError" class="skip-error">{{ skipError }}</div>
            <div v-if="chapterInjectError" class="skip-error">{{ chapterInjectError }}</div>
            <div v-if="chapterInjectResult" class="skip-results-meta">
              Wrote chapters to {{ chapterInjectResult.written }}/{{ chapterInjectResult.total }}
              episodes
              <template v-if="chapterInjectResult.skipped">
                · {{ chapterInjectResult.skipped }} skipped (no detection)
              </template>
              <template v-if="chapterInjectResult.failed">
                · {{ chapterInjectResult.failed }} failed
              </template>
            </div>
            <div v-if="skipDetections" class="skip-results">
              <div class="skip-results-meta">
                Analyzed {{ new Date(skipDetections.analyzedAt).toLocaleString() }} · window
                {{ skipDetections.algorithm.windowSec }}s · min run
                {{ skipDetections.algorithm.minRunSec }}s · threshold
                {{ skipDetections.algorithm.matchBitThreshold }}/32 bits
              </div>
              <table class="skip-table">
                <thead>
                  <tr>
                    <th>Episode</th>
                    <th>OP</th>
                    <th>ED</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="ep in filteredEpisodes" :key="ep.episodeInt">
                    <template v-if="skipDetections.perEpisode[ep.episodeInt]">
                      <td>{{ ep.episodeFull || `Episode ${ep.episodeInt}` }}</td>
                      <td>
                        <template v-if="skipDetections.perEpisode[ep.episodeInt].op">
                          {{
                            formatSkipTime(skipDetections.perEpisode[ep.episodeInt].op!.startSec)
                          }}–{{
                            formatSkipTime(skipDetections.perEpisode[ep.episodeInt].op!.endSec)
                          }}
                          <span class="skip-pair-count"
                            >({{
                              skipDetections.perEpisode[ep.episodeInt].op!.pairCount
                            }}
                            pairs)</span
                          >
                        </template>
                        <span v-else class="skip-empty">—</span>
                      </td>
                      <td>
                        <template v-if="skipDetections.perEpisode[ep.episodeInt].ed">
                          {{
                            formatSkipTime(skipDetections.perEpisode[ep.episodeInt].ed!.startSec)
                          }}–{{
                            formatSkipTime(skipDetections.perEpisode[ep.episodeInt].ed!.endSec)
                          }}
                          <span class="skip-pair-count"
                            >({{
                              skipDetections.perEpisode[ep.episodeInt].ed!.pairCount
                            }}
                            pairs)</span
                          >
                        </template>
                        <span v-else class="skip-empty">—</span>
                      </td>
                      <td>
                        {{ formatSkipTime(skipDetections.perEpisode[ep.episodeInt].durationSec) }}
                      </td>
                    </template>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>

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

      <div v-if="loadingEpisodes" class="status-text">Loading episodes...</div>

      <div v-if="isPaginated" class="pagination">
        <button class="page-btn" :disabled="currentPage === 0" @click="goToPage(currentPage - 1)">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="14"
            height="14"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          v-for="p in totalPages"
          :key="p - 1"
          class="page-btn"
          :class="{ active: currentPage === p - 1 }"
          @click="goToPage(p - 1)"
        >
          {{ p }}
        </button>
        <button
          class="page-btn"
          :disabled="currentPage === totalPages - 1"
          @click="goToPage(currentPage + 1)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="14"
            height="14"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <span class="page-info">{{ filteredEpisodes.length }} episodes</span>
      </div>

      <div class="episode-list">
        <div
          v-for="row in episodeRows"
          :key="row.episode.id"
          :data-ep-int="row.episode.episodeInt"
          class="episode-row"
        >
          <span class="ep-name">{{ row.episode.episodeFull }}</span>
          <template v-if="row.isLocked">
            <span class="ep-author locked">
              {{ row.selectedTr?.authorsSummary || 'Unknown' }}
              <span class="lock-label">Queued</span>
            </span>
          </template>
          <template v-else-if="row.allTranslations.length > 0">
            <select
              class="ep-select"
              :value="row.selectedTr?.id || ''"
              @change="
                onEpisodeTranslationChange(
                  row.episode.id,
                  row.episode.episodeInt,
                  Number(($event.target as HTMLSelectElement).value)
                )
              "
            >
              <!-- Show selected type first, then the rest -->
              <template
                v-for="type in [
                  TRANSLATION_TYPES.find((t) => t.value === translationType)!,
                  ...TRANSLATION_TYPES.filter((t) => t.value !== translationType)
                ]"
                :key="type.value"
              >
                <optgroup
                  v-if="row.allTranslations.some((tr) => tr.type === type.value)"
                  :label="type.label"
                >
                  <option
                    v-for="tr in row.allTranslations
                      .filter((t) => t.type === type.value)
                      .sort((a, b) => getRealHeight(b) - getRealHeight(a))"
                    :key="tr.id"
                    :value="tr.id"
                  >
                    {{ row.downloadedTrIds.has(tr.id) ? '⬇ ' : '' }}{{ tr.authorsSummary }} ({{
                      qualityLabel(getRealHeight(tr))
                    }})
                  </option>
                </optgroup>
              </template>
            </select>
          </template>
          <span v-else class="ep-missing">No translation</span>
          <!-- Download / merge status -->
          <div
            v-if="getGroup(row.episode.episodeFull)?.mergeStatus === 'merging'"
            class="ep-dl-status merging"
          >
            Merging
            {{
              getGroup(row.episode.episodeFull)?.mergePercent != null
                ? getGroup(row.episode.episodeFull)?.mergePercent + '%'
                : '...'
            }}
          </div>
          <div
            v-else-if="getGroup(row.episode.episodeFull)?.mergeStatus === 'failed'"
            class="ep-dl-status merge-failed"
          >
            Merge failed
          </div>
          <div
            v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'downloading'"
            class="ep-dl-status"
          >
            <div class="ep-progress-wrap">
              <div
                class="ep-progress-bar"
                :style="{ width: dlProgress(getGroup(row.episode.episodeFull)!.video) + '%' }"
              ></div>
            </div>
            <span class="ep-dl-text">{{
              formatSpeed(getGroup(row.episode.episodeFull)!.video!.speed)
            }}</span>
            <span class="ep-dl-text"
              >ETA {{ formatEta(getGroup(row.episode.episodeFull)!.video!) }}</span
            >
          </div>
          <div
            v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'queued'"
            class="ep-dl-status queued"
          >
            Queued
          </div>
          <div
            v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'paused'"
            class="ep-dl-status paused"
          >
            Paused ({{ Math.round(dlProgress(getGroup(row.episode.episodeFull)!.video)) }}%)
          </div>
          <div
            v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'failed'"
            class="ep-dl-status failed"
          >
            Failed
          </div>
          <div class="ep-right">
            <span
              v-if="isEpisodeWatched(row.episode.episodeInt)"
              class="watched-badge"
              title="Watched"
              >✓</span
            >
            <span
              v-else-if="episodeProgressPercent(row.episode.episodeInt) > 0"
              class="watch-progress-badge"
              :title="`Watched ${episodeProgressPercent(row.episode.episodeInt)}%`"
            >
              {{ episodeProgressPercent(row.episode.episodeInt) }}%
            </span>
            <span
              v-if="row.selectedTr"
              class="type-chip"
              :style="{
                backgroundColor: typeChip(row.selectedTr.type).color + '22',
                color: typeChip(row.selectedTr.type).color
              }"
              >{{ typeChip(row.selectedTr.type).short }}</span
            >
            <span
              v-if="row.selectedTr"
              class="quality-badge"
              :class="{ hd: getRealHeight(row.selectedTr) >= 1080 }"
              >{{ qualityLabel(getRealHeight(row.selectedTr)) }}</span
            >
            <template v-if="selectedTrHasFile(row)">
              <span class="file-type-badge">{{
                getFileForTranslation(
                  row.episode.episodeInt,
                  row.selectedTr?.id
                )?.type.toUpperCase()
              }}</span>
            </template>
            <template v-else-if="hasAnyFile(row.episode.episodeInt)">
              <span class="file-type-badge other-dl">⬇</span>
            </template>
          </div>
          <div class="ep-links">
            <template v-if="selectedTrHasFile(row)">
              <button class="link-btn open" @click="openFile(row)" title="Open file">Open</button>
              <button class="link-btn folder" @click="showInFolder(row)" title="Show in folder">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  width="14"
                  height="14"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M2 7.5V18a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-6.5l-2-2.5H4a2 2 0 00-2 2z"
                  />
                </svg>
              </button>
              <button class="link-btn delete" @click="deleteFile(row)" title="Delete file">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  width="14"
                  height="14"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </template>
            <button
              v-if="
                getGroup(row.episode.episodeFull) &&
                (!['completed', 'cancelled'].includes(
                  getGroup(row.episode.episodeFull)?.video?.status || ''
                ) ||
                  getGroup(row.episode.episodeFull)?.mergeStatus === 'merging')
              "
              class="link-btn cancel"
              @click="cancelEpisodeDownload(row.episode.episodeFull)"
              title="Cancel"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                width="14"
                height="14"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <button
              v-if="playerMode === 'builtin' && row.selectedTr && !selectedTrHasFile(row)"
              class="link-btn play"
              @click="playStream(row)"
              title="Play (stream)"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
            <button
              v-if="row.selectedTr && !row.isLocked && !selectedTrHasFile(row)"
              class="link-btn dl"
              @click="downloadEpisode(row)"
              title="Download this episode"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                width="14"
                height="14"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M2 19.5h20M12 2v14m0 0l-4-4m4 4l4-4"
                />
              </svg>
            </button>
          </div>
        </div>
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

.pagination {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
}

.page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #a0a0b8;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}

.page-btn:hover:not(:disabled) {
  border-color: #e94560;
  color: #e0e0e0;
}

.page-btn.active {
  background-color: #e94560;
  border-color: #e94560;
  color: white;
}

.page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.page-info {
  margin-left: 8px;
  color: #6a6a8a;
  font-size: 0.8rem;
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

.episode-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.episode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  background-color: #16213e;
  border-radius: 6px;
}

.ep-name {
  font-size: 0.9rem;
  color: #e0e0e0;
  min-width: 100px;
}

.ep-author {
  flex: 1;
  font-size: 0.8rem;
  color: #6a6a8a;
}

.ep-author.locked {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lock-label {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 4px;
  background-color: #0f3460;
  color: #3498db;
  flex-shrink: 0;
  height: 20px;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.ep-select {
  padding: 4px 8px;
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.8rem;
  outline: none;
  min-width: 150px;
  max-width: 300px;
  flex: 1;
}

.ep-select:focus {
  border-color: #e94560;
}

.ep-missing {
  flex: 1;
  font-size: 0.8rem;
  color: #e94560;
  opacity: 0.6;
}

.ep-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}

.type-chip,
.quality-badge,
.file-type-badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 700;
  flex-shrink: 0;
  line-height: 1;
  height: 20px;
  display: inline-flex;
  align-items: center;
}

.type-chip {
  letter-spacing: 0.3px;
}

.watched-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background-color: rgba(106, 176, 76, 0.2);
  color: #6ab04c;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.watch-progress-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 4px;
  background-color: rgba(233, 69, 96, 0.15);
  color: #e94560;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  height: 20px;
  flex-shrink: 0;
}

.quality-badge {
  background-color: #0f3460;
  color: #6a6a8a;
}

.quality-badge.hd {
  background-color: #1a4a2e;
  color: #6ab04c;
}

.ep-links {
  display: flex;
  gap: 6px;
}

.link-btn {
  padding: 4px 12px;
  background-color: #0f3460;
  border-radius: 4px;
  color: #e94560;
  font-size: 0.75rem;
  text-decoration: none;
  font-weight: 600;
  transition: background-color 0.15s;
}

.link-btn:hover {
  background-color: #1a4a7a;
}

.link-btn.play {
  color: #e94560;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.dl {
  color: #3498db;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.open {
  color: #6ab04c;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.folder {
  color: #f0932b;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.link-btn.delete {
  color: #e94560;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.link-btn.cancel {
  color: #f39c12;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.meta-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 600;
  background-color: #0f3460;
  color: #6a6a8a;
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ep-dl-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  color: #3498db;
  min-width: 120px;
  flex-shrink: 0;
}

.ep-dl-status.queued {
  color: #6a6a8a;
}
.ep-dl-status.paused {
  color: #f39c12;
}
.ep-dl-status.failed {
  color: #e94560;
}
.ep-dl-status.merging {
  color: #f39c12;
  font-weight: 600;
}
.ep-dl-status.merge-failed {
  color: #e94560;
}

.ep-progress-wrap {
  flex: 1;
  height: 4px;
  background-color: #0f3460;
  border-radius: 2px;
  overflow: hidden;
  min-width: 50px;
}

.ep-progress-bar {
  height: 100%;
  background-color: #3498db;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.ep-dl-text {
  font-size: 0.65rem;
  color: #6a6a8a;
  white-space: nowrap;
}

.file-type-badge {
  background-color: #1a4a2e;
  color: #6ab04c;
}

.file-type-badge.other-dl {
  background-color: #0f3460;
  color: #3498db;
  font-size: 0.7rem;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}

.shiki-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.shiki-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.shiki-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.shiki-link {
  font-size: 0.8rem;
  color: #3498db;
  text-decoration: none;
}

.shiki-link:hover {
  text-decoration: underline;
}

.shiki-loading {
  font-size: 0.85rem;
  color: #6a6a8a;
}

.shiki-controls {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.shiki-select {
  min-width: 130px;
}

.shiki-episodes {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: #a0a0b8;
}

.shiki-ep-input {
  width: 60px;
  padding: 6px 8px;
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 0.85rem;
  text-align: center;
}

.shiki-ep-input:focus {
  outline: none;
  border-color: #e94560;
}

.shiki-ep-total {
  color: #6a6a8a;
}

.shiki-score-select {
  width: 60px;
}

.shiki-save-btn {
  padding: 6px 16px;
  background-color: #0f3460;
  border: none;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.shiki-save-btn:hover {
  background-color: #1a4a7a;
}

.shiki-save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.shiki-error {
  margin-top: 8px;
  font-size: 0.8rem;
  color: #e94560;
}

.shiki-offline {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 0.78rem;
  color: #f0a75f;
  background: rgba(240, 167, 95, 0.12);
  border: 1px solid rgba(240, 167, 95, 0.3);
  border-radius: 4px;
}

.shiki-offline.shiki-syncing {
  color: #5e9cd8;
  background: rgba(94, 156, 216, 0.12);
  border-color: rgba(94, 156, 216, 0.3);
}

.shiki-offline-spin {
  animation: shiki-offline-rotate 0.9s linear infinite;
}

@keyframes shiki-offline-rotate {
  to {
    transform: rotate(360deg);
  }
}

.shiki-offline-retry {
  margin-left: 4px;
  padding: 2px 8px;
  font-size: 0.72rem;
  color: #f0a75f;
  background: transparent;
  border: 1px solid rgba(240, 167, 95, 0.5);
  border-radius: 3px;
  cursor: pointer;
}

.shiki-offline-retry:hover {
  background: rgba(240, 167, 95, 0.15);
}

.shiki-details {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(15, 52, 96, 0.6);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shiki-genres {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.shiki-genre-tag {
  font-size: 0.72rem;
  color: #cdd6e4;
  background: rgba(15, 52, 96, 0.5);
  border: 1px solid rgba(94, 156, 216, 0.25);
  border-radius: 10px;
  padding: 2px 8px;
}

.shiki-description {
  margin: 0;
  font-size: 0.85rem;
  color: #b8c2d4;
  line-height: 1.45;
  white-space: pre-wrap;
}

.shiki-description.collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.shiki-desc-toggle {
  align-self: flex-start;
  font-size: 0.75rem;
  color: #5e9cd8;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
}

.shiki-desc-toggle:hover {
  text-decoration: underline;
}

.skip-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.skip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.skip-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.skip-chevron {
  color: #a0a0b8;
  transition: transform 0.15s;
}

.skip-chevron.collapsed {
  transform: rotate(-90deg);
}

.skip-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.skip-summary {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.skip-body {
  margin-top: 10px;
}

.skip-disabled {
  font-size: 0.85rem;
  color: #6a6a8a;
  font-style: italic;
}

.skip-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.skip-button {
  background-color: #0f3460;
  color: #e0e0e0;
  border: 1px solid #1f4980;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.1s;
}

.skip-button:hover {
  background-color: #1a4880;
}

.skip-button-cancel {
  background-color: #5a2222;
  border-color: #803030;
}

.skip-button-cancel:hover {
  background-color: #803030;
}

.skip-progress-text {
  font-size: 0.8rem;
  color: #a0a0b8;
}

.skip-error {
  font-size: 0.8rem;
  color: #ff6a6a;
  margin-bottom: 10px;
}

.skip-results-meta {
  font-size: 0.75rem;
  color: #6a6a8a;
  margin-bottom: 8px;
}

.skip-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

.skip-table th {
  text-align: left;
  padding: 4px 8px;
  color: #a0a0b8;
  font-weight: 600;
  border-bottom: 1px solid #0f3460;
}

.skip-table td {
  padding: 4px 8px;
  color: #d0d0e0;
  border-bottom: 1px solid #1a2a4d;
}

.skip-table tr:last-child td {
  border-bottom: none;
}

.skip-pair-count {
  color: #6a6a8a;
  font-size: 0.7rem;
  margin-left: 4px;
}

.skip-empty {
  color: #4a4a6a;
}
</style>
