<script setup lang="ts">
import { inject } from 'vue';
import { storeToRefs } from 'pinia';
import { useShikimoriStore } from '../../stores/shikimori';
import { ShikimoriKey } from './keys';

const props = defineProps<{
  anime: AnimeDetail;
}>();

const shikimori = inject(ShikimoriKey);
if (!shikimori) throw new Error('ShikimoriPanel: missing ShikimoriKey injection');

const {
  shikiUser,
  shikiStatus,
  shikiEpisodes,
  shikiScore,
  shikiRewatches,
  shikiLoading,
  shikiSaving,
  shikiError,
  shikiDetails,
  descExpanded,
  shikiDetailsDescription,
  syncState,
  lastSyncError,
  shikiSave,
  triggerSyncNow
} = shikimori;

const { offlineQueueLength } = storeToRefs(useShikimoriStore());

const SHIKI_STATUSES: { value: ShikiUserRateStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'watching', label: 'Watching' },
  { value: 'rewatching', label: 'Rewatching' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'dropped', label: 'Dropped' }
];
</script>

<template>
  <div class="shiki-panel">
    <template v-if="shikiUser">
      <div class="shiki-header">
        <span class="shiki-label">Shikimori</span>
        <a
          :href="`https://shikimori.one/animes/${props.anime.myAnimeListId}`"
          target="_blank"
          class="shiki-link"
        >
          Open on Shikimori
        </a>
      </div>
      <div v-if="shikiLoading" class="shiki-loading">Loading...</div>
      <div v-else class="shiki-controls">
        <select v-model="shikiStatus" class="select shiki-select">
          <option v-for="s in SHIKI_STATUSES" :key="s.value" :value="s.value">
            {{ s.label }}
          </option>
        </select>
        <div class="shiki-episodes">
          <span>Episodes:</span>
          <input
            v-model.number="shikiEpisodes"
            type="number"
            min="0"
            :max="props.anime.numberOfEpisodes || undefined"
            class="shiki-ep-input"
          />
          <span v-if="props.anime.numberOfEpisodes" class="shiki-ep-total"
            >/ {{ props.anime.numberOfEpisodes }}</span
          >
        </div>
        <div class="shiki-episodes">
          <span>Score:</span>
          <select v-model.number="shikiScore" class="select shiki-score-select">
            <option :value="0">—</option>
            <option v-for="n in 10" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>
        <div class="shiki-episodes" title="Number of times you've rewatched this anime">
          <span>Rewatches:</span>
          <input v-model.number="shikiRewatches" type="number" min="0" class="shiki-ep-input" />
        </div>
        <button class="shiki-save-btn" :disabled="shikiSaving" @click="shikiSave">
          {{ shikiSaving ? 'Saving...' : 'Save' }}
        </button>
      </div>
      <div v-if="shikiError" class="shiki-error">{{ shikiError }}</div>
      <div
        v-if="offlineQueueLength > 0"
        class="shiki-offline"
        :class="{ 'shiki-syncing': syncState === 'syncing' }"
        :title="lastSyncError || ''"
      >
        <svg
          v-if="syncState === 'syncing'"
          class="shiki-offline-spin"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="14"
          height="14"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-6.219-8.56" />
        </svg>
        <svg
          v-else
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
            d="M3 3l18 18M12 5a7 7 0 016.95 6.155A4 4 0 0118 19H9m-3-2a4 4 0 01-1.9-7.516"
          />
        </svg>
        <span v-if="syncState === 'syncing'">
          Syncing {{ offlineQueueLength }} change{{ offlineQueueLength > 1 ? 's' : '' }}…
        </span>
        <span v-else>
          Working offline — {{ offlineQueueLength }} change{{ offlineQueueLength > 1 ? 's' : '' }}
          queued
        </span>
        <button
          v-if="syncState === 'idle'"
          type="button"
          class="shiki-offline-retry"
          @click="triggerSyncNow"
        >
          Retry now
        </button>
      </div>
      <div v-if="shikiDetails" class="shiki-details">
        <div v-if="shikiDetails.genres?.length" class="shiki-genres">
          <span v-for="g in shikiDetails.genres" :key="g.id" class="shiki-genre-tag">
            {{ g.russian || g.name }}
          </span>
        </div>
        <p
          v-if="shikiDetailsDescription"
          class="shiki-description"
          :class="{ collapsed: !descExpanded }"
        >
          {{ shikiDetailsDescription }}
        </p>
        <button
          v-if="shikiDetailsDescription && shikiDetailsDescription.length > 320"
          type="button"
          class="shiki-desc-toggle"
          @click="descExpanded = !descExpanded"
        >
          {{ descExpanded ? 'Show less' : 'Show more' }}
        </button>
      </div>
    </template>
    <div v-else class="shiki-loading">Loading...</div>
  </div>
</template>

<style scoped>
.shiki-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.shiki-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.shiki-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.shiki-link {
  font-size: 0.8rem;
  color: #3498db;
  text-decoration: none;
}

.shiki-link:hover {
  text-decoration: underline;
}

.shiki-loading {
  font-size: 0.85rem;
  color: #6a6a8a;
}

.shiki-controls {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.shiki-select {
  min-width: 130px;
}

.shiki-episodes {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: #a0a0b8;
}

.shiki-ep-input {
  width: 60px;
  padding: 6px 8px;
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 0.85rem;
  text-align: center;
}

.shiki-ep-input:focus {
  outline: none;
  border-color: #e94560;
}

.shiki-ep-total {
  color: #6a6a8a;
}

.shiki-score-select {
  width: 60px;
}

.shiki-save-btn {
  padding: 6px 16px;
  background-color: #0f3460;
  border: none;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.shiki-save-btn:hover {
  background-color: #1a4a7a;
}

.shiki-save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.shiki-error {
  margin-top: 8px;
  font-size: 0.8rem;
  color: #e94560;
}

.shiki-offline {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 0.78rem;
  color: #f0a75f;
  background: rgba(240, 167, 95, 0.12);
  border: 1px solid rgba(240, 167, 95, 0.3);
  border-radius: 4px;
}

.shiki-offline.shiki-syncing {
  color: #5e9cd8;
  background: rgba(94, 156, 216, 0.12);
  border-color: rgba(94, 156, 216, 0.3);
}

.shiki-offline-spin {
  animation: shiki-offline-rotate 0.9s linear infinite;
}

@keyframes shiki-offline-rotate {
  to {
    transform: rotate(360deg);
  }
}

.shiki-offline-retry {
  margin-left: 4px;
  padding: 2px 8px;
  font-size: 0.72rem;
  color: #f0a75f;
  background: transparent;
  border: 1px solid rgba(240, 167, 95, 0.5);
  border-radius: 3px;
  cursor: pointer;
}

.shiki-offline-retry:hover {
  background: rgba(240, 167, 95, 0.15);
}

.shiki-details {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(15, 52, 96, 0.6);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shiki-genres {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.shiki-genre-tag {
  font-size: 0.72rem;
  color: #cdd6e4;
  background: rgba(15, 52, 96, 0.5);
  border: 1px solid rgba(94, 156, 216, 0.25);
  border-radius: 10px;
  padding: 2px 8px;
}

.shiki-description {
  margin: 0;
  font-size: 0.85rem;
  color: #b8c2d4;
  line-height: 1.45;
  white-space: pre-wrap;
}

.shiki-description.collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.shiki-desc-toggle {
  align-self: flex-start;
  font-size: 0.75rem;
  color: #5e9cd8;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
}

.shiki-desc-toggle:hover {
  text-decoration: underline;
}
</style>
