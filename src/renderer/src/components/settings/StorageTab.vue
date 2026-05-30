<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, onActivated } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import { formatBytes } from '../../utils';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import SettingsSwitch from './SettingsSwitch.vue';

const { autoSave, showSaved } = useSettingsAutosave();

const loaded = ref(false);

const downloadDir = ref('');
const storageMode = ref<'simple' | 'advanced'>('simple');
const hotStorageDir = ref('');
const coldStorageDir = ref('');
const autoMoveToCold = ref(false);
const movingToCold = ref(false);
const moveProgress = ref<{ current: number; total: number; file: string } | null>(null);
const moveResult = ref<{ moved: number; failed: string[] } | null>(null);

const storageUsage = ref<StorageUsage | null>(null);
const usageScanning = ref(false);
const usageProgress = ref<{ scanned: number; total: number } | null>(null);
const expandedAnime = ref<Set<number>>(new Set());

const autoCleanupDays = ref(0);
const autoCleanupLastRun = ref<{ ranAt: number; deletedCount: number; freedBytes: number } | null>(
  null
);
const cleanupLog = ref<CleanupLogEntry[]>([]);
const cleanupRunning = ref(false);
const cleanupResult = ref<CleanupResult | null>(null);
const cleanupPending = ref<CleanupCandidate[] | null>(null);
const cleanupLogExpanded = ref(false);
const snoozedEntries = ref<{ animeId: number; animeName: string }[]>([]);
const snoozedLoading = ref(false);

let unsubMoveToCold: Unsubscribe | null = null;
let unsubUsageProgress: Unsubscribe | null = null;
let unsubCleanupPending: Unsubscribe | null = null;
let unsubCleanupFinished: Unsubscribe | null = null;

function onMoveProgress(data: { current: number; total: number; file: string }): void {
  moveProgress.value = data;
}

async function pickDir(): Promise<void> {
  const dir = await window.api.downloadPickDir();
  if (dir) {
    downloadDir.value = dir;
    autoSave('downloadDir', dir);
  }
}

async function pickHotDir(): Promise<void> {
  const dir = await window.api.storagePickHotDir();
  if (dir) {
    hotStorageDir.value = dir;
    showSaved();
  }
}

async function pickColdDir(): Promise<void> {
  const dir = await window.api.storagePickColdDir();
  if (dir) {
    coldStorageDir.value = dir;
    showSaved();
  }
}

async function moveToCold(): Promise<void> {
  movingToCold.value = true;
  moveProgress.value = null;
  moveResult.value = null;
  try {
    const result = await window.api.storageMoveToCold();
    moveResult.value = result;
  } catch (err) {
    moveResult.value = { moved: 0, failed: [String(err)] };
  } finally {
    movingToCold.value = false;
    moveProgress.value = null;
  }
}

async function refreshStorageUsage(): Promise<void> {
  if (usageScanning.value) return;
  usageScanning.value = true;
  usageProgress.value = null;
  try {
    storageUsage.value = await window.api.storageGetUsage();
  } catch (err) {
    console.error('storage:get-usage failed', err);
  } finally {
    usageScanning.value = false;
    usageProgress.value = null;
  }
}

function toggleAnimeExpand(animeId: number): void {
  const next = new Set(expandedAnime.value);
  if (next.has(animeId)) next.delete(animeId);
  else next.add(animeId);
  expandedAnime.value = next;
}

async function deleteEpisode(
  animeName: string,
  episodeInt: string,
  animeId: number
): Promise<void> {
  await window.api.fileDeleteEpisode(animeName, episodeInt, animeId);
  await refreshStorageUsage();
}

async function runCleanupNow(): Promise<void> {
  if (cleanupRunning.value) return;
  cleanupRunning.value = true;
  cleanupResult.value = null;
  try {
    const result = await window.api.storageRunCleanup();
    if (result.deletedCount > 0 || result.items.length === 0) {
      cleanupResult.value = result;
      autoCleanupLastRun.value = {
        ranAt: result.ranAt,
        deletedCount: result.deletedCount,
        freedBytes: result.freedBytes
      };
      await reloadCleanupLog();
      await refreshStorageUsage();
    }
    // If candidates exist + confirm gate is up, main broadcasts
    // storage:cleanup-pending instead — handled by onCleanupPending below.
  } catch (err) {
    console.error('storage:run-cleanup failed', err);
  } finally {
    cleanupRunning.value = false;
  }
}

