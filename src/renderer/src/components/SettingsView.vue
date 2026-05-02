<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { formatBytes } from '../utils'

const activeTab = ref<'general' | 'storage' | 'connectors' | 'merging' | 'player' | 'shortcuts' | 'debug'>('general')

const token = ref('')
const translationType = ref('subRu')
const downloadDir = ref('')
const storageMode = ref<'simple' | 'advanced'>('simple')
const hotStorageDir = ref('')
const coldStorageDir = ref('')
const autoMoveToCold = ref(false)
const movingToCold = ref(false)
const moveProgress = ref<{ current: number; total: number; file: string } | null>(null)
const moveResult = ref<{ moved: number; failed: string[] } | null>(null)

// Storage usage + auto-cleanup state
const storageUsage = ref<StorageUsage | null>(null)
const usageScanning = ref(false)
const usageProgress = ref<{ scanned: number; total: number } | null>(null)
const expandedAnime = ref<Set<number>>(new Set())
const autoCleanupDays = ref(0)
const autoCleanupLastRun = ref<{ ranAt: number; deletedCount: number; freedBytes: number } | null>(null)
const cleanupLog = ref<CleanupLogEntry[]>([])
const cleanupRunning = ref(false)
const cleanupResult = ref<CleanupResult | null>(null)
const cleanupPending = ref<CleanupCandidate[] | null>(null)
const cleanupLogExpanded = ref(false)
const loaded = ref(false)
const savedVisible = ref(false)
let savedTimeout: ReturnType<typeof setTimeout> | null = null

const tokenStatus = ref<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
const tokenError = ref('')

// Update state
const appVersion = ref('')
const updateStatus = ref<{ status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number; error?: string }>({ status: 'idle' })

const notificationMode = ref('off')
const speedLimitPreset = ref('0')
const customSpeedLimit = ref(1)
const concurrentDownloads = ref(2)
const autoMerge = ref(false)
const enableLocalSkipDetection = ref(true)
const skipBackfillRunning = ref(false)
const skipBackfillResult = ref('')
const skipQueueStatus = ref<{ currentAnimeId: number | null; queueLength: number }>({ currentAnimeId: null, queueLength: 0 })
let skipQueuePollTimer: ReturnType<typeof setInterval> | null = null

const skipQueueStatusLabel = computed<string>(() => {
  const s = skipQueueStatus.value
  if (s.currentAnimeId === null && s.queueLength === 0) return ''
  const inFlight = s.currentAnimeId !== null ? 1 : 0
  const remaining = s.queueLength + inFlight
  return `Currently analyzing ${remaining} show${remaining === 1 ? '' : 's'}…`
})

async function refreshSkipQueueStatus(): Promise<void> {
  try {
    skipQueueStatus.value = await window.api.skipDetectorQueueStatus()
  } catch { /* ignore */ }
}

