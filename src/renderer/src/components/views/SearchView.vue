<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import AnimeCard from '../shared/AnimeCard.vue';
import OfflineNotice from '../shared/OfflineNotice.vue';
import { useLibraryStore } from '../../stores/library';
import { useOfflineStore } from '../../stores/offline';

const libraryStore = useLibraryStore();
const { isOffline } = storeToRefs(useOfflineStore());
// A search submitted offline runs once on the next online edge (#568).
let pendingOfflineQuery = false;
watch(isOffline, (offline) => {
  if (!offline && pendingOfflineQuery) {
    pendingOfflineQuery = false;
    void search();
  }
});

const query = ref('');
const searchInput = ref<HTMLInputElement | null>(null);

function focusInput(): void {
  searchInput.value?.focus();
  searchInput.value?.select();
}

defineExpose({ focusInput });
const results = ref<AnimeSearchResult[]>([]);
const loading = ref(false);
const searched = ref(false);
const starredIds = reactive(new Set<number>());
const priorityIds = reactive(new Set<number>());

// Client-side type filter over the current result set (distinct typeTitles).
const typeFilter = ref('all');
const availableTypes = computed(() => {
  const set = new Set<string>();
  for (const a of results.value) if (a.typeTitle) set.add(a.typeTitle);
  return Array.from(set);
});
const filteredResults = computed(() =>
  typeFilter.value === 'all'
    ? results.value
    : results.value.filter((a) => a.typeTitle === typeFilter.value)
);

// Local search over the titles this PC has (#571). Offline it replaces the
// remote results; online it is the "In your library" section above them.
const LOCAL_MIN_CODE_POINTS = 2;
const LOCAL_SECTION_MAX = 6;
const STATUS_CHIPS: { id: ShikiUserRateStatus; label: string }[] = [
  { id: 'watching', label: 'Watching' },
  { id: 'rewatching', label: 'Rewatching' },
  { id: 'planned', label: 'Planned' },
  { id: 'completed', label: 'Completed' },
  { id: 'on_hold', label: 'On hold' },
  { id: 'dropped', label: 'Dropped' }
];
const SOURCE_LABELS: Record<LocalSource['kind'], string> = {
  starred: 'Starred',
  downloaded: 'Downloaded',
  watching: 'Watching'
};

// `localAll` is the unfiltered hit list the chips are built from; the chips
// re-query main with `genre` / `status`.
const localAll = ref<LocalSearchResult[]>([]);
const localResults = ref<LocalSearchResult[]>([]);
const localSearched = ref(false);
const corpusSize = ref(0);
const tooShort = ref(false);
const showAllLocal = ref(false);
const genreFilter = ref<string | null>(null);
const statusFilter = ref<ShikiUserRateStatus | null>(null);
let localQuery = '';
let localGeneration = 0;
let filterGeneration = 0;
// The `localGeneration` whose results are on screen.
let landedGeneration = 0;

const genreChips = computed(() =>
  Array.from(new Set(localAll.value.flatMap((a) => a.genres))).sort((a, b) => a.localeCompare(b))
);
const statusChips = computed(() =>
  STATUS_CHIPS.filter((s) => localAll.value.some((a) => a.listStatus === s.id))
);
const shownLocal = computed(() =>
  isOffline.value || showAllLocal.value
    ? localResults.value
    : localResults.value.slice(0, LOCAL_SECTION_MAX)
);
// Remote results already shown in "In your library" are dropped by id.
const remoteResults = computed(() => {
  const shown = new Set(shownLocal.value.map((a) => a.id));
  return filteredResults.value.filter((a) => !shown.has(a.id));
});

// The Starred badge follows the star, not the snapshot the search returned.
function badgesOf(a: LocalSearchResult): LocalSource[] {
  const rest = a.localSources.filter((s) => s.kind !== 'starred');
  return starredIds.has(a.id) ? [{ kind: 'starred' }, ...rest] : rest;
}

function clearLocal(): void {
  localGeneration++;
  localAll.value = [];
  localResults.value = [];
  localSearched.value = false;
  corpusSize.value = 0;
}

async function loadPriority(): Promise<void> {
  const priority = await window.api.libraryGetPriority();
  priorityIds.clear();
  for (const id of priority) priorityIds.add(Number(id));
}

async function runLocal(q: string): Promise<void> {
  const generation = ++localGeneration;
  genreFilter.value = null;
  statusFilter.value = null;
  showAllLocal.value = false;
  try {
    const [response] = await Promise.all([window.api.searchLocal(q), libraryStore.loadPosterIds()]);
    if (generation !== localGeneration) return;
    landedGeneration = generation;
    localQuery = q;
    localAll.value = response.results;
    localResults.value = response.results;
    corpusSize.value = response.corpusSize;
    localSearched.value = true;
    for (const a of response.results) {
      if (a.localSources.some((s) => s.kind === 'starred')) starredIds.add(a.id);
      else starredIds.delete(a.id);
    }
  } catch (err) {
    console.error('Local search failed:', err);
    if (generation === localGeneration) clearLocal();
  }
}

