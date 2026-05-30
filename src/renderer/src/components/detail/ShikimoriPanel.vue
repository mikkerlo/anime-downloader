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
  <div class="side-panel">
    <template v-if="shikiUser">
      <h4>
        <span class="sk-logo">Sh</span>Shikimori
        <a
          :href="`https://shikimori.one/animes/${props.anime.myAnimeListId}`"
          target="_blank"
          class="sk-open"
          title="Open on Shikimori"
        >
          Open ↗
        </a>
      </h4>
      <div v-if="shikiLoading" class="shiki-loading">Loading…</div>
      <template v-else>
        <div class="sk-field">
          <span class="select-label">Status</span>
          <div class="status-seg">
            <button
              v-for="s in SHIKI_STATUSES"
              :key="s.value"
              :class="{ on: shikiStatus === s.value }"
              @click="shikiStatus = s.value"
            >
              {{ s.label }}
            </button>
          </div>
        </div>
        <div class="sk-field">
          <span class="select-label">
            Your score
            <button v-if="shikiScore > 0" type="button" class="sk-clear" @click="shikiScore = 0">
              Clear
            </button>
          </span>
          <div class="score-pick">
            <button
              v-for="n in 10"
              :key="n"
              :class="{ on: shikiScore === n }"
              @click="shikiScore = n"
            >
              {{ n }}
            </button>
          </div>
        </div>
        <div class="sk-field sk-inline">
          <label class="select-label" for="shiki-ep">Episodes</label>
          <div class="sk-inline-control">
            <input
              id="shiki-ep"
              v-model.number="shikiEpisodes"
              type="number"
              min="0"
              :max="props.anime.numberOfEpisodes || undefined"
              class="sk-num-input"
            />
            <span v-if="props.anime.numberOfEpisodes" class="sk-ep-total"
              >/ {{ props.anime.numberOfEpisodes }}</span
            >
          </div>
        </div>
        <div class="sk-field sk-inline" title="Number of times you've rewatched this anime">
          <label class="select-label" for="shiki-rw">Rewatches</label>
          <input
            id="shiki-rw"
            v-model.number="shikiRewatches"
            type="number"
            min="0"
            class="sk-num-input"
          />
        </div>
        <div v-if="props.anime.numberOfEpisodes" class="sk-field">
          <span class="select-label">Progress</span>
          <div class="sk-progress">
            <div class="pbar">
              <span
                :style="{
                  width:
                    Math.min(100, Math.round(((shikiEpisodes || 0) / props.anime.numberOfEpisodes) * 100)) +
                    '%'
                }"
              ></span>
            </div>
            <span class="ptext">{{ shikiEpisodes || 0 }} / {{ props.anime.numberOfEpisodes }}</span>
          </div>
        </div>
        <button class="sk-save-btn" :disabled="shikiSaving" @click="shikiSave">
          {{ shikiSaving ? 'Saving…' : 'Save' }}
        </button>
      </template>
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
    </template>
    <div v-else class="shiki-loading">Loading…</div>
  </div>
</template>

<style scoped>
.side-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 18px;
}

.side-panel h4 {
  font-family: var(--font-display);
  font-size: 0.92rem;
  font-weight: 700;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.side-panel h4 .sk-logo {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: var(--st-blue);
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 0.6rem;
  font-weight: 800;
}

.sk-open {
  margin-left: auto;
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--st-blue);
  text-decoration: none;
}

.sk-open:hover {
  text-decoration: underline;
}

.shiki-loading {
  font-size: 0.85rem;
  color: var(--text-3);
}

.sk-field {
  margin-bottom: 14px;
}

.select-label {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.sk-clear {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-3);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}

.sk-clear:hover {
  color: var(--accent);
}

.status-seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  background: var(--surface-2);
  padding: 4px;
  border-radius: var(--radius-btn);
}

.status-seg button {
  padding: 8px 4px;
  border: none;
  background: none;
  border-radius: calc(var(--radius-btn) - 2px);
  color: var(--text-3);
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.12s;
}

.status-seg button:hover {
  color: var(--text);
}

.status-seg button.on {
  background: var(--accent);
  color: var(--accent-ink);
}

.score-pick {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.score-pick button {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-3);
  font-family: var(--font-data);
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.12s;
}

.score-pick button:hover {
  border-color: var(--accent);
  color: var(--text);
}

.score-pick button.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.sk-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.sk-inline .select-label {
  margin-bottom: 0;
}

.sk-inline-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sk-num-input {
  width: 64px;
  padding: 6px 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  color: var(--text);
  font-family: var(--font-data);
  font-size: 0.84rem;
  text-align: center;
}

.sk-num-input:focus {
  outline: none;
  border-color: var(--accent);
}

.sk-ep-total {
  color: var(--text-3);
  font-family: var(--font-data);
  font-size: 0.8rem;
}

.sk-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ptext {
  font-family: var(--font-data);
  font-size: 0.76rem;
  color: var(--text-3);
  white-space: nowrap;
}

.sk-save-btn {
  width: 100%;
  padding: 9px 16px;
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-btn);
  color: var(--accent-ink);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.sk-save-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.sk-save-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.shiki-error {
  margin-top: 8px;
  font-size: 0.8rem;
  color: var(--st-red);
}

.shiki-offline {
  margin-top: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 0.76rem;
  color: var(--st-orange);
  background: color-mix(in srgb, var(--st-orange) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--st-orange) 32%, transparent);
  border-radius: var(--radius-btn);
}

.shiki-offline.shiki-syncing {
  color: var(--st-blue);
  background: color-mix(in srgb, var(--st-blue) 12%, transparent);
  border-color: color-mix(in srgb, var(--st-blue) 32%, transparent);
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
  color: inherit;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 5px;
  cursor: pointer;
  opacity: 0.85;
}

.shiki-offline-retry:hover {
  opacity: 1;
}
</style>
