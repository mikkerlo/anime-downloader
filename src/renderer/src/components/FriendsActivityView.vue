<script setup lang="ts">
import { ref, onMounted } from 'vue'

const emit = defineEmits<{
  openAnime: [id: number]
}>()

const activities = ref<ShikiFriendActivityEntry[]>([])
const loading = ref(false)
const error = ref('')
let lastLoadedAt = 0

const CACHE_MS = 5 * 60 * 1000

function stripHtml(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return (tmp.textContent || tmp.innerText || '').trim()
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  const yr = Math.floor(day / 365)
  return `${yr}y ago`
}

async function load(force = false): Promise<void> {
  if (!force && activities.value.length > 0 && Date.now() - lastLoadedAt < CACHE_MS) {
    return
  }
  const user = await window.api.shikimoriGetUser()
  if (!user) {
    activities.value = []
    error.value = 'Connect to Shikimori in Settings to see friends activity.'
    return
  }
  loading.value = true
  error.value = ''
  try {
    activities.value = await window.api.shikimoriGetFriendsActivity()
    lastLoadedAt = Date.now()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load friends activity'
  } finally {
    loading.value = false
  }
}

function handleClick(entry: ShikiFriendActivityEntry): void {
  if (entry.smotretAnime) emit('openAnime', entry.smotretAnime.id)
}

function posterUrl(entry: ShikiFriendActivityEntry): string {
  // Prefer smotret-anime's poster — Shikimori's image URL can be a 'missing'
  // placeholder for newly-listed anime. The main process already enriches
  // smotret entries via `enrichMissingPosters`, so this is normally non-empty.
  return entry.smotretAnime?.posterUrlSmall || entry.animeImage
}

onMounted(() => load())
</script>

<template>
  <main class="friends-view">
    <header class="topbar">
      <h2>Friends Activity</h2>
      <div class="topbar-controls">
        <button class="refresh-btn" :disabled="loading" @click="load(true)" title="Refresh feed">
          <svg :class="{ spinning: loading }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992" />
          </svg>
        </button>
      </div>
    </header>
    <div class="body">
      <div v-if="loading && activities.length === 0" class="status-text">Loading friends activity...</div>
      <div v-else-if="error" class="status-text error-text">{{ error }}</div>
      <div v-else-if="activities.length === 0" class="status-text">
        No recent activity from your Shikimori friends.
      </div>
      <ul v-else class="feed">
        <li
          v-for="(entry, idx) in activities"
          :key="entry.friendId + '-' + entry.createdAt + '-' + idx"
          class="feed-item"
          :class="{ clickable: entry.smotretAnime }"
          @click="handleClick(entry)"
        >
          <img :src="entry.friendAvatar" :alt="entry.friendNickname" class="avatar" loading="lazy" />
          <div class="text">
            <div class="line-1">
              <span class="nickname">{{ entry.friendNickname }}</span>
              <span class="time">· {{ formatRelative(entry.createdAt) }}</span>
              <span v-if="!entry.smotretAnime" class="not-available">Not in catalog</span>
            </div>
            <div class="line-2">{{ stripHtml(entry.description) }}</div>
            <div class="line-3" :title="entry.animeName">{{ entry.animeName }}</div>
          </div>
          <img :src="posterUrl(entry)" :alt="entry.animeName" class="poster" loading="lazy" />
        </li>
      </ul>
    </div>
  </main>
</template>

<style scoped>
.friends-view {
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

.refresh-btn {
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

.refresh-btn:hover {
  color: #e0e0e0;
  border-color: #e94560;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.feed {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 760px;
  margin: 0 auto;
}

.feed-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  transition: all 0.15s;
}

.feed-item.clickable {
  cursor: pointer;
}

.feed-item.clickable:hover {
  border-color: #e94560;
  background: #1a2747;
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #0f3460;
}

.text {
  flex: 1;
  min-width: 0;
}

.line-1 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
}

.nickname {
  color: #e0e0e0;
  font-weight: 600;
}

.time {
  color: #6a6a8a;
  font-size: 0.75rem;
}

.not-available {
  margin-left: auto;
  color: #6a6a8a;
  font-size: 0.7rem;
  background: rgba(15, 52, 96, 0.8);
  padding: 2px 6px;
  border-radius: 4px;
}

.line-2 {
  margin-top: 2px;
  color: #c0c0d8;
  font-size: 0.85rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.line-3 {
  margin-top: 2px;
  color: #8a8aa8;
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.poster {
  width: 48px;
  height: 68px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
  background: #0f3460;
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