async function onBackfillSkipDetection(): Promise<void> {
  if (skipBackfillRunning.value) return
  skipBackfillRunning.value = true
  skipBackfillResult.value = ''
  try {
    const r = await window.api.skipDetectorBackfillAll()
    const parts: string[] = []
    parts.push(`Queued ${r.queued} of ${r.total} downloaded shows.`)
    if (r.alreadyAnalyzed > 0) parts.push(`${r.alreadyAnalyzed} already analyzed.`)
    if (r.skippedFewEpisodes > 0) parts.push(`${r.skippedFewEpisodes} skipped (need ≥2 episodes).`)
    skipBackfillResult.value = parts.join(' ')
    await refreshSkipQueueStatus()
  } catch (err) {
    skipBackfillResult.value = `Backfill failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    skipBackfillRunning.value = false
  }
}
const videoCodec = ref('copy')
const ffmpeg = ref<{ available: boolean; version: string; path: string; encoders: string[] } | null>(null)

// HEVC playback decoder availability. On Linux stock Chromium builds ship no HEVC
// decoder, so merging to H.265 produces files the built-in player can't play.
// Windows (Media Foundation) and macOS (VideoToolbox) generally work.
//
// Probe via HTMLVideoElement.canPlayType rather than MediaSource.isTypeSupported:
// merged H.265 MP4s play through a plain <video src="…"> element, not MSE, and
// the two support surfaces can diverge. Using canPlayType matches what the
// built-in player will actually attempt when opening a merged file.
const hevcPlaybackSupported = (() => {
  if (typeof document === 'undefined') return false
  const v = document.createElement('video')
  const probes = [
    'video/mp4; codecs="hvc1.1.6.L120.B0"',
    'video/mp4; codecs="hvc1.2.4.L120.B0"',
    'video/mp4; codecs="hev1.1.6.L120.B0"',
    'video/mp4; codecs="hev1.2.4.L120.B0"'
  ]
  return probes.some((p) => v.canPlayType(p) !== '')
})()

// `hevcTranscodeOnPlay` gates the MKV-via-MSE path, which negotiates codecs
// through `MediaSource.isTypeSupported`. That surface can reject HEVC even when
// `canPlayType` above accepts it (Chromium's platform HEVC path is reachable
// through <video src> but not always through MSE). Probe MSE separately so we
// only disable the dropdown when the fallback truly can't fire.
const hevcMseSupported = (() => {
  if (typeof window === 'undefined' || typeof MediaSource === 'undefined') return false
  const probes = [
    'video/mp4; codecs="hvc1.1.6.L120.B0"',
    'video/mp4; codecs="hvc1.2.4.L120.B0"',
    'video/mp4; codecs="hev1.1.6.L120.B0"',
    'video/mp4; codecs="hev1.2.4.L120.B0"'
  ]
  return probes.some((p) => MediaSource.isTypeSupported(p))
})()

const backgroundQualityProbe = ref(false)

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

// Shikimori state
const shikimoriUser = ref<ShikiUser | null>(null)
const shikimoriAuthUrl = ref('')
const shikimoriCode = ref('')
const shikimoriConnecting = ref(false)
const shikimoriError = ref('')
const shikimoriShowUrl = ref(false)

// Player settings
const playerMode = ref<'system' | 'builtin'>('system')
const anime4kPreset = ref<'off' | 'mode-a' | 'mode-b' | 'mode-c'>('off')
const hevcTranscodeOnPlay = ref<'ask' | 'always' | 'never'>('ask')
const webgpuStatus = ref<{ available: boolean; gpuName: string }>({ available: false, gpuName: '' })

// GPU benchmark state
const benchmarking = ref(false)
const benchmarkResult = ref<{ preset: string; fps: number; avgMs: number } | null>(null)
const benchmarkError = ref('')

const DEFAULT_SHORTCUTS: Record<string, string> = {
  back: 'Escape',
  focusSearch: 'CmdOrCtrl+F',
  goDownloads: 'CmdOrCtrl+D',
  playerPrevEpisode: 'Shift+ArrowLeft',
  playerNextEpisode: 'Shift+ArrowRight',
  shaderModeA: 'CmdOrCtrl+1',
  shaderModeB: 'CmdOrCtrl+2',
  shaderModeC: 'CmdOrCtrl+3',
  shaderOff: 'CmdOrCtrl+Backquote'
}

const SHORTCUT_LABELS: Record<string, { label: string; hint: string }> = {
  back: { label: 'Go back', hint: 'Navigate back from anime detail view' },
  focusSearch: { label: 'Focus search', hint: 'Switch to Search tab and focus the input' },
  goDownloads: { label: 'Go to downloads', hint: 'Switch to Downloads tab' },
  playerPrevEpisode: { label: 'Previous episode', hint: 'Go to previous episode in the built-in player' },
  playerNextEpisode: { label: 'Next episode', hint: 'Go to next episode in the built-in player' },
  shaderModeA: { label: 'Shader: Mode A', hint: 'Switch to Anime4K Mode A in player' },
  shaderModeB: { label: 'Shader: Mode B', hint: 'Switch to Anime4K Mode B in player' },
  shaderModeC: { label: 'Shader: Mode C', hint: 'Switch to Anime4K Mode C in player' },
  shaderOff: { label: 'Shader: Off', hint: 'Disable Anime4K shaders in player' }
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

async function runGpuBenchmark(): Promise<void> {
  benchmarking.value = true
  benchmarkResult.value = null
  benchmarkError.value = ''

  try {
    if (!navigator.gpu) throw new Error('WebGPU not available')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('No GPU adapter found')
    const device = await adapter.requestDevice()

    const { ModeA } = await import('anime4k-webgpu')

    // Use 720p as source, upscale to actual screen resolution
    const SRC_WIDTH = 1280
    const SRC_HEIGHT = 720
    const targetWidth = window.screen.width
    const targetHeight = window.screen.height
    const testTexture = device.createTexture({
      size: [SRC_WIDTH, SRC_HEIGHT, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    })

    const pipeline = new ModeA({
      device,
      inputTexture: testTexture,
      nativeDimensions: { width: SRC_WIDTH, height: SRC_HEIGHT },
      targetDimensions: { width: targetWidth, height: targetHeight }
    })

    // Warm up (5 frames)
    for (let i = 0; i < 5; i++) {
      const enc = device.createCommandEncoder()
      pipeline.pass(enc)
      device.queue.submit([enc.finish()])
    }
    await device.queue.onSubmittedWorkDone()

    // Benchmark 100 frames
    const FRAMES = 100
    const start = performance.now()
    for (let i = 0; i < FRAMES; i++) {
      const enc = device.createCommandEncoder()
      pipeline.pass(enc)
      device.queue.submit([enc.finish()])
    }
    await device.queue.onSubmittedWorkDone()
    const elapsed = performance.now() - start

    const avgMs = elapsed / FRAMES
    const fps = 1000 / avgMs

    benchmarkResult.value = { preset: `Mode A (720p→${targetHeight}p)`, fps: Math.round(fps * 10) / 10, avgMs: Math.round(avgMs * 100) / 100 }
    device.destroy()
  } catch (e) {
    benchmarkError.value = String(e)
  } finally {
    benchmarking.value = false
  }
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

function onMoveProgress(data: { current: number; total: number; file: string }): void {
  moveProgress.value = data
}

async function pickHotDir(): Promise<void> {
  const dir = await window.api.storagePickHotDir()
  if (dir) {
    hotStorageDir.value = dir
    showSaved()
  }
}

async function pickColdDir(): Promise<void> {
  const dir = await window.api.storagePickColdDir()
  if (dir) {
    coldStorageDir.value = dir
    showSaved()
  }
}

async function moveToCold(): Promise<void> {
  movingToCold.value = true
  moveProgress.value = null
  moveResult.value = null
  try {
    const result = await window.api.storageMoveToCold()
    moveResult.value = result
  } catch (err) {
    moveResult.value = { moved: 0, failed: [String(err)] }
  } finally {
    movingToCold.value = false
    moveProgress.value = null
  }
}

async function refreshStorageUsage(): Promise<void> {
  if (usageScanning.value) return
  usageScanning.value = true
  usageProgress.value = null
  try {
    storageUsage.value = await window.api.storageGetUsage()
  } catch (err) {
    console.error('storage:get-usage failed', err)
  } finally {
    usageScanning.value = false
    usageProgress.value = null
  }
}

function toggleAnimeExpand(animeId: number): void {
  const next = new Set(expandedAnime.value)
  if (next.has(animeId)) next.delete(animeId)
  else next.add(animeId)
  expandedAnime.value = next
}

async function deleteEpisode(animeName: string, episodeInt: string, animeId: number): Promise<void> {
  await window.api.fileDeleteEpisode(animeName, episodeInt, animeId)
  await refreshStorageUsage()
}

async function runCleanupNow(): Promise<void> {
  if (cleanupRunning.value) return
  cleanupRunning.value = true
  cleanupResult.value = null
  try {
    const result = await window.api.storageRunCleanup()
    if (result.deletedCount > 0 || result.items.length === 0) {
      cleanupResult.value = result
      autoCleanupLastRun.value = { ranAt: result.ranAt, deletedCount: result.deletedCount, freedBytes: result.freedBytes }
      await reloadCleanupLog()
      await refreshStorageUsage()
    }
    // If candidates exist + confirm gate is up, main broadcasts
    // storage:cleanup-pending instead — handled by onCleanupPending below.
  } catch (err) {
    console.error('storage:run-cleanup failed', err)
  } finally {
    cleanupRunning.value = false
  }
}

async function confirmCleanup(): Promise<void> {
  if (!cleanupPending.value) return
  await window.api.setSetting('autoCleanupConfirm', false)
  cleanupPending.value = null
  cleanupRunning.value = true
  try {
    const result = await window.api.storageRunCleanup({ force: true })
    cleanupResult.value = result
    autoCleanupLastRun.value = { ranAt: result.ranAt, deletedCount: result.deletedCount, freedBytes: result.freedBytes }
    await reloadCleanupLog()
    await refreshStorageUsage()
  } finally {
    cleanupRunning.value = false
  }
}

function dismissCleanupPending(): void {
  cleanupPending.value = null
}

async function reloadCleanupLog(): Promise<void> {
  const log = (await window.api.getSetting('cleanupLog')) as CleanupLogEntry[] | null
  cleanupLog.value = log || []
}

function onUsageProgress(data: { scanned: number; total: number }): void {
  usageProgress.value = data
}

function onCleanupPending(data: { candidates: CleanupCandidate[] }): void {
  cleanupPending.value = data.candidates
}

function onCleanupFinished(data: CleanupResult): void {
  cleanupResult.value = data
  autoCleanupLastRun.value = { ranAt: data.ranAt, deletedCount: data.deletedCount, freedBytes: data.freedBytes }
  reloadCleanupLog()
}

function formatRelativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 0) return 'in the future'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  const yr = Math.floor(day / 365)
  return `${yr}y ago`
}

onMounted(async () => {
  window.api.onScanMergeProgress(onScanProgress)
  window.api.onFixMetadataProgress(onFixProgress)
  window.api.onUpdateStatus(onUpdateStatus)
  window.api.onStorageMoveToColdProgress(onMoveProgress)
  window.api.onStorageUsageProgress(onUsageProgress)
  window.api.onStorageCleanupPending(onCleanupPending)
  window.api.onStorageCleanupFinished(onCleanupFinished)
  refreshMismatchCount()
  refreshSkipQueueStatus()
  // Poll the skip-detector queue while the Settings page is open so the
  // status line decrements as the backfill drains. 4 s is fine — analyses
  // take 30+ s each.
  skipQueuePollTimer = setInterval(refreshSkipQueueStatus, 4000)

  appVersion.value = await window.api.appVersion()
})

onUnmounted(() => {
  window.api.offScanMergeProgress()
  window.api.offFixMetadataProgress()
  window.api.offUpdateStatus()
  window.api.offStorageMoveToColdProgress()
  window.api.offStorageUsageProgress()
  window.api.offStorageCleanupPending()
  window.api.offStorageCleanupFinished()
  if (skipQueuePollTimer) {
    clearInterval(skipQueuePollTimer)
    skipQueuePollTimer = null
  }
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
  storageMode.value = (await window.api.getSetting('storageMode') as 'simple' | 'advanced') || 'simple'
  hotStorageDir.value = (await window.api.getSetting('hotStorageDir') as string) || ''
  coldStorageDir.value = (await window.api.getSetting('coldStorageDir') as string) || ''
  autoMoveToCold.value = (await window.api.getSetting('autoMoveToCold') as boolean) || false
  notificationMode.value = (await window.api.getSetting('notificationMode') as string) || 'off'
  concurrentDownloads.value = (await window.api.getSetting('concurrentDownloads') as number) || 2
  const savedSpeedLimit = (await window.api.getSetting('downloadSpeedLimit') as number) || 0
  const PRESETS = [0, 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024]
  if (PRESETS.includes(savedSpeedLimit)) {
    speedLimitPreset.value = String(savedSpeedLimit)
  } else {
    speedLimitPreset.value = 'custom'
    customSpeedLimit.value = Math.round(savedSpeedLimit / (1024 * 1024) * 10) / 10
  }
  autoMerge.value = (await window.api.getSetting('autoMerge') as boolean) || false
  const skipSetting = await window.api.getSetting('enableLocalSkipDetection')
  enableLocalSkipDetection.value = skipSetting === undefined ? true : Boolean(skipSetting)
  backgroundQualityProbe.value = (await window.api.getSetting('backgroundQualityProbe') as boolean) || false
  videoCodec.value = (await window.api.getSetting('videoCodec') as string) || 'copy'
  ffmpeg.value = await window.api.ffmpegCheck()

  // Reset codec if no longer available
  if (!availableCodecs.value.find(c => c.value === videoCodec.value)) {
    videoCodec.value = 'copy'
  }

  const saved = (await window.api.getSetting('keyboardShortcuts')) as Record<string, string> | null
  shortcutBindings.value = saved ? { ...DEFAULT_SHORTCUTS, ...saved } : { ...DEFAULT_SHORTCUTS }

  shikimoriUser.value = await window.api.shikimoriGetUser()

  // Player settings
  playerMode.value = ((await window.api.getSetting('playerMode')) as string as typeof playerMode.value) || 'system'
  anime4kPreset.value = ((await window.api.getSetting('anime4kPreset')) as string as typeof anime4kPreset.value) || 'off'
  hevcTranscodeOnPlay.value = ((await window.api.getSetting('hevcTranscodeOnPlay')) as string as typeof hevcTranscodeOnPlay.value) || 'ask'

  // Storage cleanup settings
  autoCleanupDays.value = ((await window.api.getSetting('autoCleanupWatchedDays')) as number) || 0
  autoCleanupLastRun.value = (await window.api.getSetting('autoCleanupLastRun')) as { ranAt: number; deletedCount: number; freedBytes: number } | null
  await reloadCleanupLog()

  // Probe WebGPU
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter()
      if (adapter) {
        const info = adapter.info
        webgpuStatus.value = {
          available: true,
          gpuName: info.device || info.description || info.vendor || 'Unknown GPU'
        }
      }
    }
  } catch { /* WebGPU not available */ }

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

function autoSave(key: string, value: string | boolean | number): void {
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

async function shikimoriConnect(): Promise<void> {
  shikimoriAuthUrl.value = await window.api.shikimoriGetAuthUrl()
  const opened = await window.api.shellOpenExternal(shikimoriAuthUrl.value)
  shikimoriShowUrl.value = !opened
}

function shikimoriCopyUrl(): void {
  navigator.clipboard.writeText(shikimoriAuthUrl.value)
}

async function shikimoriSubmitCode(): Promise<void> {
  const code = shikimoriCode.value.trim()
  if (!code) return
  shikimoriConnecting.value = true
  shikimoriError.value = ''
  try {
    shikimoriUser.value = await window.api.shikimoriExchangeCode(code)
    shikimoriCode.value = ''
    shikimoriAuthUrl.value = ''
  } catch (err) {
    shikimoriError.value = String(err)
  } finally {
    shikimoriConnecting.value = false
  }
}

async function shikimoriDisconnect(): Promise<void> {
  await window.api.shikimoriLogout()
  shikimoriUser.value = null
  shikimoriAuthUrl.value = ''
  shikimoriCode.value = ''
  shikimoriError.value = ''
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
watch(concurrentDownloads, (val) => { if (loaded.value) autoSave('concurrentDownloads', val) })
watch(speedLimitPreset, (val) => {
  if (!loaded.value) return
  if (val !== 'custom') {
    window.api.setSetting('downloadSpeedLimit', Number(val))
    showSaved()
  } else {
    window.api.setSetting('downloadSpeedLimit', Math.round(customSpeedLimit.value * 1024 * 1024))
    showSaved()
  }
})
watch(customSpeedLimit, (val) => {
  if (!loaded.value || speedLimitPreset.value !== 'custom') return
  window.api.setSetting('downloadSpeedLimit', Math.round(val * 1024 * 1024))
  showSaved()
})
watch(storageMode, (val) => { if (loaded.value) autoSave('storageMode', val) })
watch(autoMoveToCold, (val) => { if (loaded.value) autoSave('autoMoveToCold', val) })
watch(autoMerge, (val) => { if (loaded.value) autoSave('autoMerge', val) })
watch(enableLocalSkipDetection, (val) => { if (loaded.value) autoSave('enableLocalSkipDetection', val) })
watch(backgroundQualityProbe, (val) => { if (loaded.value) autoSave('backgroundQualityProbe', val) })
let suppressVideoCodecSave = false
watch(videoCodec, (val, oldVal) => {
  if (!loaded.value) return
  // Re-entrant call from reverting the value below — skip both the confirm
  // and the autoSave so we don't flash a "Saved" toast for a no-op change.
  if (suppressVideoCodecSave) {
    suppressVideoCodecSave = false
    return
  }
  const isHevc = val.startsWith('libx265') || val.startsWith('hevc_')
  const wasHevc = oldVal.startsWith('libx265') || oldVal.startsWith('hevc_')
  // Only ask for confirmation on platforms without a working HEVC decoder —
  // on Windows/macOS the merged file plays back fine and the prompt is noise.
  if (isHevc && !wasHevc && !hevcPlaybackSupported) {
    const confirmed = window.confirm(
      'This platform has no HEVC (H.265) decoder available for playback.\n\n' +
        'Files merged with H.265 will save disk space, but the built-in player will not be able to ' +
        'decode them — you\'ll get audio with a black video, and will need an external player (VLC/mpv) ' +
        'to watch them.\n\n' +
        'Continue with H.265?'
    )
    if (!confirmed) {
      suppressVideoCodecSave = true
      videoCodec.value = oldVal
      return
    }
  }
  autoSave('videoCodec', val)
})
watch(playerMode, (val) => { if (loaded.value) autoSave('playerMode', val) })
watch(anime4kPreset, (val) => { if (loaded.value) autoSave('anime4kPreset', val) })
watch(hevcTranscodeOnPlay, (val) => { if (loaded.value) autoSave('hevcTranscodeOnPlay', val) })
watch(autoCleanupDays, (val) => { if (loaded.value) autoSave('autoCleanupWatchedDays', Number(val) || 0) })
</script>

<template>
  <main class="settings-view">
    <header class="topbar">
      <h2>Settings</h2>
    </header>
    <div class="tabs">
      <button class="tab" :class="{ active: activeTab === 'general' }" @click="activeTab = 'general'">General</button>
      <button class="tab" :class="{ active: activeTab === 'storage' }" @click="activeTab = 'storage'">Storage</button>
      <button class="tab" :class="{ active: activeTab === 'connectors' }" @click="activeTab = 'connectors'">Connectors</button>
      <button class="tab" :class="{ active: activeTab === 'merging' }" @click="activeTab = 'merging'">Merging</button>
      <button class="tab" :class="{ active: activeTab === 'player' }" @click="activeTab = 'player'">Player</button>
      <button class="tab" :class="{ active: activeTab === 'shortcuts' }" @click="activeTab = 'shortcuts'">Shortcuts</button>
      <button class="tab" :class="{ active: activeTab === 'debug' }" @click="activeTab = 'debug'; refreshMismatchCount()">Debug</button>
    </div>
    <div class="body">
      <!-- General tab -->
      <template v-if="activeTab === 'general'">
        <div class="setting-group">
          <label class="setting-label" for="tr-type">Default Translation Type</label>
          <p class="setting-hint">Default translation type when opening an anime.</p>
          <select id="tr-type" v-model="translationType" class="setting-input setting-select">
            <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
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
          <label class="setting-label" for="speed-limit">Download Speed Limit</label>
          <p class="setting-hint">Limit download bandwidth. The limit is shared across all active downloads.</p>
          <select id="speed-limit" v-model="speedLimitPreset" class="setting-input setting-select">
            <option value="0">Unlimited</option>
            <option :value="String(1024 * 1024)">1 MB/s</option>
            <option :value="String(5 * 1024 * 1024)">5 MB/s</option>
            <option :value="String(10 * 1024 * 1024)">10 MB/s</option>
            <option value="custom">Custom</option>
          </select>
          <div v-if="speedLimitPreset === 'custom'" class="custom-speed-row">
            <input
              v-model.number="customSpeedLimit"
              type="number"
              min="0.1"
              step="0.1"
              class="setting-input speed-input"
            />
            <span class="speed-unit">MB/s</span>
          </div>
        </div>

        <div class="setting-group">
          <label class="setting-label" for="concurrent-dl">Concurrent Downloads</label>
          <p class="setting-hint">Maximum number of simultaneous downloads.</p>
          <select id="concurrent-dl" v-model.number="concurrentDownloads" class="setting-input setting-select">
            <option :value="1">1</option>
            <option :value="2">2</option>
            <option :value="3">3</option>
          </select>
        </div>

        <div class="setting-group">
          <label class="setting-label">Updates</label>
          <p class="setting-hint">Version {{ appVersion }}</p>

          <button
            v-if="updateStatus.status === 'idle' || updateStatus.status === 'up-to-date' || updateStatus.status === 'error'"
            class="test-token-btn"
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

      <!-- Storage tab -->
      <template v-if="activeTab === 'storage'">
        <div class="setting-group">
          <label class="setting-label">Storage Mode</label>
          <p class="setting-hint">Simple mode uses a single directory. Advanced mode separates active downloads (hot) from finished files (cold).</p>
          <div class="storage-mode-toggle">
            <button
              class="mode-btn"
              :class="{ active: storageMode === 'simple' }"
              @click="storageMode = 'simple'"
            >Simple</button>
            <button
              class="mode-btn"
              :class="{ active: storageMode === 'advanced' }"
              @click="storageMode = 'advanced'"
            >Advanced</button>
          </div>
        </div>

        <template v-if="storageMode === 'simple'">
          <div class="setting-group">
            <label class="setting-label">Download Directory</label>
            <p class="setting-hint">Where downloaded anime files are saved.</p>
            <div class="dir-row">
              <span class="dir-path">{{ downloadDir || 'Default (Downloads/anime-dl)' }}</span>
              <button class="browse-btn" @click="pickDir">Browse</button>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="setting-group">
            <label class="setting-label">Hot Storage (Active Downloads)</label>
            <p class="setting-hint">Where new downloads and in-progress files are saved.</p>
            <div class="dir-row">
              <span class="dir-path">{{ hotStorageDir || 'Default (Downloads/anime-dl)' }}</span>
              <button class="browse-btn" @click="pickHotDir">Browse</button>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">Cold Storage (Finished Files)</label>
            <p class="setting-hint">Where completed files are moved for long-term storage.</p>
            <div class="dir-row">
              <span class="dir-path" :class="{ 'dir-warning': !coldStorageDir }">{{ coldStorageDir || 'Not set' }}</span>
              <button class="browse-btn" @click="pickColdDir">Browse</button>
            </div>
            <div v-if="!coldStorageDir" class="token-result token-invalid">Cold storage directory must be set in advanced mode.</div>
            <div v-if="coldStorageDir && coldStorageDir === hotStorageDir" class="token-result token-invalid">Cold storage must be different from hot storage.</div>
          </div>

          <div class="setting-group">
            <label class="setting-label">Auto-move to cold storage</label>
            <p class="setting-hint">Automatically move finished files to cold storage after download (or merge, if enabled).</p>
            <label class="toggle-row" :class="{ disabled: !coldStorageDir }">
              <input type="checkbox" v-model="autoMoveToCold" :disabled="!coldStorageDir" class="toggle-input" />
              <span class="toggle-slider"></span>
              <span class="toggle-label">{{ autoMoveToCold ? 'Enabled' : 'Disabled' }}</span>
            </label>
          </div>

          <div class="setting-group">
            <label class="setting-label">Move all to cold storage</label>
            <p class="setting-hint">Move all finished files from hot to cold storage now.</p>
            <button
              class="merge-all-btn"
              @click="moveToCold"
              :disabled="movingToCold || !coldStorageDir || coldStorageDir === hotStorageDir"
            >
              {{ movingToCold ? 'Moving...' : 'Move all to cold storage' }}
            </button>

            <div v-if="moveProgress" class="scan-progress">
              <div class="scan-progress-header">
                <span>{{ moveProgress.current }} / {{ moveProgress.total }}</span>
              </div>
              <div class="progress-bar-wrap">
                <div class="progress-bar" :style="{ width: (moveProgress.total > 0 ? Math.round(moveProgress.current / moveProgress.total * 100) : 0) + '%' }"></div>
              </div>
              <div class="scan-progress-file">{{ moveProgress.file }}</div>
            </div>

            <div v-if="moveResult" class="scan-result" :class="{ 'has-errors': moveResult.failed.length > 0 }">
              <div class="scan-result-ok">Moved: {{ moveResult.moved }} file(s)</div>
              <div v-if="moveResult.failed.length > 0" class="scan-result-errors">
                <div>Failed ({{ moveResult.failed.length }}):</div>
                <div v-for="(err, i) in moveResult.failed" :key="i" class="scan-error-item">{{ err }}</div>
              </div>
            </div>
          </div>
        </template>

        <div class="setting-group">
          <label class="setting-label">Storage usage</label>
          <p class="setting-hint">Disk space used by downloaded episodes. Click an anime to expand its episode list.</p>

          <div class="usage-actions">
            <button class="merge-all-btn" :disabled="usageScanning" @click="refreshStorageUsage">
              {{ usageScanning ? 'Scanning...' : (storageUsage ? 'Rescan' : 'Scan storage') }}
            </button>
          </div>

          <div v-if="usageProgress" class="scan-progress">
            <div class="scan-progress-header">
              <span>{{ usageProgress.scanned }} / {{ usageProgress.total }}</span>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar" :style="{ width: (usageProgress.total > 0 ? Math.round(usageProgress.scanned / usageProgress.total * 100) : 0) + '%' }"></div>
            </div>
          </div>

          <div v-if="storageUsage" class="usage-summary">
            <div class="usage-total">
              <span class="usage-total-label">Total</span>
              <span class="usage-total-value">{{ formatBytes(storageUsage.totalBytes) }}</span>
              <span class="usage-total-meta">{{ storageUsage.fileCount }} file(s) across {{ storageUsage.perAnime.length }} title(s)</span>
            </div>
            <div v-if="storageMode === 'advanced'" class="usage-buckets">
              <span class="usage-bucket"><span class="bucket-label">Hot</span> {{ formatBytes(storageUsage.bytesHot) }}</span>
              <span class="usage-bucket"><span class="bucket-label">Cold</span> {{ formatBytes(storageUsage.bytesCold) }}</span>
            </div>
          </div>

          <div v-if="storageUsage && storageUsage.perAnime.length > 0" class="usage-list">
            <div v-for="anime in storageUsage.perAnime" :key="anime.animeId" class="usage-anime">
              <div class="usage-anime-row" @click="toggleAnimeExpand(anime.animeId)">
                <img v-if="anime.posterUrlSmall" :src="anime.posterUrlSmall" class="usage-poster" />
                <div class="usage-anime-name">{{ anime.animeName }}</div>
                <div class="usage-anime-meta">
                  <span>{{ anime.fileCount }} file(s)</span>
                  <span class="usage-anime-size">{{ formatBytes(anime.bytes) }}</span>
                </div>
                <span class="usage-chevron" :class="{ open: expandedAnime.has(anime.animeId) }">›</span>
              </div>
              <div v-if="expandedAnime.has(anime.animeId)" class="usage-episodes">
                <div v-for="ep in anime.episodes" :key="ep.episodeInt" class="usage-episode">
                  <span class="usage-ep-num">Ep {{ ep.episodeInt }}</span>
                  <span class="usage-ep-tags">
                    <span v-if="ep.files.mkv" class="usage-tag">MKV</span>
                    <span v-if="ep.files.mp4" class="usage-tag">MP4</span>
                    <span v-if="ep.files.ass" class="usage-tag">ASS</span>
                    <span v-if="ep.watched" class="usage-tag usage-tag-watched">Watched{{ ep.watchedAt ? ` ${formatRelativeTime(ep.watchedAt)}` : '' }}</span>
                  </span>
                  <span class="usage-ep-size">{{ formatBytes(ep.totalBytes) }}</span>
                  <button class="usage-ep-delete" @click.stop="deleteEpisode(anime.animeName, ep.episodeInt, anime.animeId)">Delete</button>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="storageUsage && !usageScanning" class="usage-empty">No downloaded files found.</div>
        </div>

        <div class="setting-group">
          <label class="setting-label">Auto-cleanup watched episodes</label>
          <p class="setting-hint">Delete episode files marked as watched once they've sat for the chosen number of days. Set to 0 to disable.</p>
          <div class="custom-speed-row">
            <input
              type="number"
              min="0"
              step="1"
              class="setting-input speed-input"
              v-model.number="autoCleanupDays"
            />
            <span class="speed-unit">day(s) after watched</span>
          </div>

          <div class="usage-actions" style="margin-top: 12px">
            <button class="merge-all-btn" :disabled="cleanupRunning" @click="runCleanupNow">
              {{ cleanupRunning ? 'Cleaning...' : 'Run cleanup now' }}
            </button>
          </div>

          <div v-if="autoCleanupLastRun" class="usage-meta-row">
            Last run: {{ formatRelativeTime(autoCleanupLastRun.ranAt) }} —
            {{ autoCleanupLastRun.deletedCount }} file(s), {{ formatBytes(autoCleanupLastRun.freedBytes) }} freed
          </div>

          <div v-if="cleanupResult && cleanupResult.deletedCount === 0 && cleanupResult.items.length === 0" class="usage-meta-row">
            Nothing to clean up.
          </div>

          <div v-if="cleanupLog.length > 0" class="cleanup-log">
            <button class="cleanup-log-toggle" @click="cleanupLogExpanded = !cleanupLogExpanded">
              {{ cleanupLogExpanded ? 'Hide history' : `Show history (${cleanupLog.length})` }}
            </button>
            <div v-if="cleanupLogExpanded" class="cleanup-log-list">
              <div v-for="(entry, i) in cleanupLog" :key="i" class="cleanup-log-row">
                <span class="cleanup-log-time">{{ formatRelativeTime(entry.ranAt) }}</span>
                <span class="cleanup-log-name">{{ entry.animeName }}</span>
                <span class="cleanup-log-ep">Ep {{ entry.episodeInt }}</span>
                <span class="cleanup-log-size">{{ formatBytes(entry.bytes) }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Connectors tab -->
      <template v-if="activeTab === 'connectors'">
        <div class="setting-group">
          <label class="setting-label" for="token-input">smotret-anime.ru</label>
          <p class="setting-hint">API token for smotret-anime.ru. Required for downloading episodes.</p>
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
          <label class="setting-label">Shikimori</label>
          <p class="setting-hint">Connect your Shikimori account to sync watch progress.</p>

          <template v-if="shikimoriUser">
            <div class="shikimori-user">
              <img v-if="shikimoriUser.avatar" :src="shikimoriUser.avatar" class="shikimori-avatar" />
              <span class="shikimori-nickname">{{ shikimoriUser.nickname }}</span>
              <button class="test-token-btn" @click="shikimoriDisconnect">Disconnect</button>
            </div>
          </template>

          <template v-else>
            <div v-if="!shikimoriAuthUrl">
              <button class="browse-btn" @click="shikimoriConnect">Connect Shikimori</button>
            </div>
            <div v-else class="shikimori-auth">
              <div v-if="shikimoriShowUrl">
                <p class="setting-hint" style="margin-bottom: 6px">
                  Could not open browser. Copy the link and open it manually, then paste the code.
                </p>
                <div class="shikimori-url-row">
                  <span class="dir-path shikimori-url">{{ shikimoriAuthUrl }}</span>
                  <button class="test-token-btn" @click="shikimoriCopyUrl">Copy Link</button>
                </div>
              </div>
              <p v-else class="setting-hint" style="margin-bottom: 6px">
                A browser window has opened. Authorize the app, then paste the code below.
                <a href="#" class="shiki-show-url" @click.prevent="shikimoriShowUrl = true">Show link</a>
              </p>
              <div class="token-row" style="margin-top: 8px">
                <input
                  v-model="shikimoriCode"
                  type="text"
                  class="setting-input"
                  placeholder="Paste authorization code..."
                  @keydown.enter="shikimoriSubmitCode"
                />
                <button class="test-token-btn" :disabled="!shikimoriCode.trim() || shikimoriConnecting" @click="shikimoriSubmitCode">
                  {{ shikimoriConnecting ? 'Connecting...' : 'Submit' }}
                </button>
              </div>
              <div v-if="shikimoriError" class="token-result token-invalid">{{ shikimoriError }}</div>
            </div>
          </template>
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
          <label class="setting-label">Local skip detection</label>
          <p class="setting-hint">Fingerprint downloaded episodes locally to detect OP/ED in the player. Runs in the background after each download; first analysis on a show takes a minute or two of CPU.</p>
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
            >{{ skipBackfillRunning ? 'Queuing…' : 'Run detection on all downloaded shows' }}</button>
            <p v-if="skipBackfillResult" class="setting-hint">{{ skipBackfillResult }}</p>
            <p v-if="skipQueueStatusLabel" class="setting-hint">{{ skipQueueStatusLabel }}</p>
          </div>
        </div>

        <div class="setting-group">
          <label class="setting-label">Re-encode video</label>
          <p class="setting-hint">Re-encode video during merge. "None" copies the stream as-is (fastest). H.265 reduces file size but takes longer.</p>
          <select v-model="videoCodec" class="setting-input setting-select" :disabled="!ffmpeg?.available">
            <option v-for="c in availableCodecs" :key="c.value" :value="c.value">{{ c.label }}</option>
          </select>
          <p
            v-if="(videoCodec.startsWith('libx265') || videoCodec.startsWith('hevc_')) && !hevcPlaybackSupported"
            class="setting-hint setting-hint-warn"
          >
            H.265 merges save disk space, but this platform has no HEVC decoder — the built-in player will not play these files.
          </p>
        </div>
      </template>

      <!-- Player tab -->
      <template v-if="activeTab === 'player'">
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
          <p class="setting-hint">Real-time anime upscaling via WebGPU shaders. Choose a preset based on your source video resolution.</p>
          <select v-model="anime4kPreset" class="setting-input setting-select" :disabled="!webgpuStatus.available">
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
            When a local HEVC (H.265) MKV can't be decoded by the built-in player, transcode it to H.264 in real time instead of leaving the viewer with a black screen.
          </p>
          <select v-model="hevcTranscodeOnPlay" class="setting-input setting-select" :disabled="hevcMseSupported">
            <option value="ask">Ask each time</option>
            <option value="always">Always transcode</option>
            <option value="never">Never — open in external player</option>
          </select>
          <div v-if="hevcMseSupported" class="status-line ok" style="margin-top: 0.4rem">
            HEVC MSE decoder: available — the MKV pipeline plays HEVC directly and this fallback won't fire.
          </div>
          <div v-else class="status-line warn" style="margin-top: 0.4rem">
            HEVC MSE decoder: not available — this setting controls the fallback for local MKV playback.
          </div>
        </div>

        <div class="setting-group">
          <p class="setting-hint">Note: the built-in player supports local MKV playback via the MSE remux pipeline. For non-downloaded episodes, MKV files are streamed from the server — a Play button will appear on those rows when player mode is "Built-in". If a local HEVC MKV can't be decoded by your platform, the fallback above decides what happens.</p>
        </div>
      </template>

      <!-- Shortcuts tab -->
      <template v-if="activeTab === 'shortcuts'">
        <div class="setting-group">
          <label class="setting-label">Keyboard Shortcuts</label>
          <p class="setting-hint">Click "Record" to set a new key, press Escape to cancel recording. Click "Clear" to disable a shortcut.</p>
        </div>

        <div
          v-for="(meta, action) in SHORTCUT_LABELS"
          :key="action"
          v-show="!String(action).startsWith('shader') || webgpuStatus.available"
          class="shortcut-row"
        >
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
          <label class="setting-label">Anime4K GPU Benchmark</label>
          <p class="setting-hint">Test how fast your GPU can run Anime4K shaders (Mode A, 720p→screen resolution, 100 frames). Requires WebGPU.</p>
          <button class="merge-all-btn" @click="runGpuBenchmark" :disabled="benchmarking">
            {{ benchmarking ? 'Running benchmark...' : 'Run GPU benchmark' }}
          </button>

          <div v-if="benchmarkResult" class="scan-result">
            <div class="scan-result-ok" :style="{ color: benchmarkResult.fps >= 24 ? '#6ab04c' : '#f0932b' }">
              {{ benchmarkResult.preset }}: {{ benchmarkResult.fps }} fps ({{ benchmarkResult.avgMs }}ms/frame)
            </div>
            <div class="scan-error-item" :style="{ color: benchmarkResult.fps >= 24 ? '#6ab04c' : '#f0932b' }">
              {{ benchmarkResult.fps >= 24 ? 'Your GPU can handle real-time Anime4K shaders' : 'Your GPU may struggle with real-time shaders — consider using "Off" preset' }}
            </div>
          </div>

          <div v-if="benchmarkError" class="scan-result has-errors">
            <div class="scan-result-errors">{{ benchmarkError }}</div>
          </div>

          <div v-if="webgpuStatus.available" class="status-line ok" style="margin-top: 8px;">
            WebGPU: {{ webgpuStatus.gpuName }}
          </div>
          <div v-else class="status-line warn" style="margin-top: 8px;">
            WebGPU not detected — benchmark will attempt to initialize it
          </div>
        </div>

        <div class="setting-group">
          <label class="setting-label">Background quality probe</label>
          <p class="setting-hint">Probe actual stream quality for all translations when opening an anime page (not just the selected one). Detects quality mismatches but may cause lag on slower connections.</p>
          <label class="toggle-row">
            <input type="checkbox" v-model="backgroundQualityProbe" />
            <span>Enable background quality probe</span>
          </label>
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

    <div v-if="cleanupPending" class="cleanup-modal-backdrop" @click.self="dismissCleanupPending">
      <div class="cleanup-modal">
        <div class="cleanup-modal-title">Auto-cleanup ready</div>
        <p class="cleanup-modal-hint">
          {{ cleanupPending.length }} watched episode(s) are eligible for deletion.
          Confirming will delete them now and skip this prompt on future runs.
        </p>
        <div class="cleanup-modal-list">
          <div v-for="c in cleanupPending" :key="`${c.animeId}:${c.episodeInt}`" class="cleanup-modal-row">
            <span class="cleanup-modal-name">{{ c.animeName }}</span>
            <span class="cleanup-modal-ep">Ep {{ c.episodeInt }}</span>
            <span class="cleanup-modal-size">{{ formatBytes(c.bytes) }}</span>
          </div>
        </div>
        <div class="cleanup-modal-actions">
          <button class="test-token-btn" @click="dismissCleanupPending">Cancel</button>
          <button class="merge-all-btn" @click="confirmCleanup">Delete and remember</button>
        </div>
      </div>
    </div>
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

.setting-hint-warn {
  color: #e0b36a;
  margin-top: 6px;
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

.custom-speed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.speed-input {
  width: 100px !important;
}

.speed-unit {
  color: #a0a0b8;
  font-size: 0.85rem;
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

.dir-path.dir-warning {
  border-color: #e94560;
  color: #6a6a8a;
}

.storage-mode-toggle {
  display: flex;
  gap: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #0f3460;
  width: fit-content;
}

.mode-btn {
  padding: 8px 20px;
  background: #16213e;
  border: none;
  color: #6a6a8a;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-btn:not(:last-child) {
  border-right: 1px solid #0f3460;
}

.mode-btn.active {
  background: #0f3460;
  color: #e0e0e0;
}

.mode-btn:hover:not(.active) {
  color: #a0a0b8;
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

.shikimori-user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shikimori-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

.shikimori-nickname {
  font-size: 0.9rem;
  font-weight: 600;
  color: #e0e0e0;
  flex: 1;
}

.shikimori-url-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shikimori-url {
  font-size: 0.75rem;
  user-select: all;
}

.shiki-show-url {
  color: #3498db;
  text-decoration: none;
  font-size: 0.8rem;
}

.shiki-show-url:hover {
  text-decoration: underline;
}

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

.radio-label input[type="radio"] {
  accent-color: #e94560;
}

.status-line {
  font-size: 0.85rem;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 4px;
}

.status-line.ok {
  color: #6ab04c;
  background: rgba(106, 176, 76, 0.1);
}

.status-line.warn {
  color: #f0932b;
  background: rgba(240, 147, 43, 0.1);
}

/* Storage usage dashboard */
.usage-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.usage-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 12px;
  padding: 12px 14px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
}

.usage-total {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.usage-total-label {
  font-size: 0.8rem;
  color: #6a6a8a;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.usage-total-value {
  font-size: 1.15rem;
  font-weight: 600;
  color: #e0e0e0;
}

.usage-total-meta {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.usage-buckets {
  display: flex;
  gap: 12px;
}

.usage-bucket {
  font-size: 0.85rem;
  color: #a0a0b8;
}

.bucket-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6a6a8a;
  margin-right: 4px;
}

.usage-list {
  margin-top: 10px;
  border: 1px solid #0f3460;
  border-radius: 8px;
  overflow: hidden;
}

.usage-anime {
  border-bottom: 1px solid #0f3460;
}

.usage-anime:last-child {
  border-bottom: none;
}

.usage-anime-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.12s;
}

.usage-anime-row:hover {
  background-color: rgba(15, 52, 96, 0.4);
}

.usage-poster {
  width: 32px;
  height: 44px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.usage-anime-name {
  flex: 1;
  font-size: 0.9rem;
  color: #e0e0e0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-anime-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.8rem;
  color: #6a6a8a;
}

.usage-anime-size {
  color: #a0a0b8;
  font-weight: 600;
  min-width: 70px;
  text-align: right;
}

.usage-chevron {
  color: #6a6a8a;
  font-size: 1.1rem;
  transition: transform 0.15s;
  width: 14px;
  text-align: center;
}

.usage-chevron.open {
  transform: rotate(90deg);
}

.usage-episodes {
  background-color: rgba(15, 52, 96, 0.2);
  padding: 4px 0;
}

.usage-episode {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px 6px 54px;
  font-size: 0.85rem;
}

.usage-ep-num {
  color: #e0e0e0;
  min-width: 50px;
}

.usage-ep-tags {
  display: flex;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.usage-tag {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 6px;
  background: rgba(15, 52, 96, 0.7);
  color: #a0a0b8;
  border-radius: 3px;
  letter-spacing: 0.03em;
}

.usage-tag-watched {
  background: rgba(106, 176, 76, 0.18);
  color: #8fc26d;
}

.usage-ep-size {
  color: #a0a0b8;
  min-width: 70px;
  text-align: right;
}

.usage-ep-delete {
  padding: 4px 10px;
  background-color: transparent;
  border: 1px solid #e94560;
  border-radius: 6px;
  color: #e94560;
  font-size: 0.75rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.usage-ep-delete:hover {
  background-color: rgba(233, 69, 96, 0.12);
}

.usage-empty {
  margin-top: 10px;
  font-size: 0.85rem;
  color: #6a6a8a;
}

.usage-meta-row {
  margin-top: 10px;
  font-size: 0.8rem;
  color: #a0a0b8;
}

.cleanup-log {
  margin-top: 12px;
}

.cleanup-log-toggle {
  background: none;
  border: none;
  color: #a0a0b8;
  font-size: 0.8rem;
  cursor: pointer;
  padding: 0;
}

.cleanup-log-toggle:hover {
  color: #e0e0e0;
  text-decoration: underline;
}

.cleanup-log-list {
  margin-top: 8px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid #0f3460;
  border-radius: 6px;
}

.cleanup-log-row {
  display: flex;
  gap: 10px;
  padding: 6px 10px;
  font-size: 0.8rem;
  border-bottom: 1px solid rgba(15, 52, 96, 0.5);
}

.cleanup-log-row:last-child {
  border-bottom: none;
}

.cleanup-log-time {
  color: #6a6a8a;
  width: 90px;
  flex-shrink: 0;
}

.cleanup-log-name {
  color: #e0e0e0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cleanup-log-ep {
  color: #a0a0b8;
  width: 60px;
  flex-shrink: 0;
}

.cleanup-log-size {
  color: #a0a0b8;
  width: 70px;
  text-align: right;
  flex-shrink: 0;
}

.cleanup-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.cleanup-modal {
  width: 480px;
  max-width: calc(100% - 40px);
  max-height: calc(100% - 60px);
  display: flex;
  flex-direction: column;
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 18px 20px;
}

.cleanup-modal-title {
  font-size: 1rem;
  font-weight: 600;
  color: #e0e0e0;
  margin-bottom: 6px;
}

.cleanup-modal-hint {
  font-size: 0.85rem;
  color: #a0a0b8;
  margin-bottom: 12px;
}

.cleanup-modal-list {
  flex: 1;
  overflow-y: auto;
  margin-bottom: 14px;
  border: 1px solid #0f3460;
  border-radius: 6px;
}

.cleanup-modal-row {
  display: flex;
  gap: 10px;
  padding: 6px 10px;
  font-size: 0.8rem;
  border-bottom: 1px solid rgba(15, 52, 96, 0.5);
}

.cleanup-modal-row:last-child {
  border-bottom: none;
}

.cleanup-modal-name {
  flex: 1;
  color: #e0e0e0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cleanup-modal-ep {
  color: #a0a0b8;
  width: 60px;
}

.cleanup-modal-size {
  color: #a0a0b8;
  width: 70px;
  text-align: right;
}

.cleanup-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
