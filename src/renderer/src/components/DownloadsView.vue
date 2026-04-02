<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

const groups = ref<EpisodeGroup[]>([])

function onProgress(data: EpisodeGroup[]): void {
  groups.value = data
}

onMounted(async () => {
  groups.value = await window.api.downloadGetQueue()
  window.api.onDownloadProgress(onProgress)
})

onUnmounted(() => {
  window.api.offDownloadProgress()
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

function formatSpeed(bps: number): string {
  return formatBytes(bps) + '/s'
}

function formatEta(item: DownloadProgressItem): string {
  if (item.speed <= 0 || item.totalBytes <= 0) return '--'
  const remaining = item.totalBytes - item.bytesReceived
  const seconds = Math.ceil(remaining / item.speed)
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function progress(item: DownloadProgressItem): number {
  if (item.totalBytes <= 0) return 0
  return (item.bytesReceived / item.totalBytes) * 100
}

function groupStatus(g: EpisodeGroup): string {
  const items = [g.video, g.subtitle].filter(Boolean) as DownloadProgressItem[]
  if (items.every(i => i.status === 'completed')) {
    if (g.mergeStatus === 'completed') return 'merged'
    if (g.mergeStatus === 'merging') return 'merging'
    return 'completed'
  }
  if (items.some(i => i.status === 'failed')) return 'failed'
  if (items.some(i => i.status === 'downloading')) return 'downloading'
  if (items.some(i => i.status === 'paused')) return 'paused'
  return 'queued'
}

const hasFinished = computed(() =>
  groups.value.some(g => {
    const s = groupStatus(g)
    return s === 'completed' || s === 'merged' || s === 'failed'
  })
)

const hasMergeable = computed(() =>
  groups.value.some(g => {
    const items = [g.video, g.subtitle].filter(Boolean) as DownloadProgressItem[]
    return items.every(i => i.status === 'completed') && g.mergeStatus !== 'completed' && g.mergeStatus !== 'merging'
  })
)

const merging = ref(false)

function pauseItem(id: string): void { window.api.downloadPause(id) }
function resumeItem(id: string): void { window.api.downloadResume(id) }
function restartItem(id: string): void { window.api.downloadRestart(id) }
function cancelItem(id: string): void { window.api.downloadCancel(id) }

async function clearCompleted(): Promise<void> {
  await window.api.downloadClearCompleted()
  groups.value = await window.api.downloadGetQueue()
}

async function mergeFinished(): Promise<void> {
  merging.value = true
  try {
    await window.api.downloadMerge()
  } finally {
    merging.value = false
    groups.value = await window.api.downloadGetQueue()
  }
}
</script>

<template>
  <main class="downloads-view">
    <header class="topbar">
      <h2>Downloads</h2>
      <div class="topbar-actions">
        <button v-if="hasMergeable" class="merge-btn" @click="mergeFinished" :disabled="merging">
          {{ merging ? 'Merging...' : 'Merge finished' }}
        </button>
        <button v-if="hasFinished" class="clear-btn" @click="clearCompleted">Clear finished</button>
      </div>
    </header>
    <div class="body">
      <div v-if="groups.length === 0" class="status-text">
        No downloads yet. Open an anime and click "Download All".
      </div>
      <div v-else class="download-list">
        <div v-for="g in groups" :key="g.translationId" class="episode-group" :class="groupStatus(g)">
          <div class="group-header">
            <span class="group-title">{{ g.animeName }} - {{ g.episodeLabel }}</span>
            <span class="group-quality">{{ g.quality }}p</span>
            <span class="group-status" :class="groupStatus(g)">
              <template v-if="g.mergeStatus === 'merging'">merging {{ g.mergePercent != null ? g.mergePercent + '%' : '' }}</template>
              <template v-else>{{ groupStatus(g) }}</template>
            </span>
            <div v-if="g.mergeStatus === 'merging'" class="progress-bar-wrap merge-bar">
              <div class="progress-bar merge" :style="{ width: (g.mergePercent || 0) + '%' }"></div>
            </div>
            <span v-if="g.mergeStatus === 'failed' && g.mergeError" class="merge-error">{{ g.mergeError }}</span>
          </div>

          <!-- Video row -->
          <div v-if="g.video" class="dl-row">
            <span class="dl-kind">VIDEO</span>
            <span class="dl-status-badge" :class="g.video.status">{{ g.video.status }}</span>
            <template v-if="g.video.status === 'downloading'">
              <div class="progress-bar-wrap">
                <div class="progress-bar" :style="{ width: progress(g.video) + '%' }"></div>
              </div>
              <span class="dl-speed">{{ formatSpeed(g.video.speed) }}</span>
              <span class="dl-eta">ETA {{ formatEta(g.video) }}</span>
            </template>
            <template v-else-if="g.video.status === 'paused'">
              <div class="progress-bar-wrap">
                <div class="progress-bar paused" :style="{ width: progress(g.video) + '%' }"></div>
              </div>
            </template>
            <span v-if="g.video.totalBytes > 0" class="dl-size">{{ formatBytes(g.video.bytesReceived) }} / {{ formatBytes(g.video.totalBytes) }}</span>
            <span v-if="g.video.error" class="dl-error">{{ g.video.error }}</span>
            <div class="dl-actions">
              <button v-if="g.video.status === 'downloading'" class="action-btn" @click="pauseItem(g.video.id)" title="Pause">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
              </button>
              <button v-if="g.video.status === 'paused' || g.video.status === 'failed'" class="action-btn resume" @click="resumeItem(g.video.id)" :title="g.video.status === 'failed' ? 'Retry' : 'Resume'">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <button v-if="g.video.status === 'failed'" class="action-btn restart" @click="restartItem(g.video.id)" title="Restart from scratch (re-fetch URLs)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"/></svg>
              </button>
              <button v-if="g.video.status !== 'completed' && g.video.status !== 'cancelled'" class="action-btn cancel" @click="cancelItem(g.video.id)" title="Cancel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
          </div>

          <!-- Subtitle row -->
          <div v-if="g.subtitle" class="dl-row">
            <span class="dl-kind sub">SUB</span>
            <span class="dl-status-badge" :class="g.subtitle.status">{{ g.subtitle.status }}</span>
            <template v-if="g.subtitle.status === 'downloading'">
              <div class="progress-bar-wrap">
                <div class="progress-bar sub" :style="{ width: progress(g.subtitle) + '%' }"></div>
              </div>
              <span class="dl-speed">{{ formatSpeed(g.subtitle.speed) }}</span>
            </template>
            <span v-if="g.subtitle.totalBytes > 0" class="dl-size">{{ formatBytes(g.subtitle.bytesReceived) }} / {{ formatBytes(g.subtitle.totalBytes) }}</span>
            <span v-if="g.subtitle.error" class="dl-error">{{ g.subtitle.error }}</span>
            <div class="dl-actions">
              <button v-if="g.subtitle.status === 'downloading'" class="action-btn" @click="pauseItem(g.subtitle.id)" title="Pause">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
              </button>
              <button v-if="g.subtitle.status === 'paused' || g.subtitle.status === 'failed'" class="action-btn resume" @click="resumeItem(g.subtitle.id)" :title="g.subtitle.status === 'failed' ? 'Retry' : 'Resume'">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <button v-if="g.subtitle.status === 'failed'" class="action-btn restart" @click="restartItem(g.subtitle.id)" title="Restart from scratch (re-fetch URLs)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"/></svg>
              </button>
              <button v-if="g.subtitle.status !== 'completed' && g.subtitle.status !== 'cancelled'" class="action-btn cancel" @click="cancelItem(g.subtitle.id)" title="Cancel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.downloads-view {
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

.topbar-actions {
  display: flex;
  gap: 8px;
}

.clear-btn, .merge-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.clear-btn {
  background-color: #0f3460;
  color: #a0a0b8;
}

.clear-btn:hover {
  background-color: #1a4a7a;
  color: #e0e0e0;
}

.merge-btn {
  background-color: #6ab04c;
  color: white;
}

.merge-btn:hover {
  background-color: #5a9a3c;
}

.merge-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}

.download-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.episode-group {
  background-color: #16213e;
  border-radius: 8px;
  padding: 12px 16px;
  border-left: 3px solid #0f3460;
}

.episode-group.downloading { border-left-color: #3498db; }
.episode-group.completed { border-left-color: #6ab04c; }
.episode-group.merged { border-left-color: #9b59b6; }
.episode-group.merging { border-left-color: #f39c12; }
.episode-group.failed { border-left-color: #e94560; }
.episode-group.paused { border-left-color: #f39c12; }

.group-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.group-title {
  font-size: 0.9rem;
  color: #e0e0e0;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-quality {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 700;
  background-color: #1a4a2e;
  color: #6ab04c;
  flex-shrink: 0;
}

.group-status {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.group-status.downloading { color: #3498db; }
.group-status.queued { color: #6a6a8a; }
.group-status.paused { color: #f39c12; }
.group-status.completed { color: #6ab04c; }
.group-status.merged { color: #9b59b6; }
.group-status.merging { color: #f39c12; }
.group-status.failed { color: #e94560; }

.merge-error {
  font-size: 0.7rem;
  color: #e94560;
}

.dl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  flex-wrap: wrap;
}

.dl-kind {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 3px;
  background-color: #0f3460;
  color: #3498db;
  flex-shrink: 0;
  width: 40px;
  text-align: center;
}

.dl-kind.sub {
  color: #6ab04c;
}

.dl-status-badge {
  font-size: 0.7rem;
  font-weight: 600;
  width: 80px;
  flex-shrink: 0;
}

.dl-status-badge.downloading { color: #3498db; }
.dl-status-badge.queued { color: #6a6a8a; }
.dl-status-badge.paused { color: #f39c12; }
.dl-status-badge.completed { color: #6ab04c; }
.dl-status-badge.failed { color: #e94560; }

.progress-bar-wrap {
  flex: 1;
  height: 4px;
  background-color: #0f3460;
  border-radius: 2px;
  overflow: hidden;
  min-width: 80px;
}

.progress-bar {
  height: 100%;
  background-color: #3498db;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.progress-bar.paused { background-color: #f39c12; }
.progress-bar.merge { background-color: #9b59b6; }
.merge-bar { max-width: 120px; }
.progress-bar.sub { background-color: #6ab04c; }

.dl-speed, .dl-eta, .dl-size {
  font-size: 0.7rem;
  color: #6a6a8a;
  flex-shrink: 0;
}

.dl-error {
  font-size: 0.7rem;
  color: #e94560;
}

.dl-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}

.action-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background-color: #0f3460;
  color: #a0a0b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.action-btn:hover { background-color: #1a4a7a; color: #e0e0e0; }
.action-btn.resume { color: #6ab04c; }
.action-btn.resume:hover { color: #8ee070; }
.action-btn.restart { color: #f0932b; }
.action-btn.restart:hover { color: #f5b041; }
.action-btn.cancel { color: #e94560; }
.action-btn.cancel:hover { color: #ff6b81; }
</style>
