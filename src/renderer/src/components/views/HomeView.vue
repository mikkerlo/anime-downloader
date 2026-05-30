<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useLibraryStore } from '../../stores/library';
import { useShikimoriStore } from '../../stores/shikimori';
import AnimeCard from '../shared/AnimeCard.vue';

const libraryStore = useLibraryStore();
const shikimoriStore = useShikimoriStore();

const entries = ref<ContinueWatchingEntry[]>([]);
const loading = ref(true);
const failedPosters = ref(new Set<string>());

// Dismissed continue-watching shows, persisted across restarts in electron-store
// under `dismissedContinueWatching`. Keyed on `animeId:episodeInt` (NOT animeId
// alone) so a dismissed show stays hidden across restarts for the *same* unwatched
// episode, but resurfaces once progress advances the entry to a newer episode whose
// key was never dismissed.
const DISMISSED_KEY = 'dismissedContinueWatching';
const dismissed = ref(new Set<string>());

function dismissKey(e: ContinueWatchingEntry): string {
  return `${e.animeId}:${e.episodeInt}`;
}

const visibleEntries = computed(() =>
  entries.value.filter((e) => !dismissed.value.has(dismissKey(e)))
);

async function dismiss(e: ContinueWatchingEntry): Promise<void> {
  if (!e.animeId) return;
  dismissed.value = new Set(dismissed.value).add(dismissKey(e));
  try {
    await window.api.setSetting(DISMISSED_KEY, [...dismissed.value]);
  } catch (err) {
    console.error('Failed to persist dismissed continue-watching:', err);
  }
}

// "Recently added to your list" — the most recently updated Watching /
// Rewatching / Planned entries from the Shikimori list (already in the store),
// mapped to the resolved smotret-anime entry so they render as AnimeCards.
const RECENT_STATUSES: ShikiUserRateStatus[] = ['watching', 'rewatching', 'planned'];
const recentlyAdded = computed<AnimeSearchResult[]>(() =>
  shikimoriStore.rates
    .filter((e) => e.smotretAnime && RECENT_STATUSES.includes(e.rate.status))
    .slice()
    .sort((a, b) => new Date(b.rate.updated_at).getTime() - new Date(a.rate.updated_at).getTime())
    .slice(0, 12)
    .map((e) => e.smotretAnime as AnimeSearchResult)
);

const starredIds = reactive(new Set<number>());

async function refreshStars(): Promise<void> {
  const cards = recentlyAdded.value;
  try {
    const inLibrary = await Promise.all(cards.map((a) => window.api.libraryHas(a.id)));
    // Bail if the list changed while we were awaiting, so two interleaved
    // refreshes can't clear the set and apply stale results.
    if (cards !== recentlyAdded.value) return;
    starredIds.clear();
    cards.forEach((a, i) => {
      if (inLibrary[i]) starredIds.add(a.id);
    });
  } catch (err) {
    console.error('Failed to load library status for Home:', err);
  }
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  const inLibrary = await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)));
  if (inLibrary) starredIds.add(anime.id);
  else starredIds.delete(anime.id);
}

watch(recentlyAdded, () => void refreshStars(), { immediate: true });

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function entryKey(e: ContinueWatchingEntry): string {
  return `${e.kind}:${e.animeId}:${e.episodeInt}`;
}

function showPoster(e: ContinueWatchingEntry): boolean {
  return !!e.posterUrl && !failedPosters.value.has(entryKey(e));
}

function onPosterError(e: ContinueWatchingEntry): void {
  failedPosters.value = new Set(failedPosters.value).add(entryKey(e));
}

function onPosterLoad(e: ContinueWatchingEntry, evt: Event): void {
  // smotret-anime.ru sometimes serves a 200-OK response with content-length: 0
  // for missing posters. The browser fires `load` (not `error`) and renders an
  // empty <img>, leaving the dark container visible forever. Detect via the
  // decoded dimensions and treat as failed.
  const img = evt.target as HTMLImageElement;
  if (img.naturalWidth === 0 || img.naturalHeight === 0) {
    failedPosters.value = new Set(failedPosters.value).add(entryKey(e));
  }
}

