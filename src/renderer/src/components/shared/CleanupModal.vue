<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { formatBytes } from '../../utils';

const props = defineProps<{
  animeId: number;
  animeName: string;
}>();

const emit = defineEmits<{
  closed: [];
  deleted: [];
}>();

const sizeLoading = ref(true);
const bytes = ref(0);
const fileCount = ref(0);
const activeDownloads = ref(0);
const deleting = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    const [size, active] = await Promise.all([
      window.api.cleanupGetSize(props.animeId, props.animeName),
      window.api.cleanupGetActiveDownloads(props.animeName)
    ]);
    bytes.value = size.bytes;
    fileCount.value = size.files;
    activeDownloads.value = active.active;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    sizeLoading.value = false;
  }
});

async function confirmDelete(): Promise<void> {
  if (deleting.value) return;
  deleting.value = true;
  error.value = '';
  try {
    if (activeDownloads.value > 0) {
      await window.api.downloadCancelByEpisode(props.animeName);
    }
    await window.api.cleanupExecute(props.animeId, props.animeName);
    emit('deleted');
    emit('closed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    deleting.value = false;
  }
}

function cancel(): void {
  if (deleting.value) return;
  emit('closed');
}
</script>

<template>
  <div class="cleanup-backdrop" @click.self="cancel">
    <div class="cleanup-modal">
      <div class="cleanup-title">Clean up «{{ animeName }}»?</div>
      <p v-if="sizeLoading" class="cleanup-hint">Calculating disk usage…</p>
      <template v-else>
        <p v-if="fileCount === 0" class="cleanup-hint">No local files found for this anime.</p>
        <p v-else class="cleanup-hint">
          {{ fileCount }} file{{ fileCount === 1 ? '' : 's' }} · {{ formatBytes(bytes) }} on disk.
        </p>
      </template>
      <p class="cleanup-note">Watch progress and your Shikimori rate will be kept.</p>
      <p v-if="activeDownloads > 0" class="cleanup-warn">
        ⚠ {{ activeDownloads }} download{{ activeDownloads === 1 ? '' : 's' }} for this show
        {{ activeDownloads === 1 ? 'is' : 'are' }} still in flight and will be cancelled.
      </p>
      <p v-if="error" class="cleanup-error">{{ error }}</p>
      <div class="cleanup-actions">
        <button class="btn btn-secondary" :disabled="deleting" @click="cancel">Cancel</button>
        <button
          class="btn btn-danger"
          :disabled="deleting || sizeLoading || fileCount === 0"
          @click="confirmDelete"
        >
          {{
            deleting
              ? 'Deleting…'
              : activeDownloads > 0
                ? 'Cancel downloads + delete files'
                : 'Delete files'
          }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cleanup-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
}

.cleanup-modal {
  width: 460px;
  max-width: calc(100% - 40px);
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cleanup-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: #e0e0e0;
  margin-bottom: 4px;
}

.cleanup-hint {
  font-size: 0.9rem;
  color: #c0c0d0;
}

.cleanup-note {
  font-size: 0.8rem;
  color: #8a8aa8;
}

.cleanup-warn {
  font-size: 0.82rem;
  color: #f0b070;
  background: rgba(240, 176, 112, 0.08);
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(240, 176, 112, 0.3);
}

.cleanup-error {
  font-size: 0.82rem;
  color: #e94560;
}

.cleanup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.btn {
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  border: 1px solid transparent;
  font-weight: 500;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-secondary {
  background-color: transparent;
  color: #c0c0d0;
  border-color: #0f3460;
}

.btn-secondary:hover:not(:disabled) {
  background-color: rgba(15, 52, 96, 0.4);
}

.btn-danger {
  background-color: #b8324a;
  color: #ffffff;
}

.btn-danger:hover:not(:disabled) {
  background-color: #d13a55;
}
</style>
