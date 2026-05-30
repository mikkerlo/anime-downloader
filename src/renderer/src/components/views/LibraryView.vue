<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import AnimeCard from '../shared/AnimeCard.vue';
import { getAnimeName } from '../../utils';
import { useLibraryStore } from '../../stores/library';
import { useShikimoriStore } from '../../stores/shikimori';

const libraryStore = useLibraryStore();
const shikimoriStore = useShikimoriStore();
const { rates } = storeToRefs(shikimoriStore);

const library = ref<AnimeSearchResult[]>([]);
const starredIds = ref(new Set<number>());
const downloadedIds = ref(new Set<number>());

// Join Shikimori rates onto library entries by smotret-anime id, so the
// status tabs can filter the saved library by watch status.
const statusBySmotretId = computed(() => {
  const map = new Map<number, ShikiUserRateStatus>();
  for (const e of rates.value) {
    if (e.smotretAnime) map.set(e.smotretAnime.id, e.rate.status);
  }
  return map;
});
// Only show the status tabs when at least one *library* entry has a resolved
// Shikimori status — not merely when the user has any tracked rates (which
// would surface tabs whose non-"All" options are all empty).
const hasStatuses = computed(() => library.value.some((a) => statusBySmotretId.value.has(a.id)));

const statusTabs: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'watching', label: 'Watching' },
  { id: 'planned', label: 'Planned' },
  { id: 'completed', label: 'Completed' }
];
const statusFilter = ref('all');

function matchesFilter(anime: AnimeSearchResult): boolean {
  if (statusFilter.value === 'all') return true;
  const status = statusBySmotretId.value.get(anime.id);
  if (statusFilter.value === 'watching') return status === 'watching' || status === 'rewatching';
  return status === statusFilter.value;
}

const filteredLibrary = computed(() => library.value.filter(matchesFilter));

onMounted(async () => {
  await loadLibrary();
  // Hydrate Shikimori rates (cache-first) so the status tabs have data.
  if (shikimoriStore.loggedIn && rates.value.length === 0) {
    shikimoriStore
      .refreshRates()
      .catch((err) => console.error('Failed to hydrate Shikimori rates for Library:', err));
  }
});

async function loadLibrary(): Promise<void> {
  library.value = await window.api.libraryGet();
  const ids = library.value.map((a) => a.id);
  const statuses = await window.api.libraryGetStatus(ids);
  const starred = new Set<number>();
  const downloaded = new Set<number>();
  for (const [id, s] of Object.entries(statuses)) {
    if (s.starred) starred.add(Number(id));
    if (s.downloaded) downloaded.add(Number(id));
  }
  starredIds.value = starred;
  downloadedIds.value = downloaded;
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)));
  await loadLibrary();
}

async function deleteAnime(anime: AnimeSearchResult): Promise<void> {
  const name = getAnimeName(anime);
  await window.api.downloadedAnimeDelete(anime.id, name);
  await loadLibrary();
}
</script>

<template>
  <main class="library-view">
    <header class="topbar">
      <h2>Library</h2>
      <span v-if="library.length > 0" class="sub">· {{ library.length }} shows</span>
    </header>
    <div class="body">
      <div v-if="hasStatuses && library.length > 0" class="filter-row">
        <div class="pill-tabs">
          <button
            v-for="tab in statusTabs"
            :key="tab.id"
            class="pill-tab"
            :class="{ active: statusFilter === tab.id }"
            @click="statusFilter = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>
      </div>

      <div v-if="filteredLibrary.length > 0" class="poster-grid">
        <div v-for="anime in filteredLibrary" :key="anime.id" class="card-wrap">
          <AnimeCard
            :anime="anime"
            :starred="starredIds.has(anime.id)"
            @toggle-star="toggleStar"
            @click="libraryStore.openAnime(anime.id)"
          />
          <button
            v-if="downloadedIds.has(anime.id)"
            class="delete-folder-btn"
            title="Delete downloaded files"
            @click.stop="deleteAnime(anime)"
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
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Remove files
          </button>
        </div>
      </div>
      <div v-else-if="library.length > 0" class="status-text">No anime with this status.</div>
      <div v-else class="status-text">
        No saved anime yet. Use the star button on search results to add anime here.
      </div>
    </div>
  </main>
</template>

<style scoped>
.library-view {
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

.filter-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 22px;
}

.card-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}

.delete-folder-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 6px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--st-red) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--st-red) 32%, transparent);
  border-radius: var(--radius-btn);
  color: var(--st-red);
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.delete-folder-btn:hover {
  background: color-mix(in srgb, var(--st-red) 22%, transparent);
  border-color: var(--st-red);
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1.05rem;
  padding-top: 80px;
}
</style>
