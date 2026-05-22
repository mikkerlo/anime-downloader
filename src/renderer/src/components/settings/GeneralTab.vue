<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '../../stores/settings';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';

const settingsStore = useSettingsStore();
const { updateStatus } = storeToRefs(settingsStore);
const { autoSave, showSaved } = useSettingsAutosave();

const loaded = ref(false);
const appVersion = ref('');

const translationType = ref('subRu');
const notificationMode = ref('off');
const calendarView = ref<'week' | 'month'>('week');
const speedLimitPreset = ref('0');
const customSpeedLimit = ref(1);
const concurrentDownloads = ref(2);

const autoDownloadEnabled = ref(true);
const autoDlSubscriptions = ref<AutoDownloadSubscription[]>([]);
const autoDlSubscriptionsExpanded = ref(false);
const autoDlRunning = ref(false);
const autoDlLastResult = ref<AutoDlTickResult | null>(null);

let unsubAutoDlTickResult: Unsubscribe | null = null;

const TRANSLATION_TYPES = [
  { value: 'subRu', label: 'Russian Subtitles' },
  { value: 'subEn', label: 'English Subtitles' },
  { value: 'voiceRu', label: 'Russian Voice' },
  { value: 'voiceEn', label: 'English Voice' },
  { value: 'raw', label: 'RAW' }
];

async function refreshAutoDlSubscriptions(): Promise<void> {
  try {
    autoDlSubscriptions.value = await window.api.autoDlListSubscriptions();
  } catch (err) {
    console.warn('Failed to load auto-dl subscriptions:', err);
  }
}

async function runAutoDlNow(): Promise<void> {
  if (autoDlRunning.value) return;
  autoDlRunning.value = true;
  try {
    await window.api.autoDlTrigger();
    await refreshAutoDlSubscriptions();
  } finally {
    autoDlRunning.value = false;
  }
}

async function unsubscribeAutoDl(animeId: number): Promise<void> {
  await window.api.autoDlSetSubscription(animeId, false);
  await refreshAutoDlSubscriptions();
}

function autoDlLastCheckedLabel(ts: number): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

async function checkForUpdates(): Promise<void> {
  updateStatus.value = { status: 'checking' };
  try {
    await window.api.updateCheck();
  } catch {
    updateStatus.value = { status: 'error', error: 'Failed to check for updates' };
  }
}

async function downloadUpdate(): Promise<void> {
  try {
    await window.api.updateDownload();
  } catch {
    updateStatus.value = { status: 'error', error: 'Failed to download update' };
  }
}

function installUpdate(): void {
  window.api.updateInstall();
}

onMounted(async () => {
  appVersion.value = await window.api.appVersion();
  translationType.value = ((await window.api.getSetting('translationType')) as string) || 'subRu';
  notificationMode.value = ((await window.api.getSetting('notificationMode')) as string) || 'off';
  calendarView.value =
    ((await window.api.getSetting('calendarView')) as 'week' | 'month') || 'week';
  concurrentDownloads.value = ((await window.api.getSetting('concurrentDownloads')) as number) || 2;
  const savedSpeedLimit = ((await window.api.getSetting('downloadSpeedLimit')) as number) || 0;
  const PRESETS = [0, 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024];
  if (PRESETS.includes(savedSpeedLimit)) {
    speedLimitPreset.value = String(savedSpeedLimit);
  } else {
    speedLimitPreset.value = 'custom';
    customSpeedLimit.value = Math.round((savedSpeedLimit / (1024 * 1024)) * 10) / 10;
  }

  autoDownloadEnabled.value = await window.api.autoDlGetEnabled();
  await refreshAutoDlSubscriptions();
  const autoDlStatus = await window.api.autoDlGetStatus();
  autoDlLastResult.value = autoDlStatus.lastResult;
  unsubAutoDlTickResult = window.api.onAutoDlTickResult((result) => {
    autoDlLastResult.value = result;
    void refreshAutoDlSubscriptions();
  });

  loaded.value = true;
});

onUnmounted(() => {
  unsubAutoDlTickResult?.();
});