async function refresh(): Promise<void> {
  try {
    entries.value = await window.api.homeGetContinueWatching();
    failedPosters.value = new Set();
  } catch (err) {
    console.error('Failed to load continue-watching list:', err);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

async function manualRefresh(): Promise<void> {
  loading.value = true;
  // Kick a Shikimori rates refresh — returns cached instantly and triggers a
  // background fetch. When the fetch completes the `rates-refreshed` broadcast
  // re-fires `refresh()` via our existing listener, picking up anything newly
  // added on Shikimori.
  try {
    void window.api.shikimoriGetAnimeRates();
  } catch (err) {
    console.error('Failed to trigger Shikimori refresh:', err);
  }
  await refresh();
}

function debouncedRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 1000);
}

function progressPercent(entry: ContinueWatchingEntry): number {
  if (!entry.position || !entry.duration) return 0;
  const pct = Math.min(100, Math.round((entry.position / entry.duration) * 100));
  return pct < 2 ? 2 : pct;
}

function onClick(entry: ContinueWatchingEntry): void {
  if (!entry.animeId) return;
  libraryStore.openAnime(entry.animeId, entry.episodeInt);
}

// Rate changes from the Shikimori store (broadcast-driven) re-fetch the
// continue-watching list since it merges main-process Shikimori state.
watch(
  () => shikimoriStore.rates,
  () => void refresh(),
  { deep: true }
);

onMounted(async () => {
  try {
    const saved = (await window.api.getSetting(DISMISSED_KEY)) as string[] | null;
    if (Array.isArray(saved)) dismissed.value = new Set(saved);
  } catch (err) {
    console.error('Failed to load dismissed continue-watching:', err);
  }
  await refresh();
  window.addEventListener('watch-progress-updated', debouncedRefresh);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  window.removeEventListener('watch-progress-updated', debouncedRefresh);
});
</script>

<template>
  <main class="home-view">
    <header class="topbar">
      <h2>Home</h2>
      <span class="sub">· Continue watching</span>
      <span class="topbar-spacer"></span>
      <button class="refresh-btn" :disabled="loading" @click="manualRefresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
          />
        </svg>
        Refresh
      </button>
    </header>
    <div class="body">
      <div v-if="loading && entries.length === 0" class="status-text">Loading…</div>
      <template v-else>
        <div v-if="visibleEntries.length === 0" class="empty-state">
          <div class="es-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <p>All caught up — nothing left to resume right now.</p>
          <button class="cta-btn" @click="libraryStore.navigate('search')">Browse Search</button>
        </div>
        <div v-else class="cw-grid">
          <div v-for="e in visibleEntries" :key="entryKey(e)" class="cw-card-wrap">
            <button
              class="cw-card"
              :class="{ disabled: !e.animeId }"
              :disabled="!e.animeId"
              @click="onClick(e)"
            >
              <div class="cw-poster">
                <img
                  v-if="showPoster(e)"
                  :src="e.posterUrl"
                  :alt="e.animeName"
                  @error="onPosterError(e)"
                  @load="onPosterLoad(e, $event)"
                />
                <div v-else class="cw-poster-fallback"></div>
              </div>
              <div class="cw-body">
                <div class="cw-title">{{ e.animeName || 'Unknown anime' }}</div>
                <div class="cw-ep">
                  <span class="chip" :class="e.kind === 'resume' ? 'accent' : 'blue'">{{
                    e.kind === 'resume' ? 'Resume' : 'Up next'
                  }}</span>
                  <span class="cw-ep-label">{{ e.episodeLabel }}</span>
                </div>
                <div class="cw-foot">
                  <div class="cw-play">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z"
                      />
                    </svg>
                  </div>
                  <template v-if="e.kind === 'resume'">
                    <div class="pbar">
                      <span :style="{ width: progressPercent(e) + '%' }"></span>
                    </div>
                    <span class="ptext">{{ progressPercent(e) }}%</span>
                  </template>
                  <span v-else class="ptext grow">Not started</span>
                </div>
              </div>
            </button>
            <button
              class="cw-dismiss"
              :aria-label="`Dismiss ${e.animeName || 'this show'}`"
              @click.stop="dismiss(e)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <template v-if="recentlyAdded.length > 0">
          <div class="section-head spaced">
            <h3>Recently added to your list</h3>
            <span class="muted">From Shikimori</span>
          </div>
          <div class="poster-grid">
            <AnimeCard
              v-for="a in recentlyAdded"
              :key="a.id"
              :anime="a"
              :starred="starredIds.has(a.id)"
              @toggle-star="toggleStar"
              @click="libraryStore.openAnime(a.id)"
            />
          </div>
        </template>
      </template>
    </div>
  </main>
