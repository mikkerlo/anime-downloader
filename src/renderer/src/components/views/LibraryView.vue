<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import AnimeCard from '../shared/AnimeCard.vue';
import ExportDialog from '../shared-library/ExportDialog.vue';
import SharedLibrariesTab from '../shared-library/SharedLibrariesTab.vue';
import OpenLibraryDialog from '../shared-library/OpenLibraryDialog.vue';
import { getAnimeName } from '../../utils';
import { useLibraryStore } from '../../stores/library';
import { useShikimoriStore } from '../../stores/shikimori';
import { useSharedLibrariesStore } from '../../stores/shared-libraries';
import { useImportStore } from '../../stores/import';
import { useSyncStore } from '../../stores/sync';

const libraryStore = useLibraryStore();
// Held merge conflicts (#585): the count badge on the Shared Libraries tab.
const { conflictCount } = storeToRefs(useSyncStore());
const shikimoriStore = useShikimoriStore();
const { rates } = storeToRefs(shikimoriStore);
const sharedStore = useSharedLibrariesStore();
const { attachedCount, librariesByAnimeId, focusTab } = storeToRefs(sharedStore);
const openDialog = ref(false);

const library = ref<AnimeSearchResult[]>([]);
const starredIds = ref(new Set<number>());
const downloadedIds = ref(new Set<number>());
// Local priority list: ordered smotret-anime ids (promote order), plus a
// derived rank map so the Priority tab can render as a queue. Purely local —
// it has no Shikimori dependency and survives logout.
const priorityIds = ref<number[]>([]);

// Join Shikimori rates onto library entries by smotret-anime id, so the
// status tabs can filter the saved library by watch status.
const statusBySmotretId = computed(() => {
  const map = new Map<number, ShikiUserRateStatus>();
  for (const e of rates.value) {
    if (e.smotretAnime) map.set(e.smotretAnime.id, e.rate.status);
  }
  return map;
});
// Only show the status tabs when at least one *library* entry has a resolved
// Shikimori status — not merely when the user has any tracked rates (which
// would surface tabs whose non-"All" options are all empty).
const hasStatuses = computed(() => library.value.some((a) => statusBySmotretId.value.has(a.id)));

const prioritySet = computed(() => new Set(priorityIds.value));
const priorityRank = computed(() => {
  const map = new Map<number, number>();
  priorityIds.value.forEach((id, i) => map.set(id, i + 1));
  return map;
});
const hasPriority = computed(() => priorityIds.value.length > 0);

const statusFilter = ref('all');

// Built dynamically: "All" always, "Priority" whenever the list is non-empty
// *or* the user is standing on it (so demoting the last entry cannot strand
// `statusFilter` on a tab that just vanished), the three Shikimori status
// pills only when a library entry actually resolved to a status, and "Shared
// Libraries" (#578) while one is attached or the user is standing on it.
const statusTabs = computed<{ id: string; label: string }[]>(() => {
  const tabs = [{ id: 'all', label: 'All' }];
  if (hasPriority.value || statusFilter.value === 'priority') {
    tabs.push({ id: 'priority', label: 'Priority' });
  }
  if (hasStatuses.value) {
    tabs.push(
      { id: 'watching', label: 'Watching' },
      { id: 'planned', label: 'Planned' },
      { id: 'completed', label: 'Completed' }
    );
  }
  if (attachedCount.value > 0 || statusFilter.value === 'shared') {
    tabs.push({ id: 'shared', label: 'Shared Libraries' });
  }
  return tabs;
});

// Derived from the tab list rather than restated, so the strip can never be
// hidden while `statusFilter` still points at one of its tabs: an "All"-only
// strip is noise, anything more is a real choice. An attached library counts
// as content: on a fresh PC the local library is empty. So does standing on
// the Shared Libraries tab, or detaching the last library would hide the only
// way off it.
const showFilterRow = computed(
  () =>
    statusTabs.value.length > 1 &&
    (library.value.length > 0 || attachedCount.value > 0 || statusFilter.value === 'shared')
);

/** "Also on <library>": a downloaded title an attached library holds too. */
function alsoOn(animeId: number): string | null {
  if (!downloadedIds.value.has(animeId)) return null;
  return librariesByAnimeId.value.get(animeId)?.[0]?.name ?? null;
}

watch(
  focusTab,
  (focus) => {
    if (!focus) return;
    statusFilter.value = 'shared';
    focusTab.value = false;
  },
  { immediate: true }
);

function showShared(): void {
  openDialog.value = false;
  statusFilter.value = 'shared';
}

