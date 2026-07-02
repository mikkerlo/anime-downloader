<script setup lang="ts">
import { ref, watch, onMounted, onActivated, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useDownloadsStore } from '../../stores/downloads';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import SettingsSwitch from './SettingsSwitch.vue';

const downloadsStore = useDownloadsStore();
const { scanMergeProgress: scanProgress, fixMetadataProgress: fixProgress } =
  storeToRefs(downloadsStore);
const { autoSave } = useSettingsAutosave();

const loaded = ref(false);

const ffmpeg = ref<{
  available: boolean;
  version: string;
  path: string;
  encoders: string[];
} | null>(null);

const scanMerging = ref(false);
const scanResult = ref<{ merged: number; failed: string[] } | null>(null);

const fixingMetadata = ref(false);
const fixResult = ref<{ fixed: number; failed: string[] } | null>(null);

const dumpingMismatches = ref(false);
const dumpResult = ref<{ count: number; path: string } | null>(null);
const mismatchCount = ref(0);

const mp4Stats = ref<Mp4StreamingStats | null>(null);
const latestNonFaststart = computed<Mp4StreamingStatsSample | null>(() => {
  const s = mp4Stats.value;
  if (!s || s.nonFaststartSamples.length === 0) return null;
  return s.nonFaststartSamples[s.nonFaststartSamples.length - 1];
});

const webgpuStatus = ref<{ available: boolean; gpuName: string }>({
  available: false,
  gpuName: ''
});

const benchmarking = ref(false);
const benchmarkResult = ref<{ preset: string; fps: number; avgMs: number } | null>(null);
const benchmarkError = ref('');

const backgroundQualityProbe = ref(false);

const playerDiagLogging = ref(false);
const playerDiagLog = ref<{ path: string; exists: boolean } | null>(null);

async function refreshPlayerDiagLog(): Promise<void> {
  try {
    playerDiagLog.value = await window.api.debugGetPlayerDiagLog();
  } catch {
    /* ignore */
  }
}

async function openPlayerDiagLog(): Promise<void> {
  if (playerDiagLog.value?.exists) {
    await window.api.shellOpenExternalFile(playerDiagLog.value.path);
  }
}

async function scanAndMerge(): Promise<void> {
  scanMerging.value = true;
  scanProgress.value = null;
  scanResult.value = null;
  try {
    const result = await window.api.downloadScanMerge();
    scanResult.value = result;
  } catch (err) {
    scanResult.value = { merged: 0, failed: [String(err)] };
  } finally {
    scanMerging.value = false;
    scanProgress.value = null;
  }
}

async function fixMetadata(): Promise<void> {
  fixingMetadata.value = true;
  fixProgress.value = null;
  fixResult.value = null;
  try {
    const result = await window.api.downloadFixMetadata();
    fixResult.value = result;
  } catch (err) {
    fixResult.value = { fixed: 0, failed: [String(err)] };
  } finally {
    fixingMetadata.value = false;
    fixProgress.value = null;
  }
}

async function refreshMismatchCount(): Promise<void> {
  mismatchCount.value = await window.api.getQualityMismatchCount();
}

async function dumpMismatches(): Promise<void> {
  dumpingMismatches.value = true;
  dumpResult.value = null;
  try {
    dumpResult.value = await window.api.dumpQualityMismatches();
  } catch (err) {
    dumpResult.value = { count: -1, path: String(err) };
  } finally {
    dumpingMismatches.value = false;
  }
}

async function refreshMp4Stats(): Promise<void> {
  try {
    mp4Stats.value = await window.api.debugGetMp4Stats();
  } catch {
    /* ignore */
  }
}

async function resetMp4Stats(): Promise<void> {
  await window.api.debugResetMp4Stats();
  await refreshMp4Stats();
}

async function deleteFfmpeg(): Promise<void> {
  await window.api.ffmpegDelete();
  ffmpeg.value = await window.api.ffmpegCheck();
}

