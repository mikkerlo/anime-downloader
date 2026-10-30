<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useSyncStore } from '../../stores/sync';

// After a run (#585): "Synced with <library>: N updates, M need your input" →
// Review, "… N updates" → Details, or a manual run's "Everything is up to
// date". The look is the app's toast (`.cleanup-toast`, App.vue).
defineProps<{ raised?: boolean }>();
const sync = useSyncStore();
const { toast, toastLine, conflictCount } = storeToRefs(sync);

function details(): void {
  const ids = toast.value?.libraryIds ?? [];
  void sync.openHistory(ids.length === 1 ? ids[0] : null);
}
</script>

<template>
  <div
    v-if="toast && toastLine"
    class="cleanup-toast sync-toast"
    :class="{ raised }"
    data-testid="sync-toast"
  >
    <div class="cleanup-toast-body">
      <div class="cleanup-toast-title" data-testid="sync-toast-text">{{ toastLine }}</div>
    </div>
    <div class="cleanup-toast-actions">
      <button
        v-if="toast.conflicts && conflictCount > 0"
        class="cleanup-toast-btn primary"
        data-testid="sync-toast-review"
        @click="sync.openReview()"
      >
        Review
      </button>
      <button
        v-else-if="toast.applied > 0"
        class="cleanup-toast-btn primary"
        data-testid="sync-toast-details"
        @click="details"
      >
        Details
      </button>
      <button class="cleanup-toast-btn subtle" @click="sync.dismissToast()">Dismiss</button>
    </div>
  </div>
</template>

<style scoped>
.sync-toast.raised {
  bottom: 170px;
}
</style>
