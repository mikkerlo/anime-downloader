<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

const activeTab = ref<'general' | 'merging' | 'debug'>('general')

const token = ref('')
const translationType = ref('subRu')
const downloadDir = ref('')
const saved = ref(false)

const autoMerge = ref(false)
const videoCodec = ref('copy')
const ffmpeg = ref<{ available: boolean; version: string; path: string; encoders: string[] } | null>(null)

// Debug / scan-merge state
const scanMerging = ref(false)
const scanProgress = ref<{ current: number; total: number; file: string; percent: number } | null>(null)
const scanResult = ref<{ merged: number; failed: string[] } | null>(null)

function onScanProgress(data: ScanMergeProgress): void {
  scanProgress.value = data
}

async function scanAndMerge(): Promise<void> {
  scanMerging.value = true
  scanProgress.value = null
  scanResult.value = null
  try {
    const result = await window.api.downloadScanMerge()
    scanResult.value = result
  } catch (err) {
    scanResult.value = { merged: 0, failed: [String(err)] }
  } finally {
    scanMerging.value = false
    scanProgress.value = null
  }
}

onMounted(() => {
  window.api.onScanMergeProgress(onScanProgress)
})

onUnmounted(() => {
  window.api.offScanMergeProgress()
})

const TRANSLATION_TYPES = [
  { value: 'subRu', label: 'Russian Subtitles' },
  { value: 'subEn', label: 'English Subtitles' },
  { value: 'voiceRu', label: 'Russian Voice' },
  { value: 'voiceEn', label: 'English Voice' },
  { value: 'raw', label: 'RAW' }
]

const CODEC_OPTIONS: { value: string; label: string; encoder?: string }[] = [
  { value: 'copy', label: 'None (copy, fastest)' },
  { value: 'libx265', label: 'H.265 (CPU)', encoder: 'libx265' },
  { value: 'hevc_nvenc', label: 'H.265 (NVIDIA GPU)', encoder: 'hevc_nvenc' },
  { value: 'hevc_amf', label: 'H.265 (AMD GPU)', encoder: 'hevc_amf' },
  { value: 'hevc_qsv', label: 'H.265 (Intel QSV)', encoder: 'hevc_qsv' }
]

const availableCodecs = computed(() => {
  if (!ffmpeg.value) return [CODEC_OPTIONS[0]]
  return CODEC_OPTIONS.filter(c => !c.encoder || ffmpeg.value!.encoders.includes(c.encoder))
})

onMounted(async () => {
  token.value = (await window.api.getSetting('token') as string) || ''
  translationType.value = (await window.api.getSetting('translationType') as string) || 'subRu'
  downloadDir.value = (await window.api.getSetting('downloadDir') as string) || ''
  autoMerge.value = (await window.api.getSetting('autoMerge') as boolean) || false
  videoCodec.value = (await window.api.getSetting('videoCodec') as string) || 'copy'
  ffmpeg.value = await window.api.ffmpegCheck()

  // Reset codec if no longer available
  if (!availableCodecs.value.find(c => c.value === videoCodec.value)) {
    videoCodec.value = 'copy'
  }
})

async function pickDir(): Promise<void> {
  const dir = await window.api.downloadPickDir()
  if (dir) downloadDir.value = dir
}

async function save(): Promise<void> {
  await window.api.setSetting('token', token.value.trim())
  await window.api.setSetting('translationType', translationType.value)
  await window.api.setSetting('autoMerge', autoMerge.value)
  await window.api.setSetting('videoCodec', videoCodec.value)
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}
</script>

