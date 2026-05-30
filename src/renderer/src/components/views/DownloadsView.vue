<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useDownloadsStore } from '../../stores/downloads';
import { formatBytes, formatSpeed, formatEta } from '../../utils';

const downloadsStore = useDownloadsStore();
const { groups } = storeToRefs(downloadsStore);

onMounted(() => {
  void downloadsStore.refreshQueue();
});

function progress(item: DownloadProgressItem): number {
  if (item.totalBytes <= 0) return 0;
  return (item.bytesReceived / item.totalBytes) * 100;
}

function groupStatus(g: EpisodeGroup): string {
  const items = [g.video, g.subtitle].filter(Boolean) as DownloadProgressItem[];
  if (items.every((i) => i.status === 'completed')) {
    if (g.mergeStatus === 'completed') return 'merged';
    if (g.mergeStatus === 'merging') return 'merging';
    if (g.mergeStatus === 'failed') return 'merge-failed';
    // Crash-recovered merge: loadQueue() reset a mid-merge entry to 'pending'.
    // Backend refuses to clear these so the user can retry via Merge finished.
    if (g.hasMergeEntry && g.mergeStatus === 'pending') return 'pending-merge';
    return 'ready-for-merge';
  }
  if (items.some((i) => i.status === 'failed')) return 'failed';
  if (items.some((i) => i.status === 'downloading')) return 'downloading';
  if (items.some((i) => i.status === 'paused')) return 'paused';
  return 'queued';
}

function statusLabel(g: EpisodeGroup): string {
  const s = groupStatus(g);
  switch (s) {
    case 'merging':
      return `merging${g.mergePercent != null ? ' ' + g.mergePercent + '%' : ''}`;
    case 'ready-for-merge':
      return 'ready for merge';
    case 'pending-merge':
      return 'merge interrupted';
    case 'merge-failed':
      return 'merge failed';
    default:
      return s;
  }
}

const hasFailed = computed(() =>
  groups.value.some((g) => {
    const items = [g.video, g.subtitle].filter(Boolean) as DownloadProgressItem[];
    return items.some((i) => i.status === 'failed');
  })
);

const hasFinished = computed(() =>
  groups.value.some((g) => {
    const s = groupStatus(g);
    return s === 'merged' || s === 'failed' || s === 'merge-failed' || s === 'ready-for-merge';
  })
);

const hasMergeable = computed(() =>
  groups.value.some((g) => {
    const items = [g.video, g.subtitle].filter(Boolean) as DownloadProgressItem[];
    return (
      items.every((i) => i.status === 'completed') &&
      g.mergeStatus !== 'completed' &&
      g.mergeStatus !== 'merging'
    );
  })
);

const hasActive = computed(() =>
  groups.value.some((g) => {
    const items = [g.video, g.subtitle].filter(Boolean) as DownloadProgressItem[];
    return items.some((i) => i.status === 'downloading' || i.status === 'queued');
  })
);

const hasPaused = computed(() =>
  groups.value.some((g) => {
    const items = [g.video, g.subtitle].filter(Boolean) as DownloadProgressItem[];
    return items.some((i) => i.status === 'paused');
  })
);

const summary = computed(() => {
  let active = 0;
  let done = 0;
  let failed = 0;
  for (const g of groups.value) {
    const s = groupStatus(g);
    if (s === 'merged' || s === 'ready-for-merge') done++;
    else if (s === 'failed' || s === 'merge-failed') failed++;
    else active++;
  }
  return { active, done, failed };
});

const merging = ref(false);

function pauseItem(id: string): void {
  window.api.downloadPause(id);
}
function resumeItem(id: string): void {
  window.api.downloadResume(id);
}
function restartItem(id: string): void {
  window.api.downloadRestart(id);
}
function cancelItem(id: string): void {
  window.api.downloadCancel(id);
}
function cancelMerge(): void {
  window.api.downloadCancelMerge();
}
function retryAllFailed(): void {
  window.api.downloadRestartAllFailed();
}
function pauseAll(): void {
  window.api.downloadPauseAll();
}
function resumeAll(): void {
  window.api.downloadResumeAll();
}