async function confirmCleanup(): Promise<void> {
  if (!cleanupPending.value) return;
  await window.api.setSetting('autoCleanupConfirm', false);
  cleanupPending.value = null;
  cleanupRunning.value = true;
  try {
    const result = await window.api.storageRunCleanup({ force: true });
    cleanupResult.value = result;
    autoCleanupLastRun.value = {
      ranAt: result.ranAt,
      deletedCount: result.deletedCount,
      freedBytes: result.freedBytes
    };
    await reloadCleanupLog();
    await refreshStorageUsage();
  } finally {
    cleanupRunning.value = false;
  }
}

function dismissCleanupPending(): void {
  cleanupPending.value = null;
}

async function reloadCleanupLog(): Promise<void> {
  const log = (await window.api.getSetting('cleanupLog')) as CleanupLogEntry[] | null;
  cleanupLog.value = log || [];
}

async function reloadSnoozedCleanups(): Promise<void> {
  snoozedLoading.value = true;
  try {
    const map = await window.api.cleanupGetSnoozed();
    snoozedEntries.value = Object.entries(map)
      .map(([id, v]) => ({ animeId: Number(id), animeName: v.animeName }))
      .sort((a, b) => a.animeName.localeCompare(b.animeName));
  } finally {
    snoozedLoading.value = false;
  }
}

async function unsnoozeCleanup(animeId: number): Promise<void> {
  await window.api.cleanupSetSnoozed(animeId, false);
  await reloadSnoozedCleanups();
}

async function resetAllCleanupSnoozes(): Promise<void> {
  for (const entry of snoozedEntries.value) {
    await window.api.cleanupSetSnoozed(entry.animeId, false);
  }
  await reloadSnoozedCleanups();
}

function onUsageProgress(data: { scanned: number; total: number }): void {
  usageProgress.value = data;
}

function onCleanupPending(data: { candidates: CleanupCandidate[] }): void {
  cleanupPending.value = data.candidates;
}

function onCleanupFinished(data: CleanupResult): void {
  cleanupResult.value = data;
  autoCleanupLastRun.value = {
    ranAt: data.ranAt,
    deletedCount: data.deletedCount,
    freedBytes: data.freedBytes
  };
  void reloadCleanupLog();
}

function formatRelativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'in the future';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

onMounted(async () => {
  unsubMoveToCold = window.api.onStorageMoveToColdProgress(onMoveProgress);
  unsubUsageProgress = window.api.onStorageUsageProgress(onUsageProgress);
  unsubCleanupPending = window.api.onStorageCleanupPending(onCleanupPending);
  unsubCleanupFinished = window.api.onStorageCleanupFinished(onCleanupFinished);

  downloadDir.value = ((await window.api.getSetting('downloadDir')) as string) || '';
  storageMode.value =
    ((await window.api.getSetting('storageMode')) as 'simple' | 'advanced') || 'simple';
  hotStorageDir.value = ((await window.api.getSetting('hotStorageDir')) as string) || '';
  coldStorageDir.value = ((await window.api.getSetting('coldStorageDir')) as string) || '';
  autoMoveToCold.value = ((await window.api.getSetting('autoMoveToCold')) as boolean) || false;
  autoCleanupDays.value = ((await window.api.getSetting('autoCleanupWatchedDays')) as number) || 0;
  autoCleanupLastRun.value = (await window.api.getSetting('autoCleanupLastRun')) as {
    ranAt: number;
    deletedCount: number;
    freedBytes: number;
  } | null;
  await reloadCleanupLog();
  await reloadSnoozedCleanups();

  loaded.value = true;
});

onActivated(() => {
  void reloadSnoozedCleanups();
});

onUnmounted(() => {
  unsubMoveToCold?.();
  unsubUsageProgress?.();
  unsubCleanupPending?.();
  unsubCleanupFinished?.();
});

watch(storageMode, (val) => {
  if (loaded.value) autoSave('storageMode', val);
});
watch(autoMoveToCold, (val) => {
  if (loaded.value) autoSave('autoMoveToCold', val);
});
watch(autoCleanupDays, (val) => {
  if (loaded.value) autoSave('autoCleanupWatchedDays', Number(val) || 0);
});
</script>

