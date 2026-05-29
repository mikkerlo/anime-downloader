<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import AnimeCard from '../shared/AnimeCard.vue';
import { useLibraryStore } from '../../stores/library';

const libraryStore = useLibraryStore();

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

async function search(): Promise<void> {
  const q = query.value.trim();
  if (!q) return;

  loading.value = true;
  searched.value = true;
  typeFilter.value = 'all';
  try {
    const response = await window.api.searchAnime(q);
    results.value = response.data;
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
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  const inLibrary = await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)));
  if (inLibrary) {
    starredIds.add(anime.id);
  } else {
    starredIds.delete(anime.id);
  }
}
</script>

<template>
  <main class="search-view">
    <header class="topbar">
      <h2>Search</h2>
      <span v-if="searched && !loading" class="sub">· {{ results.length }} titles</span>
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
      <div v-else-if="filteredResults.length > 0" class="poster-grid">
        <AnimeCard
          v-for="anime in filteredResults"
          :key="anime.id"
          :anime="anime"
          :starred="starredIds.has(anime.id)"
          @toggle-star="toggleStar"
          @click="libraryStore.openAnime(anime.id)"
        />
      </div>
      <div v-else-if="searched" class="empty-state">
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
      <div v-else class="status-text">Search for anime to get started.</div>
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

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1.05rem;
  padding-top: 80px;
}
</style>
