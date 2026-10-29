<script setup lang="ts">
// One copy-to-this-PC job in Downloads (#579): "Copying from <library> — 5 / 12",
// pause / resume / cancel, and the waiting states: the player is open, the
// drive is gone, or a duplicate needs an answer.
import { computed } from 'vue';
import { formatBytes } from '../../utils';
import { useImportStore } from '../../stores/import';

const props = defineProps<{ job: ImportJobView }>();
const importStore = useImportStore();

const finished = computed(
  () =>
    props.job.status === 'completed' ||
    props.job.status === 'cancelled' ||
    props.job.status === 'failed'
);

const headline = computed(() => {
  const j = props.job;
  const counts = `${j.itemsDone} / ${j.itemsTotal}`;
  switch (j.status) {
    case 'completed':
      return `Copied from ${j.libraryName} — ${counts}`;
    case 'cancelled':
      return `Copy from ${j.libraryName} cancelled — ${counts}`;
    case 'failed':
      return `Copy from ${j.libraryName} failed — ${counts}`;
    default:
      return `Copying from ${j.libraryName} — ${counts}`;
  }
});

const waiting = computed(() => {
  switch (props.job.status) {
    case 'held':
      return 'Paused while the player is open';
    case 'waiting-drive':
      return `Waiting for drive '${props.job.libraryName}'`;
    case 'waiting-duplicate':
      return 'Waiting for your answer: this PC already has an episode';
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
  <div class="import-card" data-testid="import-job" :data-status="job.status">
    <div class="head">
      <span class="title" data-testid="import-job-headline">{{ headline }}</span>
      <div class="buttons">
        <button
          v-if="job.status === 'running' || job.status === 'held'"
          class="sl-btn"
          @click="importStore.pause(job.jobId)"
        >
          Pause
        </button>
        <button
          v-if="job.status === 'paused' || job.status === 'waiting-drive'"
          class="sl-btn primary"
          @click="importStore.resume(job.jobId)"
        >
          Resume
        </button>
        <button class="sl-btn" @click="importStore.cancel(job.jobId)">
          {{ finished ? 'Dismiss' : 'Cancel' }}
        </button>
      </div>
    </div>
    <div class="bar"><div class="fill" :style="{ width: `${percent}%` }"></div></div>
    <div class="current">
      {{ formatBytes(job.bytesDone) }} / {{ formatBytes(job.bytesTotal) }}
      <template v-if="job.destination === 'cold'"> · to cold storage</template>
    </div>
    <div v-if="waiting" class="waiting">{{ waiting }}</div>
    <div v-else-if="job.current && job.status === 'running'" class="current">
      Copying: {{ job.current }}
    </div>
    <div v-if="job.note" class="note">{{ job.note }}</div>
    <div v-if="job.error" class="error">{{ job.error }}</div>
    <details v-if="job.failed.length > 0" class="failed">
      <summary>{{ job.failed.length }} failed</summary>
      <div v-for="f in job.failed" :key="f.key">{{ f.label }}: {{ f.reason }}</div>
    </details>
    <details v-if="job.kept.length > 0" class="failed" data-testid="import-job-kept">
      <summary>{{ job.kept.length }} already on this PC, kept</summary>
      <div v-for="k in job.kept" :key="k.key">{{ k.label }}: {{ k.reason }}</div>
    </details>
  </div>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.import-card {
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