<template>
  <div>
    <SettingsGroup title="Storage mode">
      <SettingsRow
        label="Mode"
        desc="Simple mode uses a single directory. Advanced mode separates active downloads (hot) from finished files (cold)."
      >
        <div class="set-seg">
          <button :class="{ on: storageMode === 'simple' }" @click="storageMode = 'simple'">
            Simple
          </button>
          <button :class="{ on: storageMode === 'advanced' }" @click="storageMode = 'advanced'">
            Advanced
          </button>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Locations">
      <SettingsRow
        v-if="storageMode === 'simple'"
        label="Download folder"
        desc="Where downloaded anime files are saved."
      >
        <div class="path-field">
          <span class="path-input">{{ downloadDir || 'Default (Downloads/anime-dl)' }}</span>
          <button class="btn btn-sm btn-ghost" @click="pickDir">Browse</button>
        </div>
      </SettingsRow>

      <template v-else>
        <SettingsRow
          label="Hot storage (active downloads)"
          desc="Where new downloads and in-progress files are saved."
        >
          <div class="path-field">
            <span class="path-input">{{ hotStorageDir || 'Default (Downloads/anime-dl)' }}</span>
            <button class="btn btn-sm btn-ghost" @click="pickHotDir">Browse</button>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Cold storage (finished files)"
          desc="Where completed files are moved for long-term storage."
        >
          <div class="path-field">
            <span class="path-input" :class="{ warn: !coldStorageDir }">{{
              coldStorageDir || 'Not set'
            }}</span>
            <button class="btn btn-sm btn-ghost" @click="pickColdDir">Browse</button>
          </div>
        </SettingsRow>
        <SettingsRow v-if="!coldStorageDir || coldStorageDir === hotStorageDir" stack>
          <div v-if="!coldStorageDir" class="inline-result bad">
            Cold storage directory must be set in advanced mode.
          </div>
          <div v-else class="inline-result bad">
            Cold storage must be different from hot storage.
          </div>
        </SettingsRow>
        <SettingsRow
          label="Auto-move to cold storage"
          desc="Automatically move finished files to cold storage after download (or merge, if enabled)."
        >
          <SettingsSwitch v-model="autoMoveToCold" :disabled="!coldStorageDir" />
        </SettingsRow>
        <SettingsRow
          label="Move all to cold storage"
          desc="Move all finished files from hot to cold storage now."
        >
          <button
            class="btn btn-sm"
            :disabled="movingToCold || !coldStorageDir || coldStorageDir === hotStorageDir"
            @click="moveToCold"
          >
            {{ movingToCold ? 'Moving...' : 'Move all' }}
          </button>
        </SettingsRow>
        <SettingsRow v-if="moveProgress || moveResult" stack>
          <div v-if="moveProgress" class="set-progress">
            <div class="set-progress-head">
              <span>{{ moveProgress.current }} / {{ moveProgress.total }}</span>
            </div>
            <div class="bar">
              <span
                :style="{
                  width:
                    (moveProgress.total > 0
                      ? Math.round((moveProgress.current / moveProgress.total) * 100)
                      : 0) + '%'
                }"
              ></span>
            </div>
            <div class="file">{{ moveProgress.file }}</div>
          </div>
          <div
            v-if="moveResult"
            class="result-box"
            :class="{ 'has-errors': moveResult.failed.length > 0 }"
          >
            <div class="result-ok">Moved: {{ moveResult.moved }} file(s)</div>
            <div v-if="moveResult.failed.length > 0" class="result-errors">
              <div>Failed ({{ moveResult.failed.length }}):</div>
              <div v-for="(err, i) in moveResult.failed" :key="i" class="result-error-item">
                {{ err }}
              </div>
            </div>
          </div>
        </SettingsRow>
      </template>
    </SettingsGroup>

    <SettingsGroup
      title="Storage usage"
      desc="Disk space used by downloaded episodes. Click an anime to expand its episode list."
    >
      <SettingsRow label="Scan">
        <button class="btn btn-sm" :disabled="usageScanning" @click="refreshStorageUsage">
          {{ usageScanning ? 'Scanning...' : storageUsage ? 'Rescan' : 'Scan storage' }}
        </button>
      </SettingsRow>

      <SettingsRow v-if="usageProgress || storageUsage" stack>
        <div v-if="usageProgress" class="set-progress">
          <div class="set-progress-head">
            <span>{{ usageProgress.scanned }} / {{ usageProgress.total }}</span>
          </div>
          <div class="bar">
            <span
              :style="{
                width:
                  (usageProgress.total > 0
                    ? Math.round((usageProgress.scanned / usageProgress.total) * 100)
                    : 0) + '%'
              }"
            ></span>
          </div>
        </div>

        <div v-if="storageUsage" class="usage-summary">
          <div class="usage-total">
            <span class="usage-total-label">Total</span>
            <span class="usage-total-value">{{ formatBytes(storageUsage.totalBytes) }}</span>
            <span class="usage-total-meta"
              >{{ storageUsage.fileCount }} file(s) across
              {{ storageUsage.perAnime.length }} title(s)</span
            >
          </div>
          <div v-if="storageMode === 'advanced'" class="usage-buckets">
            <span class="usage-bucket"
              ><span class="bucket-label">Hot</span> {{ formatBytes(storageUsage.bytesHot) }}</span
            >
            <span class="usage-bucket"
              ><span class="bucket-label">Cold</span>
              {{ formatBytes(storageUsage.bytesCold) }}</span
            >
          </div>
        </div>

        <div v-if="storageUsage && storageUsage.perAnime.length > 0" class="usage-list">
          <div v-for="anime in storageUsage.perAnime" :key="anime.animeId" class="usage-anime">
            <div class="usage-anime-row" @click="toggleAnimeExpand(anime.animeId)">
              <img v-if="anime.posterUrlSmall" :src="anime.posterUrlSmall" class="usage-poster" />
              <div class="usage-anime-name">{{ anime.animeName }}</div>
              <div class="usage-anime-meta">
                <span>{{ anime.fileCount }} file(s)</span>
                <span class="usage-anime-size">{{ formatBytes(anime.bytes) }}</span>
              </div>
              <span class="usage-chevron" :class="{ open: expandedAnime.has(anime.animeId) }"
                >›</span
              >
            </div>
            <div v-if="expandedAnime.has(anime.animeId)" class="usage-episodes">
              <div v-for="ep in anime.episodes" :key="ep.episodeInt" class="usage-episode">
                <span class="usage-ep-num">Ep {{ ep.episodeInt }}</span>
                <span class="usage-ep-tags">
                  <span v-if="ep.files.mkv" class="usage-tag">MKV</span>
                  <span v-if="ep.files.mp4" class="usage-tag">MP4</span>
                  <span v-if="ep.files.ass" class="usage-tag">ASS</span>
                  <span v-if="ep.watched" class="usage-tag usage-tag-watched"
                    >Watched{{ ep.watchedAt ? ` ${formatRelativeTime(ep.watchedAt)}` : '' }}</span
                  >
                </span>
                <span class="usage-ep-size">{{ formatBytes(ep.totalBytes) }}</span>
                <button
                  class="usage-ep-delete"
                  @click.stop="deleteEpisode(anime.animeName, ep.episodeInt, anime.animeId)"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="storageUsage && !usageScanning" class="usage-empty">
          No downloaded files found.
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Auto-cleanup">
      <SettingsRow
        label="Auto-cleanup watched episodes"
        desc="Delete episode files marked as watched once they've sat for the chosen number of days. Set to 0 to disable."
      >
        <div class="cleanup-days">
          <input
            v-model.number="autoCleanupDays"
            type="number"
            min="0"
            step="1"
            class="field-input days-input"
          />
          <span class="days-unit">day(s)</span>
        </div>
      </SettingsRow>
      <SettingsRow label="Run cleanup" desc="Delete eligible watched episodes now.">
        <button class="btn btn-sm" :disabled="cleanupRunning" @click="runCleanupNow">
          {{ cleanupRunning ? 'Cleaning...' : 'Run cleanup now' }}
        </button>
      </SettingsRow>
      <SettingsRow
        v-if="
          autoCleanupLastRun ||
          (cleanupResult && cleanupResult.deletedCount === 0 && cleanupResult.items.length === 0) ||
          cleanupLog.length > 0
        "
        stack
      >
        <div v-if="autoCleanupLastRun" class="usage-meta-row">
          Last run: {{ formatRelativeTime(autoCleanupLastRun.ranAt) }} —
          {{ autoCleanupLastRun.deletedCount }} file(s),
          {{ formatBytes(autoCleanupLastRun.freedBytes) }} freed
        </div>
        <div
          v-if="
            cleanupResult && cleanupResult.deletedCount === 0 && cleanupResult.items.length === 0
          "
          class="usage-meta-row"
        >
          Nothing to clean up.
        </div>
        <div v-if="cleanupLog.length > 0" class="cleanup-log">
          <button class="cleanup-log-toggle" @click="cleanupLogExpanded = !cleanupLogExpanded">
            {{ cleanupLogExpanded ? 'Hide history' : `Show history (${cleanupLog.length})` }}
          </button>
          <div v-if="cleanupLogExpanded" class="cleanup-log-list">
            <div v-for="(entry, i) in cleanupLog" :key="i" class="cleanup-log-row">
              <span class="cleanup-log-time">{{ formatRelativeTime(entry.ranAt) }}</span>
              <span class="cleanup-log-name">{{ entry.animeName }}</span>
              <span class="cleanup-log-ep">Ep {{ entry.episodeInt }}</span>
              <span class="cleanup-log-size">{{ formatBytes(entry.bytes) }}</span>
            </div>
          </div>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      title="Cleanup prompts"
      desc="When a Shikimori rate is flipped to «Completed», a prompt offers to delete the show's local files. Use «Don't ask for this show» on a prompt to silence it; manage silenced shows here."
    >
      <SettingsRow stack>
        <div v-if="snoozedLoading" class="usage-meta-row">Loading…</div>
        <template v-else>
          <div v-if="snoozedEntries.length === 0" class="usage-meta-row">No shows are snoozed.</div>
          <template v-else>
            <div class="cleanup-log-list">
              <div v-for="entry in snoozedEntries" :key="entry.animeId" class="cleanup-log-row">
                <span class="cleanup-log-name">{{ entry.animeName }}</span>
                <button class="cleanup-log-toggle" @click="unsnoozeCleanup(entry.animeId)">
                  Un-snooze
                </button>
              </div>
            </div>
            <div class="snooze-actions">
              <button class="btn btn-sm" @click="resetAllCleanupSnoozes">
                Reset all ({{ snoozedEntries.length }})
              </button>
            </div>
          </template>
        </template>
      </SettingsRow>
    </SettingsGroup>

    <div v-if="cleanupPending" class="cleanup-modal-backdrop" @click.self="dismissCleanupPending">
      <div class="cleanup-modal">
        <div class="cleanup-modal-title">Auto-cleanup ready</div>
        <p class="cleanup-modal-hint">
          {{ cleanupPending.length }} watched episode(s) are eligible for deletion. Confirming will
          delete them now and skip this prompt on future runs.
        </p>
        <div class="cleanup-modal-list">
          <div
            v-for="c in cleanupPending"
            :key="`${c.animeId}:${c.episodeInt}`"
            class="cleanup-modal-row"
          >
            <span class="cleanup-modal-name">{{ c.animeName }}</span>
            <span class="cleanup-modal-ep">Ep {{ c.episodeInt }}</span>
            <span class="cleanup-modal-size">{{ formatBytes(c.bytes) }}</span>
          </div>
        </div>
        <div class="cleanup-modal-actions">
          <button class="btn btn-sm btn-ghost" @click="dismissCleanupPending">Cancel</button>
          <button class="btn btn-sm btn-primary" @click="confirmCleanup">
            Delete and remember
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.cleanup-days {
  display: flex;
  align-items: center;
  gap: 8px;
}

