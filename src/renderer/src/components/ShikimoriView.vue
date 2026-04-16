<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import AnimeCard from './AnimeCard.vue'

const emit = defineEmits<{
  openAnime: [id: number]
}>()

const entries = ref<ShikiAnimeRateEntry[]>([])
const loading = ref(false)
const error = ref('')
const statusFilter = ref<string>('to_watch')
const starredIds = ref(new Set<number>())
const refreshing = ref(false)

const filteredEntries = computed(() => {
  let list = entries.value
  if (statusFilter.value === 'to_watch') {
    list = list.filter((e) => hasUnwatched(e))
  } else if (statusFilter.value) {
    list = list.filter((e) => e.rate.status === statusFilter.value)
  }
  return list.slice().sort((a, b) => {
    return new Date(b.rate.updated_at).getTime() - new Date(a.rate.updated_at).getTime()
  })
})

const statusOptions = [
  { value: '', label: 'All' },
  { value: 'to_watch', label: 'To Watch' },
  { value: 'watching', label: 'Watching' },
  { value: 'planned', label: 'Planned' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'rewatching', label: 'Rewatching' },
  { value: 'dropped', label: 'Dropped' }
]

const statusCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const e of entries.value) {
    counts[e.rate.status] = (counts[e.rate.status] || 0) + 1
    if (hasUnwatched(e)) {
      counts['to_watch'] = (counts['to_watch'] || 0) + 1
    }
  }
  return counts
})

async function loadRates(): Promise<void> {
  const user = await window.api.shikimoriGetUser()
  if (!user) return
  loading.value = true
  error.value = ''
  try {
    entries.value = await window.api.shikimoriGetAnimeRates()
    const ids = entries.value.filter((e) => e.smotretAnime).map((e) => e.smotretAnime!.id)
    if (ids.length > 0) {
      const statuses = await window.api.libraryGetStatus(ids)
      const starred = new Set<number>()
      for (const [id, s] of Object.entries(statuses)) {
        if (s.starred) starred.add(Number(id))
      }
      starredIds.value = starred
    }
    if (entries.value.length > 0) refreshing.value = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load anime list'
  } finally {
    loading.value = false
  }
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)))
  if (starredIds.value.has(anime.id)) {
    starredIds.value.delete(anime.id)
  } else {
    starredIds.value.add(anime.id)
  }
  starredIds.value = new Set(starredIds.value)
}

function getEpisodeLabel(entry: ShikiAnimeRateEntry): string {
  const watched = entry.rate.episodes
  const total = entry.shikiAnime.episodes || entry.shikiAnime.episodes_aired || '?'
  return `${watched}/${total}`
}

function hasUnwatched(entry: ShikiAnimeRateEntry): boolean {
  return entry.rate.status === 'watching' && entry.shikiAnime.episodes_aired > entry.rate.episodes
}

function shikiPosterUrl(entry: ShikiAnimeRateEntry): string {
  const img = entry.shikiAnime.image.original
  return img.startsWith('http') ? img : `https://shikimori.one${img}`
}

function shikiTitle(entry: ShikiAnimeRateEntry): string {
  return entry.shikiAnime.russian || entry.shikiAnime.name
}

onMounted(() => {
  loadRates()

  window.api.onShikimoriRateUpdated((entry) => {
    const idx = entries.value.findIndex((e) => e.rate.target_id === entry.rate.target_id)
    if (idx !== -1) {
      entries.value[idx] = entry
      entries.value = [...entries.value]
    }
  })

  window.api.onShikimoriRatesRefreshed(async (newEntries) => {
    entries.value = newEntries
    refreshing.value = false
    const ids = newEntries.filter((e) => e.smotretAnime).map((e) => e.smotretAnime!.id)
    if (ids.length > 0) {
      const statuses = await window.api.libraryGetStatus(ids)
      const starred = new Set<number>()
      for (const [id, s] of Object.entries(statuses)) {
        if (s.starred) starred.add(Number(id))
      }
      starredIds.value = starred
    }
  })
})

