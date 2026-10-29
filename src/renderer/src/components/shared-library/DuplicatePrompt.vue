<script setup lang="ts">
// The duplicate prompt of a copy to this PC (#579): an episode this PC already
// has. It shows both sizes and waits for an answer; "Apply to all remaining"
// answers the rest of the job, which Import all relies on. Mounted once in
// App.vue, so it shows over any view.
import { ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { formatBytes } from '../../utils';
import { useImportStore } from '../../stores/import';

const importStore = useImportStore();
const { asking } = storeToRefs(importStore);
const applyToAll = ref(false);
const sending = ref(false);

// A new question starts unticked.
watch(
  () => asking.value?.duplicate?.key,
  () => {
    applyToAll.value = false;
  }
);

async function answer(choice: ImportDuplicateChoice): Promise<void> {
  const job = asking.value;
  if (!job || sending.value) return;
  sending.value = true;
  try {
    await importStore.answer(job.jobId, { choice, applyToAll: applyToAll.value });
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div v-if="asking && asking.duplicate" class="dup-backdrop">
    <div class="dup-modal" data-testid="duplicate-prompt">
      <div class="dup-title">This PC already has this episode</div>
      <p class="dup-label">{{ asking.duplicate.label }}</p>
      <p class="hint">Copying from {{ asking.libraryName }}.</p>
      <div class="choices">
        <button
          class="sl-btn"
          data-testid="duplicate-keep"
          :disabled="sending"
          @click="answer('keep')"
        >
          Keep this PC’s file ({{ formatBytes(asking.duplicate.localSize) }})
        </button>
        <button
          class="sl-btn primary"
          data-testid="duplicate-replace"
          :disabled="sending || !asking.duplicate.canReplace"
          :title="
            asking.duplicate.canReplace
              ? undefined
              : 'This PC’s file is still downloading or merging'
          "
          @click="answer('replace')"
        >
          Replace with the drive’s ({{ formatBytes(asking.duplicate.driveSize) }})
        </button>
        <button
          v-if="asking.duplicate.canKeepBoth"
          class="sl-btn"
          data-testid="duplicate-keep-both"
          :disabled="sending"
          @click="answer('keep-both')"
        >
          Keep both
        </button>
      </div>
      <label class="apply-all">
        <input v-model="applyToAll" type="checkbox" data-testid="duplicate-apply-all" />
        Apply to all remaining
      </label>
    </div>
  </div>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.dup-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9100;
}

.dup-modal {
  width: 460px;
  max-width: calc(100% - 40px);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-card);
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dup-title {
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text);
}

.dup-label {
  color: var(--text-2);
  font-size: 0.9rem;
}

.hint {
  font-size: 0.8rem;
  color: var(--text-3);
}

.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.apply-all {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--text-2);
}
</style>
