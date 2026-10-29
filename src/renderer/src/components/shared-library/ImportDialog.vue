<script setup lang="ts">
// "Copy to this PC" (one title) and "Import all" (every title of a library)
// from an attached Shared Library (#579). The tree is S6a's `ExportTree`, all
// preselected; the destination is the hot or the cold root; the size bar is
// the selection against that root's free space. Items whose names the library
// can't be trusted with are listed, greyed, with the reason.
import { computed, onMounted, ref } from 'vue';
import { fitsFreeSpace, requiredBytes } from '@shared/shared-library-export';
import { formatBytes } from '../../utils';
import { useImportStore } from '../../stores/import';
import ExportTree from './ExportTree.vue';
import { allKeys, sizeOf, toSelection } from './export-selection';

const props = defineProps<{
  libraryId: string;
  /** The titles to copy; null for every title in the library (Import all). */
  animeIds: number[] | null;
}>();

const emit = defineEmits<{ close: [] }>();

const importStore = useImportStore();

const plan = ref<ImportPlan | null>(null);
const selected = ref(new Set<string>());
const destination = ref<ImportDestination>('hot');
const loading = ref(true);
const starting = ref(false);
const error = ref('');

const titles = computed(() => plan.value?.titles ?? []);
const bytes = computed(() =>
  titles.value.reduce(
    (n, t) =>
      n +
      t.translations.reduce(
        (m, tr) => m + sizeOf(tr.episodes.filter((e) => selected.value.has(e.key))),
        0
      ),
    0
  )
);
const count = computed(() => toSelection(titles.value, selected.value).length);
const root = computed(() =>
  destination.value === 'cold' ? (plan.value?.cold ?? null) : (plan.value?.hot ?? null)
);
const free = computed(() => root.value?.free ?? null);
const fits = computed(() => fitsFreeSpace(bytes.value, free.value));
const barPercent = computed(() => {
  if (free.value === null || free.value <= 0) return 0;
  return Math.min(100, (requiredBytes(bytes.value) / free.value) * 100);
});

const blockedReason = computed(() => {
  if (loading.value) return 'Loading…';
  if (plan.value?.error) return plan.value.error;
  if (count.value === 0) return 'Nothing to copy.';
  if (!root.value) return plan.value?.coldUnavailable ?? 'Choose where to copy.';
  if (!fits.value) return 'The selection doesn’t fit on this PC.';
  if (importStore.activeJob) return 'Another copy is running.';
  return null;
});

onMounted(async () => {
  try {
    plan.value = await window.api.importPlan({
      libraryId: props.libraryId,
      // A plain array: IPC can't clone a reactive proxy.
      animeIds: props.animeIds ? [...props.animeIds] : null
    });
    selected.value = new Set(allKeys(plan.value.titles));
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

async function startImport(): Promise<void> {
  if (blockedReason.value) return;
  starting.value = true;
  error.value = '';
  try {
    const result = await importStore.start({
      libraryId: props.libraryId,
      selection: toSelection(titles.value, selected.value),
      destination: destination.value
    });
    if (result.ok) emit('close');
    else error.value = result.reason;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div class="import-backdrop" @click.self="emit('close')">
    <div class="import-modal" data-testid="import-dialog">
      <div class="import-title">
        {{ animeIds === null ? 'Import all' : 'Copy to this PC' }}
        <span v-if="plan?.libraryName" class="from">from {{ plan.libraryName }}</span>
      </div>
      <p class="hint">
        Copies the episodes onto this PC. They play without the drive, and count as downloads.
      </p>
      <div v-if="loading" class="hint">Loading…</div>
      <ExportTree
        v-else
        :titles="titles"
        :selected="selected"
        :present="[]"
        missing-label="Missing on the drive"
        empty-label="Nothing on this library to copy."
        @update:selected="selected = $event"
      />
      <details
        v-if="plan && plan.rejected.length > 0"
        class="rejected"
        data-testid="import-rejected"
        open
      >
        <summary>
          {{ plan.rejected.length }}
          {{ plan.rejected.length === 1 ? 'episode' : 'episodes' }} can’t be copied
        </summary>
        <div v-for="r in plan.rejected" :key="r.key" class="rejected-item">
          <span class="name">{{ r.label }}</span>
          <span class="reason">{{ r.reason }}</span>
        </div>
      </details>
      <div class="dest">
        <span class="label">Copy to</span>
        <label>
          <input v-model="destination" type="radio" value="hot" data-testid="import-dest-hot" />
          Downloads <span class="dir">{{ plan?.hot.dir }}</span>
        </label>
        <label :class="{ disabled: !plan?.cold }" :title="plan?.coldUnavailable ?? undefined">
          <input
            v-model="destination"
            type="radio"
            value="cold"
            :disabled="!plan?.cold"
            data-testid="import-dest-cold"
          />
          Cold storage <span v-if="plan?.cold" class="dir">{{ plan.cold.dir }}</span>
        </label>
      </div>
      <div class="space">
        <div class="bar" :class="{ over: !fits }" data-testid="import-space-bar">
          <div class="fill" :style="{ width: `${barPercent}%` }"></div>
        </div>
        <div class="space-text">
          {{ formatBytes(bytes) }} to copy ({{ count }} {{ count === 1 ? 'episode' : 'episodes' }})
          <template v-if="free !== null"> · {{ formatBytes(free) }} free</template>
        </div>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <span v-if="blockedReason" class="why">{{ blockedReason }}</span>
        <button class="sl-btn" @click="emit('close')">Cancel</button>
        <button
          class="sl-btn primary"
          data-testid="import-start"
          :disabled="!!blockedReason || starting"
          @click="startImport"
        >
          {{ starting ? 'Starting…' : 'Copy' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.import-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
}

.import-modal {
  width: 620px;
  max-width: calc(100% - 40px);
  max-height: calc(100% - 40px);
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-card);
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.import-title {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
}

.import-title .from {
  font-weight: 400;
  color: var(--text-3);
  font-size: 0.95rem;
}

.hint {
  font-size: 0.85rem;
  color: var(--text-3);
}

.rejected {
  font-size: 0.8rem;
  color: var(--text-3);
}

.rejected-item {
  display: flex;
  gap: 10px;
  opacity: 0.6;
  padding: 2px 0 2px 14px;
}

.rejected-item .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dest {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85rem;
  color: var(--text-2);
}

.dest .label {
  color: var(--text-2);
}

.dest .disabled {
  opacity: 0.5;
}

.dir {
  color: var(--text-3);
  font-family: var(--font-data);
  font-size: 0.75rem;
}

.space {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-deep);
  overflow: hidden;
}

.bar .fill {
  height: 100%;
  background: var(--accent);
}

.bar.over .fill {
  background: var(--st-red);
}

.space-text {
  font-size: 0.8rem;
  color: var(--text-3);
}

.error {
  color: var(--st-red);
  font-size: 0.85rem;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.why {
  flex: 1;
  font-size: 0.8rem;
  color: var(--text-3);
}
</style>
