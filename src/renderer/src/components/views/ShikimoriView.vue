<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import AnimeCard from '../shared/AnimeCard.vue';
import { useLibraryStore } from '../../stores/library';
import { useShikimoriStore } from '../../stores/shikimori';

const libraryStore = useLibraryStore();
const shikimoriStore = useShikimoriStore();
const { rates: entries, profile } = storeToRefs(shikimoriStore);

const loading = ref(false);
const error = ref('');
const statusFilter = ref<string>('to_watch');
const starredIds = ref(new Set<number>());
const refreshing = ref(false);

// Presentation for the Shikimori list statuses — labels + swatch colors for the
// breakdown bar/legend and the recent-activity chips. Keyed on the raw status
// names the Shikimori stats block returns.
const LIST_META: Record<string, { label: string; color: string; chip: string }> = {
  watching: { label: 'Watching', color: 'var(--st-blue)', chip: 'blue' },
  completed: { label: 'Completed', color: 'var(--st-green)', chip: 'green' },
  rewatching: { label: 'Rewatching', color: 'var(--st-purple)', chip: 'purple' },
  planned: { label: 'Planned', color: 'var(--text-3)', chip: 'neutral' },
  on_hold: { label: 'On hold', color: 'var(--st-orange)', chip: 'orange' },
  dropped: { label: 'Dropped', color: 'var(--st-red)', chip: 'neutral' }
};

function listLabel(status: string): string {
  return LIST_META[status]?.label ?? status;
}
function listColor(status: string): string {
  return LIST_META[status]?.color ?? 'var(--text-3)';
}

const visibleLists = computed(() => (profile.value?.lists ?? []).filter((l) => l.n > 0));
const totalTitles = computed(() => visibleLists.value.reduce((s, l) => s + l.n, 0));
const maxScore = computed(() => Math.max(1, ...(profile.value?.scores ?? [0])));
const maxGenre = computed(() => Math.max(1, ...(profile.value?.genres ?? []).map((g) => g.n)));
const profileNickname = computed(
  () => profile.value?.nickname ?? shikimoriStore.user?.nickname ?? ''
);
const avatarInitial = computed(() => profileNickname.value.charAt(0).toUpperCase() || '?');

// Recent activity — the most recently updated rate entries, surfaced as a small
// feed. Derived from the cached rate list (no extra fetch).
const recentActivity = computed(() =>
  entries.value
    .slice()
    .sort((a, b) => new Date(b.rate.updated_at).getTime() - new Date(a.rate.updated_at).getTime())
    .slice(0, 8)
);

const filteredEntries = computed(() => {
  let list = entries.value;
  if (statusFilter.value === 'to_watch') {
    list = list.filter((e) => hasUnwatched(e));
  } else if (statusFilter.value) {
    list = list.filter((e) => e.rate.status === statusFilter.value);
  }
  return list.slice().sort((a, b) => {
    return new Date(b.rate.updated_at).getTime() - new Date(a.rate.updated_at).getTime();
  });
});

const statusOptions = [
  { value: '', label: 'All' },
  { value: 'to_watch', label: 'To Watch' },
  { value: 'watching', label: 'Watching' },
  { value: 'planned', label: 'Planned' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'rewatching', label: 'Rewatching' },
  { value: 'dropped', label: 'Dropped' }
];

const statusCounts = computed(() => {
  const counts: Record<string, number> = {};
  for (const e of entries.value) {
    counts[e.rate.status] = (counts[e.rate.status] || 0) + 1;
    if (hasUnwatched(e)) {
      counts['to_watch'] = (counts['to_watch'] || 0) + 1;
    }
  }
  return counts;
});

async function refreshStarredFromEntries(list: ShikiAnimeRateEntry[]): Promise<void> {
  const ids = list.filter((e) => e.smotretAnime).map((e) => e.smotretAnime!.id);
  if (ids.length === 0) return;
  const statuses = await window.api.libraryGetStatus(ids);
  const starred = new Set<number>();
  for (const [id, s] of Object.entries(statuses)) {
    if (s.starred) starred.add(Number(id));
  }
  starredIds.value = starred;
}

async function loadRates(): Promise<void> {
  if (!shikimoriStore.loggedIn) {
    await shikimoriStore.refreshUser();
    if (!shikimoriStore.loggedIn) return;
  }
  loading.value = true;
  error.value = '';
  try {
    await Promise.all([shikimoriStore.refreshRates(), shikimoriStore.refreshProfile()]);
    await refreshStarredFromEntries(entries.value);
    if (entries.value.length > 0) refreshing.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load anime list';
  } finally {
    loading.value = false;
  }
}