.days-input {
  width: 80px;
}

.days-unit {
  color: var(--text-3);
  font-size: 0.8rem;
}

.snooze-actions {
  margin-top: 12px;
}

.usage-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
}

.usage-total {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.usage-total-label {
  font-size: 0.74rem;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.usage-total-value {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text);
  font-family: var(--font-data);
}

.usage-total-meta {
  font-size: 0.8rem;
  color: var(--text-3);
}

.usage-buckets {
  display: flex;
  gap: 12px;
}

.usage-bucket {
  font-size: 0.85rem;
  color: var(--text-2);
  font-family: var(--font-data);
}

.bucket-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-3);
  margin-right: 4px;
  font-family: var(--font-ui);
}

.usage-list {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  overflow: hidden;
}

.usage-anime {
  border-bottom: 1px solid var(--border-soft);
}

.usage-anime:last-child {
  border-bottom: none;
}

.usage-anime-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.12s var(--ease);
}

.usage-anime-row:hover {
  background: var(--surface-2);
}

.usage-poster {
  width: 32px;
  height: 44px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.usage-anime-name {
  flex: 1;
  font-size: 0.9rem;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-anime-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.8rem;
  color: var(--text-3);
}

.usage-anime-size {
  color: var(--text-2);
  font-weight: 600;
  min-width: 70px;
  text-align: right;
  font-family: var(--font-data);
}

.usage-chevron {
  color: var(--text-3);
  font-size: 1.1rem;
  transition: transform 0.15s var(--ease);
  width: 14px;
  text-align: center;
}

.usage-chevron.open {
  transform: rotate(90deg);
}

.usage-episodes {
  background: var(--bg-deep);
  padding: 4px 0;
}

.usage-episode {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px 6px 54px;
  font-size: 0.85rem;
}

.usage-ep-num {
  color: var(--text);
  min-width: 50px;
  font-family: var(--font-data);
}

.usage-ep-tags {
  display: flex;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.usage-tag {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 6px;
  background: var(--surface-3);
  color: var(--text-2);
  border-radius: 4px;
  letter-spacing: 0.03em;
}

.usage-tag-watched {
  background: color-mix(in srgb, var(--st-green) 16%, transparent);
  color: var(--st-green);
}

.usage-ep-size {
  color: var(--text-2);
  min-width: 70px;
  text-align: right;
  font-family: var(--font-data);
}

.usage-ep-delete {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: var(--radius-btn);
  color: var(--accent);
  font-size: 0.75rem;
  cursor: pointer;
  transition: background-color 0.15s var(--ease);
}

.usage-ep-delete:hover {
  background: var(--accent-soft);
}

.usage-empty {
  font-size: 0.85rem;
  color: var(--text-3);
}

.usage-meta-row {
  font-size: 0.8rem;
  color: var(--text-2);
}

.usage-meta-row + .usage-meta-row,
.usage-meta-row + .cleanup-log {
  margin-top: 8px;
}

.cleanup-log {
  margin-top: 4px;
}

.cleanup-log-toggle {
  background: none;
  border: none;
  color: var(--text-2);
  font-size: 0.8rem;
  cursor: pointer;
  padding: 0;
}

.cleanup-log-toggle:hover {
  color: var(--text);
  text-decoration: underline;
}

.cleanup-log-list {
  margin-top: 8px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
}

.cleanup-log-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--border-soft);
}