async function clearCompleted(): Promise<void> {
  await window.api.downloadClearCompleted();
  groups.value = await window.api.downloadGetQueue();
}

async function mergeFinished(): Promise<void> {
  merging.value = true;
  try {
    await window.api.downloadMerge();
  } finally {
    merging.value = false;
    groups.value = await window.api.downloadGetQueue();
  }
}
</script>

<template>
  <main class="downloads-view">
    <header class="topbar">
      <h2>Downloads</h2>
      <div class="topbar-actions">
        <button v-if="hasActive" class="btn btn-warn" @click="pauseAll">Pause all</button>
        <button v-if="hasPaused" class="btn btn-ok" @click="resumeAll">Resume all</button>
        <button v-if="hasFailed" class="btn btn-primary" @click="retryAllFailed">
          Retry all failed
        </button>
        <button v-if="hasMergeable" class="btn btn-ok" :disabled="merging" @click="mergeFinished">
          {{ merging ? 'Merging…' : 'Merge finished' }}
        </button>
        <button v-if="hasFinished" class="btn" @click="clearCompleted">Clear done</button>
      </div>
    </header>
    <div class="body">
      <div v-if="groups.length === 0" class="empty-state">
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
            />
          </svg>
        </div>
        <p>No downloads yet. Open an anime and click "Download All".</p>
      </div>
      <template v-else>
        <div class="dl-summary">
          <div class="dl-stat">
            <span class="n active">{{ summary.active }}</span>
            <span class="l">Active</span>
          </div>
          <div class="dl-stat">
            <span class="n done">{{ summary.done }}</span>
            <span class="l">Done</span>
          </div>
          <div class="dl-stat">
            <span class="n failed">{{ summary.failed }}</span>
            <span class="l">Failed</span>
          </div>
        </div>

        <div class="dl-list">
          <div v-for="g in groups" :key="g.translationId" class="dl-card" :class="groupStatus(g)">
            <div class="dl-head">
              <div class="dl-poster" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M8 5v14l11-7z" />
                </svg>
              </div>
              <div class="dl-head-info">
                <span class="dl-title">{{ g.animeName }}</span>
                <span class="dl-ep">{{ g.episodeLabel }} · {{ g.quality }}p</span>
              </div>
              <span class="dl-status" :class="groupStatus(g)">{{ statusLabel(g) }}</span>
            </div>

            <div
              v-if="g.mergeStatus === 'merging'"
              class="dl-merge-banner merging"
            >
              <span class="mb-label">Merging</span>
              <div class="pbar thin">
                <span :style="{ width: (g.mergePercent || 0) + '%' }"></span>
              </div>
              <span class="mb-pct">{{ g.mergePercent != null ? g.mergePercent + '%' : '' }}</span>
              <button class="iconbtn cancel" title="Cancel merge" @click="cancelMerge()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div v-else-if="groupStatus(g) === 'merged'" class="dl-merge-banner merged">
              <span class="mb-label">Merged to MKV</span>
            </div>
            <div
              v-if="g.mergeStatus === 'failed' && g.mergeError"
              class="dl-error-line"
            >
              {{ g.mergeError }}
            </div>

            <!-- Video row -->
            <div v-if="g.video" class="dl-row">
              <span class="dl-kind">VIDEO</span>
              <span class="r-status" :class="g.video.status">{{ g.video.status }}</span>
              <template v-if="g.video.status === 'downloading'">
                <div class="pbar thin">
                  <span :style="{ width: progress(g.video) + '%' }"></span>
                </div>
                <span class="r-speed">{{ formatSpeed(g.video.speed) }}</span>
                <span class="r-eta">ETA {{ formatEta(g.video) }}</span>
              </template>
              <template v-else-if="g.video.status === 'paused'">
                <div class="pbar thin paused">
                  <span :style="{ width: progress(g.video) + '%' }"></span>
                </div>
              </template>
              <span v-if="g.video.totalBytes > 0" class="r-size"
                >{{ formatBytes(g.video.bytesReceived) }} /
                {{ formatBytes(g.video.totalBytes) }}</span
              >
              <span v-if="g.video.error" class="dl-error-line inline">{{ g.video.error }}</span>
              <div class="dl-actions">
                <button
                  v-if="g.video.status === 'downloading'"
                  class="iconbtn"
                  title="Pause"
                  @click="pauseItem(g.video.id)"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                </button>
                <button
                  v-if="g.video.status === 'paused' || g.video.status === 'failed'"
                  class="iconbtn resume"
                  :title="g.video.status === 'failed' ? 'Retry' : 'Resume'"
                  @click="resumeItem(g.video.id)"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>
                <button
                  v-if="g.video.status === 'failed'"
                  class="iconbtn restart"
                  title="Restart from scratch (re-fetch URLs)"
                  @click="restartItem(g.video.id)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
                    />
                  </svg>
                </button>
                <button
                  v-if="g.video.status !== 'completed' && g.video.status !== 'cancelled'"
                  class="iconbtn cancel"
                  title="Cancel"
                  @click="cancelItem(g.video.id)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- Subtitle row -->
            <div v-if="g.subtitle" class="dl-row">
              <span class="dl-kind sub">SUB</span>
              <span class="r-status" :class="g.subtitle.status">{{ g.subtitle.status }}</span>
              <template v-if="g.subtitle.status === 'downloading'">
                <div class="pbar thin sub">
                  <span :style="{ width: progress(g.subtitle) + '%' }"></span>
                </div>
                <span class="r-speed">{{ formatSpeed(g.subtitle.speed) }}</span>
              </template>
              <span v-if="g.subtitle.totalBytes > 0" class="r-size"
                >{{ formatBytes(g.subtitle.bytesReceived) }} /
                {{ formatBytes(g.subtitle.totalBytes) }}</span
              >
              <span v-if="g.subtitle.error" class="dl-error-line inline">{{
                g.subtitle.error
              }}</span>
              <div class="dl-actions">
                <button
                  v-if="g.subtitle.status === 'downloading'"
                  class="iconbtn"
                  title="Pause"
                  @click="pauseItem(g.subtitle.id)"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                </button>
                <button
                  v-if="g.subtitle.status === 'paused' || g.subtitle.status === 'failed'"
                  class="iconbtn resume"
                  :title="g.subtitle.status === 'failed' ? 'Retry' : 'Resume'"
                  @click="resumeItem(g.subtitle.id)"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>
                <button
                  v-if="g.subtitle.status === 'failed'"
                  class="iconbtn restart"
                  title="Restart from scratch (re-fetch URLs)"
                  @click="restartItem(g.subtitle.id)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
                    />
                  </svg>
                </button>
                <button
                  v-if="g.subtitle.status !== 'completed' && g.subtitle.status !== 'cancelled'"
                  class="iconbtn cancel"
                  title="Cancel"
                  @click="cancelItem(g.subtitle.id)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.downloads-view {
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

