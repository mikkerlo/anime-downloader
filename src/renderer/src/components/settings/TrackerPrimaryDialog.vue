<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { TRACKER_LABELS } from '@shared/trackers/labels';

// "Which tracker becomes primary?" (#701), after a disconnect of the primary
// that left two or more trackers. The disconnect has already happened and
// main has already made `interim` (the first remaining one in `TrackerId`
// order) primary, so there is no Cancel: closing keeps `interim`, as Confirm
// on it does, and only Confirm on another pick changes the primary.
const props = defineProps<{
  candidates: TrackerId[];
  interim: TrackerId;
}>();

const emit = defineEmits<{
  /** The pick, only when it isn't `interim`. */
  choose: [trackerId: TrackerId];
  close: [];
}>();

const picked = ref<TrackerId>(props.interim);

function confirm(): void {
  if (picked.value !== props.interim) emit('choose', picked.value);
  else emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

const confirmButton = ref<HTMLButtonElement | null>(null);
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  confirmButton.value?.focus();
});
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="primary-backdrop" @click.self="emit('close')">
    <div class="primary-modal tracker-primary-dialog" role="dialog" aria-modal="true">
      <div class="primary-title">Which tracker becomes primary?</div>
      <p class="primary-text">
        The primary is the source of truth for your lists, next episodes and auto-download. The
        others receive mirrored changes.
      </p>
      <label v-for="id in candidates" :key="id" class="primary-option" :data-tracker-id="id">
        <input v-model="picked" type="radio" name="tracker-primary-choice" :value="id" />
        {{ TRACKER_LABELS[id] }}
      </label>
      <div class="primary-actions">
        <button ref="confirmButton" class="btn btn-primary" data-action="confirm" @click="confirm">
          Confirm
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.primary-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
}

.primary-modal {
  width: 420px;
  max-width: calc(100% - 40px);
  background: var(--surface);
  border: 1px solid var(--surface-3);
  border-radius: 10px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.primary-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}

.primary-text {
  font-size: 0.9rem;
  color: var(--text-2);
}

.primary-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
  color: var(--text);
  cursor: pointer;
}

.primary-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
</style>
