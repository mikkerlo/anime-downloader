<script setup lang="ts">
import { useLibraryStore } from '../../stores/library';

const props = defineProps<{
  shikiRelated: ShikiRelatedEntry[];
  relatedLoading: boolean;
}>();

const collapsed = defineModel<boolean>('collapsed', { default: true });

const libraryStore = useLibraryStore();

const KIND_LABELS: Record<string, string> = {
  tv: 'TV',
  tv_13: 'TV',
  tv_24: 'TV',
  tv_48: 'TV',
  movie: 'Movie',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
  music: 'Music',
  tv_special: 'TV Special',
  pv: 'PV',
  cm: 'CM'
};

const STATUS_LABELS: Record<string, string> = {
  planned: 'Planned',
  watching: 'Watching',
  rewatching: 'Rewatching',
  completed: 'Watched',
  on_hold: 'On Hold',
  dropped: 'Dropped'
};

function open(entry: ShikiRelatedEntry): void {
  if (entry.smotretAnime && !entry.isCurrent) {
    libraryStore.openAnime(entry.smotretAnime.id);
  }
}
</script>

<template>
  <div class="related-panel">
    <div class="related-header" @click="collapsed = !collapsed">
      <div class="related-header-left">
        <svg
          class="related-chevron"
          :class="{ collapsed }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="14"
          height="14"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
        </svg>
        <span class="related-label">Chronology</span>
      </div>
      <span v-if="relatedLoading" class="related-summary">Loading...</span>
      <span v-else-if="props.shikiRelated.length > 0" class="related-summary"
        >{{ props.shikiRelated.length }}
        {{ props.shikiRelated.length === 1 ? 'entry' : 'entries' }}</span
      >
    </div>
    <div v-if="!collapsed" class="related-body">
      <div v-if="relatedLoading" class="related-loading">Loading chronology...</div>
      <div v-else class="related-list">
        <div
          v-for="entry in props.shikiRelated"
          :key="entry.shikiAnime.id"
          class="related-row"
          :class="{
            clickable: entry.smotretAnime && !entry.isCurrent,
            unavailable: !entry.smotretAnime,
            current: entry.isCurrent
          }"
          :role="entry.smotretAnime && !entry.isCurrent ? 'button' : undefined"
          :tabindex="entry.smotretAnime && !entry.isCurrent ? 0 : undefined"
          @click="open(entry)"
          @keydown.enter.prevent="open(entry)"
          @keydown.space.prevent="open(entry)"
        >
          <img
            :src="entry.smotretAnime?.posterUrlSmall || entry.shikiAnime.image_url || ''"
            :alt="entry.shikiAnime.name"
            class="related-thumb"
            loading="lazy"
          />
          <div class="related-info">
            <div class="related-title">{{ entry.shikiAnime.name }}</div>
            <div class="related-meta">
              <span v-if="entry.shikiAnime.kind" class="related-kind">{{
                KIND_LABELS[entry.shikiAnime.kind] || entry.shikiAnime.kind.toUpperCase()
              }}</span>
              <span v-if="entry.shikiAnime.year" class="related-year">{{
                entry.shikiAnime.year
              }}</span>
              <span v-if="entry.relation" class="related-relation">{{ entry.relation }}</span>
              <span v-if="entry.isCurrent" class="related-current-badge">Current</span>
              <span
                v-if="entry.watchStatus"
                class="related-status-badge"
                :class="'status-' + entry.watchStatus"
              >
                {{ STATUS_LABELS[entry.watchStatus] }}
              </span>
              <span v-if="!entry.smotretAnime && !entry.isCurrent" class="related-unavailable-badge"
                >Not available</span
              >
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.related-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.related-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.related-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.related-chevron {
  color: #a0a0b8;
  transition: transform 0.15s;
}

.related-chevron.collapsed {
  transform: rotate(-90deg);
}

.related-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.related-summary {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.related-body {
  margin-top: 10px;
}

.related-loading {
  font-size: 0.85rem;
  color: #6a6a8a;
}

.related-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.related-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  transition: background-color 0.1s;
}

.related-row.clickable {
  cursor: pointer;
}

.related-row.clickable:hover,
.related-row.clickable:focus-visible {
  background-color: #1a2a4d;
  outline: none;
}

.related-row.unavailable {
  opacity: 0.55;
}

.related-row.current {
  background-color: #0f3460;
}

.related-thumb {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
  background-color: #0f3460;
}

.related-info {
  flex: 1;
  min-width: 0;
}

.related-title {
  color: #e0e0e0;
  font-size: 0.9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.related-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
  flex-wrap: wrap;
}

.related-kind {
  font-size: 0.7rem;
  font-weight: 600;
  color: #6a6a8a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.related-year {
  font-size: 0.72rem;
  color: #6a6a8a;
}

.related-relation {
  font-size: 0.78rem;
  color: #a0a0b8;
}

.related-current-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 600;
  background-color: #e9456033;
  color: #e94560;
  white-space: nowrap;
}

.related-status-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.related-unavailable-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 600;
  background-color: #6a6a8a1a;
  color: #6a6a8a;
  white-space: nowrap;
}

.status-watching {
  background-color: #27ae601a;
  color: #6ab04c;
}

.status-completed {
  background-color: #3498db1a;
  color: #3498db;
}

.status-planned {
  background-color: #9b59b61a;
  color: #9b59b6;
}

.status-on_hold {
  background-color: #f39c121a;
  color: #f39c12;
}

.status-dropped {
  background-color: #e945601a;
  color: #e94560;
}

.status-rewatching {
  background-color: #1abc9c1a;
  color: #1abc9c;
}
</style>
