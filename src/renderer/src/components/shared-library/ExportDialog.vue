<script setup lang="ts">
// "Export to a Shared Library" (#574). The tree comes from main once; the size
// estimate and the free-space bar refresh live as the selection changes, and
// the target is re-planned when the folder or the library name changes. The
// preflight (#575) comes with each plan and is narrowed to the selection here.
// Unmerged pairs (#576) are merged into MKV by default when this PC has ffmpeg.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { availableCodecs } from '@shared/video-codecs';
import {
  exportEstimate,
  fitsFreeSpace,
  mayBeSkippedWarning,
  overflowWarning,
  preflightForSelection,
  renamedWarning,
  requiredBytes,
  skippedWarning
} from '@shared/shared-library-export';
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
const planPreflight = ref<ExportPreflight | null>(null);
const dir = ref<string | null>(null);
const name = ref('Anime Library');
const loading = ref(true);
const planning = ref(false);
const starting = ref(false);
const error = ref('');
let nameTimer: ReturnType<typeof setTimeout> | null = null;
// Main probes each folder once while this dialog is open.
const session = crypto.randomUUID();

// Merge into MKV (#576): offered when ffmpeg is on this PC, with `copy` (no
// re-encode) as the codec until the user picks one.
const mergeSupport = ref<ExportMergeSupport>({ available: false, encoders: [] });
const unmerged = ref<ExportUnmergedMode>('copy-as-is');
const codec = ref('copy');
const canMerge = computed(() => mergeSupport.value.available);
const codecOptions = computed(() =>
  availableCodecs(mergeSupport.value.encoders).map((c) =>
    c.value === 'copy' ? { ...c, label: 'No (fastest)' } : c
  )
);
const choice = computed(() => ({
  merge: canMerge.value && unmerged.value === 'merge',
  reencode: codec.value !== 'copy'
}));

const preflight = computed(() =>
  planPreflight.value ? preflightForSelection(planPreflight.value, selected.value) : null
);
const itemLabels = computed(() => {
  const out = new Map<string, string>();
  for (const t of titles.value) {
    for (const tr of t.translations) {
      for (const ep of tr.episodes) out.set(ep.key, `${t.name} — ${ep.label} (${tr.author})`);
    }
  }
  return out;
});
const labelOf = (key: string): string => itemLabels.value.get(key) ?? key;

const present = computed(() => target.value?.present ?? []);
// Files preflight skips (over 4 GB on FAT32) aren't copied, so they don't count.
const toEstimate = computed(() => {
  const skipped = preflight.value?.skipped ?? [];
  if (skipped.length === 0) return selected.value;
  const out = new Set(selected.value);
  for (const k of skipped) out.delete(k);
  return out;
});
const estimate = computed(() =>
  exportEstimate(titles.value, toEstimate.value, present.value, choice.value)
);
// A re-encode's output size is unknown: the estimate is the source plus 10%.
const sizeWillChange = computed(
  () => choice.value.merge && choice.value.reencode && estimate.value.unmerged > 0
);
// Selected pairs already on the drive as an MKV an export merged (#623): a
// re-encode doesn't redo them.
const notReencoded = computed(() => {
  if (!choice.value.merge || !choice.value.reencode) return 0;
  return (target.value?.presentMerged ?? []).filter((k) => selected.value.has(k)).length;
});
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
  if (preflight.value && !preflight.value.ok) return preflight.value.blockers.join(' ');
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
      name: name.value,
      session,
      unmerged: choice.value.merge ? 'merge' : 'copy-as-is',
      codec: codec.value
    });
    target.value = plan.target;
    planPreflight.value = plan.preflight ?? null;
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
    if (plan.merge) mergeSupport.value = plan.merge;
    unmerged.value = mergeSupport.value.available ? 'merge' : 'copy-as-is';
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

// The preflight's names (`.mkv`) and FAT32 sizes depend on the merge choice.
watch([unmerged, codec], () => void replan());

