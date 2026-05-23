<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';

const { autoSave } = useSettingsAutosave();

const loaded = ref(false);

const playerMode = ref<'system' | 'builtin'>('system');
const anime4kPreset = ref<'off' | 'mode-a' | 'mode-b' | 'mode-c'>('off');
const hevcTranscodeOnPlay = ref<'ask' | 'always' | 'never'>('ask');
const prefetchNextEpisode = ref<'off' | 'open' | 'time-5min' | 'progress-50'>('progress-50');

const webgpuStatus = ref<{ available: boolean; gpuName: string }>({
  available: false,
  gpuName: ''
});

// `hevcTranscodeOnPlay` gates the MKV-via-MSE path, which negotiates codecs
// through `MediaSource.isTypeSupported`. That surface can reject HEVC even when
// `canPlayType` accepts it (Chromium's platform HEVC path is reachable through
// <video src> but not always through MSE). Probe MSE separately so we only
// disable the dropdown when the fallback truly can't fire.
const hevcMseSupported = (() => {
  if (typeof window === 'undefined' || typeof MediaSource === 'undefined') return false;
  const probes = [
    'video/mp4; codecs="hvc1.1.6.L120.B0"',
    'video/mp4; codecs="hvc1.2.4.L120.B0"',
    'video/mp4; codecs="hev1.1.6.L120.B0"',
    'video/mp4; codecs="hev1.2.4.L120.B0"'
  ];
  return probes.some((p) => MediaSource.isTypeSupported(p));
})();

onMounted(async () => {
  playerMode.value =
    ((await window.api.getSetting('playerMode')) as string as typeof playerMode.value) || 'system';
  anime4kPreset.value =
    ((await window.api.getSetting('anime4kPreset')) as string as typeof anime4kPreset.value) ||
    'off';
  hevcTranscodeOnPlay.value =
    ((await window.api.getSetting(
      'hevcTranscodeOnPlay'
    )) as string as typeof hevcTranscodeOnPlay.value) || 'ask';
  prefetchNextEpisode.value =
    ((await window.api.getSetting(
      'prefetchNextEpisode'
    )) as string as typeof prefetchNextEpisode.value) || 'progress-50';

  // Probe WebGPU
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info;
        webgpuStatus.value = {
          available: true,
          gpuName: info.device || info.description || info.vendor || 'Unknown GPU'
        };
      }
    }
  } catch {
    /* WebGPU not available */
  }

  loaded.value = true;
});

watch(playerMode, (val) => {
  if (loaded.value) autoSave('playerMode', val);
});
watch(anime4kPreset, (val) => {
  if (loaded.value) autoSave('anime4kPreset', val);
});
watch(hevcTranscodeOnPlay, (val) => {
  if (loaded.value) autoSave('hevcTranscodeOnPlay', val);
});
watch(prefetchNextEpisode, (val) => {
  if (!loaded.value) return;
  autoSave('prefetchNextEpisode', val);
  window.dispatchEvent(new CustomEvent('prefetch-setting-changed', { detail: val }));
});
</script>

<template>
  <div>
    <div class="setting-group">
      <label class="setting-label">Default player</label>
      <p class="setting-hint">Choose what happens when you click "Open" on a downloaded episode.</p>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" v-model="playerMode" value="system" />
          System default player
        </label>
        <label class="radio-label">
          <input type="radio" v-model="playerMode" value="builtin" />
          Built-in player
        </label>
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Anime4K upscaling preset</label>
      <p class="setting-hint">
        Real-time anime upscaling via WebGPU shaders. Choose a preset based on your source video
        resolution.
      </p>
      <select
        v-model="anime4kPreset"
        class="setting-input setting-select"
        :disabled="!webgpuStatus.available"
      >
        <option value="off">Off</option>
        <option value="mode-a">Mode A (1080p source)</option>
        <option value="mode-b">Mode B (720p source)</option>
        <option value="mode-c">Mode C (480p source)</option>
      </select>
    </div>

    <div class="setting-group">
      <label class="setting-label">WebGPU status</label>
      <div v-if="webgpuStatus.available" class="status-line ok">
        Available — {{ webgpuStatus.gpuName }}
      </div>
      <div v-else class="status-line warn">
        Not available — Anime4K shaders are disabled. Plain video playback still works.
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">HEVC transcoding on play</label>
      <p class="setting-hint">
        When a local HEVC (H.265) MKV can't be decoded by the built-in player, transcode it to H.264
        in real time instead of leaving the viewer with a black screen.
      </p>
      <select
        v-model="hevcTranscodeOnPlay"
        class="setting-input setting-select"
        :disabled="hevcMseSupported"
      >
        <option value="ask">Ask each time</option>
        <option value="always">Always transcode</option>
        <option value="never">Never — open in external player</option>
      </select>
      <div v-if="hevcMseSupported" class="status-line ok" style="margin-top: 0.4rem">
        HEVC MSE decoder: available — the MKV pipeline plays HEVC directly and this fallback won't
        fire.
      </div>
      <div v-else class="status-line warn" style="margin-top: 0.4rem">
        HEVC MSE decoder: not available — this setting controls the fallback for local MKV playback.
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Pre-fetch next episode</label>
      <p class="setting-hint">
        Starts downloading the next episode in the background while you're watching the current one.
        Uses your active translation and quality. Subscribed shows are skipped — the auto-downloader
        handles them.
      </p>
      <select v-model="prefetchNextEpisode" class="setting-input setting-select">
        <option value="off">Off</option>
        <option value="open">On player open</option>
        <option value="time-5min">After 5 minutes of playback</option>
        <option value="progress-50">At 50% playback</option>
      </select>
    </div>

    <div class="setting-group">
      <p class="setting-hint">
        Note: the built-in player supports local MKV playback via the MSE remux pipeline. For
        non-downloaded episodes, MKV files are streamed from the server — a Play button will appear
        on those rows when player mode is "Built-in". If a local HEVC MKV can't be decoded by your
        platform, the fallback above decides what happens.
      </p>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #a0a0b8;
  font-size: 0.85rem;
  cursor: pointer;
}

.radio-label input[type='radio'] {
  accent-color: #e94560;
}
</style>
