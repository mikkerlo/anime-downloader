<script setup lang="ts">
import { onMounted, ref } from 'vue';
import IdentityWarning from './IdentityWarning.vue';
import FfmpegMissingBanner from './FfmpegMissingBanner.vue';
import { pathOverflowText, useSharedLibrariesStore } from '../../stores/shared-libraries';

// "Open Shared Library…" (#578): pick a folder, choose among the libraries
// found in it and one level below, pass the identity check, attach. Nothing
// here writes to the drive. With `found` (the found-on-a-drive toast's Open,
// #581) the poller has already discovered them, so there is no picker.
const props = defineProps<{ found?: SharedLibraryFound | null }>();
const emit = defineEmits<{ close: []; show: [libraryId: string] }>();
const shared = useSharedLibrariesStore();

type Phase = 'picking' | 'empty' | 'choose' | 'blocked' | 'identity' | 'attaching' | 'done';
const phase = ref<Phase>('picking');
const candidates = ref<SharedLibraryCandidate[]>([]);
const current = ref<SharedLibraryCandidate | null>(null);
const result = ref<Extract<SharedLibraryAttachResult, { ok: true }> | null>(null);
const error = ref('');

const MODE_LABEL: Record<SharedLibraryMode, string> = {
  videos: 'Videos only',
  metadata: 'With metadata'
};

onMounted(async () => {
  try {
    const found = props.found ?? (await window.api.sharedLibraryPickAndDiscover());
    if (!found.dir) {
      emit('close');
      return;
    }
    candidates.value = found.candidates;
    if (found.candidates.length === 0) phase.value = 'empty';
    else if (found.candidates.length === 1) select(found.candidates[0]);
    else phase.value = 'choose';
  } catch (err) {
    error.value = String(err);
    phase.value = 'empty';
  }
});

function select(c: SharedLibraryCandidate): void {
  current.value = c;
  if (!c.libraryId) phase.value = 'blocked';
  else if (c.identity === 'foreign' || c.identity === 'choose') phase.value = 'identity';
  else void attach();
}

async function attach(choice?: SharedLibraryAttachChoice): Promise<void> {
  const c = current.value;
  if (!c?.libraryId) return;
  phase.value = 'attaching';
  error.value = '';
  const res = await window.api.sharedLibraryAttach(c.libraryId, choice);
  if (!res.ok) {
    error.value = res.error;
    phase.value = candidates.value.length > 1 ? 'choose' : 'blocked';
    return;
  }
  result.value = res;
  phase.value = 'done';
  await shared.refresh();
}
</script>

<template>
  <IdentityWarning
    v-if="phase === 'identity' && current"
    :candidate="current"
    @choose="attach"
    @cancel="emit('close')"
  />
  <div v-else-if="phase !== 'picking'" class="sl-backdrop" @click.self="emit('close')">
    <div class="sl-modal" data-testid="open-library-dialog">
      <template v-if="phase === 'empty'">
        <div class="sl-title">No Shared Library here</div>
        <p class="sl-text">
          This folder has no Shared Library, and neither do the folders directly inside it.
        </p>
        <p v-if="error" class="sl-error">{{ error }}</p>
      </template>

      <template v-else-if="phase === 'choose'">
        <div class="sl-title">This drive holds {{ candidates.length }} libraries</div>
        <p class="sl-text">Pick the one to open.</p>
        <p v-if="error" class="sl-error">{{ error }}</p>
        <button
          v-for="c in candidates"
          :key="c.root"
          class="candidate"
          data-testid="library-candidate"
          @click="select(c)"
        >
          <span class="candidate-name">{{ c.name }}</span>
          <span class="sl-muted">
            {{ c.ownerNickname ?? 'No owner' }} · {{ c.mode ? MODE_LABEL[c.mode] : 'Unreadable' }} ·
            {{ c.titleCount }}
            {{ c.titleCount === 1 ? 'title' : 'titles' }}
          </span>
        </button>
      </template>

      <template v-else-if="phase === 'blocked' && current">
        <div class="sl-title">{{ current.name }}</div>
        <p v-if="current.readOnly" class="sl-warn">{{ current.readOnly.message }}</p>
        <p v-if="error" class="sl-error">{{ error }}</p>
      </template>

      <template v-else-if="phase === 'attaching'">
        <div class="sl-title">Opening…</div>
      </template>

      <template v-else-if="phase === 'done' && result">
        <div class="sl-title">Opened {{ result.library.name }}</div>
        <p class="sl-muted">
          {{ MODE_LABEL[result.library.mode] }}
          <template v-if="result.library.ownerNickname">
            · {{ result.library.ownerNickname }}</template
          >
          · {{ result.library.titles.length }}
          {{ result.library.titles.length === 1 ? 'title' : 'titles' }}
        </p>
        <p
          v-if="result.library.role === 'owner' || result.library.role === 'claim'"
          class="sl-text"
        >
          Sync arrives in a later update.
        </p>
        <p v-if="result.library.message" class="sl-warn" data-testid="read-only-message">
          {{ result.library.message }}
        </p>
        <p v-if="result.library.pathOverflow > 0" class="sl-warn" data-testid="path-overflow">
          {{ pathOverflowText(result.library.pathOverflow) }}
        </p>
        <FfmpegMissingBanner
          v-if="result.ffmpegMissing"
          :mkv-count="result.ffmpegMissing.mkvCount"
        />
      </template>

      <div class="sl-actions">
        <button class="sl-btn" @click="emit('close')">
          {{ phase === 'done' ? 'Close' : 'Cancel' }}
        </button>
        <button
          v-if="phase === 'done' && result"
          class="sl-btn primary"
          data-testid="show-library"
          @click="emit('show', result.library.libraryId)"
        >
          Show in Library
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.candidate {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.candidate:hover {
  border-color: var(--accent);
}

.candidate-name {
  font-weight: 600;
  font-size: 0.9rem;
}
</style>
