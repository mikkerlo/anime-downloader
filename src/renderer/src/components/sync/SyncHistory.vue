<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSyncStore } from '../../stores/sync';
import { formatAgo } from '../../utils';

// The sync history (#585): a read-only, reverse-chronological list of runs and
// choices, each expandable to its lines. There is no undo and no per-entry
// action; the title page is where a value changes again.
const sync = useSyncStore();
const { history } = storeToRefs(sync);
const open = ref<Set<string>>(new Set());

const heading = computed(() =>
  history.value?.libraryId
    ? `Sync history: ${sync.libraryName(history.value.libraryId)}`
    : 'Sync history'
);

function toggle(key: string): void {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
}
</script>

<template>
  <div v-if="history" class="sl-backdrop" @click.self="sync.closeHistory()">
    <div class="sl-modal sheet" data-testid="sync-history">
      <div class="sl-title">{{ heading }}</div>
      <p class="sl-muted">You can change any of these later from the title page.</p>
      <p
        v-if="!history.loading && history.entries.length === 0"
        class="sl-text"
        data-testid="history-empty"
      >
        Nothing has been synced yet.
      </p>
      <ul class="entries">
        <li
          v-for="e in history.entries"
          :key="e.key"
          class="entry"
          data-testid="history-entry"
          :data-kind="e.kind"
        >
          <button
            class="entry-head"
            data-testid="history-expand"
            :aria-expanded="open.has(e.key)"
            :disabled="e.details.length === 0"
            @click="toggle(e.key)"
          >
            <span class="when" :title="new Date(e.at).toLocaleString()">{{ formatAgo(e.at) }}</span>
            <span class="summary">{{ e.summary }}</span>
            <span v-if="e.libraries.length > 0" class="sl-muted">{{
              e.libraries.map((l) => l.name).join(', ')
            }}</span>
          </button>
          <ul v-if="open.has(e.key)" class="details" data-testid="history-details">
            <li v-for="(d, i) in e.details" :key="i">{{ d }}</li>
          </ul>
        </li>
      </ul>
      <div class="sl-actions">
        <button
          v-if="history.nextBefore !== null"
          class="sl-btn"
          data-testid="history-more"
          :disabled="history.loading"
          @click="sync.loadMoreHistory()"
        >
          Show older
        </button>
        <button class="sl-btn" @click="sync.closeHistory()">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="../shared-library/shared-library.css"></style>

<style scoped>
.sheet {
  width: 680px;
}

.entries,
.details {
  list-style: none;
  margin: 0;
  padding: 0;
}

.entry {
  border-top: 1px solid var(--border);
}

.entry-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
  background: none;
  border: none;
  color: var(--text-2);
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
}

.entry-head:disabled {
  cursor: default;
}

.when {
  color: var(--text-3);
  min-width: 90px;
}

.summary {
  color: var(--text);
}

.details {
  padding: 0 0 8px 100px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 0.8rem;
  color: var(--text-2);
}
</style>
