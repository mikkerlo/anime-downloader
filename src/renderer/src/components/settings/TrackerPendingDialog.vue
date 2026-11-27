<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

// `disconnect`: the live queue is about to be kept or dropped by a logout.
// `switch`: main has already parked the previous account's changes, so there is
// no Cancel and closing means Keep. `discard`: confirms dropping a kept row.
// `mirror-off` (#701): switching a mirror off drops the changes queued for it
// from the primary, so it asks first, even with none queued; closing cancels.
const props = defineProps<{
  mode: 'disconnect' | 'switch' | 'discard' | 'mirror-off';
  /** The tracker's display name (`TRACKER_LABELS`), e.g. 'Shikimori'. */
  trackerLabel: string;
  count: number;
  /** Whose changes these are; null for the unknown-account bucket. */
  nickname: string | null;
  newNickname?: string;
  /** `mirror-off`: the primary's display name, which the mirrored changes came from. */
  primaryLabel?: string;
}>();

const emit = defineEmits<{
  keep: [];
  discard: [];
  cancel: [];
  /** `mirror-off`: Stop mirroring. */
  confirm: [];
}>();

const changes = computed(() =>
  props.count === 1
    ? `1 ${props.trackerLabel} change`
    : `${props.count} ${props.trackerLabel} changes`
);
const notSynced = computed(() => (props.count === 1 ? "hasn't" : "haven't"));
const owner = computed(() => props.nickname ?? 'an unknown account');

const title = computed(() => {
  if (props.mode === 'disconnect') return `Disconnect ${props.trackerLabel}?`;
  if (props.mode === 'switch') return 'Signed in to a different account';
  if (props.mode === 'mirror-off') return `Stop mirroring to ${props.trackerLabel}?`;
  return 'Discard kept changes?';
});

// Only the changes mirrored from the primary are dropped (#692's `discardQueue`).
const mirroredCount = computed(() =>
  props.count === 1 ? "1 change won't be sent" : `${props.count} changes won't be sent`
);

function close(): void {
  if (props.mode === 'switch') emit('keep');
  else emit('cancel');
}

const keepButton = ref<HTMLButtonElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);

// On `window`: the backdrop can't take focus, so a key handler on it never fires.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  // The safe choice takes focus: Keep where there is one, else Cancel.
  (keepButton.value ?? cancelButton.value)?.focus();
});

onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="pending-backdrop" @click.self="close">
    <div class="pending-modal" role="dialog" aria-modal="true">
      <div class="pending-title">{{ title }}</div>
      <p v-if="mode === 'disconnect'" class="pending-text">
        {{ changes }} {{ notSynced }} been synced yet.
      </p>
      <p v-else-if="mode === 'switch'" class="pending-text">
        {{ changes }} for {{ owner }} {{ notSynced }} been synced yet. They won't be sent to
        {{ newNickname }}.
      </p>
      <p v-else-if="mode === 'mirror-off'" class="pending-text">
        Changes you make in {{ primaryLabel }} will no longer be sent to {{ trackerLabel }}.
        <template v-if="count > 0">
          {{ mirroredCount }}: they were mirrored from {{ primaryLabel }} and haven't synced yet.
        </template>
      </p>
      <p v-else class="pending-text">
        {{ changes }} for {{ owner }} {{ notSynced }} been synced yet. Discarding them can't be
        undone.
      </p>
      <div class="pending-actions">
        <button
          v-if="mode !== 'switch'"
          ref="cancelButton"
          class="btn btn-outline"
          data-action="cancel"
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          v-if="mode === 'mirror-off'"
          class="btn btn-danger"
          data-action="confirm"
          @click="emit('confirm')"
        >
          Stop mirroring
        </button>
        <button v-else class="btn btn-danger" data-action="discard" @click="emit('discard')">
          Discard
        </button>
        <button
          v-if="mode === 'disconnect' || mode === 'switch'"
          ref="keepButton"
          class="btn btn-primary"
          data-action="keep"
          @click="emit('keep')"
        >
          Keep for {{ owner }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.pending-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
}

.pending-modal {
  width: 460px;
  max-width: calc(100% - 40px);
  background: var(--surface);
  border: 1px solid var(--surface-3);
  border-radius: 10px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pending-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}

.pending-text {
  font-size: 0.9rem;
  color: var(--text-2);
}

.pending-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
</style>
