<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'

const activeTab = ref<'general' | 'merging' | 'shortcuts' | 'debug'>('general')

const token = ref('')
const translationType = ref('subRu')
const downloadDir = ref('')
const loaded = ref(false)
const savedVisible = ref(false)
let savedTimeout: ReturnType<typeof setTimeout> | null = null

const tokenStatus = ref<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
const tokenError = ref('')

// Update state
const appVersion = ref('')
const updateStatus = ref<{ status: string; version?: string; percent?: number; error?: string }>({ status: 'idle' })

const notificationMode = ref('off')
const autoMerge = ref(false)
const videoCodec = ref('copy')
const ffmpeg = ref<{ available: boolean; version: string; path: string; encoders: string[] } | null>(null)

// Debug / scan-merge state
const scanMerging = ref(false)
const scanProgress = ref<{ current: number; total: number; file: string; percent: number } | null>(null)
const scanResult = ref<{ merged: number; failed: string[] } | null>(null)

// Fix metadata state
const fixingMetadata = ref(false)
const fixProgress = ref<{ current: number; total: number; file: string } | null>(null)
const fixResult = ref<{ fixed: number; failed: string[] } | null>(null)

// Quality mismatch dump
const dumpingMismatches = ref(false)
const dumpResult = ref<{ count: number; path: string } | null>(null)
const mismatchCount = ref(0)

const DEFAULT_SHORTCUTS: Record<string, string> = {
  back: 'Escape',
  focusSearch: 'CmdOrCtrl+F',
  goDownloads: 'CmdOrCtrl+D'
}

const SHORTCUT_LABELS: Record<string, { label: string; hint: string }> = {
  back: { label: 'Go back', hint: 'Navigate back from anime detail view' },
  focusSearch: { label: 'Focus search', hint: 'Switch to Search tab and focus the input' },
  goDownloads: { label: 'Go to downloads', hint: 'Switch to Downloads tab' }
}

const shortcutBindings = ref<Record<string, string>>({})
const recordingAction = ref<string | null>(null)
const isMac = navigator.platform.toUpperCase().includes('MAC')

function formatBinding(binding: string): string {
  if (!binding) return 'None'
  return binding
    .replace(/CmdOrCtrl/g, isMac ? '\u2318' : 'Ctrl')
    .replace(/\+/g, isMac ? '' : '+')
}

function captureKey(e: KeyboardEvent): void {
  if (!recordingAction.value) return
  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    stopRecording()
    return
  }

  // Ignore bare modifier keys
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('CmdOrCtrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')

  const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key
  parts.push(keyName)

  shortcutBindings.value[recordingAction.value] = parts.join('+')
  stopRecording()
  saveShortcuts()
}

function startRecording(action: string): void {
  recordingAction.value = action
  window.addEventListener('keydown', captureKey, true)
}

function stopRecording(): void {
  recordingAction.value = null
  window.removeEventListener('keydown', captureKey, true)
}

function cancelRecording(): void {
  stopRecording()
}

function clearBinding(action: string): void {
  shortcutBindings.value[action] = ''
  saveShortcuts()
}

function resetShortcuts(): void {
  shortcutBindings.value = { ...DEFAULT_SHORTCUTS }
  saveShortcuts()
}

function saveShortcuts(): void {
  window.api.setSetting('keyboardShortcuts', { ...shortcutBindings.value })
  showSaved()
}

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

function onFixProgress(data: { current: number; total: number; file: string }): void {
  fixProgress.value = data
}

async function refreshMismatchCount(): Promise<void> {
  mismatchCount.value = await window.api.getQualityMismatchCount()
}

async function dumpMismatches(): Promise<void> {
  dumpingMismatches.value = true
  dumpResult.value = null
  try {
    dumpResult.value = await window.api.dumpQualityMismatches()
  } catch (err) {
    dumpResult.value = { count: -1, path: String(err) }
  } finally {
    dumpingMismatches.value = false
  }
}

async function deleteFfmpeg(): Promise<void> {
  await window.api.ffmpegDelete()
  ffmpeg.value = await window.api.ffmpegCheck()
}

async function fixMetadata(): Promise<void> {
  fixingMetadata.value = true
  fixProgress.value = null
  fixResult.value = null
  try {
    const result = await window.api.downloadFixMetadata()
    fixResult.value = result
  } catch (err) {
    fixResult.value = { fixed: 0, failed: [String(err)] }
  } finally {
    fixingMetadata.value = false
    fixProgress.value = null
  }
}

function onUpdateStatus(data: UpdateStatus): void {
  updateStatus.value = data
}