async function toggleStar(anime: AnimeSearchResult): Promise<void> {
  await window.api.libraryToggle(JSON.parse(JSON.stringify(anime)));
  if (starredIds.value.has(anime.id)) {
    starredIds.value.delete(anime.id);
  } else {
    starredIds.value.add(anime.id);
  }
  starredIds.value = new Set(starredIds.value);
}

function selectList(status: string): void {
  statusFilter.value = status;
}

function openProfile(): void {
  if (profileNickname.value) {
    void window.api.shellOpenExternal(`https://shikimori.one/@${profileNickname.value}`);
  }
}

function openActivity(entry: ShikiAnimeRateEntry): void {
  if (entry.smotretAnime) libraryStore.openAnime(entry.smotretAnime.id);
}

function getEpisodeLabel(entry: ShikiAnimeRateEntry): string {
  const watched = entry.rate.episodes;
  const total = entry.shikiAnime.episodes || entry.shikiAnime.episodes_aired || '?';
  return `${watched}/${total}`;
}

function hasUnwatched(entry: ShikiAnimeRateEntry): boolean {
  return entry.rate.status === 'watching' && entry.shikiAnime.episodes_aired > entry.rate.episodes;
}

function shikiPosterUrl(entry: ShikiAnimeRateEntry): string {
  // Prefer smotret-anime's poster — Shikimori's image URL can be a 'missing'
  // placeholder for newly-listed anime. The main process already enriches
  // smotret entries via `enrichMissingPosters`, so this is normally non-empty.
  if (entry.smotretAnime?.posterUrlSmall) return entry.smotretAnime.posterUrlSmall;
  const img = entry.shikiAnime.image.original;
  return img.startsWith('http') ? img : `https://shikimori.one${img}`;
}