function matchesFilter(anime: AnimeSearchResult): boolean {
  if (statusFilter.value === 'all') return true;
  if (statusFilter.value === 'priority') return prioritySet.value.has(anime.id);
  const status = statusBySmotretId.value.get(anime.id);
  if (statusFilter.value === 'watching') return status === 'watching' || status === 'rewatching';
  return status === statusFilter.value;
}

const filteredLibrary = computed(() => {
  const matched = library.value.filter(matchesFilter);
  // The Priority tab reads as a queue, so it renders in stored (promote) order
  // rather than the merged-map order every other tab inherits from LIBRARY_GET.
  if (statusFilter.value !== 'priority') return matched;
  return [...matched].sort(
    (a, b) => priorityIds.value.indexOf(a.id) - priorityIds.value.indexOf(b.id)
  );
});

onMounted(async () => {
  // Both reads in flight together; the cards wait for the poster ids, so a
  // cached poster is their first src (#570).
  await loadLibrary(libraryStore.loadPosterIds());
  // Hydrate Shikimori rates (cache-first) so the status tabs have data.
  if (shikimoriStore.loggedIn && rates.value.length === 0) {
    shikimoriStore
      .refreshRates()
      .catch((err) => console.error('Failed to hydrate Shikimori rates for Library:', err));
  }
});

// A copy from a Shared Library (#579) registers titles while this view is open.
const { itemsDone: importedItems } = storeToRefs(useImportStore());
watch(importedItems, () => void loadLibrary(libraryStore.loadPosterIds()));

async function loadLibrary(posterIdsLoaded?: Promise<void>): Promise<void> {
  const list = await window.api.libraryGet();
  await posterIdsLoaded;
  library.value = list;
  const ids = library.value.map((a) => a.id);
  const [statuses, priority] = await Promise.all([
    window.api.libraryGetStatus(ids),
    window.api.libraryGetPriority()
  ]);
  priorityIds.value = priority.map(Number);
  const starred = new Set<number>();
  const downloaded = new Set<number>();
  for (const [id, s] of Object.entries(statuses)) {
    if (s.starred) starred.add(Number(id));
    if (s.downloaded) downloaded.add(Number(id));
  }
  starredIds.value = starred;
  downloadedIds.value = downloaded;
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)));
  await loadLibrary();
}

async function togglePriority(anime: AnimeSearchResult): Promise<void> {
  // The handler returns the resulting ordered list, so membership *and*
  // ordering come back from the one round-trip.
  const next = await window.api.librarySetPriority(
    JSON.parse(JSON.stringify(anime)),
    !prioritySet.value.has(anime.id)
  );
  priorityIds.value = next.map(Number);
}

// Multi-select for "Export N titles…" (#574). While it is on, a click on a
// card selects it instead of opening it.
const selectMode = ref(false);
const selectedIds = ref(new Set<number>());
const exportIds = ref<number[] | null>(null);

function toggleSelectMode(): void {
  selectMode.value = !selectMode.value;
  selectedIds.value = new Set();
}

function toggleSelected(anime: AnimeSearchResult): void {
  const next = new Set(selectedIds.value);
  if (next.has(anime.id)) next.delete(anime.id);
  else next.add(anime.id);
  selectedIds.value = next;
}

function onCardClick(anime: AnimeSearchResult): void {
  if (selectMode.value) toggleSelected(anime);
  else libraryStore.openAnime(anime.id);
}

function openExport(): void {
  exportIds.value = [...selectedIds.value];
}

function closeExport(): void {
  exportIds.value = null;
  selectMode.value = false;
  selectedIds.value = new Set();
}

async function deleteAnime(anime: AnimeSearchResult): Promise<void> {
  const name = getAnimeName(anime);
  await window.api.downloadedAnimeDelete(anime.id, name);
  await loadLibrary();
}
</script>

