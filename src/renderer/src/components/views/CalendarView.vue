<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useLibraryStore } from '../../stores/library';

const libraryStore = useLibraryStore();

const entries = ref<CalendarEntry[]>([]);
const loading = ref(false);
const error = ref('');
const weeksPerPage = ref(1);
const subscribedAnimeIds = ref<Set<number>>(new Set());

const DAY_LABELS_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LABELS_SUN_FIRST = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localeFirstDay(): 1 | 7 {
  try {
    const loc = new (Intl as unknown as { Locale: new (tag: string) => unknown }).Locale(
      navigator.language
    ) as { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && info.firstDay === 7) return 7;
  } catch {
    /* fall through */
  }
  return 1;
}

const firstDay = localeFirstDay();
const dayLabels = firstDay === 7 ? DAY_LABELS_SUN_FIRST : DAY_LABELS_MON_FIRST;

function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay();
  const offset = firstDay === 7 ? day : (day + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

const now = ref(new Date());
const pageOffset = ref(0);

const pageStart = computed(() => {
  const base = startOfWeek(now.value);
  base.setDate(base.getDate() + pageOffset.value * weeksPerPage.value * 7);
  return base;
});
const pageEnd = computed(() => {
  const d = new Date(pageStart.value);
  d.setDate(d.getDate() + weeksPerPage.value * 7);
  return d;
});

const todayPos = computed(() => {
  const today = new Date();
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayDiff = Math.floor((t.getTime() - pageStart.value.getTime()) / (24 * 60 * 60 * 1000));
  if (dayDiff < 0 || dayDiff >= weeksPerPage.value * 7) return null;
  return { row: Math.floor(dayDiff / 7), col: dayDiff % 7 };
});

const rows = computed(() => {
  const result: { weekStart: Date; columns: { date: Date; items: CalendarEntry[] }[] }[] = [];
  for (let w = 0; w < weeksPerPage.value; w++) {
    const wStart = new Date(pageStart.value);
    wStart.setDate(wStart.getDate() + w * 7);
    const cols: { date: Date; items: CalendarEntry[] }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(wStart);
      d.setDate(d.getDate() + i);
      cols.push({ date: d, items: [] });
    }
    result.push({ weekStart: wStart, columns: cols });
  }
  // Forward-looking only on the current page — past episodes drop out, future
  // pages and past pages show every entry in their range.
  const minTime = pageOffset.value === 0 ? now.value.getTime() : pageStart.value.getTime();
  const maxTime = pageEnd.value.getTime();
  for (const e of entries.value) {
    const ts = new Date(e.nextEpisodeAt).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts < minTime || ts >= maxTime) continue;
    const dayDiff = Math.floor((ts - pageStart.value.getTime()) / (24 * 60 * 60 * 1000));
    if (dayDiff < 0 || dayDiff >= weeksPerPage.value * 7) continue;
    const row = Math.floor(dayDiff / 7);
    const col = dayDiff % 7;
    result[row].columns[col].items.push(e);
  }
  for (const r of result) {
    for (const c of r.columns) {
      c.items.sort(
        (a, b) => new Date(a.nextEpisodeAt).getTime() - new Date(b.nextEpisodeAt).getTime()
      );
    }
  }
  return result;
});

const pageRangeLabel = computed(() => {
  const start = pageStart.value;
  const end = new Date(pageStart.value);
  end.setDate(end.getDate() + weeksPerPage.value * 7 - 1);
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const startStr = start.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  });
  const endStr = sameMonth
    ? end.toLocaleDateString([], { day: 'numeric' })
    : end.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' })
      });
  return `${startStr} – ${endStr}`;
});

const isCurrentPage = computed(() => pageOffset.value === 0);

function shiftPage(delta: number): void {
  pageOffset.value += delta;
}

function resetPage(): void {
  pageOffset.value = 0;
}

const totalCount = computed(() =>
  rows.value.reduce((sum, r) => sum + r.columns.reduce((s, c) => s + c.items.length, 0), 0)
);