async function setLocalFilter(
  genre: string | null,
  status: ShikiUserRateStatus | null
): Promise<void> {
  // A filter refines the landed query; it never supersedes an in-flight one.
  // While a newer search is in flight the old chips are inert, and a filter
  // already in flight yields to any search submitted after it.
  if (!localSearched.value || localGeneration !== landedGeneration) return;
  genreFilter.value = genre;
  statusFilter.value = status;
  const base = localGeneration;
  const generation = ++filterGeneration;
  try {
    const response = await window.api.searchLocal(localQuery, {
      ...(genre ? { genre } : {}),
      ...(status ? { status } : {})
    });
    if (generation === filterGeneration && base === localGeneration) {
      localResults.value = response.results;
    }
  } catch (err) {
    console.error('Local search failed:', err);
  }
}

async function search(): Promise<void> {
  const q = query.value.trim();
  if (!q) return;
  const short = [...q].length < LOCAL_MIN_CODE_POINTS;
  if (isOffline.value) {
    pendingOfflineQuery = true;
    tooShort.value = short;
    if (short) {
      clearLocal();
      return;
    }
    await Promise.all([runLocal(q), loadPriority().catch(() => {})]);
    return;
  }

  tooShort.value = false;
  loading.value = true;
  searched.value = true;
  typeFilter.value = 'all';
  // The local query goes first, so its section paints while the remote loads.
  let localDone: Promise<void> = Promise.resolve();
  if (short) clearLocal();
  else localDone = runLocal(q);
  try {
    const response = await window.api.searchAnime(q);
    results.value = response.data;
    // One call for the whole result set — cheaper than the N sequential
    // `libraryHas` round-trips below, which predate it.
    await loadPriority();
    for (const anime of results.value) {
      if (await window.api.libraryHas(anime.id)) {
        starredIds.add(anime.id);
      } else {
        starredIds.delete(anime.id);
      }
    }
  } catch (err) {
    console.error('Search failed:', err);
    results.value = [];
  } finally {
    loading.value = false;
  }
  await localDone;
}

// A local hit without its search-only fields, so starring it from here stores
// the same record a remote card would.
function plain(a: LocalSearchResult): AnimeSearchResult {
  const { id, title, titles, posterUrlSmall, numberOfEpisodes, type, typeTitle, year, season } = a;
  return { id, title, titles, posterUrlSmall, numberOfEpisodes, type, typeTitle, year, season };
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  const inLibrary = await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)));
  if (inLibrary) {
    starredIds.add(anime.id);
  } else {
    starredIds.delete(anime.id);
    // Un-starring drops the id from the priority list main-side.
    priorityIds.delete(anime.id);
  }
}

async function togglePriority(anime: AnimeSearchResult): Promise<void> {
  const next = await window.api.librarySetPriority(
    JSON.parse(JSON.stringify(anime)),
    !priorityIds.has(anime.id)
  );
  priorityIds.clear();
  for (const id of next) priorityIds.add(Number(id));
  // Prioritizing also stars, so the star fills in the same tick.
  if (priorityIds.has(anime.id)) starredIds.add(anime.id);
}
</script>

