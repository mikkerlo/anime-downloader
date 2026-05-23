<script setup lang="ts">
import { ref, watch, onMounted, onActivated, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useDownloadsStore } from '../../stores/downloads';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';

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

  void refreshMismatchCount();
  void refreshMp4Stats();

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
});

watch(backgroundQualityProbe, (val) => {
  if (loaded.value) autoSave('backgroundQualityProbe', val);
});
</script>

<template>
  <div>
    <div class="setting-group">
      <label class="setting-label">FFmpeg Info</label>
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
    </div>

    <div class="setting-group">
      <label class="setting-label">Merge all available</label>
      <p class="setting-hint">
        Scan all download folders for .mp4 files without matching .mkv and merge them with subtitles
        if available.
      </p>
      <button
        class="merge-all-btn"
        @click="scanAndMerge"
        :disabled="scanMerging || !ffmpeg?.available"
      >
        {{ scanMerging ? 'Merging...' : 'Merge all available' }}
      </button>

      <div v-if="scanProgress" class="scan-progress">
        <div class="scan-progress-header">
          <span>{{ scanProgress.current }} / {{ scanProgress.total }}</span>
          <span>{{ scanProgress.percent }}%</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar" :style="{ width: scanProgress.percent + '%' }"></div>
        </div>
        <div class="scan-progress-file">{{ scanProgress.file }}</div>
      </div>

      <div
        v-if="scanResult"
        class="scan-result"
        :class="{ 'has-errors': scanResult.failed.length > 0 }"
      >
        <div class="scan-result-ok">Merged: {{ scanResult.merged }} file(s)</div>
        <div v-if="scanResult.failed.length > 0" class="scan-result-errors">
          <div>Failed ({{ scanResult.failed.length }}):</div>
          <div v-for="(err, i) in scanResult.failed" :key="i" class="scan-error-item">
            {{ err }}
          </div>
        </div>
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Fix old files</label>
      <p class="setting-hint">
        Re-mux existing MKV files to set subtitle language, title (translator name), and default
        track. Uses stored episode metadata.
      </p>
      <button
        class="merge-all-btn"
        @click="fixMetadata"
        :disabled="fixingMetadata || !ffmpeg?.available"
      >
        {{ fixingMetadata ? 'Fixing...' : 'Fix subtitle metadata' }}
      </button>

      <div v-if="fixProgress" class="scan-progress">
        <div class="scan-progress-header">
          <span>{{ fixProgress.current }} / {{ fixProgress.total }}</span>
        </div>
        <div class="scan-progress-file">{{ fixProgress.file }}</div>
      </div>

      <div
        v-if="fixResult"
        class="scan-result"
        :class="{ 'has-errors': fixResult.failed.length > 0 }"
      >
        <div class="scan-result-ok">Fixed: {{ fixResult.fixed }} file(s)</div>
        <div v-if="fixResult.failed.length > 0" class="scan-result-errors">
          <div>Failed ({{ fixResult.failed.length }}):</div>
          <div v-for="(err, i) in fixResult.failed" :key="i" class="scan-error-item">
            {{ err }}
          </div>
        </div>
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Delete ffmpeg binaries</label>
      <p class="setting-hint">
        Remove downloaded ffmpeg/ffprobe binaries. They will be re-downloaded on next app launch
        (useful for testing the download progress indicator).
      </p>
      <button
        class="merge-all-btn"
        style="background-color: #e94560"
        @click="deleteFfmpeg"
        :disabled="!ffmpeg?.available"
      >
        Delete ffmpeg + ffprobe
      </button>
    </div>

    <div class="setting-group">
      <label class="setting-label">Anime4K GPU Benchmark</label>
      <p class="setting-hint">
        Test how fast your GPU can run Anime4K shaders (Mode A, 720p→screen resolution, 100 frames).
        Requires WebGPU.
      </p>
      <button class="merge-all-btn" @click="runGpuBenchmark" :disabled="benchmarking">
        {{ benchmarking ? 'Running benchmark...' : 'Run GPU benchmark' }}
      </button>

      <div v-if="benchmarkResult" class="scan-result">
        <div
          class="scan-result-ok"
          :style="{ color: benchmarkResult.fps >= 24 ? '#6ab04c' : '#f0932b' }"
        >
          {{ benchmarkResult.preset }}: {{ benchmarkResult.fps }} fps ({{
            benchmarkResult.avgMs
          }}ms/frame)
        </div>
        <div
          class="scan-error-item"
          :style="{ color: benchmarkResult.fps >= 24 ? '#6ab04c' : '#f0932b' }"
        >
          {{
            benchmarkResult.fps >= 24
              ? 'Your GPU can handle real-time Anime4K shaders'
              : 'Your GPU may struggle with real-time shaders — consider using "Off" preset'
          }}
        </div>
      </div>

      <div v-if="benchmarkError" class="scan-result has-errors">
        <div class="scan-result-errors">{{ benchmarkError }}</div>
      </div>

      <div v-if="webgpuStatus.available" class="status-line ok" style="margin-top: 8px">
        WebGPU: {{ webgpuStatus.gpuName }}
      </div>
      <div v-else class="status-line warn" style="margin-top: 8px">
        WebGPU not detected — benchmark will attempt to initialize it
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Background quality probe</label>
      <p class="setting-hint">
        Probe actual stream quality for all translations when opening an anime page (not just the
        selected one). Detects quality mismatches but may cause lag on slower connections.
      </p>
      <label class="toggle-row">
        <input type="checkbox" v-model="backgroundQualityProbe" class="toggle-input" />
        <span class="toggle-slider"></span>
        <span class="toggle-label">Enable background quality probe</span>
      </label>
    </div>

    <div class="setting-group">
      <label class="setting-label">Dump quality mismatches</label>
      <p class="setting-hint">
        Probe the embed API for all translations in your downloaded anime and save a report of cases
        where the reported quality differs from actual stream quality.
      </p>
      <button
        class="merge-all-btn"
        @click="dumpMismatches"
        :disabled="dumpingMismatches || mismatchCount === 0"
      >
        {{ dumpingMismatches ? 'Saving...' : `Dump ${mismatchCount} mismatch(es) to file` }}
      </button>

      <div v-if="dumpResult" class="scan-result">
        <div class="scan-result-ok" :style="{ color: '#6ab04c' }">
          Saved {{ dumpResult.count }} mismatch(es)
        </div>
        <div class="scan-error-item">{{ dumpResult.path }}</div>
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">MP4 streaming-optimization check</label>
      <p class="setting-hint">
        After every video download or when an MP4 is opened in the player, the first ~64 KB are
        scanned for the MP4 box order. Streaming-optimized files (<code>moov</code> before
        <code>mdat</code>) are required to play while still downloading. If a non-faststart file is
        found, an example is shown below for inspection.
      </p>
      <button class="merge-all-btn" @click="refreshMp4Stats">Refresh</button>
      <button
        class="merge-all-btn"
        style="margin-left: 0.5rem"
        @click="resetMp4Stats"
        :disabled="!mp4Stats || mp4Stats.totalChecked === 0"
      >
        Reset
      </button>

      <div
        v-if="mp4Stats"
        class="scan-result"
        :class="{ 'has-errors': mp4Stats.nonFaststartSamples.length > 0 }"
      >
        <div class="scan-result-ok">
          Faststart: {{ mp4Stats.faststartCount }} / {{ mp4Stats.totalChecked }}
        </div>
        <div v-if="latestNonFaststart" class="scan-result-errors">
          <div>
            Sample non-faststart MP4 (most recent of {{ mp4Stats.nonFaststartSamples.length }}):
          </div>
          <div class="scan-error-item">
            {{ latestNonFaststart.animeName }} — {{ latestNonFaststart.episodeLabel }} (first
            non-ftyp box: {{ latestNonFaststart.firstNonFtypBox }})
          </div>
          <div class="scan-error-item" style="opacity: 0.7">
            {{ latestNonFaststart.filePath }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>