watch(translationType, (val) => {
  if (loaded.value) autoSave('translationType', val);
});
watch(notificationMode, (val) => {
  if (loaded.value) autoSave('notificationMode', val);
});
watch(calendarView, (val) => {
  if (!loaded.value) return;
  autoSave('calendarView', val);
  window.dispatchEvent(new Event('calendar-view-changed'));
});
watch(concurrentDownloads, (val) => {
  if (loaded.value) autoSave('concurrentDownloads', val);
});
watch(speedLimitPreset, (val) => {
  if (!loaded.value) return;
  if (val !== 'custom') {
    void window.api.setSetting('downloadSpeedLimit', Number(val));
    showSaved();
  } else {
    void window.api.setSetting(
      'downloadSpeedLimit',
      Math.round(customSpeedLimit.value * 1024 * 1024)
    );
    showSaved();
  }
});
watch(customSpeedLimit, (val) => {
  if (!loaded.value || speedLimitPreset.value !== 'custom') return;
  void window.api.setSetting('downloadSpeedLimit', Math.round(val * 1024 * 1024));
  showSaved();
});
watch(autoDownloadEnabled, (val) => {
  if (loaded.value) {
    void window.api.autoDlSetEnabled(val).then(() => showSaved());
  }
});
</script>

<template>
  <div>
    <div class="setting-group">
      <label class="setting-label" for="tr-type">Default Translation Type</label>
      <p class="setting-hint">Default translation type when opening an anime.</p>
      <select id="tr-type" v-model="translationType" class="setting-input setting-select">
        <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">
          {{ t.label }}
        </option>
      </select>
    </div>

    <div class="setting-group">
      <label class="setting-label" for="notif-mode">Notifications</label>
      <p class="setting-hint">
        Desktop notifications when downloads or merges complete (only when app is not focused).
      </p>
      <select id="notif-mode" v-model="notificationMode" class="setting-input setting-select">
        <option value="off">Off</option>
        <option value="each">Each Episode</option>
        <option value="queue">Queue Complete</option>
      </select>
    </div>

    <div class="setting-group">
      <label class="setting-label" for="calendar-view">Calendar View</label>
      <p class="setting-hint">Default time range shown in the Airing Calendar tab.</p>
      <select id="calendar-view" v-model="calendarView" class="setting-input setting-select">
        <option value="week">Week (7 days)</option>
        <option value="month">Month (4 weeks)</option>
      </select>
    </div>

    <div class="setting-group">
      <label class="setting-label" for="speed-limit">Download Speed Limit</label>
      <p class="setting-hint">
        Limit download bandwidth. The limit is shared across all active downloads.
      </p>
      <select id="speed-limit" v-model="speedLimitPreset" class="setting-input setting-select">
        <option value="0">Unlimited</option>
        <option :value="String(1024 * 1024)">1 MB/s</option>
        <option :value="String(5 * 1024 * 1024)">5 MB/s</option>
        <option :value="String(10 * 1024 * 1024)">10 MB/s</option>
        <option value="custom">Custom</option>
      </select>
      <div v-if="speedLimitPreset === 'custom'" class="custom-speed-row">
        <input
          v-model.number="customSpeedLimit"
          type="number"
          min="0.1"
          step="0.1"
          class="setting-input speed-input"
        />
        <span class="speed-unit">MB/s</span>
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label" for="concurrent-dl">Concurrent Downloads</label>
      <p class="setting-hint">Maximum number of simultaneous downloads.</p>
      <select
        id="concurrent-dl"
        v-model.number="concurrentDownloads"
        class="setting-input setting-select"
      >
        <option :value="1">1</option>
        <option :value="2">2</option>
        <option :value="3">3</option>
      </select>
    </div>

    <div class="setting-group">
      <label class="setting-label">Auto-download</label>
      <p class="setting-hint">
        Subscribed shows queue newly-aired episodes automatically. Subscribe per show on its detail
        page. Forward-only — already-aired episodes are never backfilled.
      </p>
      <label class="toggle-row">
        <input v-model="autoDownloadEnabled" type="checkbox" class="toggle-input" />
        <span class="toggle-slider"></span>
        <span class="toggle-label">{{ autoDownloadEnabled ? 'Enabled' : 'Disabled' }}</span>
      </label>
      <div class="auto-dl-status">
        <button
          class="test-token-btn"
          :disabled="autoDlRunning || !autoDownloadEnabled"
          @click="runAutoDlNow"
        >
          {{ autoDlRunning ? 'Running...' : 'Run now' }}
        </button>
        <span v-if="autoDlLastResult" class="setting-hint" style="margin: 0 0 0 12px">
          Last run: {{ autoDlLastResult.enqueued }} enqueued,
          {{ autoDlLastResult.skipped }} skipped, {{ autoDlLastResult.errors }} errors
        </span>
      </div>
      <div class="auto-dl-subs">
        <button
          type="button"
          class="auto-dl-subs-toggle"
          @click="autoDlSubscriptionsExpanded = !autoDlSubscriptionsExpanded"
        >
          {{ autoDlSubscriptions.length }} show{{ autoDlSubscriptions.length === 1 ? '' : 's' }}
          subscribed
          <span class="caret">{{ autoDlSubscriptionsExpanded ? '▾' : '▸' }}</span>
        </button>
        <ul
          v-if="autoDlSubscriptionsExpanded && autoDlSubscriptions.length > 0"
          class="auto-dl-sub-list"
        >
          <li v-for="sub in autoDlSubscriptions" :key="sub.animeId">
            <span class="auto-dl-sub-name">{{ sub.animeName }}</span>
            <span class="auto-dl-sub-meta">
              next: Ep {{ sub.lastEnqueuedEpisodeInt + 1 }} · checked
              {{ autoDlLastCheckedLabel(sub.lastCheckedAt) }}
            </span>
            <button class="auto-dl-unsub-btn" @click="unsubscribeAutoDl(sub.animeId)">
              Unsubscribe
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Updates</label>
      <p class="setting-hint">Version {{ appVersion }}</p>

      <button
        v-if="
          updateStatus.status === 'idle' ||
          updateStatus.status === 'up-to-date' ||
          updateStatus.status === 'error'
        "
        class="test-token-btn"
        @click="checkForUpdates"
      >
        Check for updates
      </button>

      <span
        v-else-if="updateStatus.status === 'checking'"
        class="setting-hint"
        style="margin-bottom: 0"
        >Checking...</span
      >

      <div v-else-if="updateStatus.status === 'available'">
        <div class="token-result token-valid" style="margin-bottom: 8px">
          v{{ updateStatus.version }} available
        </div>
        <button class="browse-btn" @click="downloadUpdate">Download update</button>
      </div>

      <div v-else-if="updateStatus.status === 'downloading'" class="scan-progress">
        <div class="scan-progress-header">
          <span>Downloading update...</span>
          <span>{{ updateStatus.percent }}%</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar" :style="{ width: (updateStatus.percent || 0) + '%' }"></div>
        </div>
      </div>

      <div v-else-if="updateStatus.status === 'ready'">
        <button class="merge-all-btn" @click="installUpdate">Restart to update</button>
      </div>

      <div
        v-if="updateStatus.status === 'error'"
        class="token-result token-invalid"
        style="margin-top: 6px"
      >
        {{ updateStatus.error }}
      </div>
      <div
        v-if="updateStatus.status === 'up-to-date'"
        class="token-result token-valid"
        style="margin-top: 6px"
      >
        Up to date
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.auto-dl-status {
  display: flex;
  align-items: center;
  margin-top: 10px;
}

.auto-dl-subs {
  margin-top: 10px;
}

.auto-dl-subs-toggle {
  background: none;
  border: none;
  color: #8aa8d0;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 4px 0;
}

.auto-dl-subs-toggle .caret {
  margin-left: 4px;
  font-size: 0.7rem;
}

.auto-dl-sub-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}

.auto-dl-sub-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 0.85rem;
}

.auto-dl-sub-name {
  flex: 1;
  color: #e0e0f0;
}

.auto-dl-sub-meta {
  color: #6a6a8a;
  font-size: 0.75rem;
}

.auto-dl-unsub-btn {
  background: rgba(120, 50, 50, 0.6);
  color: #e0a0a0;
  border: none;
  border-radius: 3px;
  padding: 3px 8px;
  font-size: 0.75rem;
  cursor: pointer;
}

.auto-dl-unsub-btn:hover {
  background: rgba(150, 60, 60, 0.8);
}
</style>