<template>
  <main class="library-view">
    <header class="topbar">
      <h2>Library</h2>
      <span v-if="library.length > 0" class="sub">· {{ library.length }} shows</span>
      <div class="grow"></div>
      <!-- Select / Export act on this PC's grid, not on the Shared Libraries tab (#574). -->
      <div v-if="library.length > 0 && statusFilter !== 'shared'" class="topbar-actions">
        <button
          v-if="selectMode"
          class="btn btn-primary btn-sm"
          data-testid="library-export-selected"
          :disabled="selectedIds.size === 0"
          @click="openExport"
        >
          Export {{ selectedIds.size }} {{ selectedIds.size === 1 ? 'title' : 'titles' }}…
        </button>
        <button
          class="btn btn-sm"
          :class="selectMode ? 'btn-secondary' : 'btn-outline'"
          data-testid="library-select-toggle"
          @click="toggleSelectMode"
        >
          {{ selectMode ? 'Done' : 'Select' }}
        </button>
      </div>
      <button class="open-shared-btn" data-testid="open-shared-library" @click="openDialog = true">
        Open Shared Library…
      </button>
    </header>
    <ExportDialog v-if="exportIds" :anime-ids="exportIds" preselect @close="closeExport" />
    <OpenLibraryDialog v-if="openDialog" @close="openDialog = false" @show="showShared" />
    <div class="body">
      <div v-if="showFilterRow" class="filter-row">
        <div class="pill-tabs">
          <button
            v-for="tab in statusTabs"
            :key="tab.id"
            class="pill-tab"
            :class="{ active: statusFilter === tab.id }"
            @click="statusFilter = tab.id"
          >
            {{ tab.label }}
            <span
              v-if="tab.id === 'shared' && conflictCount > 0"
              class="tab-badge"
              data-testid="conflict-badge"
              :title="`${conflictCount} need your input`"
              >{{ conflictCount }}</span
            >
          </button>
        </div>
      </div>

      <!-- Ahead of every empty-library branch: on a fresh PC the local library is
           empty and the drive's titles are the whole point (#578). -->
      <SharedLibrariesTab
        v-if="statusFilter === 'shared'"
        :starred-ids="starredIds"
        @toggle-star="toggleStar"
      />
      <div v-else-if="filteredLibrary.length > 0" class="poster-grid">
        <div v-for="anime in filteredLibrary" :key="anime.id" class="card-wrap">
          <AnimeCard
            :anime="anime"
            :starred="starredIds.has(anime.id)"
            :prioritized="prioritySet.has(anime.id)"
            :selectable="selectMode"
            :selected="selectedIds.has(anime.id)"
            @toggle-star="toggleStar"
            @toggle-priority="togglePriority"
            @toggle-select="toggleSelected"
            @click="onCardClick(anime)"
          />
          <span
            v-if="!selectMode && statusFilter === 'priority' && priorityRank.has(anime.id)"
            class="rank-badge"
            >{{ priorityRank.get(anime.id) }}</span
          >
          <span v-if="alsoOn(anime.id)" class="drive-badge" data-testid="also-on"
            >Also on {{ alsoOn(anime.id) }}</span
          >
          <button
            v-if="downloadedIds.has(anime.id)"
            class="delete-folder-btn"
            title="Delete downloaded files"
            @click.stop="deleteAnime(anime)"
          >
            <svg
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
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Remove files
          </button>
        </div>
      </div>
      <!-- Empty-library first: un-starring the last (prioritized) entry from the
           Priority tab empties the library while `statusFilter` stays on
           'priority', and onboarding copy beats "Nothing prioritized yet" for a
           user who has saved nothing at all. -->
      <div v-else-if="library.length === 0" class="status-text">
        No saved anime yet. Use the star button on search results to add anime here.
      </div>
      <div v-else-if="statusFilter === 'priority'" class="status-text">
        Nothing prioritized yet — use the flag on a card, or “Prioritize” on an anime’s page.
      </div>
      <div v-else class="status-text">No anime with this status.</div>
    </div>
  </main>
</template>

<style scoped>
.library-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 var(--pad-x);
  height: 64px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(8px);
}

.topbar h2 {
  font-family: var(--font-display);
  font-size: 1.32rem;
  font-weight: 700;
  letter-spacing: -0.015em;
}

.topbar .sub {
  color: var(--text-3);
  font-size: 0.85rem;
}

.topbar-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-y) var(--pad-x) 48px;
}

.filter-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 22px;
}

.card-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}

/* Queue position on the Priority tab. Anchored to `.card-wrap` (not inside
   AnimeCard) so the shared atom stays free of tab-specific decoration. */
.rank-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--accent) 88%, black);
  color: #fff;
  font-family: var(--font-data);
  font-size: 0.72rem;
  font-weight: 700;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.grow {
  flex: 1;
}

.open-shared-btn {
  padding: 7px 13px;
  border-radius: var(--radius-btn);
  border: 1px solid var(--border-strong);
  background: none;
  color: var(--text-2);
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.open-shared-btn:hover {
  color: var(--text);
  border-color: var(--accent);
}

.drive-badge {
  margin-top: 6px;
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: var(--radius-chip);
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  font-size: 0.7rem;
  font-weight: 600;
}

.delete-folder-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 6px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--st-red) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--st-red) 32%, transparent);
  border-radius: var(--radius-btn);
  color: var(--st-red);
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.delete-folder-btn:hover {
  background: color-mix(in srgb, var(--st-red) 22%, transparent);
  border-color: var(--st-red);
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1.05rem;
  padding-top: 80px;
}
</style>