async function startExport(): Promise<void> {
  if (blockedReason.value || !dir.value) return;
  starting.value = true;
  error.value = '';
  try {
    const result = await exportStore.start({
      selection: toSelection(titles.value, selected.value),
      target: dir.value,
      name: name.value,
      unmerged: choice.value.merge ? 'merge' : 'copy-as-is',
      codec: codec.value
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

      <div v-if="estimate.unmerged > 0" class="unmerged" data-testid="export-unmerged">
        <div class="unmerged-title">Unmerged episodes ({{ estimate.unmerged }}):</div>
        <div class="mode">
          <label>
            <input
              v-model="unmerged"
              type="radio"
              value="copy-as-is"
              data-testid="export-unmerged-copy"
            />
            Copy .mp4 + .ass as they are
          </label>
          <label :class="{ disabled: !canMerge }">
            <input
              v-model="unmerged"
              type="radio"
              value="merge"
              :disabled="!canMerge"
              data-testid="export-unmerged-merge"
            />
            Merge into MKV
          </label>
        </div>
        <div v-if="!canMerge" class="hint" data-testid="export-merge-missing">
          ffmpeg isn't installed on this PC. Download it in Settings → Merging
        </div>
        <template v-else-if="unmerged === 'merge'">
          <label class="field">
            <span class="label">Re-encode video</span>
            <select v-model="codec" data-testid="export-codec">
              <option v-for="c in codecOptions" :key="c.value" :value="c.value">
                {{ c.label }}
              </option>
            </select>
          </label>
          <div class="hint">Resolution is never reduced.</div>
          <div class="hint">
            Other PCs need ffmpeg to play .mkv files. They download it once while online.
          </div>
        </template>
      </div>
      <div v-if="notReencoded > 0" class="hint" data-testid="export-not-reencoded">
        {{ notReencoded }} {{ notReencoded === 1 ? 'episode is' : 'episodes are' }} already on the
        drive as MKV and won’t be re-encoded.
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
          <template v-if="sizeWillChange"> · size will change</template>
        </div>
      </div>

      <div
        v-if="
          preflight &&
          (preflight.blockers.length > 0 ||
            preflight.driveWarnings.length > 0 ||
            preflight.skipped.length > 0 ||
            preflight.mayBeSkipped.length > 0 ||
            preflight.renamed.length > 0 ||
            preflight.overflow.length > 0)
        "
        class="preflight"
        data-testid="export-preflight"
      >
        <div class="preflight-title">Preflight</div>
        <div v-for="b in preflight.blockers" :key="b" class="pf-blocker">{{ b }}</div>
        <div v-for="w in preflight.driveWarnings" :key="w" class="pf-warning">{{ w }}</div>
        <details v-if="preflight.skipped.length > 0" class="pf-warning" data-testid="pf-skipped">
          <summary>{{ skippedWarning(preflight.skipped.length) }}</summary>
          <div v-for="k in preflight.skipped" :key="k" class="pf-item">{{ labelOf(k) }}</div>
        </details>
        <details v-if="preflight.mayBeSkipped.length > 0" class="pf-warning">
          <summary>{{ mayBeSkippedWarning(preflight.mayBeSkipped.length) }}</summary>
          <div v-for="k in preflight.mayBeSkipped" :key="k" class="pf-item">{{ labelOf(k) }}</div>
        </details>
        <details v-if="preflight.renamed.length > 0" class="pf-warning" data-testid="pf-renamed">
          <summary>{{ renamedWarning(preflight.renamed.length) }}</summary>
          <div v-for="k in preflight.renamed" :key="k" class="pf-item">
            {{ preflight.renames[k]?.from ?? labelOf(k) }} →
            {{ preflight.renames[k]?.to ?? '' }}
          </div>
        </details>
        <details v-if="preflight.overflow.length > 0" class="pf-warning" data-testid="pf-overflow">
          <summary>{{ overflowWarning(preflight.overflow.length) }}</summary>
          <div v-for="k in preflight.overflow" :key="k" class="pf-item">{{ labelOf(k) }}</div>
        </details>
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

.unmerged {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.unmerged-title {
  font-size: 0.85rem;
  color: var(--text-2);
}

.unmerged select {
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  color: var(--text);
  padding: 4px 6px;
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

.preflight {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  padding: 8px 10px;
  font-size: 0.8rem;
}

.preflight-title {
  font-weight: 600;
  color: var(--text-2);
}

.pf-blocker {
  color: var(--st-red);
}

.pf-warning {
  color: var(--st-orange);
}

.pf-item {
  margin-left: 14px;
  color: var(--text-3);
  overflow-wrap: anywhere;
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
