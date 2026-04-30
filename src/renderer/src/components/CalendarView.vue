<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const emit = defineEmits<{
  openAnime: [id: number]
}>()

const entries = ref<CalendarEntry[]>([])
const loading = ref(false)
const error = ref('')
const weeksPerPage = ref(1)

const DAY_LABELS_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_LABELS_SUN_FIRST = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function localeFirstDay(): 1 | 7 {
  try {
    const loc = new (Intl as unknown as { Locale: new (tag: string) => unknown }).Locale(
      navigator.language
    ) as { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo
    if (info && info.firstDay === 7) return 7
  } catch {
    /* fall through */
  }
  return 1
}

const firstDay = localeFirstDay()
const dayLabels = firstDay === 7 ? DAY_LABELS_SUN_FIRST : DAY_LABELS_MON_FIRST

function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = d.getDay()
  const offset = firstDay === 7 ? day : (day + 6) % 7
  d.setDate(d.getDate() - offset)
  return d
}

const now = ref(new Date())
const pageOffset = ref(0)

const pageStart = computed(() => {
  const base = startOfWeek(now.value)
  base.setDate(base.getDate() + pageOffset.value * weeksPerPage.value * 7)
  return base
})
const pageEnd = computed(() => {
  const d = new Date(pageStart.value)
  d.setDate(d.getDate() + weeksPerPage.value * 7)
  return d
})

const todayPos = computed(() => {
  const today = new Date()
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const dayDiff = Math.floor((t.getTime() - pageStart.value.getTime()) / (24 * 60 * 60 * 1000))
  if (dayDiff < 0 || dayDiff >= weeksPerPage.value * 7) return null
  return { row: Math.floor(dayDiff / 7), col: dayDiff % 7 }
})

const rows = computed(() => {
  const result: { weekStart: Date; columns: { date: Date; items: CalendarEntry[] }[] }[] = []
  for (let w = 0; w < weeksPerPage.value; w++) {
    const wStart = new Date(pageStart.value)
    wStart.setDate(wStart.getDate() + w * 7)
    const cols: { date: Date; items: CalendarEntry[] }[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(wStart)
      d.setDate(d.getDate() + i)
      cols.push({ date: d, items: [] })
    }
    result.push({ weekStart: wStart, columns: cols })
  }
  // Forward-looking only on the current page — past episodes drop out, future
  // pages and past pages show every entry in their range.
  const minTime = pageOffset.value === 0 ? now.value.getTime() : pageStart.value.getTime()
  const maxTime = pageEnd.value.getTime()
  for (const e of entries.value) {
    const ts = new Date(e.nextEpisodeAt).getTime()
    if (!Number.isFinite(ts)) continue
    if (ts < minTime || ts >= maxTime) continue
    const dayDiff = Math.floor((ts - pageStart.value.getTime()) / (24 * 60 * 60 * 1000))
    if (dayDiff < 0 || dayDiff >= weeksPerPage.value * 7) continue
    const row = Math.floor(dayDiff / 7)
    const col = dayDiff % 7
    result[row].columns[col].items.push(e)
  }
  for (const r of result) {
    for (const c of r.columns) {
      c.items.sort(
        (a, b) => new Date(a.nextEpisodeAt).getTime() - new Date(b.nextEpisodeAt).getTime()
      )
    }
  }
  return result
})

const pageRangeLabel = computed(() => {
  const start = pageStart.value
  const end = new Date(pageStart.value)
  end.setDate(end.getDate() + weeksPerPage.value * 7 - 1)
  const sameMonth = start.getMonth() === end.getMonth()
  const sameYear = start.getFullYear() === end.getFullYear()
  const startStr = start.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
  const endStr = sameMonth
    ? end.toLocaleDateString([], { day: 'numeric' })
    : end.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' })
      })
  return `${startStr} – ${endStr}`
})

const isCurrentPage = computed(() => pageOffset.value === 0)

function shiftPage(delta: number): void {
  pageOffset.value += delta
}

function resetPage(): void {
  pageOffset.value = 0
}

const totalCount = computed(() =>
  rows.value.reduce((sum, r) => sum + r.columns.reduce((s, c) => s + c.items.length, 0), 0)
)

