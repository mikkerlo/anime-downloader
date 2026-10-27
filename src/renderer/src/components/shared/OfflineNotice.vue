<script setup lang="ts">
// The one offline empty state (#568), so every view words it the same way. In
// manual mode the button turns Work offline off; in auto mode it probes now.
import { storeToRefs } from 'pinia';
import { useOfflineStore } from '../../stores/offline';

defineProps<{ reason: string; compact?: boolean }>();

const offlineStore = useOfflineStore();
const { isManual, retrying } = storeToRefs(offlineStore);

function onAction(): void {
  if (isManual.value) void offlineStore.setManual(false);
  else void offlineStore.retry();
}
</script>

<template>
  <div class="empty-state offline-notice" :class="{ compact }" data-testid="offline-notice">
    <div class="es-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M3 3l18 18M8.53 16.11a5 5 0 016.95.02M5.1 12.66a10 10 0 014.3-2.46m5.06-.04a10 10 0 014.44 2.5M1.75 9.2a15 15 0 014.28-2.81m4.1-1.12A15 15 0 0122.25 9.2M12 20h.01"
        />
      </svg>
    </div>
    <p>{{ reason }}</p>
    <button
      type="button"
      class="on-btn"
      :disabled="retrying"
      data-testid="offline-notice-action"
      @click="onAction"
    >
      {{ isManual ? 'Work offline is on — go online' : retrying ? 'Checking…' : 'Retry' }}
    </button>
  </div>
</template>

<style scoped>
.offline-notice.compact {
  padding: 8px 0 4px;
  text-align: left;
}

.offline-notice.compact .es-icon {
  display: none;
}

.offline-notice.compact p {
  margin-bottom: 10px;
}

.on-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border-strong);
  padding: 8px 14px;
  border-radius: var(--radius-btn);
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.on-btn:hover:not(:disabled) {
  background: var(--surface-3);
}

.on-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
