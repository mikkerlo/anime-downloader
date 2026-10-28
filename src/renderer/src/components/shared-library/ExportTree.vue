<script setup lang="ts">
// The title → translation → episode tree of the export dialog (#574), with
// tri-state checkboxes and per-node sizes. Missing and busy episodes are shown
// greyed out and can't be selected.
import { ref } from 'vue';
import { formatBytes } from '../../utils';
import {
  readyKeys,
  sizeOf,
  stateOf,
  titleKeys,
  titleSize,
  toggle,
  type TriState
} from './export-selection';

const props = defineProps<{
  titles: ExportTreeTitle[];
  selected: Set<string>;
  /** Keys the target already has: shown as "On the drive", not counted. */
  present: string[];
}>();

const emit = defineEmits<{ 'update:selected': [selected: Set<string>] }>();

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
  if (e.state === 'missing') return 'Not downloaded';
  if (e.state === 'busy') return 'Busy (merging or downloading)';
  if (props.present.includes(e.key)) return 'On the drive';
  return e.unmerged ? `${formatBytes(e.size)} · .mp4 + .ass` : formatBytes(e.size);
}
</script>

<template>
  <div class="export-tree" data-testid="export-tree">
    <div v-if="titles.length === 0" class="empty">No downloaded episodes to export.</div>
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
          :checked="checkState(titleKeys(t)) === 'checked'"
          :indeterminate="checkState(titleKeys(t)) === 'partial'"
          :disabled="titleKeys(t).length === 0"
          @change="click(titleKeys(t))"
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
          class="row episode unavailable"
        >
          <input type="checkbox" disabled />
          <span class="name">{{ e.label }}</span>
          <span class="size">Not downloaded</span>
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

.caret {
  width: 18px;
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0;
}
</style>