async function checkForUpdates(): Promise<void> {
  updateStatus.value = { status: 'checking' }
  try {
    await window.api.updateCheck()
  } catch {
    updateStatus.value = { status: 'error', error: 'Failed to check for updates' }
  }
}

async function downloadUpdate(): Promise<void> {
  try {
    await window.api.updateDownload()
  } catch {
    updateStatus.value = { status: 'error', error: 'Failed to download update' }
  }
}

function installUpdate(): void {
  window.api.updateInstall()
}

onMounted(async () => {
  window.api.onScanMergeProgress(onScanProgress)
  window.api.onFixMetadataProgress(onFixProgress)
  window.api.onUpdateStatus(onUpdateStatus)
  refreshMismatchCount()

  appVersion.value = await window.api.appVersion()
})

onUnmounted(() => {
  window.api.offScanMergeProgress()
  window.api.offFixMetadataProgress()
  window.api.offUpdateStatus()
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
  { value: 'hevc_qsv', label: 'H.265 (Intel QSV)', encoder: 'hevc_qsv' },
  { value: 'hevc_videotoolbox', label: 'H.265 (macOS VideoToolbox)', encoder: 'hevc_videotoolbox' }
]

const availableCodecs = computed(() => {
  if (!ffmpeg.value) return [CODEC_OPTIONS[0]]
  return CODEC_OPTIONS.filter(c => !c.encoder || ffmpeg.value!.encoders.includes(c.encoder))
})

onMounted(async () => {
  token.value = (await window.api.getSetting('token') as string) || ''
  translationType.value = (await window.api.getSetting('translationType') as string) || 'subRu'
  downloadDir.value = (await window.api.getSetting('downloadDir') as string) || ''
  notificationMode.value = (await window.api.getSetting('notificationMode') as string) || 'off'
  autoMerge.value = (await window.api.getSetting('autoMerge') as boolean) || false
  videoCodec.value = (await window.api.getSetting('videoCodec') as string) || 'copy'
  ffmpeg.value = await window.api.ffmpegCheck()

  // Reset codec if no longer available
  if (!availableCodecs.value.find(c => c.value === videoCodec.value)) {
    videoCodec.value = 'copy'
  }

  const saved = (await window.api.getSetting('keyboardShortcuts')) as Record<string, string> | null
  shortcutBindings.value = saved ? { ...DEFAULT_SHORTCUTS, ...saved } : { ...DEFAULT_SHORTCUTS }

  loaded.value = true
})

async function pickDir(): Promise<void> {
  const dir = await window.api.downloadPickDir()
  if (dir) {
    downloadDir.value = dir
    autoSave('downloadDir', dir)
  }
}

function showSaved(): void {
  savedVisible.value = true
  if (savedTimeout) clearTimeout(savedTimeout)
  savedTimeout = setTimeout(() => { savedVisible.value = false }, 1500)
}

function autoSave(key: string, value: string | boolean): void {
  window.api.setSetting(key, value)
  showSaved()
}

async function testToken(): Promise<void> {
  tokenStatus.value = 'checking'
  tokenError.value = ''
  try {
    const result = await window.api.validateToken()
    if (result.valid) {
      tokenStatus.value = 'valid'
    } else {
      tokenStatus.value = 'invalid'
      tokenError.value = result.error || 'Invalid token'
    }
  } catch (err) {
    tokenStatus.value = 'invalid'
    tokenError.value = String(err)
  }
}

// Debounced watcher for token (user typing)
let tokenTimer: ReturnType<typeof setTimeout> | null = null
watch(token, (val) => {
  if (!loaded.value) return
  tokenStatus.value = 'idle'
  if (tokenTimer) clearTimeout(tokenTimer)
  tokenTimer = setTimeout(() => autoSave('token', val.trim()), 800)
})

// Immediate watchers for dropdowns/toggles
watch(translationType, (val) => { if (loaded.value) autoSave('translationType', val) })
watch(notificationMode, (val) => { if (loaded.value) autoSave('notificationMode', val) })
watch(autoMerge, (val) => { if (loaded.value) autoSave('autoMerge', val) })
watch(videoCodec, (val) => { if (loaded.value) autoSave('videoCodec', val) })
</script>

<template>
  <main class="settings-view">
    <header class="topbar">
      <h2>Settings</h2>
    </header>
    <div class="tabs">
      <button class="tab" :class="{ active: activeTab === 'general' }" @click="activeTab = 'general'">General</button>
      <button class="tab" :class="{ active: activeTab === 'merging' }" @click="activeTab = 'merging'">Merging</button>
      <button class="tab" :class="{ active: activeTab === 'shortcuts' }" @click="activeTab = 'shortcuts'">Shortcuts</button>
      <button class="tab" :class="{ active: activeTab === 'debug' }" @click="activeTab = 'debug'; refreshMismatchCount()">Debug</button>
    </div>
    <div class="body">
      <!-- General tab -->
      <template v-if="activeTab === 'general'">
        <div class="setting-group">
          <label class="setting-label" for="token-input">API Token</label>
          <p class="setting-hint">Token for smotret-anime.ru API access. Used for direct download links.</p>
          <div class="token-row">
            <input
              id="token-input"
              v-model="token"
              type="password"
              class="setting-input"
              placeholder="Enter your API token..."
            />
            <button class="test-token-btn" :disabled="!token || tokenStatus === 'checking'" @click="testToken">
              {{ tokenStatus === 'checking' ? 'Testing...' : 'Test' }}
            </button>
          </div>
          <div v-if="tokenStatus === 'valid'" class="token-result token-valid">Token is valid</div>
          <div v-if="tokenStatus === 'invalid'" class="token-result token-invalid">{{ tokenError }}</div>
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

        <div class="setting-group">
          <label class="setting-label" for="notif-mode">Notifications</label>
          <p class="setting-hint">Desktop notifications when downloads or merges complete (only when app is not focused).</p>
          <select id="notif-mode" v-model="notificationMode" class="setting-input setting-select">
            <option value="off">Off</option>
            <option value="each">Each Episode</option>
            <option value="queue">Queue Complete</option>
          </select>
        </div>

        <div class="setting-group">
          <label class="setting-label">Updates</label>
          <p class="setting-hint">Version {{ appVersion }}</p>

          <button
            v-if="updateStatus.status === 'idle' || updateStatus.status === 'up-to-date' || updateStatus.status === 'error'"
            class="test-token-btn"
            :disabled="updateStatus.status === 'checking'"
            @click="checkForUpdates"
          >
            Check for updates
          </button>

          <span v-else-if="updateStatus.status === 'checking'" class="setting-hint" style="margin-bottom: 0">Checking...</span>

          <div v-else-if="updateStatus.status === 'available'">
            <div class="token-result token-valid" style="margin-bottom: 8px">
              v{{ updateStatus.version }} available
            </div>
            <button class="browse-btn" @click="downloadUpdate">Download update</button>
          </div>

          <div v-else-if="updateStatus.status === 'downloading'" class="scan-progress">
            <div class="scan-progress-header">
              <span>Downloading update...</span>
              <span>{{ updateStatus.percent }}%</span>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar" :style="{ width: (updateStatus.percent || 0) + '%' }"></div>
            </div>
          </div>

          <div v-else-if="updateStatus.status === 'ready'">
            <button class="merge-all-btn" @click="installUpdate">
              Restart to update
            </button>
          </div>

          <div v-if="updateStatus.status === 'error'" class="token-result token-invalid" style="margin-top: 6px">
            {{ updateStatus.error }}
          </div>
          <div v-if="updateStatus.status === 'up-to-date'" class="token-result token-valid" style="margin-top: 6px">
            Up to date
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

      <!-- Shortcuts tab -->
      <template v-if="activeTab === 'shortcuts'">
        <div class="setting-group">
          <label class="setting-label">Keyboard Shortcuts</label>
          <p class="setting-hint">Click "Record" to set a new key, press Escape to cancel recording. Click "Clear" to disable a shortcut.</p>
        </div>

        <div v-for="(meta, action) in SHORTCUT_LABELS" :key="action" class="shortcut-row">
          <div class="shortcut-info">
            <span class="shortcut-action">{{ meta.label }}</span>
            <span class="shortcut-hint">{{ meta.hint }}</span>
          </div>
          <div class="shortcut-controls">
            <span v-if="recordingAction === action" class="shortcut-key recording">
              Press a key...
            </span>
            <span v-else class="shortcut-key" :class="{ empty: !shortcutBindings[action] }">
              {{ formatBinding(shortcutBindings[action]) }}
            </span>
            <button v-if="recordingAction === action" class="shortcut-btn" @click="cancelRecording">Cancel</button>
            <button v-else class="shortcut-btn" @click="startRecording(action)">Record</button>
            <button class="shortcut-btn shortcut-clear" @click="clearBinding(action)" :disabled="!shortcutBindings[action]">Clear</button>
          </div>
        </div>

        <div class="setting-group" style="margin-top: 16px">
          <button class="test-token-btn" @click="resetShortcuts">Reset to defaults</button>
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

        <div class="setting-group">
          <label class="setting-label">Fix old files</label>
          <p class="setting-hint">Re-mux existing MKV files to set subtitle language, title (translator name), and default track. Uses stored episode metadata.</p>
          <button class="merge-all-btn" @click="fixMetadata" :disabled="fixingMetadata || !ffmpeg?.available">
            {{ fixingMetadata ? 'Fixing...' : 'Fix subtitle metadata' }}
          </button>

          <div v-if="fixProgress" class="scan-progress">
            <div class="scan-progress-header">
              <span>{{ fixProgress.current }} / {{ fixProgress.total }}</span>
            </div>
            <div class="scan-progress-file">{{ fixProgress.file }}</div>
          </div>

          <div v-if="fixResult" class="scan-result" :class="{ 'has-errors': fixResult.failed.length > 0 }">
            <div class="scan-result-ok">Fixed: {{ fixResult.fixed }} file(s)</div>
            <div v-if="fixResult.failed.length > 0" class="scan-result-errors">
              <div>Failed ({{ fixResult.failed.length }}):</div>
              <div v-for="(err, i) in fixResult.failed" :key="i" class="scan-error-item">{{ err }}</div>
            </div>
          </div>
        </div>

        <div class="setting-group">
          <label class="setting-label">Delete ffmpeg binaries</label>
          <p class="setting-hint">Remove downloaded ffmpeg/ffprobe binaries. They will be re-downloaded on next app launch (useful for testing the download progress indicator).</p>
          <button class="merge-all-btn" style="background-color: #e94560;" @click="deleteFfmpeg" :disabled="!ffmpeg?.available">
            Delete ffmpeg + ffprobe
          </button>
        </div>

        <div class="setting-group">
          <label class="setting-label">Dump quality mismatches</label>
          <p class="setting-hint">Probe the embed API for all translations in your downloaded anime and save a report of cases where the reported quality differs from actual stream quality.</p>
          <button class="merge-all-btn" @click="dumpMismatches" :disabled="dumpingMismatches || mismatchCount === 0">
            {{ dumpingMismatches ? 'Saving...' : `Dump ${mismatchCount} mismatch(es) to file` }}
          </button>

          <div v-if="dumpResult" class="scan-result">
            <div class="scan-result-ok" :style="{ color: '#6ab04c' }">
              Saved {{ dumpResult.count }} mismatch(es)
            </div>
            <div class="scan-error-item">{{ dumpResult.path }}</div>
          </div>
        </div>
      </template>

    </div>
    <transition name="saved-fade">
      <div v-if="savedVisible" class="saved-toast">Saved</div>
    </transition>
  </main>
</template>

<style scoped>
.settings-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
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

.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.token-row .setting-input {
  flex: 1;
}

.test-token-btn {
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

.test-token-btn:hover {
  background-color: #1a4a7a;
}

.test-token-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.token-result {
  margin-top: 6px;
  font-size: 0.8rem;
  font-weight: 600;
}

.token-valid {
  color: #6ab04c;
}

.token-invalid {
  color: #e94560;
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

.saved-toast {
  position: absolute;
  bottom: 24px;
  right: 24px;
  padding: 8px 18px;
  background-color: #2d6a30;
  color: #6ab04c;
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: 8px;
  pointer-events: none;
}

.saved-fade-enter-active,
.saved-fade-leave-active {
  transition: opacity 0.3s;
}

.saved-fade-enter-from,
.saved-fade-leave-to {
  opacity: 0;
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

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  margin-bottom: 8px;
}

.shortcut-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.shortcut-action {
  font-size: 0.9rem;
  font-weight: 600;
  color: #e0e0e0;
}

.shortcut-hint {
  font-size: 0.75rem;
  color: #6a6a8a;
}

.shortcut-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 16px;
}

.shortcut-key {
  display: inline-block;
  min-width: 80px;
  text-align: center;
  padding: 6px 12px;
  background-color: #0f3460;
  border: 1px solid #1a4a7a;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
}

.shortcut-key.empty {
  color: #4a4a6a;
  font-weight: 400;
}

.shortcut-key.recording {
  border-color: #e94560;
  color: #e94560;
  animation: pulse-border 1s ease-in-out infinite;
  outline: none;
}

@keyframes pulse-border {
  0%, 100% { border-color: #e94560; }
  50% { border-color: #c0374d; }
}

.shortcut-btn {
  padding: 6px 12px;
  background-color: #0f3460;
  border: none;
  border-radius: 6px;
  color: #a0a0b8;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background-color 0.15s;
  white-space: nowrap;
}

.shortcut-btn:hover {
  background-color: #1a4a7a;
  color: #e0e0e0;
}

.shortcut-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.shortcut-clear {
  color: #e94560;
}
</style>
