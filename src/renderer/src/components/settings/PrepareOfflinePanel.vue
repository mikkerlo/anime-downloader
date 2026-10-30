<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { STATUS_TEXT, usePrepareOfflineStore } from '../../stores/prepare-offline';
import { useLibraryStore } from '../../stores/library';
import { useSyncStore } from '../../stores/sync';
import { LAYER } from '../overlay-layers';

const store = usePrepareOfflineStore();
// The sync's held conflicts (#585): the library step offers Review, since the
// toast after this run would sit under the panel's backdrop.
const sync = useSyncStore();
const { conflictCount } = storeToRefs(sync);
const { run, running, lastPreparedText } = storeToRefs(store);
const libraryStore = useLibraryStore();
const expanded = ref<Set<string>>(new Set());

const finished = computed(() => run.value !== null && run.value.finishedAt !== null);

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function statusOf(step: PrepareOfflineStepState): string {
  if (step.state === 'pending') return 'Waiting';
  if (step.state === 'running') {
    return step.total > 0 ? `${step.done} / ${step.total}` : 'Running';
  }
  return STATUS_TEXT[step.status ?? 'skipped'];
}

function openTitle(animeId: number): void {
  store.closePanel();
  libraryStore.navigate('library');
  libraryStore.openAnime(animeId);
}

function onKeydown(e: KeyboardEvent): void {
  // The review sheet over this panel takes its own Escape (#585).
  if (e.key === 'Escape' && !sync.reviewOpen) store.closePanel();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    class="po-backdrop"
    :style="{ zIndex: LAYER.prepareOfflinePanel }"
    @click.self="store.closePanel()"
  >
    <div class="po-modal" role="dialog" aria-modal="true" data-testid="prepare-offline-panel">
      <div class="po-title">Prepare for offline</div>
      <p class="po-text">
        Refreshes your titles' details and posters, installs and checks ffmpeg, checks your
        downloads and Shared Libraries, and syncs the libraries you own.
      </p>
      <ul v-if="run" class="po-steps">
        <li
          v-for="step in run.steps"
          :key="step.id"
          class="po-step"
          :data-step="step.id"
          :data-status="step.state === 'done' ? step.status : step.state"
        >
          <div class="po-row">
            <span class="po-icon" :class="step.state === 'done' ? step.status : step.state" />
            <span class="po-label">{{ step.label }}</span>
            <span class="po-status">{{ statusOf(step) }}</span>
            <button
              v-if="step.id === 'library-sync' && step.state === 'done' && conflictCount > 0"
              class="btn btn-outline btn-sm"
              data-testid="prepare-offline-review"
              @click="sync.openReview()"
            >
              Review ({{ conflictCount }})
            </button>
            <button
              v-if="step.details.length > 0 || step.reason"
              class="btn btn-ghost btn-sm"
              @click="toggle(step.id)"
            >
              {{ expanded.has(step.id) ? 'Hide' : 'Details' }}
            </button>
          </div>
          <div v-if="step.state === 'running' && step.message" class="po-message">
            {{ step.message }}
          </div>
          <div v-if="step.reason" class="po-reason">{{ step.reason }}</div>
          <ul v-if="expanded.has(step.id)" class="po-details">
            <li v-for="(d, i) in step.details" :key="i" :class="d.status">
              <a v-if="d.animeId" href="#" @click.prevent="openTitle(d.animeId)">{{ d.text }}</a>
              <span v-else>{{ d.text }}</span>
            </li>
          </ul>
        </li>
      </ul>
      <p v-if="finished && run?.cancelled" class="po-text">Cancelled.</p>
      <p class="po-last">{{ lastPreparedText }}</p>
      <div class="po-actions">
        <button
          v-if="running"
          class="btn btn-outline"
          data-testid="prepare-offline-cancel"
          @click="store.cancel()"
        >
          Cancel
        </button>
        <button
          v-else
          class="btn btn-primary"
          data-testid="prepare-offline-run"
          @click="store.start()"
        >
          {{ run ? 'Run again' : 'Start' }}
        </button>
        <button class="btn btn-ghost" @click="store.closePanel()">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.po-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}

.po-modal {
  width: 560px;
  max-width: calc(100% - 40px);
  max-height: calc(100% - 60px);
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--surface-3);
  border-radius: 10px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.po-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.po-text,
.po-last {
  font-size: 0.9rem;
  color: var(--text-2);
}

.po-last {
  color: var(--text-3);
}

.po-steps,
.po-details {
  list-style: none;
  margin: 0;
  padding: 0;
}

.po-step {
  padding: 8px 0;
  border-top: 1px solid var(--border-soft);
}

.po-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.po-label {
  flex: 1;
  color: var(--text);
  font-size: 0.92rem;
}

.po-status {
  color: var(--text-2);
  font-size: 0.85rem;
  font-family: var(--font-data);
}

.po-icon {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--surface-3);
  flex-shrink: 0;
}

.po-icon.running {
  background: transparent;
  border: 2px solid var(--accent);
  border-top-color: transparent;
  animation: po-spin 0.8s linear infinite;
}

.po-icon.ok {
  background: var(--st-green);
}

.po-icon.warning {
  background: var(--st-orange);
}

.po-icon.failed {
  background: var(--st-red);
}

.po-icon.skipped,
.po-icon.unavailable {
  background: var(--text-faint);
}

.po-message,
.po-reason {
  margin-left: 20px;
  font-size: 0.82rem;
  color: var(--text-3);
}

.po-details {
  margin: 6px 0 0 20px;
  font-size: 0.82rem;
  color: var(--text-2);
}

.po-details li.warning,
.po-details li.warning a {
  color: var(--st-orange);
}

.po-details li.failed,
.po-details li.failed a {
  color: var(--st-red);
}

.po-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

@keyframes po-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