function shikiTitle(entry: ShikiAnimeRateEntry): string {
  return entry.shikiAnime.russian || entry.shikiAnime.name;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

// When the store-owned rates broadcast updates, refresh the local starred-anime
// overlay (re-check libraryGetStatus for newly-added entries).
watch(
  () => entries.value,
  (newEntries) => {
    refreshing.value = false;
    void refreshStarredFromEntries(newEntries);
  },
  { deep: false }
);

onMounted(() => {
  loadRates();
});
</script>

<template>
  <main class="shikimori-view">
    <header class="topbar">
      <h2>Shikimori</h2>
      <span v-if="profileNickname" class="sub">· @{{ profileNickname }}</span>
      <span class="topbar-spacer"></span>
      <button v-if="profileNickname" class="hdr-btn ghost" @click="openProfile">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
          />
        </svg>
        Open profile
      </button>
      <button class="hdr-btn outline" :disabled="loading" @click="loadRates">
        <svg
          :class="{ spinning: loading || refreshing }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992"
          />
        </svg>
        Sync now
      </button>
    </header>

    <div class="body">
      <!-- Logged out -->
      <div v-if="!shikimoriStore.loggedIn && !loading" class="empty-state">
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
            />
          </svg>
        </div>
        <p>Connect your Shikimori account in Settings to see your profile.</p>
        <button class="cta-btn" @click="libraryStore.navigate('settings')">Open Settings</button>
      </div>

      <div v-else-if="loading && !profile" class="status-text">Loading your profile…</div>
      <div v-else-if="error && !profile" class="status-text error-text">{{ error }}</div>

      <template v-else>
        <!-- Profile header -->
        <section v-if="profile" class="sk-profile">
          <div class="sk-avatar">{{ avatarInitial }}</div>
          <div class="sk-id">
            <div class="sk-name">
              {{ profileNickname }}<span class="sk-handle">@{{ profileNickname }}</span>
            </div>
            <div class="sk-chips">
              <span class="chip green"><span class="dot"></span>Connected</span>
            </div>
            <div class="sk-id-meta">
              <span
                ><strong>{{ profile.friendsCount }}</strong> friends</span
              >
              <span
                ><strong class="mono">{{ profile.stats.titles }}</strong> titles</span
              >
            </div>
          </div>
        </section>

        <!-- Headline stats -->
        <section v-if="profile" class="sk-bigstats">
          <div class="sk-big">
            <div class="v mono">{{ profile.stats.titles }}</div>
            <div class="l">Titles</div>
          </div>
          <div class="sk-big">
            <div class="v mono">{{ profile.stats.episodes.toLocaleString() }}</div>
            <div class="l">Episodes</div>
          </div>
          <div class="sk-big">
            <div class="v mono">
              {{ profile.stats.daysWatched.toFixed(1) }}<span class="suf">d</span>
            </div>
            <div class="l">Days watched</div>
          </div>
          <div class="sk-big">
            <div class="v mono">{{ profile.stats.mean.toFixed(2) }}</div>
            <div class="l">Mean score</div>
          </div>
        </section>

        <!-- Panels -->
        <div v-if="profile" class="sk-cols">
          <div class="sk-stack">
            <div class="panel">
              <h4>
                List breakdown<span class="muted">{{ totalTitles }} titles</span>
              </h4>
              <div class="sk-bar">
                <span
                  v-for="l in visibleLists"
                  :key="l.status"
                  :style="{
                    width: (l.n / totalTitles) * 100 + '%',
                    background: listColor(l.status)
                  }"
                  :title="`${listLabel(l.status)} · ${l.n}`"
                ></span>
              </div>
              <div class="sk-legend">
                <button
                  v-for="l in visibleLists"
                  :key="l.status"
                  class="sk-leg"
                  @click="selectList(l.status)"
                >
                  <span class="sw" :style="{ background: listColor(l.status) }"></span>
                  <span class="lb">{{ listLabel(l.status) }}</span>
                  <span class="ct mono">{{ l.n }}</span>
                </button>
              </div>
            </div>

            <div class="panel">
              <h4>
                Score distribution<span class="muted"
                  >mean {{ profile.stats.mean.toFixed(2) }}</span
                >
              </h4>
              <div class="sk-hist">
                <div
                  v-for="(n, i) in profile.scores"
                  :key="i"
                  class="sk-hbar"
                  :title="`${n} titles rated ${i + 1}`"
                >
                  <div
                    class="sk-hfill"
                    :style="{ height: Math.max(4, (n / maxScore) * 100) + '%' }"
                  >
                    <span class="sk-hval">{{ n || '' }}</span>
                  </div>
                  <span class="sk-hx">{{ i + 1 }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="sk-stack">
            <div v-if="profile.genres.length" class="panel">
              <h4>Favorite genres</h4>
              <div class="genre-list">
                <div v-for="g in profile.genres" :key="g.name" class="genre-row">
                  <span class="gn">{{ g.name }}</span>
                  <div class="gbar">
                    <span :style="{ width: (g.n / maxGenre) * 100 + '%' }"></span>
                  </div>
                  <span class="gc mono">{{ g.n }}</span>
                </div>
              </div>
            </div>

            <div class="panel">
              <h4>Recent activity</h4>
              <div v-if="recentActivity.length" class="act-list">
                <button
                  v-for="entry in recentActivity"
                  :key="entry.rate.id"
                  class="act-row"
                  @click="openActivity(entry)"
                >
                  <span class="act-ico" :class="LIST_META[entry.rate.status]?.chip ?? 'neutral'">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z"
                      />
                    </svg>
                  </span>
                  <div class="act-poster">
                    <img :src="shikiPosterUrl(entry)" :alt="shikiTitle(entry)" loading="lazy" />
                  </div>
                  <div class="act-body">
                    <div class="act-title">{{ shikiTitle(entry) }}</div>
                    <div class="act-detail">
                      <span class="chip" :class="LIST_META[entry.rate.status]?.chip ?? 'neutral'">{{
                        listLabel(entry.rate.status)
                      }}</span>
                      <span class="mono">EP {{ getEpisodeLabel(entry) }}</span>
                    </div>
                  </div>
                  <span class="act-when mono">{{ timeAgo(entry.rate.updated_at) }}</span>
                </button>
              </div>
              <p v-else class="panel-empty">No recent activity yet.</p>
            </div>
          </div>
        </div>

        <!-- Watchlist -->
        <div class="section-head spaced">
          <h3>Your list</h3>
          <span class="topbar-spacer"></span>
          <div class="select-wrap">
            <select v-model="statusFilter">
              <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
                {{ opt.label
                }}{{ opt.value && statusCounts[opt.value] ? ` (${statusCounts[opt.value]})` : '' }}
              </option>
            </select>
            <svg
              class="caret"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M19.5 8.25l-7.5 7.5-7.5-7.5"
              />
            </svg>
          </div>
        </div>

        <div v-if="filteredEntries.length === 0" class="status-text">
          {{
            entries.length === 0 ? 'No anime in your Shikimori list.' : 'No anime with this status.'
          }}
        </div>
        <div v-else class="results-grid">
          <div v-for="entry in filteredEntries" :key="entry.rate.id" class="card-wrap">
            <template v-if="entry.smotretAnime">
              <AnimeCard
                :anime="entry.smotretAnime"
                :starred="starredIds.has(entry.smotretAnime.id)"
                @toggle-star="toggleStar"
                @click="libraryStore.openAnime(entry.smotretAnime.id)"
              />
            </template>
            <template v-else>
              <div class="acard fallback-card">
                <div class="poster-wrap">
                  <img
                    :src="shikiPosterUrl(entry)"
                    :alt="shikiTitle(entry)"
                    class="poster"
                    loading="lazy"
                  />
                  <div class="unavailable-badge">Not available</div>
                </div>
                <div class="acard-info">
                  <div class="acard-title" :title="shikiTitle(entry)">{{ shikiTitle(entry) }}</div>
                  <div class="acard-meta">
                    <span v-if="entry.shikiAnime.kind">{{ entry.shikiAnime.kind }}</span>
                    <span v-if="entry.shikiAnime.episodes"
                      >· {{ entry.shikiAnime.episodes }} ep</span
                    >
                  </div>
                </div>
              </div>
            </template>
            <div class="badges-row">
              <div class="episode-badge" :class="{ unwatched: hasUnwatched(entry) }">
                {{ getEpisodeLabel(entry) }} ep
              </div>
              <div v-if="entry.rate.score > 0" class="score-badge">
                <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
                  <path
                    d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
                  />
                </svg>
                {{ entry.rate.score }}
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.shikimori-view {
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
  margin-left: -6px;
  font-family: var(--font-data);
}

.topbar-spacer {
  flex: 1;
}

.hdr-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 15px;
  border-radius: var(--radius-btn);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s var(--ease);
}