<template>
  <main class="settings-view">
    <header class="topbar">
      <h2>Settings</h2>
    </header>
    <div class="tabs">
      <button class="tab" :class="{ active: activeTab === 'general' }" @click="activeTab = 'general'">General</button>
      <button class="tab" :class="{ active: activeTab === 'merging' }" @click="activeTab = 'merging'">Merging</button>
      <button class="tab" :class="{ active: activeTab === 'debug' }" @click="activeTab = 'debug'">Debug</button>
    </div>
    <div class="body">
      <!-- General tab -->
      <template v-if="activeTab === 'general'">
        <div class="setting-group">
          <label class="setting-label" for="token-input">API Token</label>
          <p class="setting-hint">Token for smotret-anime.ru API access. Used for direct download links.</p>
          <input
            id="token-input"
            v-model="token"
            type="password"
            class="setting-input"
            placeholder="Enter your API token..."
          />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="tr-type">Default Translation Type</label>
          <p class="setting-hint">Default translation type when opening an anime.</p>
          <select id="tr-type" v-model="translationType" class="setting-input setting-select">
            <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
        </div>

        <div class="setting-group">
          <label class="setting-label">Download Directory</label>
          <p class="setting-hint">Where downloaded anime files are saved.</p>
          <div class="dir-row">
            <span class="dir-path">{{ downloadDir || 'Default (Downloads/anime-dl)' }}</span>
            <button class="browse-btn" @click="pickDir">Browse</button>
          </div>
        </div>
      </template>

      <!-- Merging tab -->
      <template v-if="activeTab === 'merging'">
        <div class="setting-group">
          <label class="setting-label">FFmpeg</label>
          <p class="setting-hint">Required for merging video + subtitles into MKV.</p>
          <div v-if="ffmpeg" class="ffmpeg-status" :class="{ ok: ffmpeg.available, missing: !ffmpeg.available }">
            <span v-if="ffmpeg.available" class="ffmpeg-ok">{{ ffmpeg.version }}</span>
            <span v-else class="ffmpeg-missing">Not found</span>
            <span v-if="ffmpeg.path" class="ffmpeg-path">{{ ffmpeg.path }}</span>
          </div>
          <div v-else class="ffmpeg-status">Checking...</div>
        </div>

        <div class="setting-group">
          <label class="setting-label">Auto-merge</label>
          <p class="setting-hint">Automatically merge video + subtitles into MKV when both finish downloading.</p>
          <label class="toggle-row" :class="{ disabled: !ffmpeg?.available }">
            <input type="checkbox" v-model="autoMerge" :disabled="!ffmpeg?.available" class="toggle-input" />
            <span class="toggle-slider"></span>
            <span class="toggle-label">{{ autoMerge ? 'Enabled' : 'Disabled' }}</span>
          </label>
        </div>

        <div class="setting-group">
          <label class="setting-label">Re-encode video</label>
          <p class="setting-hint">Re-encode video during merge. "None" copies the stream as-is (fastest). H.265 reduces file size but takes longer.</p>
          <select v-model="videoCodec" class="setting-input setting-select" :disabled="!ffmpeg?.available">
            <option v-for="c in availableCodecs" :key="c.value" :value="c.value">{{ c.label }}</option>
          </select>
        </div>
      </template>

      <!-- Debug tab -->
      <template v-if="activeTab === 'debug'">
        <div class="setting-group">
          <label class="setting-label">FFmpeg Info</label>
          <div v-if="ffmpeg" class="ffmpeg-status" :class="{ ok: ffmpeg.available, missing: !ffmpeg.available }">
            <span v-if="ffmpeg.available" class="ffmpeg-ok">{{ ffmpeg.version }}</span>
            <span v-else class="ffmpeg-missing">Not found</span>
            <span v-if="ffmpeg.path" class="ffmpeg-path">{{ ffmpeg.path }}</span>
            <span v-if="ffmpeg.encoders.length" class="ffmpeg-path">Encoders: {{ ffmpeg.encoders.join(', ') }}</span>
          </div>
          <div v-else class="ffmpeg-status">Checking...</div>
        </div>

        <div class="setting-group">
          <label class="setting-label">Merge all available</label>
          <p class="setting-hint">Scan all download folders for .mp4 files without matching .mkv and merge them with subtitles if available.</p>
          <button class="merge-all-btn" @click="scanAndMerge" :disabled="scanMerging || !ffmpeg?.available">
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

          <div v-if="scanResult" class="scan-result" :class="{ 'has-errors': scanResult.failed.length > 0 }">
            <div class="scan-result-ok">Merged: {{ scanResult.merged }} file(s)</div>
            <div v-if="scanResult.failed.length > 0" class="scan-result-errors">
              <div>Failed ({{ scanResult.failed.length }}):</div>
              <div v-for="(err, i) in scanResult.failed" :key="i" class="scan-error-item">{{ err }}</div>
            </div>
          </div>
        </div>
      </template>

      <button v-if="activeTab !== 'debug'" class="save-btn" @click="save">
        {{ saved ? 'Saved!' : 'Save' }}
      </button>
    </div>
  </main>
