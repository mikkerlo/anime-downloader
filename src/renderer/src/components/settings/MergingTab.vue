<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';

const { autoSave } = useSettingsAutosave();

const loaded = ref(false);

const ffmpeg = ref<{
  available: boolean;
  version: string;
  path: string;
  encoders: string[];
} | null>(null);
const autoMerge = ref(false);
const enableLocalSkipDetection = ref(true);
const videoCodec = ref('copy');

const skipBackfillRunning = ref(false);
const skipBackfillResult = ref('');
const skipQueueStatus = ref<{ currentAnimeId: number | null; queueLength: number }>({
  currentAnimeId: null,
  queueLength: 0
});
let skipQueuePollTimer: ReturnType<typeof setInterval> | null = null;

// HEVC playback decoder availability. On Linux stock Chromium builds ship no HEVC
// decoder, so merging to H.265 produces files the built-in player can't play.
// Windows (Media Foundation) and macOS (VideoToolbox) generally work.
//
// Probe via HTMLVideoElement.canPlayType rather than MediaSource.isTypeSupported:
// merged H.265 MP4s play through a plain <video src="…"> element, not MSE, and
// the two support surfaces can diverge. Using canPlayType matches what the
// built-in player will actually attempt when opening a merged file.
const hevcPlaybackSupported = (() => {
  if (typeof document === 'undefined') return false;
  const v = document.createElement('video');
  const probes = [
    'video/mp4; codecs="hvc1.1.6.L120.B0"',
    'video/mp4; codecs="hvc1.2.4.L120.B0"',
    'video/mp4; codecs="hev1.1.6.L120.B0"',
    'video/mp4; codecs="hev1.2.4.L120.B0"'
  ];
  return probes.some((p) => v.canPlayType(p) !== '');
})();

const CODEC_OPTIONS: { value: string; label: string; encoder?: string }[] = [
  { value: 'copy', label: 'None (copy, fastest)' },
  { value: 'libx265', label: 'H.265 (CPU)', encoder: 'libx265' },
  { value: 'hevc_nvenc', label: 'H.265 (NVIDIA GPU)', encoder: 'hevc_nvenc' },
  { value: 'hevc_amf', label: 'H.265 (AMD GPU)', encoder: 'hevc_amf' },
  { value: 'hevc_qsv', label: 'H.265 (Intel QSV)', encoder: 'hevc_qsv' },
  { value: 'hevc_videotoolbox', label: 'H.265 (macOS VideoToolbox)', encoder: 'hevc_videotoolbox' }
];

const availableCodecs = computed(() => {
  if (!ffmpeg.value) return [CODEC_OPTIONS[0]];
  return CODEC_OPTIONS.filter((c) => !c.encoder || ffmpeg.value!.encoders.includes(c.encoder));
});

const skipQueueStatusLabel = computed<string>(() => {
  const s = skipQueueStatus.value;
  if (s.currentAnimeId === null && s.queueLength === 0) return '';
  const inFlight = s.currentAnimeId !== null ? 1 : 0;
  const remaining = s.queueLength + inFlight;
  return `Currently analyzing ${remaining} show${remaining === 1 ? '' : 's'}…`;
});

async function refreshSkipQueueStatus(): Promise<void> {
  try {
    skipQueueStatus.value = await window.api.skipDetectorQueueStatus();
  } catch {
    /* ignore */
  }
}