onUnmounted(() => {
  window.api.offShikimoriRateUpdated()
  window.api.offShikimoriRatesRefreshed()
})
</script>

<template>
  <main class="shikimori-view">
    <header class="topbar">
      <h2>Shikimori</h2>
      <div class="topbar-controls">
        <select v-model="statusFilter" class="status-select">
          <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}{{ opt.value && statusCounts[opt.value] ? ` (${statusCounts[opt.value]})` : '' }}
          </option>
        </select>
        <button class="refresh-btn" :disabled="loading" @click="loadRates" title="Refresh list">
          <svg :class="{ spinning: loading || refreshing }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992" />
          </svg>
        </button>
      </div>
    </header>
    <div class="body">
      <div v-if="loading && entries.length === 0" class="status-text">Loading anime list...</div>
      <div v-else-if="error" class="status-text error-text">{{ error }}</div>
      <div v-else-if="filteredEntries.length === 0" class="status-text">
        {{ entries.length === 0 ? 'No anime in your Shikimori list.' : 'No anime with this status.' }}
      </div>
      <div v-else class="results-grid">
        <div v-for="entry in filteredEntries" :key="entry.rate.id" class="card-wrap">
          <template v-if="entry.smotretAnime">
            <AnimeCard
              :anime="entry.smotretAnime"
              :starred="starredIds.has(entry.smotretAnime.id)"
              @toggle-star="toggleStar"
              @click="emit('openAnime', entry.smotretAnime.id)"
            />
          </template>
          <template v-else>
            <div class="card fallback-card">
              <div class="poster-wrap">
                <img :src="shikiPosterUrl(entry)" :alt="shikiTitle(entry)" class="poster" loading="lazy" />
                <div class="unavailable-badge">Not available</div>
              </div>
              <div class="info">
                <div class="title" :title="shikiTitle(entry)">{{ shikiTitle(entry) }}</div>
                <div class="meta">
                  <span v-if="entry.shikiAnime.kind">{{ entry.shikiAnime.kind }}</span>
                  <span v-if="entry.shikiAnime.episodes"> · {{ entry.shikiAnime.episodes }} ep</span>
                </div>
              </div>
            </div>
          </template>
          <div class="badges-row">
            <div class="episode-badge" :class="{ unwatched: hasUnwatched(entry) }">
              {{ getEpisodeLabel(entry) }} ep
            </div>
            <div v-if="entry.rate.score > 0" class="score-badge">
              <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
                <path d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
              </svg>
              {{ entry.rate.score }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.shikimori-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  padding: 16px 24px;
  border-bottom: 1px solid #0f3460;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.topbar h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #e0e0e0;
}

.topbar-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-select {
  background: #16213e;
  color: #e0e0e0;
  border: 1px solid #0f3460;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.85rem;
  cursor: pointer;
}

.status-select:focus {
  outline: none;
  border-color: #e94560;
}

.refresh-btn {
  background: none;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #6a6a8a;
  padding: 5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.refresh-btn:hover {
  color: #e0e0e0;
  border-color: #e94560;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
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

.card-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}

.card {
  background-color: #16213e;
  border-radius: 10px;
  overflow: hidden;
  cursor: default;
}

.fallback-card .poster-wrap {
  position: relative;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background-color: #0f3460;
}

.fallback-card .poster {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.unavailable-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.8);
  color: #6a6a8a;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
}

.fallback-card .info {
  padding: 10px 12px 12px;
}

.fallback-card .title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #e0e0e0;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.fallback-card .meta {
  margin-top: 4px;
  font-size: 0.75rem;
  color: #6a6a8a;
}

.badges-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
  padding: 0 2px;
}

.episode-badge {
  background: rgba(15, 52, 96, 0.8);
  color: #a0a0c0;
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.episode-badge.unwatched {
  color: #fbbf24;
}

.score-badge {
  background: rgba(15, 52, 96, 0.8);
  color: #fbbf24;
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 2px;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}

.error-text {
  color: #e94560;
}
</style>
