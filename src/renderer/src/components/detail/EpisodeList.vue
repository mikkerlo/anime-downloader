<script setup lang="ts">
import { inject } from 'vue';
import EpisodeRow from './EpisodeRow.vue';
import { EpisodeListKey } from './keys';

defineProps<{
  playerMode: 'system' | 'builtin';
  translationType: string;
  posterUrl: string;
}>();

const list = inject(EpisodeListKey);
if (!list) throw new Error('EpisodeList: missing EpisodeListKey injection');

const {
  filteredEpisodes,
  episodeRows,
  loadingEpisodes,
  currentPage,
  totalPages,
  isPaginated,
  goToPage
} = list;
</script>

<template>
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

  <div class="ep-list">
    <EpisodeRow
      v-for="row in episodeRows"
      :key="row.episode.id"
      :row="row"
      :player-mode="playerMode"
      :translation-type="translationType"
      :poster-url="posterUrl"
    />
  </div>
</template>

<style scoped>
.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1.05rem;
  padding: 40px 0;
}

.pagination {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  color: var(--text-3);
  font-family: var(--font-data);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.page-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.page-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-info {
  margin-left: 8px;
  color: var(--text-3);
  font-size: 0.8rem;
  font-family: var(--font-data);
}

.ep-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