async function onBackfillSkipDetection(): Promise<void> {
  if (skipBackfillRunning.value) return;
  skipBackfillRunning.value = true;
  skipBackfillResult.value = '';
  try {
    const r = await window.api.skipDetectorBackfillAll();
    const parts: string[] = [];
    parts.push(`Queued ${r.queued} of ${r.total} downloaded shows.`);
    if (r.alreadyAnalyzed > 0) parts.push(`${r.alreadyAnalyzed} already analyzed.`);
    if (r.skippedFewEpisodes > 0) parts.push(`${r.skippedFewEpisodes} skipped (need ≥2 episodes).`);
    skipBackfillResult.value = parts.join(' ');
    await refreshSkipQueueStatus();
  } catch (err) {
    skipBackfillResult.value = `Backfill failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    skipBackfillRunning.value = false;
  }
}

onMounted(async () => {
  ffmpeg.value = await window.api.ffmpegCheck();
  autoMerge.value = ((await window.api.getSetting('autoMerge')) as boolean) || false;
  const skipSetting = await window.api.getSetting('enableLocalSkipDetection');
  enableLocalSkipDetection.value = skipSetting === undefined ? true : Boolean(skipSetting);
  videoCodec.value = ((await window.api.getSetting('videoCodec')) as string) || 'copy';

  // Reset codec if no longer available
  if (!availableCodecs.value.find((c) => c.value === videoCodec.value)) {
    videoCodec.value = 'copy';
  }

  void refreshSkipQueueStatus();
  // Poll the skip-detector queue while the Settings page is open so the
  // status line decrements as the backfill drains. 4 s is fine — analyses
  // take 30+ s each.
  skipQueuePollTimer = setInterval(refreshSkipQueueStatus, 4000);

  loaded.value = true;
});

onUnmounted(() => {
  if (skipQueuePollTimer) {
    clearInterval(skipQueuePollTimer);
    skipQueuePollTimer = null;
  }
});

watch(autoMerge, (val) => {
  if (loaded.value) autoSave('autoMerge', val);
});
watch(enableLocalSkipDetection, (val) => {
  if (loaded.value) autoSave('enableLocalSkipDetection', val);
});

let suppressVideoCodecSave = false;
watch(videoCodec, (val, oldVal) => {
  if (!loaded.value) return;
  // Re-entrant call from reverting the value below — skip both the confirm
  // and the autoSave so we don't flash a "Saved" toast for a no-op change.
  if (suppressVideoCodecSave) {
    suppressVideoCodecSave = false;
    return;
  }
  const isHevc = val.startsWith('libx265') || val.startsWith('hevc_');
  const wasHevc = oldVal.startsWith('libx265') || oldVal.startsWith('hevc_');
  // Only ask for confirmation on platforms without a working HEVC decoder —
  // on Windows/macOS the merged file plays back fine and the prompt is noise.
  if (isHevc && !wasHevc && !hevcPlaybackSupported) {
    const confirmed = window.confirm(
      'This platform has no HEVC (H.265) decoder available for playback.\n\n' +
        'Files merged with H.265 will save disk space, but the built-in player will not be able to ' +
        "decode them — you'll get audio with a black video, and will need an external player (VLC/mpv) " +
        'to watch them.\n\n' +
        'Continue with H.265?'
    );
    if (!confirmed) {
      suppressVideoCodecSave = true;
      videoCodec.value = oldVal;
      return;
    }
  }
  autoSave('videoCodec', val);
});
</script>

<template>
  <div>
    <div class="setting-group">
      <label class="setting-label">FFmpeg</label>
      <p class="setting-hint">Required for merging video + subtitles into MKV.</p>
      <div
        v-if="ffmpeg"
        class="ffmpeg-status"
        :class="{ ok: ffmpeg.available, missing: !ffmpeg.available }"
      >
        <span v-if="ffmpeg.available" class="ffmpeg-ok">{{ ffmpeg.version }}</span>
        <span v-else class="ffmpeg-missing">Not found</span>
        <span v-if="ffmpeg.path" class="ffmpeg-path">{{ ffmpeg.path }}</span>
      </div>
      <div v-else class="ffmpeg-status">Checking...</div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Auto-merge</label>
      <p class="setting-hint">
        Automatically merge video + subtitles into MKV when both finish downloading.
      </p>
      <label class="toggle-row" :class="{ disabled: !ffmpeg?.available }">
        <input
          type="checkbox"
          v-model="autoMerge"
          :disabled="!ffmpeg?.available"
          class="toggle-input"
        />
        <span class="toggle-slider"></span>
        <span class="toggle-label">{{ autoMerge ? 'Enabled' : 'Disabled' }}</span>
      </label>
    </div>

    <div class="setting-group">
      <label class="setting-label">Local skip detection</label>
      <p class="setting-hint">
        Fingerprint downloaded episodes locally to detect OP/ED in the player. Runs in the
        background after each download; first analysis on a show takes a minute or two of CPU.
      </p>
      <label class="toggle-row">
        <input type="checkbox" v-model="enableLocalSkipDetection" class="toggle-input" />
        <span class="toggle-slider"></span>
        <span class="toggle-label">{{ enableLocalSkipDetection ? 'Enabled' : 'Disabled' }}</span>
      </label>
      <div class="skip-backfill">
        <button
          type="button"
          class="browse-btn"
          :disabled="skipBackfillRunning"
          @click="onBackfillSkipDetection"
        >
          {{ skipBackfillRunning ? 'Queuing…' : 'Run detection on all downloaded shows' }}
        </button>
        <p v-if="skipBackfillResult" class="setting-hint">{{ skipBackfillResult }}</p>
        <p v-if="skipQueueStatusLabel" class="setting-hint">{{ skipQueueStatusLabel }}</p>
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Re-encode video</label>
      <p class="setting-hint">
        Re-encode video during merge. "None" copies the stream as-is (fastest). H.265 reduces file
        size but takes longer.
      </p>
      <select
        v-model="videoCodec"
        class="setting-input setting-select"
        :disabled="!ffmpeg?.available"
      >
        <option v-for="c in availableCodecs" :key="c.value" :value="c.value">
          {{ c.label }}
        </option>
      </select>
      <p
        v-if="
          (videoCodec.startsWith('libx265') || videoCodec.startsWith('hevc_')) &&
          !hevcPlaybackSupported
        "
        class="setting-hint setting-hint-warn"
      >
        H.265 merges save disk space, but this platform has no HEVC decoder — the built-in player
        will not play these files.
      </p>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.skip-backfill {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
