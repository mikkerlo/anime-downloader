<script setup lang="ts">
// "Export to a Shared Library" (#574). The tree comes from main once; the size
// estimate and the free-space bar refresh live as the selection changes, and
// the target is re-planned when the folder or the library name changes.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { exportEstimate, fitsFreeSpace, requiredBytes } from '@shared/shared-library-export';
import { formatBytes } from '../../utils';
import { useExportStore } from '../../stores/export';
import ExportTree from './ExportTree.vue';
import { allKeys, toSelection } from './export-selection';

const props = defineProps<{
  /** The titles to show; null for every downloaded title. */
  animeIds: number[] | null;
  /** Start with every ready episode of `animeIds` selected. */
  preselect?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const exportStore = useExportStore();

const titles = ref<ExportTreeTitle[]>([]);
const selected = ref(new Set<string>());
const target = ref<ExportTarget | null>(null);
const dir = ref<string | null>(null);
const name = ref('Anime Library');
const loading = ref(true);
const planning = ref(false);
const starting = ref(false);
const error = ref('');
let nameTimer: ReturnType<typeof setTimeout> | null = null;

const present = computed(() => target.value?.present ?? []);
const estimate = computed(() => exportEstimate(titles.value, selected.value, present.value));
const free = computed(() => target.value?.free ?? null);
const fits = computed(() => fitsFreeSpace(estimate.value.bytes, free.value));
const barPercent = computed(() => {
  if (free.value === null || free.value <= 0) return 0;
  return Math.min(100, (requiredBytes(estimate.value.bytes) / free.value) * 100);
});

const targetLine = computed(() => {
  const t = target.value;
  if (!t) return '';
  switch (t.kind) {
    case 'new':
      return `New library '${t.libraryName}'`;
    case 'add':
      // Next to a foreign library: the sibling an earlier export made.
      return t.ownerNickname !== undefined
        ? `This drive has ${t.ownerNickname}'s library. Your export adds to '${t.libraryName}' (Videos only) next to it.`
        : `Adds to '${t.libraryName}' (Videos only)`;
    case 'own-metadata':
      return 'This library carries watch state. Adding to it needs With metadata.';
    case 'foreign':
      return `This drive has ${t.ownerNickname}'s library. Your export goes into a new library next to it.`;
    case 'read-only':
      return t.blocked ?? 'This library can’t be written by this version.';
  }
  return '';
});

const blockedReason = computed(() => {
  if (!dir.value) return 'Choose a folder first.';
  if (planning.value) return 'Checking the folder…';
  if (target.value?.blocked) return target.value.blocked;
  if (estimate.value.items === 0) return 'Nothing to copy.';
  if (!fits.value) return 'The selection doesn’t fit on the drive.';
  if (exportStore.activeJob) return 'Another export is running.';
  return null;
});

async function replan(): Promise<void> {
  if (!dir.value) return;
  planning.value = true;
  try {
    // The tree's titles again, so main can tell which items the target already has.
    const plan = await window.api.exportPlan({
      animeIds: titles.value.map((t) => t.animeId),
      target: dir.value,
      name: name.value
    });
    target.value = plan.target;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    planning.value = false;
  }
}

onMounted(async () => {
  try {
    const plan = await window.api.exportPlan({
      // A plain array: IPC can't clone a reactive proxy.
      animeIds: props.animeIds ? [...props.animeIds] : null,
      target: null,
      name: name.value
    });
    titles.value = plan.titles;
    if (props.preselect) selected.value = new Set(allKeys(plan.titles));
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  if (nameTimer) clearTimeout(nameTimer);
});

async function pickFolder(): Promise<void> {
  const picked = await window.api.exportPickTarget();
  if (!picked) return;
  dir.value = picked;
  await replan();
}

function onNameInput(): void {
  if (nameTimer) clearTimeout(nameTimer);
  nameTimer = setTimeout(() => void replan(), 300);
}

async function startExport(): Promise<void> {
  if (blockedReason.value || !dir.value) return;
  starting.value = true;
  error.value = '';
  try {
    const result = await exportStore.start({
      selection: toSelection(titles.value, selected.value),
      target: dir.value,
      name: name.value
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
  <div class="export-backdrop" @click.self="emit('close')">
    <div class="export-modal" data-testid="export-dialog">
      <div class="export-title">Export to a Shared Library</div>
      <p class="hint">
        Copies the selected episodes to a folder another PC can open, or that plays with VLC.
      </p>

      <div v-if="loading" class="hint">Loading…</div>
      <ExportTree
        v-else
        :titles="titles"
        :selected="selected"
        :present="present"
        @update:selected="selected = $event"
      />

      <div class="field">
        <button class="btn btn-outline btn-sm" data-testid="export-pick" @click="pickFolder">
          Choose folder…
        </button>
        <span class="dir" :title="dir ?? ''">{{ dir ?? 'No folder chosen' }}</span>
      </div>
      <label class="field">
        <span class="label">Library name</span>
        <input
          v-model="name"
          class="name-input"
          data-testid="export-name"
          type="text"
          @input="onNameInput"
        />
      </label>
      <div
        v-if="target"
        class="target-line"
        :class="{ blocked: !!target.blocked }"
        data-testid="export-target-line"
      >
        {{ targetLine }}
      </div>

      <div class="mode">
        <label><input type="radio" checked /> Videos only</label>
        <label class="disabled" title="Coming soon">
          <input type="radio" disabled /> With metadata <span class="soon">Coming soon</span>
        </label>
      </div>

      <div class="space">
        <div class="bar" :class="{ over: !fits }" data-testid="export-space-bar">
          <div class="fill" :style="{ width: `${barPercent}%` }"></div>
        </div>
        <div class="space-text">
          {{ formatBytes(estimate.bytes) }} to copy ({{ estimate.items }} episodes)
          <template v-if="free !== null"> · {{ formatBytes(free) }} free</template>
          <template v-if="estimate.alreadyThere > 0">
            · {{ estimate.alreadyThere }} already on the drive</template
          >
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <span v-if="blockedReason" class="why">{{ blockedReason }}</span>
        <button class="btn btn-secondary" @click="emit('close')">Cancel</button>
        <button
          class="btn btn-primary"
          data-testid="export-start"
          :disabled="!!blockedReason || starting"
          @click="startExport"
        >
          {{ starting ? 'Starting…' : 'Export' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.export-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
}

.export-modal {
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

.export-title {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
}

.hint {
  font-size: 0.85rem;
  color: var(--text-3);
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.85rem;
}

.field .label {
  color: var(--text-2);
  min-width: 96px;
}

.dir {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name-input {
  flex: 1;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  color: var(--text);
  padding: 6px 8px;
}

.target-line {
  font-size: 0.85rem;
  color: var(--st-green);
}

.target-line.blocked {
  color: var(--st-orange);
}

.mode {
  display: flex;
  gap: 18px;
  font-size: 0.85rem;
  color: var(--text-2);
}

.mode .disabled {
  opacity: 0.5;
}

.soon {
  font-size: 0.7rem;
  color: var(--text-3);
}

.bar {
  height: 8px;
  border-radius: 4px;
  background: var(--surface-3);
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
  margin-top: 4px;
  font-size: 0.78rem;
  color: var(--text-3);
}

.error {
  font-size: 0.82rem;
  color: var(--st-red);
}

.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.why {
  flex: 1;
  font-size: 0.78rem;
  color: var(--text-3);
}
</style>
