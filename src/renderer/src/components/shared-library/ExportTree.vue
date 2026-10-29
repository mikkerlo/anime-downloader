<script setup lang="ts">
// The title → translation → episode tree of the export dialog (#574), with
// tri-state checkboxes and per-node sizes. Missing and busy episodes are shown
// greyed out and can't be selected. Episodes that aren't downloaded at all can
// be, while pre-fetch is on (#577): the export downloads them first, in the
// translation picked for each.
import { computed, ref } from 'vue';
import { formatBytes } from '../../utils';
import {
  missingOnDrive,
  nodeKeys,
  pickedOption,
  prefetchKey,
  readyKeys,
  sizeOf,
  stateOf,
  titleSize,
  toggle,
  type TriState
} from './export-selection';

const props = withDefaults(
  defineProps<{
    titles: ExportTreeTitle[];
    selected: Set<string>;
    /** Keys the target already has: shown as "On the drive", not counted. */
    present: string[];
    /** Whether not-downloaded episodes can be pre-fetched (#577). */
    prefetch?: ExportPrefetchGate;
    /** The translation picked per not-downloaded episode, by its `pf:` key. */
    choices?: Record<string, number>;
    /** Not-downloaded episodes the target has (`presentMissing`): "On the drive". */
    onDrive?: string[];
    /** The copy to this PC (#579) reuses the tree: what a `missing` episode and no titles say. */
    missingLabel?: string;
    emptyLabel?: string;
  }>(),
  {
    prefetch: 'unavailable',
    choices: () => ({}),
    onDrive: () => [],
    missingLabel: 'Not downloaded',
    emptyLabel: 'No downloaded episodes to export.'
  }
);

const emit = defineEmits<{
  'update:selected': [selected: Set<string>];
  'update:choices': [choices: Record<string, number>];
}>();

const prefetchOn = computed(() => props.prefetch === 'ok');

const GATE_NOTE: Record<ExportPrefetchGate, string | null> = {
  ok: null,
  offline: 'Needs internet to download',
  'no-token': 'API token is required for downloads',
  unavailable: null
};

const onDriveSet = computed(() => new Set(props.onDrive));

function canPrefetch(t: ExportTreeTitle, e: ExportNotDownloaded): boolean {
  return (
    prefetchOn.value && e.options.length > 0 && !missingOnDrive(t.animeId, e, onDriveSet.value)
  );
}

function prefetchNote(t: ExportTreeTitle, e: ExportNotDownloaded): string {
  // Exported earlier and deleted here since: nothing to download.
  if (missingOnDrive(t.animeId, e, onDriveSet.value)) return 'On the drive';
  const gate = GATE_NOTE[props.prefetch];
  if (gate) return gate;
  if (e.unavailable) return e.unavailable;
  if (!prefetchOn.value) return 'Not downloaded';
  const o = pickedOption(e, prefetchKey(t.animeId, e.episodeInt), props.choices);
  const size = o?.sizeBytes == null ? 'size unknown' : `~${formatBytes(o.sizeBytes)}`;
  return `Will be downloaded first (${size})`;
}

function choose(key: string, ev: Event): void {
  const id = Number((ev.target as HTMLSelectElement).value);
  emit('update:choices', { ...props.choices, [key]: id });
}

const collapsed = ref(new Set<string>());

function isOpen(id: string): boolean {
  return !collapsed.value.has(id);
}

