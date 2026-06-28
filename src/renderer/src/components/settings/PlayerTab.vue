<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';

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
    <SettingsGroup title="Playback defaults">
      <SettingsRow
        label="Default player"
        desc="What happens when you click “Open” on a downloaded episode."
      >
        <div class="set-seg">
          <button :class="{ on: playerMode === 'system' }" @click="playerMode = 'system'">
            System
          </button>
          <button :class="{ on: playerMode === 'builtin' }" @click="playerMode = 'builtin'">
            Built-in
          </button>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Pre-fetch next episode"
        desc="Starts downloading the next episode in the background while you're watching the current one. Uses your active translation and quality. Subscribed shows are skipped — the auto-downloader handles them."
      >
        <div class="select-wrap">
          <select v-model="prefetchNextEpisode">
            <option value="off">Off</option>
            <option value="open">On player open</option>
            <option value="time-5min">After 5 minutes of playback</option>
            <option value="progress-50">At 50% playback</option>
          </select>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Enhancements">
      <SettingsRow
        label="Anime4K upscaling preset"
        desc="Real-time anime upscaling via WebGPU shaders. Choose a preset based on your source video resolution."
      >
        <div class="select-wrap">
          <select v-model="anime4kPreset" :disabled="!webgpuStatus.available">
            <option value="off">Off</option>
            <option value="mode-a">Mode A (1080p source)</option>
            <option value="mode-b">Mode B (720p source)</option>
            <option value="mode-c">Mode C (480p source)</option>
          </select>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </SettingsRow>
      <SettingsRow stack>
        <div v-if="webgpuStatus.available" class="status-line ok">
          WebGPU available — {{ webgpuStatus.gpuName }}
        </div>
        <div v-else class="status-line warn">
          WebGPU not available — Anime4K shaders are disabled. Plain video playback still works.
        </div>
      </SettingsRow>
      <SettingsRow
        label="HEVC transcoding on play"
        desc="For local HEVC (H.265) MKVs: when the built-in player can't decode HEVC, transcode to H.264 instead of a black screen. Set to Always to force the transcode even when HEVC decodes natively — useful if direct HEVC playback has seek/sync issues."
      >
        <div class="select-wrap">
          <select v-model="hevcTranscodeOnPlay">
            <option value="ask">Ask each time</option>
            <option value="always">Always transcode</option>
            <option value="never">Never — open in external player</option>
          </select>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </SettingsRow>
      <SettingsRow stack>
        <div v-if="hevcMseSupported" class="status-line ok">
          HEVC MSE decoder: available — HEVC plays directly. Set to Always to force transcoding
          anyway (e.g. if direct HEVC seeking is out of sync).
        </div>
        <div v-else class="status-line warn">
          HEVC MSE decoder: not available — this setting controls the fallback for local MKV
          playback.
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup>
      <SettingsRow stack>
        <p class="sr-desc">
          Note: the built-in player supports local MKV playback via the MSE remux pipeline. For
          non-downloaded episodes, MKV files are streamed from the server — a Play button will
          appear on those rows when player mode is “Built-in”. If a local HEVC MKV can't be decoded
          by your platform, the fallback above decides what happens.
        </p>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>