<template>
  <main class="search-view">
    <header class="topbar">
      <h2>Search</h2>
      <span v-if="searched && !loading && !isOffline" class="sub"
        >· {{ results.length }} titles</span
      >
      <span
        v-else-if="isOffline && !(localSearched && corpusSize === 0)"
        class="sub"
        data-testid="local-subtitle"
        >· Showing titles saved on this PC</span
      >
    </header>
    <div class="body">
      <form class="search-wrap" @submit.prevent="search">
        <svg
          class="search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
          />
        </svg>
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          class="search-input"
          placeholder="Search anime by title…"
        />
      </form>

      <template v-if="isOffline">
        <div v-if="tooShort" class="status-text" data-testid="local-too-short">
          Type at least 2 characters
        </div>
        <OfflineNotice
          v-else-if="localSearched && corpusSize === 0"
          reason="Search needs an internet connection"
        />
        <template v-else-if="localSearched">
          <div
            v-if="genreChips.length > 0 || statusChips.length > 0"
            class="filter-row"
            data-testid="local-chips"
          >
            <div v-if="genreChips.length > 0" class="pill-tabs" data-testid="genre-chips">
              <button
                class="pill-tab"
                :class="{ active: genreFilter === null }"
                @click="setLocalFilter(null, statusFilter)"
              >
                All genres
              </button>
              <button
                v-for="g in genreChips"
                :key="g"
                class="pill-tab"
                :class="{ active: genreFilter === g }"
                @click="setLocalFilter(g, statusFilter)"
              >
                {{ g }}
              </button>
            </div>
            <div v-if="statusChips.length > 0" class="pill-tabs" data-testid="status-chips">
              <button
                class="pill-tab"
                :class="{ active: statusFilter === null }"
                @click="setLocalFilter(genreFilter, null)"
              >
                Any status
              </button>
              <button
                v-for="s in statusChips"
                :key="s.id"
                class="pill-tab"
                :class="{ active: statusFilter === s.id }"
                @click="setLocalFilter(genreFilter, s.id)"
              >
                {{ s.label }}
              </button>
            </div>
          </div>
        </template>
        <div v-else class="status-text">Search titles saved on this PC.</div>
      </template>

      <section v-if="shownLocal.length > 0" class="local-section" data-testid="local-section">
        <div v-if="!isOffline" class="section-head">
          <h3>In your library</h3>
          <span class="muted">{{ localResults.length }} saved on this PC</span>
          <button
            v-if="localResults.length > LOCAL_SECTION_MAX"
            type="button"
            class="show-all"
            data-testid="local-show-all"
            @click="showAllLocal = !showAllLocal"
          >
            {{ showAllLocal ? 'Show less' : 'Show all' }}
          </button>
        </div>
        <div class="poster-grid local-grid">
          <div
            v-for="anime in shownLocal"
            :key="anime.id"
            class="local-card"
            data-testid="local-card"
          >
            <AnimeCard
              :anime="anime"
              :starred="starredIds.has(anime.id)"
              :prioritized="priorityIds.has(anime.id)"
              @toggle-star="toggleStar(plain(anime))"
              @toggle-priority="togglePriority(plain(anime))"
              @click="libraryStore.openAnime(anime.id)"
            />
            <div class="local-badges">
              <span
                v-for="s in badgesOf(anime)"
                :key="s.kind"
                class="local-badge"
                :class="`src-${s.kind}`"
                >{{ SOURCE_LABELS[s.kind] }}</span
              >
            </div>
          </div>
        </div>
      </section>
      <div
        v-else-if="isOffline && localSearched && corpusSize > 0"
        class="empty-state"
        data-testid="local-empty"
      >
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
        </div>
        <p>Nothing saved on this PC matches</p>
      </div>

      <template v-if="!isOffline">
        <div
          v-if="shownLocal.length > 0 && (loading || remoteResults.length > 0)"
          class="section-head remote-head"
        >
          <h3>Search results</h3>
        </div>
        <div v-if="availableTypes.length > 1" class="filter-row">
          <div class="pill-tabs">
            <button
              class="pill-tab"
              :class="{ active: typeFilter === 'all' }"
              @click="typeFilter = 'all'"
            >
              All
            </button>
            <button
              v-for="t in availableTypes"
              :key="t"
              class="pill-tab"
              :class="{ active: typeFilter === t }"
              @click="typeFilter = t"
            >
              {{ t }}
            </button>
          </div>
        </div>

        <div v-if="loading" class="status-text">Searching…</div>
        <div v-else-if="remoteResults.length > 0" class="poster-grid remote-grid">
          <AnimeCard
            v-for="anime in remoteResults"
            :key="anime.id"
            :anime="anime"
            :starred="starredIds.has(anime.id)"
            :prioritized="priorityIds.has(anime.id)"
            @toggle-star="toggleStar"
            @toggle-priority="togglePriority"
            @click="libraryStore.openAnime(anime.id)"
          />
        </div>
        <div v-else-if="searched && shownLocal.length === 0" class="empty-state">
          <div class="es-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          </div>
          <p>No titles match your search.</p>
        </div>
        <div v-else-if="!searched" class="status-text">Search for anime to get started.</div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.search-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 var(--pad-x);
  height: 64px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(8px);
}

.topbar h2 {
  font-family: var(--font-display);
  font-size: 1.32rem;
  font-weight: 700;
  letter-spacing: -0.015em;
}

.topbar .sub {
  color: var(--text-3);
  font-size: 0.85rem;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-y) var(--pad-x) 48px;
}

.search-wrap {
  position: relative;
  max-width: 560px;
}

.search-icon {
  position: absolute;
  left: 15px;
  top: 50%;
  transform: translateY(-50%);
  width: 19px;
  height: 19px;
  color: var(--text-3);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 12px 16px 12px 44px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  color: var(--text);
  font-size: 0.95rem;
  font-family: inherit;
  outline: none;
  transition: all 0.15s;
}

.search-input::placeholder {
  color: var(--text-faint);
}

.search-input:focus {
  border-color: var(--accent);
  background: var(--surface-2);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.filter-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 16px;
}

.poster-grid {
  margin-top: 22px;
}

.local-section {
  margin-top: 22px;
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.section-head h3 {
  font-family: var(--font-display);
  font-size: 1.04rem;
  font-weight: 700;
}

.section-head .muted {
  font-size: 0.82rem;
  color: var(--text-3);
}

.local-section .poster-grid {
  margin-top: 14px;
}

.remote-head {
  margin-top: 30px;
}

.show-all {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--accent);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
}

.show-all:hover {
  text-decoration: underline;
}

.local-card {
  position: relative;
}

.local-badges {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  pointer-events: none;
}

.local-badge {
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--bg-deep) 70%, transparent);
  backdrop-filter: blur(4px);
}

.local-badge.src-starred {
  color: var(--st-orange);
}

.local-badge.src-downloaded {
  color: var(--st-green);
}

.local-badge.src-watching {
  color: var(--st-blue);
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1.05rem;
  padding-top: 80px;
}
</style>
