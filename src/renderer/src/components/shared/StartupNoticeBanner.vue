<script setup lang="ts">
// Says why this launch didn't start from the config.json it found (#648): it
// was restored from the last-known-good copy or reset to defaults. Non-modal;
// dismissing it is local, since the next launch reads the file this one wrote.
import { computed, onMounted, ref } from 'vue';

const notice = ref<StartupNotice | null>(null);

onMounted(async () => {
  notice.value = await window.api.getStartupNotice();
});

// A `config-restored` without `corruptPath` found no config.json at all.
const corruptPath = computed(() => notice.value?.corruptPath);

const fileName = computed(() => corruptPath.value?.split(/[\\/]/).pop() ?? '');

const savedAt = computed(() =>
  notice.value?.kind === 'config-restored'
    ? new Date(notice.value.backupSavedAt).toLocaleString()
    : ''
);

function showFile(): void {
  if (corruptPath.value) void window.api.fileShowInFolder(corruptPath.value);
}

function dismiss(): void {
  notice.value = null;
}
</script>

<template>
  <div v-if="notice" class="startup-notice" role="status" data-testid="startup-notice">
    <p class="startup-notice-text">
      <template v-if="notice.kind === 'config-restored'">
        Anime DL couldn't {{ corruptPath ? 'read' : 'find' }} its settings file, so it loaded the
        copy saved when the app last started ({{ savedAt }}). Changes since then were lost.
      </template>
      <template v-else>
        Anime DL couldn't read its settings file and started with default settings. You may need to
        sign in to Shikimori again and re-open your Shared Libraries.
      </template>
      <template v-if="corruptPath">
        The unreadable file was kept as <span class="mono">{{ fileName }}</span
        >.
      </template>
    </p>
    <div class="startup-notice-actions">
      <button
        v-if="corruptPath"
        type="button"
        class="startup-notice-btn"
        data-testid="startup-notice-show"
        @click="showFile"
      >
        Show file
      </button>
      <button
        type="button"
        class="startup-notice-btn subtle"
        data-testid="startup-notice-dismiss"
        @click="dismiss"
      >
        Dismiss
      </button>
    </div>
  </div>
</template>

<style scoped>
.startup-notice {
  display: flex;
  align-items: center;
  gap: var(--gap);
  margin: 12px var(--pad-x) 0;
  padding: 12px 16px;
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--st-orange) 45%, transparent);
  border-left: 3px solid var(--st-orange);
  border-radius: var(--radius-card);
  color: var(--text);
  font-size: 0.86rem;
  line-height: 1.45;
}

.startup-notice-text {
  flex: 1;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.startup-notice-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.startup-notice-btn {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border-strong);
  padding: 7px 12px;
  border-radius: var(--radius-btn);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.startup-notice-btn:hover {
  background: var(--surface-3);
}

.startup-notice-btn.subtle {
  background: transparent;
}
</style>
