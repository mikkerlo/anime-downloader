<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AnimeCard from './AnimeCard.vue'
import { getAnimeName } from '../utils'

const emit = defineEmits<{
  openAnime: [id: number]
}>()

const library = ref<AnimeSearchResult[]>([])
const starredIds = ref(new Set<number>())
const downloadedIds = ref(new Set<number>())

onMounted(loadLibrary)

async function loadLibrary(): Promise<void> {
  library.value = await window.api.libraryGet()
  const starred = new Set<number>()
  const downloaded = new Set<number>()
  for (const anime of library.value) {
    const [isStar, isDl] = await Promise.all([
      window.api.libraryHas(anime.id),
      window.api.libraryIsDownloaded(anime.id)
    ])
    if (isStar) starred.add(anime.id)
    if (isDl) downloaded.add(anime.id)
  }
  starredIds.value = starred
  downloadedIds.value = downloaded
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)))
  await loadLibrary()
}

async function deleteAnime(anime: AnimeSearchResult): Promise<void> {
  const name = getAnimeName(anime)
  await window.api.downloadedAnimeDelete(anime.id, name)
  await loadLibrary()
}
</script>

<template>
  <main class="library-view">
    <header class="topbar">
      <h2>Library</h2>
    </header>
    <div class="body">
      <div v-if="library.length > 0" class="results-grid">
        <div v-for="anime in library" :key="anime.id" class="card-wrap">
          <AnimeCard
            :anime="anime"
            :starred="starredIds.has(anime.id)"
            @toggle-star="toggleStar"
            @click="emit('openAnime', anime.id)"
          />
          <button
            v-if="downloadedIds.has(anime.id)"
            class="delete-folder-btn"
            @click.stop="deleteAnime(anime)"
            title="Delete downloaded files"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
            Remove files
          </button>
        </div>
      </div>
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
}

.topbar {
  padding: 16px 24px;
  border-bottom: 1px solid #0f3460;
}

.topbar h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #e0e0e0;
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
  margin-top: 4px;
  padding: 5px 8px;
  background-color: rgba(233, 69, 96, 0.1);
  border: 1px solid rgba(233, 69, 96, 0.3);
  border-radius: 6px;
  color: #e94560;
  font-size: 0.7rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.delete-folder-btn:hover {
  background-color: rgba(233, 69, 96, 0.2);
  border-color: #e94560;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}
</style>