.hdr-btn svg {
  width: 15px;
  height: 15px;
}

.hdr-btn.ghost {
  background: none;
  border: 1px solid transparent;
  color: var(--text-3);
}

.hdr-btn.ghost:hover {
  background: var(--surface-2);
  color: var(--text);
}

.hdr-btn.outline {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}

.hdr-btn.outline:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text);
}

.hdr-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-y) var(--pad-x) 48px;
}

/* ---- profile header ---- */
.sk-profile {
  display: flex;
  align-items: center;
  gap: 22px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 22px 24px;
}

.sk-avatar {
  width: 84px;
  height: 84px;
  min-width: 84px;
  border-radius: 22px;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-size: 2.1rem;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--st-purple));
}

.sk-id {
  flex: 1;
  min-width: 0;
}

.sk-name {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.015em;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.sk-handle {
  font-family: var(--font-data);
  font-size: 0.92rem;
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0;
}

.sk-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.sk-id-meta {
  display: flex;
  gap: 22px;
  margin-top: 14px;
  font-size: 0.86rem;
  color: var(--text-3);
}

.sk-id-meta strong {
  color: var(--text);
  font-weight: 700;
}

/* ---- chips ---- */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: var(--radius-chip);
  letter-spacing: 0.03em;
}

.chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.chip.green {
  background: color-mix(in srgb, var(--st-green) 16%, transparent);
  color: var(--st-green);
}
.chip.blue {
  background: color-mix(in srgb, var(--st-blue) 16%, transparent);
  color: var(--st-blue);
}
.chip.orange {
  background: color-mix(in srgb, var(--st-orange) 16%, transparent);
  color: var(--st-orange);
}
.chip.purple {
  background: color-mix(in srgb, var(--st-purple) 16%, transparent);
  color: var(--st-purple);
}
.chip.neutral {
  background: var(--surface-3);
  color: var(--text-2);
}

/* ---- big stats ---- */
.sk-bigstats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--gap);
  margin-top: var(--gap);
}

@media (max-width: 760px) {
  .sk-bigstats {
    grid-template-columns: repeat(2, 1fr);
  }
}

.sk-big {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 18px 20px;
}

.sk-big .v {
  font-size: 1.85rem;
  font-weight: 700;
  line-height: 1;
  color: var(--text);
}

.sk-big .v .suf {
  font-size: 0.95rem;
  color: var(--text-3);
  margin-left: 2px;
}

.sk-big .l {
  font-size: 0.72rem;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  margin-top: 9px;
}

/* ---- panel grid ---- */
.sk-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap);
  margin-top: var(--gap);
  align-items: start;
}

@media (max-width: 960px) {
  .sk-cols {
    grid-template-columns: 1fr;
  }
}

.sk-stack {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}

.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 18px 20px;
}

.panel h4 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 0.95rem;
  font-weight: 700;
  margin-bottom: 16px;
}

.panel h4 .muted {
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--text-3);
}

.panel-empty {
  color: var(--text-3);
  font-size: 0.85rem;
}

