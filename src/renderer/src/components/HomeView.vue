<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const emit = defineEmits<{
  openAnime: [id: number, focusEpisodeInt?: string]
  navigate: [view: string]
}>()

const entries = ref<ContinueWatchingEntry[]>([])
const loading = ref(true)
const failedPosters = ref(new Set<string>())

let refreshTimer: ReturnType<typeof setTimeout> | null = null

function entryKey(e: ContinueWatchingEntry): string {
  return `${e.kind}:${e.animeId}:${e.episodeInt}`
}

function showPoster(e: ContinueWatchingEntry): boolean {
  return !!e.posterUrl && !failedPosters.value.has(entryKey(e))
}

function onPosterError(e: ContinueWatchingEntry): void {
  failedPosters.value = new Set(failedPosters.value).add(entryKey(e))
}

function onPosterLoad(e: ContinueWatchingEntry, evt: Event): void {
  // smotret-anime.ru sometimes serves a 200-OK response with content-length: 0
  // for missing posters. The browser fires `load` (not `error`) and renders an
  // empty <img>, leaving the dark container visible forever. Detect via the
  // decoded dimensions and treat as failed.
  const img = evt.target as HTMLImageElement
  if (img.naturalWidth === 0 || img.naturalHeight === 0) {
    failedPosters.value = new Set(failedPosters.value).add(entryKey(e))
  }
}

async function refresh(): Promise<void> {
  try {
    entries.value = await window.api.homeGetContinueWatching()
    failedPosters.value = new Set()
  } catch (err) {
    console.error('Failed to load continue-watching list:', err)
    entries.value = []
  } finally {
    loading.value = false
  }
}

async function manualRefresh(): Promise<void> {
  loading.value = true
  // Kick a Shikimori rates refresh — returns cached instantly and triggers a
  // background fetch. When the fetch completes the `rates-refreshed` broadcast
  // re-fires `refresh()` via our existing listener, picking up anything newly
  // added on Shikimori.
  try {
    void window.api.shikimoriGetAnimeRates()
  } catch (err) {
    console.error('Failed to trigger Shikimori refresh:', err)
  }
  await refresh()
}

function debouncedRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 1000)
}

function progressPercent(entry: ContinueWatchingEntry): number {
  if (!entry.position || !entry.duration) return 0
  const pct = Math.min(100, Math.round((entry.position / entry.duration) * 100))
  return pct < 2 ? 2 : pct
}

function onClick(entry: ContinueWatchingEntry): void {
  if (!entry.animeId) return
  emit('openAnime', entry.animeId, entry.episodeInt)
}

onMounted(async () => {
  await refresh()
  window.addEventListener('watch-progress-updated', debouncedRefresh)
  window.api.onShikimoriRatesRefreshed(refresh)
  window.api.onShikimoriRateUpdated(refresh)
})

onUnmounted(() => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  window.removeEventListener('watch-progress-updated', debouncedRefresh)
  window.api.offShikimoriRatesRefreshed()
  window.api.offShikimoriRateUpdated()
})
</script>

<template>
  <main class="home-view">
    <header class="topbar">
      <h2>Continue Watching</h2>
      <button class="refresh-btn" @click="manualRefresh" :disabled="loading">Refresh</button>
    </header>
    <div class="body">
      <div v-if="loading && entries.length === 0" class="status-text">Loading...</div>
      <div v-else-if="entries.length === 0" class="empty">
        <p>Nothing to resume yet.</p>
        <button class="cta-btn" @click="emit('navigate', 'search')">Browse Search</button>
      </div>
      <div v-else class="grid">
        <button
          v-for="e in entries"
          :key="`${e.kind}:${e.animeId}:${e.episodeInt}`"
          class="card"
          :class="{ disabled: !e.animeId }"
          :disabled="!e.animeId"
          @click="onClick(e)"
        >
          <div class="poster">
            <img v-if="showPoster(e)" :src="e.posterUrl" :alt="e.animeName" @error="onPosterError(e)" @load="onPosterLoad(e, $event)" />
            <div v-else class="poster-fallback"></div>
          </div>
          <div class="info">
            <div class="title">{{ e.animeName || 'Unknown anime' }}</div>
            <div class="ep">
              <span class="chip" :class="e.kind">{{ e.kind === 'resume' ? 'Resume' : 'Next' }}</span>
              <span class="ep-label">{{ e.episodeLabel }}</span>
            </div>
            <div v-if="e.kind === 'resume'" class="progress-bar">
              <div class="progress-fill" :style="{ width: progressPercent(e) + '%' }"></div>
            </div>
          </div>
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.home-view {
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

.refresh-btn {
  background: transparent;
  border: 1px solid #0f3460;
  color: #c0c0d8;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}

.refresh-btn:hover:not(:disabled) {
  background: #0f3460;
  color: #fff;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 16px;
}

.card {
  display: flex;
  align-items: stretch;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
  padding: 0;
  transition: all 0.15s;
}

.card:hover:not(:disabled) {
  border-color: #e94560;
  transform: translateY(-1px);
}

.card.disabled,
.card:disabled {
  cursor: default;
  opacity: 0.6;
}

.poster {
  width: 100px;
  min-width: 100px;
  height: 140px;
  background: #0f1626;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.poster-fallback {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #1a1a2e 0%, #0f1626 100%);
}

.info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  padding: 12px 14px;
  min-width: 0;
}

.title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #e0e0e0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ep {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: #a0a0c0;
}

.ep-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.chip.resume {
  background: rgba(233, 69, 96, 0.15);
  color: #e94560;
  border: 1px solid rgba(233, 69, 96, 0.3);
}

.chip.next {
  background: rgba(15, 52, 96, 0.5);
  color: #6a9eff;
  border: 1px solid rgba(106, 158, 255, 0.3);
}

.progress-bar {
  width: 100%;
  height: 3px;
  background: #0f1626;
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #e94560;
  transition: width 0.3s ease;
}

.empty {
  text-align: center;
  padding-top: 100px;
}

.empty p {
  color: #6a6a8a;
  font-size: 1rem;
  margin-bottom: 16px;
}

.cta-btn {
  background: #e94560;
  color: #fff;
  border: none;
  padding: 10px 20px;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.cta-btn:hover {
  background: #d63752;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1rem;
  padding-top: 80px;
}
</style>
