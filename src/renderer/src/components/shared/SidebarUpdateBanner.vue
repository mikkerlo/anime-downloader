<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '../../stores/settings';

// Surfaces an available app update right above the sidebar profile chip so users
// don't have to dig into Settings → General. The whole update pipeline already
// exists (electron-updater in the main process, broadcast via `update:status`);
// this just reads the reactive status the settings store already holds and
// drives the existing `window.api.update*` methods.
const settingsStore = useSettingsStore();
const { updateStatus } = storeToRefs(settingsStore);

const dismissed = ref(false);

// A fresh `available`/`ready` transition re-surfaces the banner even if the user
// dismissed an earlier one (e.g. the download they kicked off has finished).
watch(
  () => updateStatus.value.status,
  (status) => {
    if (status === 'available' || status === 'ready') dismissed.value = false;
  }
);

// Stay silent for idle/checking/up-to-date/error — notably the dev-mode
// "not available" error must never show a banner.
const visible = computed(
  () =>
    !dismissed.value && ['available', 'downloading', 'ready'].includes(updateStatus.value.status)
);

const title = computed(() => {
  switch (updateStatus.value.status) {
    case 'downloading':
      return 'Downloading update';
    case 'ready':
      return 'Update ready';
    default:
      return 'Update available';
  }
});

function download(): void {
  void window.api.updateDownload();
}

function install(): void {
  window.api.updateInstall();
}
</script>

<template>
  <div v-if="visible" class="update-banner" :class="updateStatus.status">
    <div class="ub-head">
      <svg class="ub-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 3v12m0 0l-4-4m4 4l4-4M4.5 19.5h15"
        />
      </svg>
      <div class="ub-meta">
        <span class="ub-title">{{ title }}</span>
        <span v-if="updateStatus.version" class="ub-version">v{{ updateStatus.version }}</span>
      </div>
      <button
        v-if="updateStatus.status !== 'downloading'"
        class="ub-dismiss"
        aria-label="Dismiss"
        @click="dismissed = true"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <button v-if="updateStatus.status === 'available'" class="ub-action" @click="download">
      Download
    </button>
    <button v-else-if="updateStatus.status === 'ready'" class="ub-action" @click="install">
      Restart to update
    </button>
    <div v-else class="ub-progress">
      <div class="ub-bar"><span :style="{ width: (updateStatus.percent || 0) + '%' }" /></div>
      <span class="ub-pct">{{ updateStatus.percent || 0 }}%</span>
    </div>
  </div>
</template>

<style scoped>
.update-banner {
  margin: 0 14px 10px;
  padding: 10px 12px;
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius-btn);
  background: var(--accent-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ub-head {
  display: flex;
  align-items: center;
  gap: 9px;
}

.ub-ico {
  width: 18px;
  height: 18px;
  color: var(--accent);
  flex-shrink: 0;
}

.ub-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
  flex: 1;
}

.ub-title {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--text);
}

.ub-version {
  font-family: var(--font-data);
  font-size: 0.68rem;
  color: var(--text-3);
}

.ub-dismiss {
  background: none;
  border: none;
  padding: 2px;
  color: var(--text-3);
  cursor: pointer;
  display: flex;
  border-radius: 6px;
  flex-shrink: 0;
}

.ub-dismiss:hover {
  color: var(--text);
  background: var(--surface-2);
}

.ub-dismiss svg {
  width: 14px;
  height: 14px;
}

.ub-action {
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-btn);
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
  transition: filter 0.15s var(--ease);
}

.ub-action:hover {
  filter: brightness(1.08);
}

.ub-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ub-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.ub-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s var(--ease);
}

.ub-pct {
  font-family: var(--font-data);
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-2);
  min-width: 32px;
  text-align: right;
}
</style>