function flip(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function click(keys: string[]): void {
  emit('update:selected', toggle(keys, props.selected));
}

function checkState(keys: string[]): TriState {
  return stateOf(keys, props.selected);
}

function episodeNote(e: ExportTreeEpisode): string {
  if (e.state === 'missing') return props.missingLabel;
  if (e.state === 'busy') return 'Busy (merging or downloading)';
  if (props.present.includes(e.key)) return 'On the drive';
  return e.unmerged ? `${formatBytes(e.size)} · .mp4 + .ass` : formatBytes(e.size);
}
</script>

<template>
  <div class="export-tree" data-testid="export-tree">
    <div v-if="titles.length === 0" class="empty">{{ emptyLabel }}</div>
    <div v-for="t in titles" :key="t.animeId" class="node title-node">
      <div class="row">
        <button
          class="caret"
          :aria-expanded="isOpen(`t${t.animeId}`)"
          @click="flip(`t${t.animeId}`)"
        >
          {{ isOpen(`t${t.animeId}`) ? '▾' : '▸' }}
        </button>
        <input
          type="checkbox"
          :data-testid="`tree-title-${t.animeId}`"
          :checked="checkState(nodeKeys(t, prefetchOn, onDriveSet)) === 'checked'"
          :indeterminate="checkState(nodeKeys(t, prefetchOn, onDriveSet)) === 'partial'"
          :disabled="nodeKeys(t, prefetchOn, onDriveSet).length === 0"
          @change="click(nodeKeys(t, prefetchOn, onDriveSet))"
        />
        <span class="name">{{ t.name }}</span>
        <span class="size">{{ formatBytes(titleSize(t)) }}</span>
      </div>
      <div v-if="isOpen(`t${t.animeId}`)" class="children">
        <div v-for="tr in t.translations" :key="tr.translationId" class="node">
          <div class="row">
            <button
              class="caret"
              :aria-expanded="isOpen(`r${tr.translationId}`)"
              @click="flip(`r${tr.translationId}`)"
            >
              {{ isOpen(`r${tr.translationId}`) ? '▾' : '▸' }}
            </button>
            <input
              type="checkbox"
              :data-testid="`tree-translation-${tr.translationId}`"
              :checked="checkState(readyKeys(tr.episodes)) === 'checked'"
              :indeterminate="checkState(readyKeys(tr.episodes)) === 'partial'"
              :disabled="readyKeys(tr.episodes).length === 0"
              @change="click(readyKeys(tr.episodes))"
            />
            <span class="name">{{ tr.author || 'Unknown' }}</span>
            <span class="meta">{{ tr.translationType }} · {{ tr.quality }}p</span>
            <span class="size">{{ formatBytes(sizeOf(tr.episodes)) }}</span>
          </div>
          <div v-if="isOpen(`r${tr.translationId}`)" class="children">
            <label
              v-for="e in tr.episodes"
              :key="e.key"
              class="row episode"
              :class="{ unavailable: e.state !== 'ready' }"
            >
              <input
                type="checkbox"
                :data-testid="`tree-episode-${e.key}`"
                :checked="selected.has(e.key)"
                :disabled="e.state !== 'ready'"
                @change="click([e.key])"
              />
              <span class="name">{{ e.label }}</span>
              <span class="size">{{ episodeNote(e) }}</span>
            </label>
          </div>
        </div>
        <div
          v-for="e in t.notDownloaded"
          :key="`nd-${e.episodeInt}`"
          class="row episode"
          :class="{ unavailable: !canPrefetch(t, e) }"
          :data-testid="`tree-missing-${t.animeId}-${e.episodeInt}`"
        >
          <input
            type="checkbox"
            :data-testid="`tree-prefetch-${t.animeId}-${e.episodeInt}`"
            :checked="selected.has(prefetchKey(t.animeId, e.episodeInt))"
            :disabled="!canPrefetch(t, e)"
            @change="click([prefetchKey(t.animeId, e.episodeInt)])"
          />
          <span v-if="canPrefetch(t, e)" class="cloud" aria-hidden="true">☁</span>
          <span class="name">{{ e.label }}</span>
          <select
            v-if="canPrefetch(t, e) && e.options.length > 1"
            class="tr-pick"
            :data-testid="`tree-prefetch-tr-${t.animeId}-${e.episodeInt}`"
            :value="pickedOption(e, prefetchKey(t.animeId, e.episodeInt), choices)?.translationId"
            @change="choose(prefetchKey(t.animeId, e.episodeInt), $event)"
          >
            <option v-for="o in e.options" :key="o.translationId" :value="o.translationId">
              {{ o.author || 'Unknown' }} · {{ o.translationType }} · {{ o.height }}p
            </option>
          </select>
          <span class="size">{{ prefetchNote(t, e) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.export-tree {
  max-height: 340px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  padding: 6px 8px;
  background: var(--bg-deep);
}

.empty {
  color: var(--text-faint);
  padding: 12px;
  text-align: center;
}

.children {
  padding-left: 22px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 0.85rem;
  color: var(--text);
}

.row .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row .meta {
  color: var(--text-3);
  font-size: 0.75rem;
}

.row .size {
  color: var(--text-3);
  font-family: var(--font-data);
  font-size: 0.75rem;
}

.title-node > .row .name {
  font-weight: 600;
}

.unavailable {
  opacity: 0.45;
}

.cloud {
  color: var(--accent);
  font-size: 0.8rem;
}

.tr-pick {
  max-width: 180px;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  color: var(--text);
  font-size: 0.75rem;
  padding: 1px 4px;
}

.caret {
  width: 18px;
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0;
}
</style>
