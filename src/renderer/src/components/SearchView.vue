<script setup lang="ts">
import { ref, reactive } from 'vue'
import AnimeCard from './AnimeCard.vue'

const emit = defineEmits<{
  openAnime: [id: number]
}>()

const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)

function focusInput(): void {
  searchInput.value?.focus()
  searchInput.value?.select()
}

defineExpose({ focusInput })
const results = ref<AnimeSearchResult[]>([])
const loading = ref(false)
const searched = ref(false)
const starredIds = reactive(new Set<number>())

async function search(): Promise<void> {
  const q = query.value.trim()
  if (!q) return

  loading.value = true
  searched.value = true
  try {
    const response = await window.api.searchAnime(q)
    results.value = response.data
    for (const anime of results.value) {
      if (await window.api.libraryHas(anime.id)) {
        starredIds.add(anime.id)
      } else {
        starredIds.delete(anime.id)
      }
    }
  } catch (err) {
    console.error('Search failed:', err)
    results.value = []
  } finally {
    loading.value = false
  }
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  const inLibrary = await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)))
  if (inLibrary) {
    starredIds.add(anime.id)
  } else {
    starredIds.delete(anime.id)
  }
}
</script>

<template>
  <main class="search-view">
    <header class="topbar">
      <form class="search-form" @submit.prevent="search">
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          class="search-input"
          placeholder="Search anime..."
        />
        <button type="submit" class="search-btn" :disabled="loading">
          <svg v-if="!loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <span v-else class="spinner" />
        </button>
      </form>
    </header>
    <div class="body">
      <div v-if="loading" class="status-text">Searching...</div>
      <div v-else-if="results.length > 0" class="results-grid">
        <AnimeCard v-for="anime in results" :key="anime.id" :anime="anime" :starred="starredIds.has(anime.id)" @toggle-star="toggleStar" @click="emit('openAnime', anime.id)" />
      </div>
      <div v-else-if="searched" class="status-text">No results found</div>
      <div v-else class="status-text">Search for anime to get started</div>
    </div>
  </main>
</template>

<style scoped>
.search-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  padding: 16px 24px;
  border-bottom: 1px solid #0f3460;
}

.search-form {
  display: flex;
  gap: 8px;
  max-width: 500px;
}

.search-input {
  flex: 1;
  padding: 10px 16px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s;
}

.search-input:focus {
  border-color: #e94560;
}

.search-btn {
  padding: 10px 14px;
  background-color: #e94560;
  border: none;
  border-radius: 8px;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s;
}

.search-btn:hover {
  background-color: #d63851;
}

.search-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 20px;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}
</style>
