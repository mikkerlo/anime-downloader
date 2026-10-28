<script setup lang="ts">
import { computed, ref } from 'vue';
import { forgetConfirmText } from '../../stores/shared-libraries';

// Forget (#581): the plain confirmation first. When main answers that pending
// changes would be discarded, the warning names them and a second Forget
// confirms dropping them. Never touches the drive.
const props = defineProps<{ library: Pick<AttachedLibraryInfo, 'libraryId' | 'name'> }>();
const emit = defineEmits<{ close: []; forgotten: [libraryId: string] }>();

const pending = ref<SharedLibraryPendingCount | null>(null);
const busy = ref(false);
const error = ref('');

const text = computed(() =>
  forgetConfirmText(props.library.name, pending.value ?? { libraryChanges: 0, resolutions: 0 })
);

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const res = await window.api.sharedLibraryForget(
      props.library.libraryId,
      pending.value ? { confirmDropPending: true } : undefined
    );
    if (res.needsConfirm) {
      pending.value = res.pendingCount;
      return;
    }
    emit('forgotten', props.library.libraryId);
    emit('close');
  } catch (err) {
    error.value = String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="sl-backdrop" @click.self="emit('close')">
    <div class="sl-modal" data-testid="forget-dialog">
      <div class="sl-title">Forget {{ library.name }}</div>
      <p class="sl-text" :class="{ 'sl-warn': pending }" data-testid="forget-text">{{ text }}</p>
      <p v-if="error" class="sl-error">{{ error }}</p>
      <div class="sl-actions">
        <button class="sl-btn" :disabled="busy" @click="emit('close')">Cancel</button>
        <button
          class="sl-btn primary"
          data-testid="forget-confirm"
          :disabled="busy"
          @click="confirm"
        >
          Forget
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./shared-library.css"></style>