async function loadViewSetting(): Promise<void> {
  const v = (await window.api.getSetting('calendarView')) as 'week' | 'month' | null
  weeksPerPage.value = v === 'month' ? 4 : 1
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatColumnDate(d: Date): string {
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function statusLabel(s: string): string {
  if (s === 'watching') return 'Watching'
  if (s === 'rewatching') return 'Rewatching'
  if (s === 'planned') return 'Planned'
  return s
}

async function load(force = false): Promise<void> {
  await loadViewSetting()
  const user = await window.api.shikimoriGetUser()
  if (!user) {
    entries.value = []
    error.value = 'Connect to Shikimori in Settings to see the calendar.'
    return
  }
  loading.value = true
  error.value = ''
  try {
    now.value = new Date()
    entries.value = await window.api.shikimoriGetCalendar(force)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load calendar'
  } finally {
    loading.value = false
  }
}

function handleClick(entry: CalendarEntry): void {
  if (entry.animeId !== null) emit('openAnime', entry.animeId)
}

function onCalendarViewChanged(): void {
  pageOffset.value = 0
  void loadViewSetting()
}

onMounted(() => {
  window.addEventListener('calendar-view-changed', onCalendarViewChanged)
  load()
})

onBeforeUnmount(() => {
  window.removeEventListener('calendar-view-changed', onCalendarViewChanged)
})
</script>

<template>
  <main class="calendar-view">
    <header class="topbar">
      <h2>Airing Calendar</h2>
      <div class="topbar-controls">
        <button class="nav-btn" @click="shiftPage(-1)" :title="weeksPerPage === 4 ? 'Previous 4 weeks' : 'Previous week'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
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
        <button class="nav-btn" @click="shiftPage(1)" :title="weeksPerPage === 4 ? 'Next 4 weeks' : 'Next week'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
        <button class="refresh-btn" :disabled="loading" @click="load(true)" title="Refresh calendar">
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
      <div v-if="loading && entries.length === 0" class="status-text">Loading calendar...</div>
      <div v-else-if="error" class="status-text error-text">{{ error }}</div>
      <div v-else-if="totalCount === 0" class="status-text">
        {{
          isCurrentPage
            ? weeksPerPage === 4
              ? 'No new episodes in the next 4 weeks — your watching list is up to date.'
              : 'No new episodes this week — your watching list is up to date.'
            : weeksPerPage === 4
              ? 'No tracked episodes air during these 4 weeks.'
              : 'No tracked episodes air during this week.'
        }}
      </div>
      <div v-else class="page">
        <div v-for="(row, rIdx) in rows" :key="rIdx" class="grid">
          <div
            v-for="(col, idx) in row.columns"
            :key="idx"
            class="column"
            :class="{ today: todayPos && todayPos.row === rIdx && todayPos.col === idx }"
          >
            <div class="column-head">
              <span class="day-label">{{ dayLabels[idx] }}</span>
              <span class="day-date">{{ formatColumnDate(col.date) }}</span>
            </div>
            <ul class="column-items">
              <li v-if="col.items.length === 0" class="empty">—</li>
              <li
                v-for="(entry, i) in col.items"
                :key="entry.malId + '-' + i"
                class="card"
                :class="{ clickable: entry.animeId !== null }"
                @click="handleClick(entry)"
              >
                <img
                  :src="entry.posterUrl"
                  :alt="entry.name"
                  class="poster"
                  loading="lazy"
                />
                <div class="card-text">
                  <div class="card-title" :title="entry.name">{{ entry.name }}</div>
                  <div class="card-meta">
                    <span class="ep">Ep {{ entry.episodeInt }}</span>
                    <span class="time">{{ formatTime(entry.nextEpisodeAt) }}</span>
                  </div>
                  <div class="card-chips">
                    <span class="chip" :class="'chip-' + entry.userStatus">{{
                      statusLabel(entry.userStatus)
                    }}</span>
                    <span v-if="entry.animeId === null" class="chip chip-na"
                      >Not on smotret-anime</span
                    >
                  </div>
                </div>
              </li>
            </ul>
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
}

.topbar {
  padding: 16px 24px;
  border-bottom: 1px solid #0f3460;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.topbar h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #e0e0e0;
}

.topbar-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.refresh-btn,
.nav-btn {
  background: none;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #6a6a8a;
  padding: 5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.refresh-btn:hover,
.nav-btn:hover {
  color: #e0e0e0;
  border-color: #e94560;
}

.refresh-btn:disabled,
.nav-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.week-label {
  background: none;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #c0c0d8;
  padding: 4px 12px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  min-width: 130px;
  text-align: center;
  transition: all 0.15s;
}

.week-label:hover:not(:disabled) {
  color: #e0e0e0;
  border-color: #e94560;
}

.week-label.today {
  color: #e94560;
  border-color: #e94560;
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
  overflow: auto;
  padding: 20px 24px;
}

.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(150px, 1fr));
  gap: 8px;
  min-width: 1050px;
}

.column {
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  min-height: 200px;
}

.column.today {
  border-color: #e94560;
  box-shadow: 0 0 0 1px rgba(233, 69, 96, 0.25);
}

.column-head {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border-bottom: 1px solid #0f3460;
}

.day-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #e0e0e0;
}

.column.today .day-label {
  color: #e94560;
}

.day-date {
  font-size: 0.7rem;
  color: #6a6a8a;
  margin-top: 2px;
}

.column-items {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}

.empty {
  color: #4a4a6a;
  font-size: 0.85rem;
  text-align: center;
  padding: 12px 0;
}

.card {
  display: flex;
  gap: 8px;
  padding: 6px;
  background: #1a1a2e;
  border: 1px solid transparent;
  border-radius: 6px;
  transition: all 0.15s;
}

.card.clickable {
  cursor: pointer;
}

.card.clickable:hover {
  border-color: #e94560;
  background: #1a2747;
}

.poster {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: 3px;
  background: #0f3460;
  flex-shrink: 0;
}

.card-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-title {
  font-size: 0.8rem;
  color: #e0e0e0;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.2;
}

.card-meta {
  display: flex;
  gap: 8px;
  font-size: 0.7rem;
  color: #8a8aa8;
}

.ep {
  color: #c0c0d8;
  font-weight: 500;
}

.time {
  color: #6a6a8a;
}

.card-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.chip {
  font-size: 0.65rem;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(15, 52, 96, 0.8);
  color: #c0c0d8;
}

.chip-watching,
.chip-rewatching {
  background: rgba(233, 69, 96, 0.2);
  color: #ff7090;
}

.chip-planned {
  background: rgba(15, 52, 96, 0.8);
  color: #8aa8d0;
}

.chip-na {
  background: rgba(80, 80, 100, 0.4);
  color: #8a8aa8;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}

.error-text {
  color: #e94560;
}
</style>