.topbar-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.btn {
  padding: 8px 14px;
  border-radius: var(--radius-btn);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.btn:hover {
  border-color: var(--border-strong);
  background: var(--surface-3);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.btn-primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.btn-warn {
  border-color: color-mix(in srgb, var(--st-orange) 40%, transparent);
  color: var(--st-orange);
}

.btn-warn:hover {
  border-color: var(--st-orange);
  background: color-mix(in srgb, var(--st-orange) 12%, transparent);
}

.btn-ok {
  border-color: color-mix(in srgb, var(--st-green) 40%, transparent);
  color: var(--st-green);
}

.btn-ok:hover:not(:disabled) {
  border-color: var(--st-green);
  background: color-mix(in srgb, var(--st-green) 12%, transparent);
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-y) var(--pad-x) 48px;
}

/* summary */
.dl-summary {
  display: flex;
  gap: 12px;
  margin-bottom: 18px;
}

.dl-stat {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dl-stat .n {
  font-family: var(--font-data);
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1;
  color: var(--text);
}

.dl-stat .n.active {
  color: var(--st-blue);
}

.dl-stat .n.done {
  color: var(--st-green);
}

.dl-stat .n.failed {
  color: var(--st-red);
}

.dl-stat .l {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
}

/* card list */
.dl-list {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}

.dl-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  border-left: 3px solid var(--border-strong);
  padding: 14px 18px;
}

.dl-card.downloading {
  border-left-color: var(--st-blue);
}
.dl-card.queued {
  border-left-color: var(--text-faint);
}
.dl-card.paused {
  border-left-color: var(--st-orange);
}
.dl-card.ready-for-merge,
.dl-card.pending-merge {
  border-left-color: var(--st-orange);
}
.dl-card.completed,
.dl-card.merging {
  border-left-color: var(--st-green);
}
.dl-card.merged {
  border-left-color: var(--st-purple);
}
.dl-card.failed,
.dl-card.merge-failed {
  border-left-color: var(--st-red);
}

/* card head */
.dl-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dl-poster {
  width: 40px;
  aspect-ratio: 2 / 3;
  border-radius: 5px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  color: var(--text-faint);
  flex-shrink: 0;
}

.dl-poster svg {
  width: 16px;
  height: 16px;
}

.dl-head-info {
  flex: 1;
  min-width: 0;
}

.dl-title {
  display: block;
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-ep {
  display: block;
  margin-top: 2px;
  font-family: var(--font-data);
  font-size: 0.74rem;
  color: var(--text-3);
}

.dl-status {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
  white-space: nowrap;
}

.dl-status.downloading {
  color: var(--st-blue);
}
.dl-status.queued {
  color: var(--text-3);
}
.dl-status.paused,
.dl-status.ready-for-merge,
.dl-status.pending-merge {
  color: var(--st-orange);
}
.dl-status.merging {
  color: var(--st-green);
}
.dl-status.merged {
  color: var(--st-purple);
}
.dl-status.failed,
.dl-status.merge-failed {
  color: var(--st-red);
}

/* merge banner */
.dl-merge-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-btn);
  font-size: 0.76rem;
  font-weight: 600;
}

