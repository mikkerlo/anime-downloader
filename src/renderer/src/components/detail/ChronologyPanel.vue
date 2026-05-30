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
  <div class="side-panel">
    <h4 class="panel-toggle" @click="collapsed = !collapsed">
      <svg
        class="chrono-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        width="17"
        height="17"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      Chronology
      <span v-if="relatedLoading" class="panel-summary">Loading…</span>
      <span v-else-if="props.shikiRelated.length > 0" class="panel-summary"
        >{{ props.shikiRelated.length }}
        {{ props.shikiRelated.length === 1 ? 'entry' : 'entries' }}</span
      >
      <svg
        class="panel-chevron"
        :class="{ collapsed }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        width="16"
        height="16"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
      </svg>
    </h4>
    <div v-if="!collapsed">
      <div v-if="relatedLoading" class="panel-muted">Loading chronology…</div>
      <div v-else class="chrono-list">
        <div
          v-for="entry in props.shikiRelated"
          :key="entry.shikiAnime.id"
          class="chrono-row"
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
          <div class="chrono-thumb" :class="{ cur: entry.isCurrent }">
            <img
              :src="entry.smotretAnime?.posterUrlSmall || entry.shikiAnime.image_url || ''"
              :alt="entry.shikiAnime.name"
              loading="lazy"
            />
          </div>
          <div class="chrono-info">
            <div class="chrono-rel">
              <template v-if="entry.isCurrent">You are here</template>
              <template v-else>{{
                entry.relation ||
                KIND_LABELS[entry.shikiAnime.kind || ''] ||
                (entry.shikiAnime.kind || '').toUpperCase()
              }}</template>
            </div>
            <div class="chrono-title">{{ entry.shikiAnime.name }}</div>
            <div
              v-if="entry.watchStatus || (!entry.smotretAnime && !entry.isCurrent)"
              class="chrono-tags"
            >
              <span
                v-if="entry.watchStatus"
                class="chrono-status"
                :class="'status-' + entry.watchStatus"
                >{{ STATUS_LABELS[entry.watchStatus] }}</span
              >
              <span v-if="!entry.smotretAnime && !entry.isCurrent" class="chrono-unavail"
                >Not available</span
              >
            </div>
          </div>
          <span v-if="entry.shikiAnime.year" class="chrono-year">{{ entry.shikiAnime.year }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.side-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 18px;
}

.panel-toggle {
  font-family: var(--font-display);
  font-size: 0.92rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.chrono-icon {
  color: var(--st-blue);
  flex-shrink: 0;
}

.panel-summary {
  font-family: var(--font-data);
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-3);
  margin-left: auto;
  white-space: nowrap;
}

.panel-chevron {
  color: var(--text-3);
  flex-shrink: 0;
  margin-left: 4px;
  transition: transform 0.2s var(--ease);
}

.panel-chevron.collapsed {
  transform: rotate(-90deg);
}

.panel-muted {
  margin-top: 12px;
  font-size: 0.82rem;
  color: var(--text-3);
}

.chrono-list {
  display: flex;
  flex-direction: column;
  margin-top: 6px;
}

.chrono-row {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 9px 0;
  border-top: 1px solid var(--border-soft);
  transition: opacity 0.15s;
}

.chrono-row:first-of-type {
  border-top: none;
}

.chrono-row.clickable {
  cursor: pointer;
}

.chrono-row.clickable:hover,
.chrono-row.clickable:focus-visible {
  opacity: 0.7;
  outline: none;
}

.chrono-row.clickable:hover .chrono-title {
  color: var(--accent);
}

.chrono-row.unavailable {
  opacity: 0.55;
}

.chrono-thumb {
  width: 34px;
  min-width: 34px;
  aspect-ratio: 2 / 3;
  border-radius: 5px;
  overflow: hidden;
  background: var(--surface-2);
}

.chrono-thumb.cur {
  box-shadow: 0 0 0 2px var(--accent);
}

.chrono-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.chrono-info {
  flex: 1;
  min-width: 0;
}

.chrono-rel {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.chrono-row.current .chrono-rel {
  color: var(--accent);
}

.chrono-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.15s;
}

.chrono-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 3px;
}

.chrono-status,
.chrono-unavail {
  font-size: 0.66rem;
  font-weight: 700;
}

.chrono-unavail {
  color: var(--text-faint);
}

.status-watching,
.status-rewatching {
  color: var(--st-green);
}

.status-completed {
  color: var(--st-blue);
}

.status-planned {
  color: var(--st-purple);
}

.status-on_hold {
  color: var(--st-orange);
}

.status-dropped {
  color: var(--st-red);
}

.chrono-year {
  font-family: var(--font-data);
  font-size: 0.72rem;
  color: var(--text-3);
  flex-shrink: 0;
}
</style>
