<script setup lang="ts">
// One export job in Downloads (#574): progress, pause / resume / cancel, and
// the two waiting states — the player is open, or the drive is gone.
import { computed } from 'vue';
import { formatBytes } from '../../utils';
import { useExportStore } from '../../stores/export';

const props = defineProps<{ job: ExportJobView }>();
const exportStore = useExportStore();

const finished = computed(
  () =>
    props.job.status === 'completed' ||
    props.job.status === 'cancelled' ||
    props.job.status === 'failed'
);

const headline = computed(() => {
  const j = props.job;
  const counts = `${j.filesDone} / ${j.filesTotal} files, ${formatBytes(j.bytesDone)} / ${formatBytes(j.bytesTotal)}`;
  switch (j.status) {
    case 'completed':
      return `Exported to ${j.libraryName} — ${counts}`;
    case 'cancelled':
      return `Export to ${j.libraryName} cancelled — ${counts}`;
    case 'failed':
      return `Export to ${j.libraryName} failed — ${counts}`;
    default:
      return `Exporting to ${j.libraryName} — ${counts}`;
  }
});

const waiting = computed(() => {
  switch (props.job.status) {
    case 'held':
      return 'Paused while the player is open';
    case 'waiting-drive':
      return `Waiting for drive '${props.job.libraryName}'`;
    case 'paused':
      return 'Paused';
    default:
      return null;
  }
});

const percent = computed(() =>
  props.job.bytesTotal > 0 ? Math.min(100, (props.job.bytesDone / props.job.bytesTotal) * 100) : 0
);
</script>

<template>
  <div class="export-card" :data-testid="`export-job-${job.status}`">
    <div class="head">
      <span class="title">{{ headline }}</span>
      <div class="buttons">
        <button
          v-if="job.status === 'running' || job.status === 'held'"
          class="btn btn-warn btn-sm"
          @click="exportStore.pause(job.jobId)"
        >
          Pause
        </button>
        <button
          v-if="job.status === 'paused' || job.status === 'waiting-drive'"
          class="btn btn-ok btn-sm"
          @click="exportStore.resume(job.jobId)"
        >
          Resume
        </button>
        <button
          v-if="job.status === 'waiting-drive'"
          class="btn btn-outline btn-sm"
          @click="exportStore.locate(job.jobId)"
        >
          Locate…
        </button>
        <button class="btn btn-sm" @click="exportStore.cancel(job.jobId)">
          {{ finished ? 'Dismiss' : 'Cancel' }}
        </button>
      </div>
    </div>
    <div class="bar"><div class="fill" :style="{ width: `${percent}%` }"></div></div>
    <div v-if="waiting" class="waiting">{{ waiting }}</div>
    <div v-else-if="job.current && job.status === 'running'" class="current">
      {{ job.current }}
    </div>
    <div v-if="exportStore.locateErrors[job.jobId]" class="error">
      {{ exportStore.locateErrors[job.jobId] }}
    </div>
    <div v-if="job.note" class="note">{{ job.note }}</div>
    <div v-if="job.error" class="error">{{ job.error }}</div>
    <div v-if="job.missing > 0" class="note">
      {{ job.missing }} selected episodes weren’t on disk.
    </div>
    <details v-if="job.failed.length > 0" class="failed">
      <summary>{{ job.failed.length }} failed</summary>
      <div v-for="f in job.failed" :key="f.key">{{ f.label }}: {{ f.reason }}</div>
    </details>
  </div>
</template>

<style scoped>
.export-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--surface);
  padding: 12px 14px;
  margin-bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title {
  flex: 1;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
}

.buttons {
  display: flex;
  gap: 6px;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--surface-3);
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--accent);
}

.waiting {
  font-size: 0.82rem;
  color: var(--st-orange);
}

.current,
.note {
  font-size: 0.8rem;
  color: var(--text-3);
}

.error {
  font-size: 0.8rem;
  color: var(--st-red);
}

.failed {
  font-size: 0.78rem;
  color: var(--text-3);
}
</style>