</template>

<style scoped>
.home-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
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
  margin-left: -8px;
}

.topbar-spacer {
  flex: 1;
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 4px 0 16px;
}

.section-head.spaced {
  margin-top: 30px;
}

.section-head h3 {
  font-family: var(--font-display);
  font-size: 1.04rem;
  font-weight: 700;
}

.section-head .muted {
  font-size: 0.82rem;
  color: var(--text-3);
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-radius: var(--radius-btn);
  font-size: 0.86rem;
  font-weight: 600;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s var(--ease);
}

.refresh-btn svg {
  width: 16px;
  height: 16px;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-y) var(--pad-x) 48px;
}

.cw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--gap);
}

.cw-card-wrap {
  position: relative;
  display: flex;
}

.cw-dismiss {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: var(--radius-chip);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transform: scale(0.9);
  transition: all 0.15s var(--ease);
}

.cw-dismiss svg {
  width: 14px;
  height: 14px;
}

.cw-card-wrap:hover .cw-dismiss,
.cw-dismiss:focus-visible {
  opacity: 1;
  transform: scale(1);
}

.cw-dismiss:hover {
  background: color-mix(in srgb, var(--st-red) 16%, var(--surface-2));
  border-color: var(--st-red);
  color: var(--st-red);
}

.cw-card {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
  padding: 0;
  transition: all 0.18s var(--ease);
}

.cw-card:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: var(--shadow-card);
}

.cw-card.disabled,
.cw-card:disabled {
  cursor: default;
  opacity: 0.6;
}

.cw-poster {
  width: 110px;
  min-width: 110px;
  background: var(--bg-deep);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.cw-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cw-poster-fallback {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--surface-2) 0%, var(--bg-deep) 100%);
}

.cw-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 9px;
  padding: 14px 16px;
  min-width: 0;
}

.cw-title {
  font-size: 0.98rem;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cw-ep {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 0.83rem;
  color: var(--text-2);
}

.cw-ep-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: var(--radius-chip);
  letter-spacing: 0.03em;
  flex-shrink: 0;
}

.chip.accent {
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent-line);
}

.chip.blue {
  background: color-mix(in srgb, var(--st-blue) 16%, transparent);
  color: var(--st-blue);
}

.cw-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}

.cw-play {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-ink);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  transition: all 0.15s;
}

.cw-play svg {
  width: 16px;
  height: 16px;
}

.cw-card:hover:not(:disabled) .cw-play {
  transform: scale(1.06);
  background: var(--accent-hover);
}

.ptext {
  font-family: var(--font-data);
  font-size: 0.72rem;
  color: var(--text-3);
  flex-shrink: 0;
}

.ptext.grow {
  flex: 1;
}

.cta-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 9px 16px;
  border-radius: var(--radius-btn);
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.cta-btn:hover {
  background: var(--accent-hover);
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1rem;
  padding-top: 80px;
}
</style>