async function runGpuBenchmark(): Promise<void> {
  benchmarking.value = true;
  benchmarkResult.value = null;
  benchmarkError.value = '';

  try {
    if (!navigator.gpu) throw new Error('WebGPU not available');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter found');
    const device = await adapter.requestDevice();

    const { ModeA } = await import('anime4k-webgpu');

    // Use 720p as source, upscale to actual screen resolution
    const SRC_WIDTH = 1280;
    const SRC_HEIGHT = 720;
    const targetWidth = window.screen.width;
    const targetHeight = window.screen.height;
    const testTexture = device.createTexture({
      size: [SRC_WIDTH, SRC_HEIGHT, 1],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    });

    const pipeline = new ModeA({
      device,
      inputTexture: testTexture,
      nativeDimensions: { width: SRC_WIDTH, height: SRC_HEIGHT },
      targetDimensions: { width: targetWidth, height: targetHeight }
    });

    // Warm up (5 frames)
    for (let i = 0; i < 5; i++) {
      const enc = device.createCommandEncoder();
      pipeline.pass(enc);
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();

    // Benchmark 100 frames
    const FRAMES = 100;
    const start = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      const enc = device.createCommandEncoder();
      pipeline.pass(enc);
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    const elapsed = performance.now() - start;

    const avgMs = elapsed / FRAMES;
    const fps = 1000 / avgMs;

    benchmarkResult.value = {
      preset: `Mode A (720p→${targetHeight}p)`,
      fps: Math.round(fps * 10) / 10,
      avgMs: Math.round(avgMs * 100) / 100
    };
    device.destroy();
  } catch (e) {
    benchmarkError.value = String(e);
  } finally {
    benchmarking.value = false;
  }
}

onMounted(async () => {
  ffmpeg.value = await window.api.ffmpegCheck();
  backgroundQualityProbe.value =
    ((await window.api.getSetting('backgroundQualityProbe')) as boolean) || false;
  playerDiagLogging.value =
    ((await window.api.getSetting('playerDiagLogging')) as boolean) || false;

  void refreshMismatchCount();
  void refreshMp4Stats();
  void refreshPlayerDiagLog();

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

onActivated(() => {
  void refreshMismatchCount();
  void refreshMp4Stats();
  void refreshPlayerDiagLog();
});

watch(backgroundQualityProbe, (val) => {
  if (loaded.value) autoSave('backgroundQualityProbe', val);
});

watch(playerDiagLogging, (val) => {
  if (loaded.value) autoSave('playerDiagLogging', val);
});
</script>

<template>
  <div>
    <SettingsGroup title="FFmpeg">
      <SettingsRow stack>
        <div
          v-if="ffmpeg"
          class="ffmpeg-status"
          :class="{ ok: ffmpeg.available, missing: !ffmpeg.available }"
        >
          <span v-if="ffmpeg.available" class="ffmpeg-ok">{{ ffmpeg.version }}</span>
          <span v-else class="ffmpeg-missing">Not found</span>
          <span v-if="ffmpeg.path" class="ffmpeg-path">{{ ffmpeg.path }}</span>
          <span v-if="ffmpeg.encoders.length" class="ffmpeg-path"
            >Encoders: {{ ffmpeg.encoders.join(', ') }}</span
          >
        </div>
        <div v-else class="ffmpeg-status">Checking...</div>
      </SettingsRow>
      <SettingsRow
        label="Delete ffmpeg binaries"
        desc="Remove downloaded ffmpeg/ffprobe binaries. They will be re-downloaded on next app launch (useful for testing the download progress indicator)."
      >
        <button class="btn btn-sm btn-danger" :disabled="!ffmpeg?.available" @click="deleteFfmpeg">
          Delete ffmpeg + ffprobe
        </button>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Batch operations">
      <SettingsRow
        label="Merge all available"
        desc="Scan all download folders for .mp4 files without matching .mkv and merge them with subtitles if available."
      >
        <button
          class="btn btn-sm"
          :disabled="scanMerging || !ffmpeg?.available"
          @click="scanAndMerge"
        >
          {{ scanMerging ? 'Merging...' : 'Merge all available' }}
        </button>
      </SettingsRow>
      <SettingsRow v-if="scanProgress || scanResult" stack>
        <div v-if="scanProgress" class="set-progress">
          <div class="set-progress-head">
            <span>{{ scanProgress.current }} / {{ scanProgress.total }}</span>
            <span>{{ scanProgress.percent }}%</span>
          </div>
          <div class="bar"><span :style="{ width: scanProgress.percent + '%' }"></span></div>
          <div class="file">{{ scanProgress.file }}</div>
        </div>
        <div
          v-if="scanResult"
          class="result-box"
          :class="{ 'has-errors': scanResult.failed.length > 0 }"
        >
          <div class="result-ok">Merged: {{ scanResult.merged }} file(s)</div>
          <div v-if="scanResult.failed.length > 0" class="result-errors">
            <div>Failed ({{ scanResult.failed.length }}):</div>
            <div v-for="(err, i) in scanResult.failed" :key="i" class="result-error-item">
              {{ err }}
            </div>
          </div>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Fix old files"
        desc="Re-mux existing MKV files to set subtitle language, title (translator name), and default track. Uses stored episode metadata."
      >
        <button
          class="btn btn-sm"
          :disabled="fixingMetadata || !ffmpeg?.available"
          @click="fixMetadata"
        >
          {{ fixingMetadata ? 'Fixing...' : 'Fix subtitle metadata' }}
        </button>
      </SettingsRow>
      <SettingsRow v-if="fixProgress || fixResult" stack>
        <div v-if="fixProgress" class="set-progress">
          <div class="set-progress-head">
            <span>{{ fixProgress.current }} / {{ fixProgress.total }}</span>
          </div>
          <div class="file">{{ fixProgress.file }}</div>
        </div>
        <div
          v-if="fixResult"
          class="result-box"
          :class="{ 'has-errors': fixResult.failed.length > 0 }"
        >
          <div class="result-ok">Fixed: {{ fixResult.fixed }} file(s)</div>
          <div v-if="fixResult.failed.length > 0" class="result-errors">
            <div>Failed ({{ fixResult.failed.length }}):</div>
            <div v-for="(err, i) in fixResult.failed" :key="i" class="result-error-item">
              {{ err }}
            </div>
          </div>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="GPU benchmark">
      <SettingsRow
        label="Anime4K GPU benchmark"
        desc="Test how fast your GPU can run Anime4K shaders (Mode A, 720p→screen resolution, 100 frames). Requires WebGPU."
      >
        <button class="btn btn-sm" :disabled="benchmarking" @click="runGpuBenchmark">
          {{ benchmarking ? 'Running…' : 'Run GPU benchmark' }}
        </button>
      </SettingsRow>
      <SettingsRow stack>
        <div
          v-if="benchmarkResult"
          class="result-box"
          :class="{ 'has-errors': benchmarkResult.fps < 24 }"
        >
          <div class="result-ok" :class="{ warn: benchmarkResult.fps < 24 }">
            {{ benchmarkResult.preset }}: {{ benchmarkResult.fps }} fps ({{
              benchmarkResult.avgMs
            }}ms/frame)
          </div>
          <div class="result-error-item">
            {{
              benchmarkResult.fps >= 24
                ? 'Your GPU can handle real-time Anime4K shaders'
                : 'Your GPU may struggle with real-time shaders — consider using “Off” preset'
            }}
          </div>
        </div>
        <div v-if="benchmarkError" class="result-box has-errors">
          <div class="result-errors">{{ benchmarkError }}</div>
        </div>
        <div v-if="webgpuStatus.available" class="status-line ok">
          WebGPU: {{ webgpuStatus.gpuName }}
        </div>
        <div v-else class="status-line warn">
          WebGPU not detected — benchmark will attempt to initialize it
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Diagnostics">
      <SettingsRow
        label="Player seek diagnostics"
        desc="Log each MKV seek's exact ffmpeg arguments and the probed seek landing vs. the requested time. Used to trace playback/subtitle desync after skipping or resuming. Written to player-diag.log in the app data folder; applies immediately, no restart needed."
      >
        <SettingsSwitch v-model="playerDiagLogging" />
      </SettingsRow>
      <SettingsRow v-if="playerDiagLog" stack>
        <div class="diag-log-row">
          <button class="btn btn-sm" :disabled="!playerDiagLog.exists" @click="openPlayerDiagLog">
            Open log
          </button>
          <span class="diag-log-path">{{
            playerDiagLog.exists ? playerDiagLog.path : 'No log written yet'
          }}</span>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Background quality probe"
        desc="Probe actual stream quality for all translations when opening an anime page (not just the selected one). Detects quality mismatches but may cause lag on slower connections."
      >
        <SettingsSwitch v-model="backgroundQualityProbe" />
      </SettingsRow>
      <SettingsRow
        label="Dump quality mismatches"
        desc="Probe the embed API for all translations in your downloaded anime and save a report of cases where the reported quality differs from actual stream quality."
      >
        <button
          class="btn btn-sm"
          :disabled="dumpingMismatches || mismatchCount === 0"
          @click="dumpMismatches"
        >
          {{ dumpingMismatches ? 'Saving...' : `Dump ${mismatchCount} mismatch(es)` }}
        </button>
      </SettingsRow>
      <SettingsRow v-if="dumpResult" stack>
        <div class="result-box">
          <div class="result-ok">Saved {{ dumpResult.count }} mismatch(es)</div>
          <div class="result-error-item">{{ dumpResult.path }}</div>
        </div>
      </SettingsRow>
      <SettingsRow stack>
        <template #text>
          <div class="sr-label">MP4 streaming-optimization check</div>
          <div class="sr-desc">
            After every video download or when an MP4 is opened in the player, the first ~64 KB are
            scanned for the MP4 box order. Streaming-optimized files (<code>moov</code> before
            <code>mdat</code>) are required to play while still downloading. If a non-faststart file
            is found, an example is shown below for inspection.
          </div>
        </template>
        <div class="mp4-actions">
          <button class="btn btn-sm" @click="refreshMp4Stats">Refresh</button>
          <button
            class="btn btn-sm"
            :disabled="!mp4Stats || mp4Stats.totalChecked === 0"
            @click="resetMp4Stats"
          >
            Reset
          </button>
        </div>
        <div
          v-if="mp4Stats"
          class="result-box"
          :class="{ 'has-errors': mp4Stats.nonFaststartSamples.length > 0 }"
        >
          <div class="result-ok">
            Faststart: {{ mp4Stats.faststartCount }} / {{ mp4Stats.totalChecked }}
          </div>
          <div v-if="latestNonFaststart" class="result-errors">
            <div>
              Sample non-faststart MP4 (most recent of {{ mp4Stats.nonFaststartSamples.length }}):
            </div>
            <div class="result-error-item">
              {{ latestNonFaststart.animeName }} — {{ latestNonFaststart.episodeLabel }} (first
              non-ftyp box: {{ latestNonFaststart.firstNonFtypBox }})
            </div>
            <div class="result-error-item" style="opacity: 0.7">
              {{ latestNonFaststart.filePath }}
            </div>
          </div>
        </div>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.mp4-actions {
  display: flex;
  gap: 8px;
}

.diag-log-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.diag-log-path {
  font-size: 12px;
  opacity: 0.7;
  word-break: break-all;
}

.result-ok.warn {
  color: var(--st-orange);
}
</style>