async function loadViewSetting(): Promise<void> {
  const v = (await window.api.getSetting('calendarView')) as 'week' | 'month' | null;
  weeksPerPage.value = v === 'month' ? 4 : 1;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatColumnDate(d: Date): string {
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function statusLabel(s: string): string {
  if (s === 'watching') return 'Watching';
  if (s === 'rewatching') return 'Rewatching';
  if (s === 'planned') return 'Planned';
  return s;
}

async function load(force = false): Promise<void> {
  await loadViewSetting();
  const user = await window.api.shikimoriGetUser();
  if (!user) {
    entries.value = [];
    error.value = 'Connect to Shikimori in Settings to see the calendar.';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    now.value = new Date();
    entries.value = await window.api.shikimoriGetCalendar(force);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load calendar';
  } finally {
    loading.value = false;
  }
}

function handleClick(entry: CalendarEntry): void {
  if (entry.animeId !== null) libraryStore.openAnime(entry.animeId);
}

function onCalendarViewChanged(): void {
  pageOffset.value = 0;
  void loadViewSetting();
}

async function loadAutoDlSubscriptions(): Promise<void> {
  try {
    const subs = await window.api.autoDlListSubscriptions();
    subscribedAnimeIds.value = new Set(subs.map((s) => s.animeId));
  } catch (err) {
    console.warn('Failed to load auto-dl subscriptions:', err);
  }
}

onMounted(() => {
  window.addEventListener('calendar-view-changed', onCalendarViewChanged);
  load();
  loadAutoDlSubscriptions();
});

onBeforeUnmount(() => {
  window.removeEventListener('calendar-view-changed', onCalendarViewChanged);
});
</script>

<template>
  <main class="calendar-view">
    <header class="topbar">
      <h2>Airing Calendar</h2>
      <div class="topbar-controls">
        <button
          class="icon-btn"
          @click="shiftPage(-1)"
          :title="weeksPerPage === 4 ? 'Previous 4 weeks' : 'Previous week'"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="16"
            height="16"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <button
          class="week-label"
          :class="{ today: isCurrentPage }"
          :disabled="isCurrentPage"
          :title="isCurrentPage ? 'Now' : 'Jump to now'"
          @click="resetPage"
        >
          {{ pageRangeLabel }}
        </button>
        <button
          class="icon-btn"
          @click="shiftPage(1)"
          :title="weeksPerPage === 4 ? 'Next 4 weeks' : 'Next week'"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="16"
            height="16"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
        <button class="icon-btn" :disabled="loading" @click="load(true)" title="Refresh calendar">
          <svg
            :class="{ spinning: loading }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            width="18"
            height="18"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992"
            />
          </svg>
        </button>
      </div>
    </header>
    <div class="body">
      <div v-if="loading && entries.length === 0" class="empty-state">
        <p>Loading calendar…</p>
      </div>
      <div v-else-if="error" class="empty-state">
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
        </div>
        <p>{{ error }}</p>
      </div>
      <div v-else-if="totalCount === 0" class="empty-state">
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"
            />
          </svg>
        </div>
        <p>
          {{
            isCurrentPage
              ? weeksPerPage === 4
                ? 'Nothing airing in the next 4 weeks — your watching list is up to date.'
                : 'Nothing airing this week — your watching list is up to date.'
              : weeksPerPage === 4
                ? 'Nothing airing during these 4 weeks.'
                : 'Nothing airing during this week.'
          }}
        </p>
      </div>
      <div v-else class="page">
        <div v-for="(row, rIdx) in rows" :key="rIdx" class="cal-grid">
          <div
            v-for="(col, idx) in row.columns"
            :key="idx"
            class="cal-col"
            :class="{ today: todayPos && todayPos.row === rIdx && todayPos.col === idx }"
          >
            <div class="cal-day">
              <span class="cal-dayname">{{ dayLabels[idx] }}</span>
              <span
                v-if="todayPos && todayPos.row === rIdx && todayPos.col === idx"
                class="today-tag"
                >Today</span
              >
              <span v-else class="cal-date">{{ formatColumnDate(col.date) }}</span>
              <span v-if="col.items.length > 0" class="cal-count">{{ col.items.length }}</span>
            </div>
            <div v-if="col.items.length === 0" class="cal-empty">Nothing airing</div>
            <div v-else class="cal-entries">
              <div
                v-for="(entry, i) in col.items"
                :key="entry.malId + '-' + i"
                class="ce"
                :class="{ clickable: entry.animeId !== null }"
                @click="handleClick(entry)"
              >
                <img :src="entry.posterUrl" :alt="entry.name" class="cal-poster" loading="lazy" />
                <div class="ce-text">
                  <div class="ce-title" :title="entry.name">{{ entry.name }}</div>
                  <div class="ce-meta">Ep {{ entry.episodeInt }} · {{ formatTime(entry.nextEpisodeAt) }}</div>
                  <div class="ce-chips">
                    <span class="ce-chip" :class="'st-' + entry.userStatus">{{
                      statusLabel(entry.userStatus)
                    }}</span>
                    <span v-if="entry.animeId === null" class="ce-chip st-na">Not on smotret-anime</span>
                    <span
                      v-if="entry.animeId !== null && subscribedAnimeIds.has(entry.animeId)"
                      class="ce-chip st-auto"
                      title="Auto-download is on for this show"
                      >↻ Auto-DL</span
                    >
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.calendar-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
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

.topbar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  color: var(--text-3);
  padding: 7px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.icon-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.week-label {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  color: var(--text-2);
  padding: 7px 14px;
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
  min-width: 138px;
  text-align: center;
  transition: all 0.15s;
}

.week-label:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.week-label.today {
  color: var(--accent);
  border-color: var(--accent-line);
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

.page {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--gap);
}

@media (max-width: 1000px) {
  .cal-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

.cal-col {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 120px;
}

.cal-col.today {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-line);
}

.cal-day {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cal-dayname {
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 700;
}

.cal-date {
  font-family: var(--font-data);
  font-size: 0.72rem;
  color: var(--text-faint);
}

.today-tag {
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: var(--radius-chip);
}

.cal-count {
  margin-left: auto;
  font-family: var(--font-data);
  font-size: 0.72rem;
  color: var(--text-faint);
}

.cal-empty {
  text-align: center;
  color: var(--text-faint);
  font-size: 0.78rem;
  padding: 14px 0;
}

.cal-entries {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ce {
  display: flex;
  gap: 10px;
  border-radius: var(--radius-btn);
}

.ce.clickable {
  cursor: pointer;
}

.cal-poster {
  width: 46px;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border-radius: 6px;
  background: var(--surface-2);
  flex-shrink: 0;
  transition: transform 0.15s var(--ease);
}

.ce.clickable:hover .cal-poster {
  transform: scale(1.06);
}

.ce-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ce-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text);
  line-height: 1.25;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  transition: color 0.15s;
}

.ce.clickable:hover .ce-title {
  color: var(--accent);
}

.ce-meta {
  font-family: var(--font-data);
  font-size: 0.68rem;
  color: var(--text-3);
}

.ce-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ce-chip {
  font-size: 0.62rem;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--radius-chip);
  background: var(--surface-3);
  color: var(--text-2);
}

.ce-chip.st-watching,
.ce-chip.st-rewatching {
  background: var(--accent-soft);
  color: var(--accent);
}

.ce-chip.st-planned {
  background: color-mix(in srgb, var(--st-blue) 16%, transparent);
  color: var(--st-blue);
}

.ce-chip.st-na {
  background: var(--surface-2);
  color: var(--text-3);
}

.ce-chip.st-auto {
  background: color-mix(in srgb, var(--st-green) 16%, transparent);
  color: var(--st-green);
}
</style>
