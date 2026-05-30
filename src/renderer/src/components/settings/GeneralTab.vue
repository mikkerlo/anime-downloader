<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '../../stores/settings';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import SettingsSwitch from './SettingsSwitch.vue';

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
    <SettingsGroup title="Defaults">
      <SettingsRow label="Default translation type" desc="Translation type when opening an anime.">
        <div class="select-wrap">
          <select id="tr-type" v-model="translationType">
            <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">
              {{ t.label }}
            </option>
          </select>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Notifications"
        desc="Desktop notifications when downloads or merges complete (only when app is not focused)."
      >
        <div class="select-wrap">
          <select id="notif-mode" v-model="notificationMode">
            <option value="off">Off</option>
            <option value="each">Each Episode</option>
            <option value="queue">Queue Complete</option>
          </select>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Calendar view"
        desc="Default time range shown in the Airing Calendar tab."
      >
        <div class="select-wrap">
          <select id="calendar-view" v-model="calendarView">
            <option value="week">Week (7 days)</option>
            <option value="month">Month (4 weeks)</option>
          </select>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Downloads">
      <SettingsRow
        label="Download speed limit"
        desc="Limit download bandwidth. The limit is shared across all active downloads."
      >
        <div class="dl-speed">
          <div class="select-wrap">
            <select id="speed-limit" v-model="speedLimitPreset">
              <option value="0">Unlimited</option>
              <option :value="String(1024 * 1024)">1 MB/s</option>
              <option :value="String(5 * 1024 * 1024)">5 MB/s</option>
              <option :value="String(10 * 1024 * 1024)">10 MB/s</option>
              <option value="custom">Custom</option>
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
          <div v-if="speedLimitPreset === 'custom'" class="custom-speed">
            <input
              v-model.number="customSpeedLimit"
              type="number"
              min="0.1"
              step="0.1"
              class="field-input speed-input"
            />
            <span class="speed-unit">MB/s</span>
          </div>
        </div>
      </SettingsRow>
      <SettingsRow label="Concurrent downloads" desc="Maximum number of simultaneous downloads.">
        <div class="select-wrap">
          <select id="concurrent-dl" v-model.number="concurrentDownloads">
            <option :value="1">1</option>
            <option :value="2">2</option>
            <option :value="3">3</option>
          </select>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Auto-download">
      <SettingsRow
        label="Auto-download airing episodes"
        desc="Subscribed shows queue newly-aired episodes automatically. Subscribe per show on its detail page. Forward-only — already-aired episodes are never backfilled."
      >
        <SettingsSwitch v-model="autoDownloadEnabled" />
      </SettingsRow>
      <SettingsRow stack>
        <div class="auto-dl-status">
          <button
            class="btn btn-sm"
            :disabled="autoDlRunning || !autoDownloadEnabled"
            @click="runAutoDlNow"
          >
            {{ autoDlRunning ? 'Running...' : 'Run now' }}
          </button>
          <span v-if="autoDlLastResult" class="sr-desc auto-dl-last">
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
            <span class="tw-caret">{{ autoDlSubscriptionsExpanded ? '▾' : '▸' }}</span>
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
              <button class="btn btn-sm btn-danger" @click="unsubscribeAutoDl(sub.animeId)">
                Unsubscribe
              </button>
            </li>
          </ul>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Updates">
      <SettingsRow label="Current version">
        <template #desc>
          <span v-if="updateStatus.status === 'up-to-date'">Up to date</span>
          <span v-else-if="updateStatus.status === 'checking'">Checking…</span>
          <span v-else-if="updateStatus.status === 'available'"
            >v{{ updateStatus.version }} available</span
          >
          <span v-else-if="updateStatus.status === 'error'">{{ updateStatus.error }}</span>
          <span v-else>Installed build</span>
        </template>
        <div class="update-control">
          <span class="chip neutral mono">v{{ appVersion }}</span>
          <button
            v-if="
              updateStatus.status === 'idle' ||
              updateStatus.status === 'up-to-date' ||
              updateStatus.status === 'error'
            "
            class="btn btn-sm"
            @click="checkForUpdates"
          >
            Check for updates
          </button>
          <button
            v-else-if="updateStatus.status === 'available'"
            class="btn btn-sm btn-primary"
            @click="downloadUpdate"
          >
            Download update
          </button>
          <button
            v-else-if="updateStatus.status === 'ready'"
            class="btn btn-sm btn-ok"
            @click="installUpdate"
          >
            Restart to update
          </button>
        </div>
      </SettingsRow>
      <SettingsRow v-if="updateStatus.status === 'downloading'" stack>
        <div class="set-progress">
          <div class="set-progress-head">
            <span>Downloading update…</span>
            <span>{{ updateStatus.percent }}%</span>
          </div>
          <div class="bar"><span :style="{ width: (updateStatus.percent || 0) + '%' }"></span></div>
        </div>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.dl-speed {
  display: flex;
  align-items: center;
  gap: 12px;
}

.custom-speed {
  display: flex;
  align-items: center;
  gap: 8px;
}

.speed-input {
  width: 90px;
}

.speed-unit {
  color: var(--text-3);
  font-size: 0.8rem;
}

.update-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.auto-dl-status {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.auto-dl-last {
  margin-top: 0;
}

.auto-dl-subs {
  margin-top: 4px;
}

.auto-dl-subs-toggle {
  background: none;
  border: none;
  color: var(--text-2);
  cursor: pointer;
  font-size: 0.82rem;
  padding: 4px 0;
}

.auto-dl-subs-toggle:hover {
  color: var(--text);
}

.tw-caret {
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
  padding: 8px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: 0.85rem;
}

.auto-dl-sub-name {
  flex: 1;
  color: var(--text);
}

.auto-dl-sub-meta {
  color: var(--text-3);
  font-size: 0.75rem;
  font-family: var(--font-data);
}
</style>
