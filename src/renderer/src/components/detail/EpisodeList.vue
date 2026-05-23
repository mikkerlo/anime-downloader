<script setup lang="ts">
import { inject } from 'vue';
import EpisodeRow from './EpisodeRow.vue';
import { EpisodeListKey } from './keys';

defineProps<{
  playerMode: 'system' | 'builtin';
  translationType: string;
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

  <div class="episode-list">
    <EpisodeRow
      v-for="row in episodeRows"
      :key="row.episode.id"
      :row="row"
      :player-mode="playerMode"
      :translation-type="translationType"
    />
  </div>
</template>

<style scoped>
.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
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

.episode-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