.dl-merge-banner.merging {
  color: var(--st-green);
  background: color-mix(in srgb, var(--st-green) 9%, transparent);
}

.dl-merge-banner.merged {
  color: var(--st-purple);
  background: color-mix(in srgb, var(--st-purple) 9%, transparent);
}

.mb-label {
  flex-shrink: 0;
}

.dl-merge-banner.merging .pbar > span {
  background: var(--st-green);
}

.mb-pct {
  font-family: var(--font-data);
  font-size: 0.72rem;
  flex-shrink: 0;
}

/* stream rows */
.dl-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.dl-kind {
  font-family: var(--font-data);
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--st-blue);
  width: 42px;
  flex-shrink: 0;
}

.dl-kind.sub {
  color: var(--st-green);
}

.r-status {
  font-size: 0.74rem;
  font-weight: 600;
  width: 86px;
  flex-shrink: 0;
  color: var(--text-3);
}

.r-status.downloading {
  color: var(--st-blue);
}
.r-status.queued {
  color: var(--text-3);
}
.r-status.paused {
  color: var(--st-orange);
}
.r-status.completed {
  color: var(--st-green);
}
.r-status.failed {
  color: var(--st-red);
}

.pbar.thin {
  min-width: 80px;
}

.pbar.thin.paused > span {
  background: var(--st-orange);
}

.pbar.thin.sub > span {
  background: var(--st-green);
}

.r-speed,
.r-eta,
.r-size {
  font-family: var(--font-data);
  font-size: 0.72rem;
  color: var(--text-3);
  flex-shrink: 0;
}

.dl-error-line {
  margin-top: 8px;
  font-size: 0.74rem;
  color: var(--st-red);
}

.dl-error-line.inline {
  margin-top: 0;
  flex: 1;
  min-width: 0;
}

.dl-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}

.iconbtn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  background: var(--surface-2);
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.iconbtn svg {
  width: 14px;
  height: 14px;
}

.iconbtn:hover {
  border-color: var(--border-strong);
  background: var(--surface-3);
  color: var(--text);
}

.iconbtn.resume {
  color: var(--st-green);
}
.iconbtn.resume:hover {
  border-color: var(--st-green);
}
.iconbtn.restart {
  color: var(--st-orange);
}
.iconbtn.restart:hover {
  border-color: var(--st-orange);
}
.iconbtn.cancel {
  color: var(--st-red);
}
.iconbtn.cancel:hover {
  border-color: var(--st-red);
}
</style>
