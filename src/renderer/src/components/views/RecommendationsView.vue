<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useLibraryStore } from '../../stores/library';
import { useShikimoriStore } from '../../stores/shikimori';

const libraryStore = useLibraryStore();
const shikimoriStore = useShikimoriStore();
const { recommendations } = storeToRefs(shikimoriStore);

const loading = ref(false);
const error = ref('');
const loaded = ref(false);

async function load(): Promise<void> {
  const user = await window.api.shikimoriGetUser();
  if (!user) {
    error.value = 'Connect to Shikimori in Settings to get personalized recommendations.';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    await shikimoriStore.refreshRecommendations();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load recommendations';
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

function open(rec: RecommendationEntry): void {
  if (rec.animeId !== null) libraryStore.openAnime(rec.animeId);
}

function scoreLabel(score: number): string {
  return score.toFixed(1);
}

onMounted(load);
</script>

<template>
  <main class="rec-view">
    <header class="topbar">
      <h2>For You</h2>
      <span v-if="recommendations.length > 0" class="sub"
        >· {{ recommendations.length }} picks</span
      >
      <div class="topbar-controls">
        <button class="icon-btn" :disabled="loading" @click="load" title="Refresh recommendations">
          <svg
            :class="{ spinning: loading }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            width="18"
            height="18"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992"
            />
          </svg>
        </button>
      </div>
    </header>

    <div class="body">
      <div v-if="loading && recommendations.length === 0" class="empty-state">
        <p>Finding shows you'll love…</p>
      </div>
      <div v-else-if="error" class="empty-state">
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
        </div>
        <p>{{ error }}</p>
      </div>
      <div v-else-if="loaded && recommendations.length === 0" class="empty-state">
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
            />
          </svg>
        </div>
        <p>Rate a few shows on the Shikimori tab and we'll suggest what to watch next.</p>
      </div>
      <div v-else class="poster-grid">
        <div
          v-for="rec in recommendations"
          :key="rec.malId"
          class="acard rec-card"
          :class="{ clickable: rec.animeId !== null }"
          @click="open(rec)"
        >
          <div class="poster-wrap">
            <img :src="rec.posterUrl" :alt="rec.title" class="poster" loading="lazy" />
            <span v-if="rec.communityScore > 0" class="score-badge"
              >★ {{ scoreLabel(rec.communityScore) }}</span
            >
            <span v-if="rec.animeId === null" class="rec-unavailable">Not on smotret-anime</span>
          </div>
          <div class="acard-info">
            <div class="acard-title" :title="rec.title">{{ rec.title }}</div>
            <div class="rec-reason" :title="rec.reason">{{ rec.reason }}</div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.rec-view {
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
  font-size: 0.9rem;
}

.topbar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.icon-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  color: var(--text-3);
  padding: 7px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.icon-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-y) var(--pad-x) 48px;
}

.rec-card.clickable {
  cursor: pointer;
}

.rec-card:not(.clickable) {
  cursor: default;
}

.rec-unavailable {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  color: var(--text-2);
  font-size: 0.68rem;
  text-align: center;
  padding: 3px 6px;
  border-radius: var(--radius-btn);
  backdrop-filter: blur(4px);
}

.rec-reason {
  margin-top: 4px;
  font-size: 0.72rem;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