/* ---- list breakdown ---- */
.sk-bar {
  display: flex;
  height: 14px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--bg-deep);
  gap: 2px;
}

.sk-bar > span {
  height: 100%;
  transition: width 0.4s var(--ease);
}

.sk-legend {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-top: 16px;
}

.sk-leg {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  background: none;
  border: none;
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: background 0.15s;
}

.sk-leg:hover {
  background: var(--surface-2);
}

.sk-leg .sw {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.sk-leg .lb {
  font-size: 0.82rem;
  color: var(--text-2);
  font-weight: 600;
  flex: 1;
  text-align: left;
}

.sk-leg .ct {
  font-size: 0.82rem;
  color: var(--text);
  font-weight: 700;
}

/* ---- histogram ---- */
.sk-hist {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 150px;
}

.sk-hbar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  gap: 7px;
}

.sk-hfill {
  position: relative;
  width: 100%;
  max-width: 30px;
  border-radius: 5px 5px 0 0;
  background: linear-gradient(
    180deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 55%, transparent)
  );
  transition: height 0.4s var(--ease);
}

.sk-hval {
  position: absolute;
  top: -17px;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--font-data);
  font-size: 0.66rem;
  color: var(--text-3);
}

.sk-hx {
  font-family: var(--font-data);
  font-size: 0.72rem;
  color: var(--text-3);
}

/* ---- genres ---- */
.genre-list {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.genre-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.genre-row .gn {
  width: 110px;
  min-width: 110px;
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.genre-row .gbar {
  flex: 1;
  height: 8px;
  background: var(--bg-deep);
  border-radius: 999px;
  overflow: hidden;
}

.genre-row .gbar > span {
  display: block;
  height: 100%;
  background: var(--st-purple);
  border-radius: 999px;
  transition: width 0.4s var(--ease);
}

.genre-row .gc {
  font-size: 0.78rem;
  color: var(--text-3);
  width: 34px;
  text-align: right;
}

/* ---- activity ---- */
.act-list {
  display: flex;
  flex-direction: column;
}

.act-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  background: none;
  border: none;
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: background 0.15s;
  text-align: left;
}

.act-row:hover {
  background: var(--surface-2);
}

.act-ico {
  width: 30px;
  height: 30px;
  min-width: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
}

.act-ico svg {
  width: 14px;
  height: 14px;
}

.act-ico.blue {
  background: color-mix(in srgb, var(--st-blue) 16%, transparent);
  color: var(--st-blue);
}
.act-ico.green {
  background: color-mix(in srgb, var(--st-green) 16%, transparent);
  color: var(--st-green);
}
.act-ico.orange {
  background: color-mix(in srgb, var(--st-orange) 16%, transparent);
  color: var(--st-orange);
}
.act-ico.purple {
  background: color-mix(in srgb, var(--st-purple) 16%, transparent);
  color: var(--st-purple);
}
.act-ico.neutral {
  background: var(--surface-3);
  color: var(--text-2);
}

.act-poster {
  width: 32px;
  min-width: 32px;
  height: 46px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-deep);
}

.act-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.act-body {
  flex: 1;
  min-width: 0;
}

.act-title {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.act-detail {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 0.76rem;
  color: var(--text-3);
}

.act-when {
  font-size: 0.74rem;
  color: var(--text-3);
  flex-shrink: 0;
}

/* ---- section head ---- */
.section-head {
  display: flex;
  align-items: center;
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

.select-wrap {
  position: relative;
}

/* ---- watchlist grid ---- */
.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--poster-grid), 1fr));
  gap: var(--gap);
}

.card-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}

.fallback-card {
  cursor: default;
}

.fallback-card:hover {
  transform: none;
  border-color: var(--border);
  box-shadow: none;
}

.fallback-card .poster-wrap {
  position: relative;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background: var(--bg-deep);
}

.fallback-card .poster {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.unavailable-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.8);
  color: var(--text-3);
  font-size: 0.75rem;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
}

.badges-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 6px;
  padding: 0 2px;
}

.episode-badge {
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 0.7rem;
  padding: 2px 7px;
  border-radius: 6px;
  font-weight: 600;
  font-family: var(--font-data);
}

.episode-badge.unwatched {
  color: var(--star);
}

.score-badge {
  background: var(--surface-2);
  color: var(--star);
  font-size: 0.7rem;
  padding: 2px 7px;
  border-radius: 6px;
  font-weight: 600;
  font-family: var(--font-data);
  display: flex;
  align-items: center;
  gap: 3px;
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1rem;
  padding: 60px 20px;
}

.error-text {
  color: var(--accent);
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
</style>