.cleanup-log-row:last-child {
  border-bottom: none;
}

.cleanup-log-time {
  color: var(--text-3);
  width: 90px;
  flex-shrink: 0;
  font-family: var(--font-data);
}

.cleanup-log-name {
  color: var(--text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cleanup-log-ep {
  color: var(--text-2);
  width: 60px;
  flex-shrink: 0;
  font-family: var(--font-data);
}

.cleanup-log-size {
  color: var(--text-2);
  width: 70px;
  text-align: right;
  flex-shrink: 0;
  font-family: var(--font-data);
}

.cleanup-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.cleanup-modal {
  width: 480px;
  max-width: calc(100% - 40px);
  max-height: calc(100% - 60px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 18px 20px;
  box-shadow: var(--shadow-card);
}

.cleanup-modal-title {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}

.cleanup-modal-hint {
  font-size: 0.85rem;
  color: var(--text-2);
  margin-bottom: 12px;
}

.cleanup-modal-list {
  flex: 1;
  overflow-y: auto;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
}

.cleanup-modal-row {
  display: flex;
  gap: 10px;
  padding: 6px 10px;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--border-soft);
}

.cleanup-modal-row:last-child {
  border-bottom: none;
}

.cleanup-modal-name {
  flex: 1;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cleanup-modal-ep {
  color: var(--text-2);
  width: 60px;
  font-family: var(--font-data);
}

.cleanup-modal-size {
  color: var(--text-2);
  width: 70px;
  text-align: right;
  font-family: var(--font-data);
}

.cleanup-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