</template>

<style scoped>
.settings-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  padding: 16px 24px;
  border-bottom: 1px solid #0f3460;
}

.topbar h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #e0e0e0;
}

.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #0f3460;
  padding: 0 24px;
}

.tab {
  padding: 10px 20px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #6a6a8a;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.tab:hover {
  color: #a0a0b8;
}

.tab.active {
  color: #e94560;
  border-bottom-color: #e94560;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 600px;
}

.setting-group {
  margin-bottom: 20px;
}

.setting-label {
  display: block;
  font-size: 0.9rem;
  font-weight: 600;
  color: #e0e0e0;
  margin-bottom: 4px;
}

.setting-hint {
  font-size: 0.8rem;
  color: #6a6a8a;
  margin-bottom: 10px;
}

.setting-input {
  width: 100%;
  padding: 10px 14px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s;
}

.setting-input:focus {
  border-color: #e94560;
}

.setting-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.setting-select {
  cursor: pointer;
}

.dir-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dir-path {
  flex: 1;
  padding: 10px 14px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  color: #a0a0b8;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browse-btn {
  padding: 10px 16px;
  background-color: #0f3460;
  border: none;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s;
}

.browse-btn:hover {
  background-color: #1a4a7a;
}

.ffmpeg-status {
  padding: 10px 14px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  font-size: 0.85rem;
  color: #6a6a8a;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ffmpeg-status.ok { border-color: #2d6a30; }
.ffmpeg-status.missing { border-color: #e94560; }
.ffmpeg-ok { color: #6ab04c; font-weight: 600; }
.ffmpeg-missing { color: #e94560; font-weight: 600; }
.ffmpeg-path { font-size: 0.75rem; color: #4a4a6a; word-break: break-all; }

.toggle-row {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  user-select: none;
}

.toggle-row.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.toggle-input {
  display: none;
}

.toggle-slider {
  width: 40px;
  height: 22px;
  background-color: #0f3460;
  border-radius: 11px;
  position: relative;
  transition: background-color 0.2s;
  flex-shrink: 0;
}

.toggle-slider::after {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background-color: #6a6a8a;
  top: 3px;
  left: 3px;
  transition: all 0.2s;
}

.toggle-input:checked + .toggle-slider {
  background-color: #2d6a30;
}

.toggle-input:checked + .toggle-slider::after {
  background-color: #6ab04c;
  transform: translateX(18px);
}

.toggle-label {
  font-size: 0.85rem;
  color: #a0a0b8;
}

.save-btn {
  padding: 10px 28px;
  background-color: #e94560;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 0.9rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.save-btn:hover {
  background-color: #d63851;
}

.merge-all-btn {
  padding: 10px 20px;
  background-color: #6ab04c;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 0.9rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.merge-all-btn:hover {
  background-color: #5a9a3c;
}

.merge-all-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.scan-progress {
  margin-top: 12px;
  padding: 12px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
}

.scan-progress-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  color: #a0a0b8;
  margin-bottom: 6px;
}

.scan-progress .progress-bar-wrap {
  height: 6px;
  background-color: #0f3460;
  border-radius: 3px;
  overflow: hidden;
}

.scan-progress .progress-bar {
  height: 100%;
  background-color: #9b59b6;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.scan-progress-file {
  font-size: 0.75rem;
  color: #6a6a8a;
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scan-result {
  margin-top: 12px;
  padding: 12px;
  background-color: #16213e;
  border: 1px solid #2d6a30;
  border-radius: 8px;
}

.scan-result.has-errors {
  border-color: #e94560;
}

.scan-result-ok {
  font-size: 0.85rem;
  color: #6ab04c;
  font-weight: 600;
}

.scan-result-errors {
  margin-top: 8px;
  font-size: 0.8rem;
  color: #e94560;
}

.scan-error-item {
  font-size: 0.75rem;
  color: #a0a0b8;
  margin-top: 4px;
  word-break: break-all;
}
</style>
