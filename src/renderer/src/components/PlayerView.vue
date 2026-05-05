<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import SubtitlesOctopus from 'libass-wasm/dist/js/subtitles-octopus.js'

const props = defineProps<{
  filePath: string
  streamUrl: string
  subtitleContent: string
  animeName: string
  episodeLabel: string
  availableStreams: { height: number; url: string }[]
  translationId: number
  translations: { id: number; label: string; type: string; height: number }[]
  downloadedTrIds: number[]
  allEpisodes: { episodeInt: string; episodeFull: string; translations: { id: number; label: string; type: string; height: number }[]; downloadedTrIds: number[] }[]
  episodeIndex: number
  animeId: number
  malId: number
}>()

const emit = defineEmits<{
  close: []
}>()

// Refs for DOM elements
const videoRef = ref<HTMLVideoElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLElement | null>(null)

// Playback state
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const muted = ref(false)
const isFullscreen = ref(false)
const seeking = ref(false)
const buffered = ref(0)
const seekTooltipVisible = ref(false)
const seekTooltipLeft = ref(0)
const seekTooltipTime = ref('0:00')

// Anime4K state
const anime4kPreset = ref<'off' | 'mode-a' | 'mode-b' | 'mode-c'>('off')
const webgpuAvailable = ref(false)
const gpuName = ref('')
const anime4kActive = computed(() => webgpuAvailable.value && anime4kPreset.value !== 'off')

// UI state
const showControls = ref(true)
const showPresetMenu = ref(false)
const showQualityMenu = ref(false)
let controlsTimer: ReturnType<typeof setTimeout> | null = null

// MKV remux state
const activeFilePath = ref(props.filePath)
const isMkv = computed(() => !!activeFilePath.value && activeFilePath.value.toLowerCase().endsWith('.mkv'))
const remuxing = ref(false)
const remuxError = ref('')
const remuxedPath = ref('')           // used by legacy full-remux fallback
const streamSessionId = ref('')       // active MSE session id
const mseSrcUrl = ref('')             // URL.createObjectURL(MediaSource)
const mkvBuffering = ref(false)       // shows "Buffering…" toast while MSE waits for data
const transcodingHevc = ref(false)    // true when the current MSE session is real-time HEVC→H.264 transcode
const transcodeSpeed = ref<number | null>(null)  // ffmpeg reported encode speed (e.g. 2.5 for 2.5x realtime)
const transcodeLabel = computed(() => {
  if (transcodeSpeed.value == null) return 'Transcoding HEVC → H.264…'
  return `Transcoding HEVC → H.264 @ ${transcodeSpeed.value.toFixed(1)}×`
})
const hevcPromptOpen = ref(false)     // consent modal when MSE rejects HEVC and setting is 'ask'
type HevcPromptChoice = 'transcode' | 'always-transcode' | 'external' | 'cancel'
let hevcPromptResolver: ((c: HevcPromptChoice) => void) | null = null

// MSE internals (not reactive)
let mediaSource: MediaSource | null = null
let sourceBuffer: SourceBuffer | null = null
let streamEnded = false
const appendQueue: Uint8Array[] = []
let pendingAckBytes = 0
let mseInitialSeek = 0
// Generation of the ffmpeg run whose chunks are currently valid. Bumped by main
// on each respawn (seek). Chunks still in-flight from the previous run — sent
// before main's generation++ reached us — carry an older `gen` and must be
// dropped, otherwise they are appended with the new timestampOffset and extend
// MediaSource.duration / corrupt the parser after sb.abort().
let currentStreamGen = 0
const STREAM_ACK_THRESHOLD = 1 * 1024 * 1024

// Quality selector state
const activeStreamUrl = ref(props.streamUrl)
const selectedHeight = ref(0)
const hasQualities = computed(() => props.availableStreams.length > 0)

const isStreaming = computed(() => !!activeStreamUrl.value && !activeFilePath.value)
const streamingBannerVisible = ref(false)
let streamingBannerTimer: ReturnType<typeof setTimeout> | null = null
watch(isStreaming, (streaming) => {
  if (streamingBannerTimer) {
    clearTimeout(streamingBannerTimer)
    streamingBannerTimer = null
  }
  if (streaming) {
    streamingBannerVisible.value = true
    streamingBannerTimer = setTimeout(() => {
      streamingBannerTimer = null
      streamingBannerVisible.value = false
    }, 3500)
  } else {
    streamingBannerVisible.value = false
  }
}, { immediate: true })

// Translation selector state
const showTranslationMenu = ref(false)
const activeTranslationId = ref(props.translationId)
const activeSubtitleContent = ref(props.subtitleContent)
const switchingTranslation = ref(false)
const hasTranslations = computed(() => activeTranslations.value.length > 1)
const translationMenuLevel = ref<'types' | 'items'>('types')
const selectedTypeGroup = ref('')

// Episode navigation state
const activeEpisodeIndex = ref(props.episodeIndex)
const activeEpisodeLabel = ref(props.episodeLabel)
const activeTranslations = ref(props.translations)
const activeDownloadedTrIds = ref(props.downloadedTrIds)
const navigating = ref(false)
const canPrev = computed(() => activeEpisodeIndex.value > 0)
const canNext = computed(() => activeEpisodeIndex.value < props.allEpisodes.length - 1)
const autoAdvanceCountdown = ref(0)
let autoAdvanceTimer: ReturnType<typeof setInterval> | null = null
const DEFAULT_PLAYER_SHORTCUTS: Record<string, string> = {
  playerPrevEpisode: 'Shift+ArrowLeft',
  playerNextEpisode: 'Shift+ArrowRight',
  shaderModeA: 'CmdOrCtrl+1',
  shaderModeB: 'CmdOrCtrl+2',
  shaderModeC: 'CmdOrCtrl+3',
  shaderOff: 'CmdOrCtrl+Backquote'
}
const playerShortcuts = ref<Record<string, string>>({ ...DEFAULT_PLAYER_SHORTCUTS })

// Watch progress tracking
const currentEpisodeInt = computed(() => props.allEpisodes[activeEpisodeIndex.value]?.episodeInt || '')

// Skip Detection (Phase 2): show OP/ED bands on the seek bar and a "Skip OP/ED"
// overlay button when playback enters a detected range. Boundaries come from
// `skipDetectorGetDetections(animeId)` — no new IPC needed (Phase 1 already
// persists per-episode boundaries in electron-store).
const showSkipDetections = ref<ShowSkipDetections | null>(null)
const skippedRanges = ref<Set<string>>(new Set())
const skipButtonVisible = ref(false)
let skipButtonGraceTimer: ReturnType<typeof setTimeout> | null = null
const SKIP_GRACE_MS = 250
const SKIP_LEAD_IN_SEC = 0.25

const currentEpisodeSkip = computed<EpisodeSkipDetection | null>(() => {
  const det = showSkipDetections.value
  const epInt = currentEpisodeInt.value
  if (!det || !epInt) return null
  return det.perEpisode[epInt] ?? null
})

// Returns 'op' | 'ed' | null based on current playback time. The lead-in
// tolerance handles the case where the seek bar lands a few hundred ms before
// the band edge.
const activeSkipRange = computed<'op' | 'ed' | null>(() => {
  const ep = currentEpisodeSkip.value
  if (!ep) return null
  const t = currentTime.value
  if (ep.op && t >= ep.op.startSec - SKIP_LEAD_IN_SEC && t < ep.op.endSec) return 'op'
  if (ep.ed && t >= ep.ed.startSec - SKIP_LEAD_IN_SEC && t < ep.ed.endSec) return 'ed'
  return null
})

function skipRangeKey(kind: 'op' | 'ed'): string {
  return `${props.animeId}:${currentEpisodeInt.value}:${kind}`
}

function activeSkipBounds(): { startSec: number; endSec: number; kind: 'op' | 'ed' } | null {
  const kind = activeSkipRange.value
  const ep = currentEpisodeSkip.value
  if (!ep || !kind) return null
  const range = kind === 'op' ? ep.op : ep.ed
  if (!range) return null
  return { startSec: range.startSec, endSec: range.endSec, kind }
}

function onSkipClick(): void {
  const bounds = activeSkipBounds()
  if (!bounds) return
  skippedRanges.value.add(skipRangeKey(bounds.kind))
  skipButtonVisible.value = false
  if (skipButtonGraceTimer) {
    clearTimeout(skipButtonGraceTimer)
    skipButtonGraceTimer = null
  }
  seek(bounds.endSec)
}

watch(activeSkipRange, (kind) => {
  if (skipButtonGraceTimer) {
    clearTimeout(skipButtonGraceTimer)
    skipButtonGraceTimer = null
  }
  if (!kind) {
    skipButtonVisible.value = false
    return
  }
  if (skippedRanges.value.has(skipRangeKey(kind))) {
    // User already skipped this range this session; don't re-show on rewind.
    skipButtonVisible.value = false
    return
  }
  // Brief grace timer prevents flicker when scrubbing through the range.
  skipButtonGraceTimer = setTimeout(() => {
    skipButtonVisible.value = true
    skipButtonGraceTimer = null
  }, SKIP_GRACE_MS)
})

async function loadSkipDetections(): Promise<void> {
  if (!props.animeId) {
    showSkipDetections.value = null
    return
  }
  try {
    showSkipDetections.value = await window.api.skipDetectorGetDetections(props.animeId)
  } catch (err) {
    console.error('Failed to load skip detections:', err)
    showSkipDetections.value = null
  }
}

// Reset the per-range "already skipped" guard when the episode changes so the
// button appears for the new episode's OP/ED. Detections themselves come from
// the same per-show payload, so they don't need a refetch on episode flip.
watch(currentEpisodeInt, () => {
  skippedRanges.value = new Set()
  if (skipButtonGraceTimer) {
    clearTimeout(skipButtonGraceTimer)
    skipButtonGraceTimer = null
  }
  skipButtonVisible.value = false
})
let cumulativePlayTime = 0
let lastTimeUpdateAt = 0
let lastSaveAt = 0
let watchedReported = false
let episodeOpenedAt = Date.now()
let pendingPrevEpisodeInt = ''
const resumeToast = ref('')
let resumeToastTimer: ReturnType<typeof setTimeout> | null = null

// Syncplay (Watch Together) state
const syncplayStatus = ref<SyncplayStatus>({ state: 'idle' })
const syncplayRoomUsers = ref<SyncplayRoomUser[]>([])
const syncplayRoomInput = ref('')
const syncplayMenuOpen = ref(false)
const syncplayToast = ref('')
let syncplayToastTimer: ReturnType<typeof setTimeout> | null = null
let syncplaySnapshotTimer: ReturnType<typeof setInterval> | null = null
let suppressNextLocalEventUntil = 0
let syncplayLocalReady = true
let syncplayLastRemotePlaying = false
let syncplayLastAppliedPaused: boolean | null = null
let syncplayWaitingTimer: ReturnType<typeof setTimeout> | null = null
const WAITING_DEBOUNCE_MS = 600
const syncplayPausedBy = ref<string | null>(null)

// Listener functions captured at register-time so onBeforeUnmount can call
// the matching off* with the same reference — avoids removeAllListeners
// ripping out listeners installed by other views (e.g. SettingsView's
// "Test connection" handler).
let syncplayConnectionStatusHandler: ((status: SyncplayStatus) => void) | null = null
let syncplayRemoteStateHandler: ((state: SyncplayRemoteState) => void) | null = null
let syncplayRoomUsersHandler: ((users: SyncplayRoomUser[]) => void) | null = null
let syncplayRoomEventHandler: ((ev: SyncplayRoomEvent) => void) | null = null
let syncplayTraceHandler: ((entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => void) | null = null
let syncplayRemoteEpisodeChangeHandler: ((ep: SyncplayRemoteEpisode) => void) | null = null

function showSyncplayToast(text: string, ms = 3500): void {
  syncplayToast.value = text
  if (syncplayToastTimer) clearTimeout(syncplayToastTimer)
  syncplayToastTimer = setTimeout(() => { syncplayToast.value = '' }, ms)
}

function buildCanonicalName(): string {
  const ep = currentEpisodeInt.value || activeEpisodeLabel.value || ''
  return ep ? `${props.animeName} - ${ep}` : props.animeName
}

function pushSyncplayFile(): void {
  if (syncplayStatus.value.state !== 'ready') return
  const dur = videoRef.value?.duration || duration.value || 0
  window.api.syncplaySetFile({
    animeId: props.animeId,
    malId: props.malId || null,
    episodeInt: currentEpisodeInt.value || activeEpisodeLabel.value || '',
    translationId: activeTranslationId.value ?? null,
    canonicalName: buildCanonicalName(),
    duration: dur
  })
}

function sendSyncplayLocalState(cause: 'play' | 'pause' | 'seek'): void {
  if (syncplayStatus.value.state !== 'ready') return
  if (Date.now() < suppressNextLocalEventUntil) return
  const v = videoRef.value
  if (!v) return
  window.api.syncplaySendLocalState({
    paused: v.paused,
    position: v.currentTime,
    cause
  })
}

function onVideoSeeked(): void {
  sendSyncplayLocalState('seek')
}

function syncplayAllUsersReady(): boolean {
  if (!syncplayLocalReady) return false
  for (const u of syncplayRoomUsers.value) {
    if (u.isReady === false) return false
  }
  return true
}

function setSyncplayLocalReady(ready: boolean): void {
  if (syncplayLocalReady === ready) return
  syncplayLocalReady = ready
  if (syncplayStatus.value.state === 'ready') {
    window.api.syncplaySetReady(ready).catch(() => {})
  }
  applySyncplayReadyGate()
}

function applySyncplayReadyGate(): void {
  if (syncplayStatus.value.state !== 'ready') return
  const v = videoRef.value
  if (!v) return
  const shouldPlay = syncplayLastRemotePlaying && syncplayAllUsersReady()
  if (!shouldPlay && !v.paused) {
    suppressNextLocalEventUntil = Date.now() + 1500
    v.pause()
  } else if (shouldPlay && v.paused) {
    suppressNextLocalEventUntil = Date.now() + 1500
    v.play().catch(() => {})
  }
}

function onVideoWaiting(): void {
  if (syncplayWaitingTimer) clearTimeout(syncplayWaitingTimer)
  syncplayWaitingTimer = setTimeout(() => {
    syncplayWaitingTimer = null
    setSyncplayLocalReady(false)
  }, WAITING_DEBOUNCE_MS)
}

function applyRemoteState(state: SyncplayRemoteState): void {
  const v = videoRef.value
  if (!v) return
  syncplayLastRemotePlaying = !state.paused
  const pausedChanged = syncplayLastAppliedPaused !== state.paused
  syncplayLastAppliedPaused = state.paused
  if (pausedChanged) {
    if (state.paused && state.setBy) syncplayPausedBy.value = state.setBy
    else if (!state.paused) syncplayPausedBy.value = null
  }
  const diff = Math.abs(v.currentTime - state.position)
  const needsSeek = state.doSeek || diff > 3.0
  const effectivePaused = state.paused || !syncplayAllUsersReady()
  const needsPlayPause = effectivePaused !== v.paused

  if (!needsSeek && !needsPlayPause) return
  suppressNextLocalEventUntil = Date.now() + 1500

  if (needsSeek) {
    v.currentTime = Math.max(0, state.position)
  }
  if (needsPlayPause) {
    if (effectivePaused) v.pause()
    else v.play().catch(() => {})
  }
  if (state.setBy && needsSeek) {
    showSyncplayToast(`${state.setBy} seeked to ${formatTime(state.position)}`)
  }
}

// Episode/translation switch: re-announce the file to peers but DO NOT reset
// syncplayLastRemotePlaying. If a peer is currently playing, applySyncplayReadyGate
// will start the new episode as soon as buffer fills — by design, so a remote
// "next episode" or local prev/next auto-resumes the binge instead of pausing.
watch([activeEpisodeIndex, activeTranslationId], () => {
  pushSyncplayFile()
})

async function toggleSyncplayConnection(): Promise<void> {
  const isActive = syncplayStatus.value.state === 'ready'
    || syncplayStatus.value.state === 'connecting'
    || syncplayStatus.value.state === 'tls-probing'
    || syncplayStatus.value.state === 'tls-handshake'
    || syncplayStatus.value.state === 'hello-sent'
    || syncplayStatus.value.state === 'reconnecting'
  if (isActive) {
    await window.api.syncplayDisconnect()
    return
  }
  const cfg = await window.api.getSetting('syncplay') as {
    lastHost?: string
    lastPort?: number
    lastRoom?: string
    username?: string
    autoReconnect?: boolean
  } | null
  const host = cfg?.lastHost || 'syncplay.pl'
  const port = cfg?.lastPort || 8999
  const room = syncplayRoomInput.value.trim() || cfg?.lastRoom || ''
  let username = cfg?.username?.trim() || ''
  if (!username) {
    const shiki = await window.api.shikimoriGetUser()
    if (shiki?.nickname) {
      username = shiki.nickname
      await window.api.setSetting('syncplay', { ...(cfg || {}), username })
    }
  }
  if (!room) {
    showSyncplayToast('Enter a room name first')
    return
  }
  if (!username) {
    showSyncplayToast('Set a username in Settings → Watch Together')
    return
  }
  await window.api.syncplayConnect({
    host,
    port,
    room,
    username,
    autoReconnect: cfg?.autoReconnect ?? true
  })
}

const WATCH_THRESHOLD_RATIO = 0.8
const WATCH_THRESHOLD_SECONDS = 180
const SAVE_INTERVAL_MS = 5000
const NEXT_MARK_PREV_WATCHED_MS = 60_000

function trackProgressDelta(now: number): void {
  if (lastTimeUpdateAt > 0 && playing.value && !seeking.value) {
    const delta = (now - lastTimeUpdateAt) / 1000
    if (delta > 0 && delta < 2) cumulativePlayTime += delta
  }
  lastTimeUpdateAt = now
}

async function saveProgress(force = false): Promise<void> {
  const epInt = currentEpisodeInt.value
  if (!props.animeId || !epInt) return
  const video = videoRef.value
  if (!video || !duration.value) return
  // Don't persist trivial progress — avoids 0% ghost entries from brief opens
  if (!watchedReported && video.currentTime < 15) return
  const now = Date.now()
  if (!force && now - lastSaveAt < SAVE_INTERVAL_MS) return
  lastSaveAt = now
  // When watched, clear the position so we don't try to resume near the end later
  const positionToSave = watchedReported ? 0 : video.currentTime
  try {
    await window.api.watchProgressSave(props.animeId, epInt, positionToSave, duration.value, watchedReported)
    window.dispatchEvent(new CustomEvent('watch-progress-updated'))
  } catch (err) {
    console.warn('[player] failed to save watch progress:', err)
  }
}

async function markEpisodeWatched(episodeInt: string): Promise<void> {
  if (!props.animeId || !episodeInt) return
  try {
    await window.api.watchProgressSave(props.animeId, episodeInt, 0, 0, true)
    window.dispatchEvent(new CustomEvent('watch-progress-updated'))
  } catch (err) {
    console.warn('[player] failed to mark episode watched:', err)
  }

  if (!props.malId) return
  const epNum = parseInt(episodeInt, 10)
  if (!Number.isFinite(epNum) || epNum <= 0) return
  try {
    const rate = await window.api.shikimoriGetRate(props.malId)
    const currentEps = rate?.episodes ?? 0
    if (epNum > currentEps) {
      const nextStatus = rate?.status === 'completed' ? 'rewatching' : 'watching'
      await window.api.shikimoriUpdateRate(props.malId, epNum, nextStatus, rate?.score ?? 0)
    }
  } catch (err) {
    console.warn('[player] failed to update Shikimori episode count:', err)
  }
}

async function maybeMarkWatched(): Promise<void> {
  if (watchedReported) return
  const video = videoRef.value
  if (!video || !duration.value) return
  const ratio = video.currentTime / duration.value
  if (ratio < WATCH_THRESHOLD_RATIO) return
  if (cumulativePlayTime < WATCH_THRESHOLD_SECONDS) return

  watchedReported = true
  await saveProgress(true)

  if (!props.malId) return
  const epNum = parseInt(currentEpisodeInt.value, 10)
  if (!Number.isFinite(epNum) || epNum <= 0) return
  try {
    const rate = await window.api.shikimoriGetRate(props.malId)
    const currentEps = rate?.episodes ?? 0
    if (epNum > currentEps) {
      const nextStatus = rate?.status === 'completed' ? 'rewatching' : 'watching'
      await window.api.shikimoriUpdateRate(props.malId, epNum, nextStatus, rate?.score ?? 0)
    }
  } catch (err) {
    console.warn('[player] failed to update Shikimori episode count:', err)
  }
}

function resetEpisodeTracking(): void {
  cumulativePlayTime = 0
  lastTimeUpdateAt = 0
  lastSaveAt = 0
  watchedReported = false
  episodeOpenedAt = Date.now()
}

async function resumeFromSavedPosition(): Promise<void> {
  const video = videoRef.value
  if (!video) return
  const epInt = currentEpisodeInt.value
  if (!props.animeId || !epInt) return
  try {
    const saved = await window.api.watchProgressGet(props.animeId, epInt)
    if (!saved) return
    watchedReported = !!saved.watched
    if (saved.watched) return
    const d = video.duration || saved.duration
    if (!d) return
    // For MSE MKV streams the ffmpeg run was already started at the saved
    // position; skip the native seek to avoid a spurious unbuffered-seek flow.
    if (streamSessionId.value && mseInitialSeek > 0) {
      if (video.currentTime < mseInitialSeek) {
        try { video.currentTime = mseInitialSeek } catch { /* ignore */ }
      }
      currentTime.value = mseInitialSeek
      resumeToast.value = `Resumed at ${formatTime(saved.position)}`
      if (resumeToastTimer) clearTimeout(resumeToastTimer)
      resumeToastTimer = setTimeout(() => { resumeToast.value = '' }, 3000)
      return
    }
    if (saved.position > 5 && saved.position / d < 0.95) {
      video.currentTime = saved.position
      currentTime.value = saved.position
      resumeToast.value = `Resumed at ${formatTime(saved.position)}`
      if (resumeToastTimer) clearTimeout(resumeToastTimer)
      resumeToastTimer = setTimeout(() => { resumeToast.value = '' }, 3000)
    }
  } catch (err) {
    console.warn('[player] failed to load watch progress:', err)
  }
}

function maybeMarkPendingPrevWatched(): void {
  if (!pendingPrevEpisodeInt) return
  if (Date.now() - episodeOpenedAt < NEXT_MARK_PREV_WATCHED_MS) return
  const prev = pendingPrevEpisodeInt
  pendingPrevEpisodeInt = ''
  markEpisodeWatched(prev)
}

// WebGPU pipeline state
let gpuDevice: GPUDevice | null = null
let pipelineActive = false

// ASS subtitle state (SubtitlesOctopus renderer)
let octopusInstance: InstanceType<typeof SubtitlesOctopus> | null = null

// Fullscreen quad WGSL shaders for rendering pipeline output to canvas
const FULLSCREEN_QUAD_VERT = `
@vertex
fn vert_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1)
  );
  return vec4f(pos[idx], 0, 1);
}
`

const FULLSCREEN_QUAD_FRAG = `
@group(0) @binding(0) var mySampler: sampler;
@group(0) @binding(1) var myTexture: texture_2d<f32>;

@fragment
fn main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(myTexture));
  let tc = coord.xy / dims;
  // Flip Y so video isn't upside down
  return textureSample(myTexture, mySampler, vec2f(tc.x, tc.y));
}
`

const videoSrc = computed(() => {
  if (activeFilePath.value) {
    // For MKV files, prefer the MSE stream URL; fall back to legacy full remux.
    if (isMkv.value) {
      if (mseSrcUrl.value) return mseSrcUrl.value
      if (remuxedPath.value) return 'anime-video://' + encodeURIComponent(remuxedPath.value)
      return ''
    }
    return 'anime-video://' + encodeURIComponent(activeFilePath.value)
  }
  return activeStreamUrl.value
})

async function prepareMkvForPlayback(filePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  resetMseState()
  streamSessionId.value = ''
  remuxedPath.value = ''
  remuxError.value = ''
  transcodingHevc.value = false
  transcodeSpeed.value = null

  let initialSeek = 0
  try {
    const epInt = currentEpisodeInt.value
    if (props.animeId && epInt) {
      const saved = await window.api.watchProgressGet(props.animeId, epInt)
      if (saved && !saved.watched && saved.position > 5 && saved.duration > 0 && saved.position / saved.duration < 0.95) {
        initialSeek = Math.max(0, saved.position - 1)
      }
    }
  } catch { /* ignore */ }

  const streamResult = await window.api.playerRemuxMkvStream(filePath, initialSeek)
  if (!('error' in streamResult)) {
    const mseOk = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(streamResult.mimeType)
    console.log(`[player] MSE negotiate mime="${streamResult.mimeType}" supported=${mseOk}`)
    if (mseOk) {
      startMseSession(streamResult.sessionId, streamResult.generation, streamResult.duration, streamResult.mimeType, streamResult.initialSeek)
      mkvBuffering.value = true
      return { ok: true }
    }
    console.warn('[player] MSE does not support codecs:', streamResult.mimeType)
    await window.api.playerCleanupRemux()

    if (/hvc1|hev1/i.test(streamResult.mimeType)) {
      const pref = ((await window.api.getSetting('hevcTranscodeOnPlay')) as 'ask' | 'always' | 'never' | undefined) ?? 'ask'
      let choice: HevcPromptChoice
      if (pref === 'always') choice = 'transcode'
      else if (pref === 'never') choice = 'external'
      else choice = await askHevcChoice()
      if (choice === 'external') {
        const res = await window.api.shellOpenExternalFile(filePath)
        if (res.ok) {
          emit('close')
          return { ok: true }
        }
        // Keep the player open so the error can surface in remuxError UI.
        return { ok: false, error: res.error || 'Failed to open externally' }
      }
      if (choice === 'cancel') {
        emit('close')
        return { ok: true }
      }
      if (choice === 'always-transcode') {
        try { await window.api.setSetting('hevcTranscodeOnPlay', 'always') } catch { /* ignore */ }
      }
      return await prepareHevcTranscode(filePath, initialSeek)
    }
  } else {
    console.warn('[player] MSE stream open failed, falling back to legacy remux:', streamResult.error)
  }

  remuxing.value = true
  try {
    const legacy = await window.api.playerRemuxMkv(filePath)
    if ('error' in legacy) return { ok: false, error: legacy.error }
    remuxedPath.value = legacy.mp4Path
    if (!activeSubtitleContent.value && legacy.subtitleContent) {
      activeSubtitleContent.value = legacy.subtitleContent
    }
    return { ok: true }
  } finally {
    remuxing.value = false
  }
}

function askHevcChoice(): Promise<HevcPromptChoice> {
  return new Promise((resolve) => {
    // If a previous resolver is somehow still pending, settle it as cancel so
    // the old caller can unwind and doesn't deadlock.
    if (hevcPromptResolver) hevcPromptResolver('cancel')
    hevcPromptResolver = resolve
    hevcPromptOpen.value = true
  })
}

function resolveHevcPrompt(choice: HevcPromptChoice): void {
  hevcPromptOpen.value = false
  const fn = hevcPromptResolver
  hevcPromptResolver = null
  if (fn) fn(choice)
}

async function prepareHevcTranscode(filePath: string, initialSeek: number): Promise<{ ok: true } | { ok: false; error: string }> {
  transcodingHevc.value = true
  const r = await window.api.playerRemuxMkvStreamTranscode(filePath, initialSeek)
  if ('error' in r) {
    transcodingHevc.value = false
    transcodeSpeed.value = null
    return { ok: false, error: r.error }
  }
  const mseOk = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(r.mimeType)
  if (!mseOk) {
    transcodingHevc.value = false
    transcodeSpeed.value = null
    await window.api.playerCleanupRemux()
    return { ok: false, error: `Browser rejected transcoded mime: ${r.mimeType}` }
  }
  startMseSession(r.sessionId, r.generation, r.duration, r.mimeType, r.initialSeek)
  mkvBuffering.value = true
  return { ok: true }
}

async function cancelHevcTranscode(): Promise<void> {
  try { await window.api.playerCleanupRemux() } catch { /* ignore */ }
  transcodingHevc.value = false
  transcodeSpeed.value = null
  emit('close')
}

function startMseSession(sessionId: string, generation: number, duration: number, mimeType: string, initialSeek: number): void {
  streamSessionId.value = sessionId
  currentStreamGen = generation
  mseInitialSeek = initialSeek
  const ms = new MediaSource()
  mediaSource = ms
  mseSrcUrl.value = URL.createObjectURL(ms)
  ms.addEventListener('sourceopen', () => {
    try {
      console.log('[player] sourceopen, adding SourceBuffer:', mimeType, 'initialSeek=', initialSeek)
      const sb = ms.addSourceBuffer(mimeType)
      sourceBuffer = sb
      try { ms.duration = duration } catch (e) { console.warn('[player] set duration failed:', e) }
      if (initialSeek > 0) {
        try { sb.timestampOffset = initialSeek } catch (e) { console.warn('[player] initial timestampOffset failed:', e) }
      }
      sb.addEventListener('updateend', onSourceBufferUpdateEnd)
      sb.addEventListener('error', (e) => console.error('[player] SourceBuffer error event:', e))
      sb.addEventListener('abort', () => console.warn('[player] SourceBuffer abort'))
      window.api.playerStreamStart(sessionId)
      pumpAppendQueue()
    } catch (e) {
      console.error('[player] addSourceBuffer failed:', e)
    }
  }, { once: true })
}

let appendCount = 0
function onSourceBufferUpdateEnd(): void {
  const sb = sourceBuffer
  if (sb && sb.buffered.length > 0) {
    appendCount++
    if (appendCount <= 5 || appendCount % 50 === 0) {
      const ranges: string[] = []
      for (let i = 0; i < sb.buffered.length; i++) {
        ranges.push(`[${sb.buffered.start(i).toFixed(2)}-${sb.buffered.end(i).toFixed(2)}]`)
      }
      console.log(`[player] append #${appendCount} buffered=${ranges.join(',')} t=${(videoRef.value?.currentTime ?? 0).toFixed(2)}`)
    }
    const bufStart = sb.buffered.start(0)
    const t = videoRef.value?.currentTime ?? 0
    if (bufStart < t - 60 && !sb.updating) {
      try { sb.remove(bufStart, Math.max(bufStart + 1, t - 30)) } catch { /* ignore */ }
    }
  }
  pumpAppendQueue()
}

const MAX_BUFFER_AHEAD = 60
function pumpAppendQueue(): void {
  const sb = sourceBuffer
  const ms = mediaSource
  if (!sb || sb.updating || !ms) return
  if (unbufferedSeekInFlight) return

  if (appendQueue.length === 0) {
    if (streamEnded && ms.readyState === 'open') {
      try { ms.endOfStream() } catch { /* ignore */ }
    }
    return
  }

  // Throttle: stop pumping once we have enough lead ahead of the playhead.
  // Without this, SourceBuffer fills to the Chromium quota and eviction would
  // remove the [0, 1] keyframe the playhead is still stuck on, leaving a gap.
  if (sb.buffered.length > 0) {
    const t = videoRef.value?.currentTime ?? 0
    const lead = sb.buffered.end(sb.buffered.length - 1) - t
    if (lead > MAX_BUFFER_AHEAD) return
  }

  const v = videoRef.value
  if (v && v.error) return
  const chunk = appendQueue.shift()!
  try {
    sb.appendBuffer(chunk as unknown as BufferSource)
    pendingAckBytes += chunk.byteLength
    if (pendingAckBytes >= STREAM_ACK_THRESHOLD && streamSessionId.value) {
      const bytes = pendingAckBytes
      pendingAckBytes = 0
      window.api.playerStreamAck(streamSessionId.value, bytes)
    }
  } catch (e) {
    const err = e as DOMException
    if (err.name === 'QuotaExceededError') {
      appendQueue.unshift(chunk)
      // Only evict data strictly behind the playhead. Never drop the range
      // the video element is currently sitting inside, or playback stalls.
      const t = videoRef.value?.currentTime ?? 0
      if (sb.buffered.length > 0 && !sb.updating) {
        const bufStart = sb.buffered.start(0)
        const removeUntil = t - 5
        if (removeUntil > bufStart + 1) {
          try { sb.remove(bufStart, removeUntil) } catch { /* ignore */ }
        }
      }
    } else {
      console.error('[player] appendBuffer failed:', err)
    }
  }
}

let unbufferedSeekInFlight = false
let respawnDebounceTimer: ReturnType<typeof setTimeout> | null = null
const RESPAWN_DEBOUNCE_MS = 250

function maybeRespawnForUnbufferedPosition(): void {
  const v = videoRef.value
  const sb = sourceBuffer
  if (!v || !sb || !streamSessionId.value) return
  // Debounce. Check `currentTime` vs buffered ranges only when the timer fires,
  // so a burst of rapid seeks coalesces into one respawn at the final target.
  if (respawnDebounceTimer) clearTimeout(respawnDebounceTimer)
  respawnDebounceTimer = setTimeout(() => {
    respawnDebounceTimer = null
    if (unbufferedSeekInFlight) return
    const cur = videoRef.value
    const curSb = sourceBuffer
    if (!cur || !curSb) return
    const t = cur.currentTime
    for (let i = 0; i < curSb.buffered.length; i++) {
      if (t >= curSb.buffered.start(i) - 0.25 && t <= curSb.buffered.end(i) + 0.25) return
    }
    // Nothing buffered yet (fresh respawn) — wait for data.
    if (curSb.buffered.length === 0) return
    handleUnbufferedSeek()
  }, RESPAWN_DEBOUNCE_MS)
}

async function waitForBufferAhead(v: HTMLVideoElement, sb: SourceBuffer, seconds: number, timeoutMs: number): Promise<void> {
  const wasPaused = v.paused
  setSyncplayLocalReady(false)
  try { v.pause() } catch { /* ignore */ }
  const deadline = performance.now() + timeoutMs
  try {
    while (performance.now() < deadline) {
      const t = v.currentTime
      for (let i = 0; i < sb.buffered.length; i++) {
        if (t >= sb.buffered.start(i) - 0.25 && sb.buffered.end(i) - t >= seconds) {
          if (!wasPaused) { try { await v.play() } catch { /* ignore */ } }
          return
        }
      }
      await new Promise<void>((res) => setTimeout(res, 200))
    }
    if (!wasPaused) { try { await v.play() } catch { /* ignore */ } }
  } finally {
    setSyncplayLocalReady(true)
  }
}

async function handleUnbufferedSeek(): Promise<void> {
  const v = videoRef.value
  const sb = sourceBuffer
  if (!v || !sb || !streamSessionId.value) return
  const target = v.currentTime
  // If the target falls inside any existing buffered range, the video element
  // handles the seek natively — nothing to do.
  for (let i = 0; i < sb.buffered.length; i++) {
    if (target >= sb.buffered.start(i) - 0.25 && target <= sb.buffered.end(i) + 0.25) {
      return
    }
  }
  if (unbufferedSeekInFlight) return
  unbufferedSeekInFlight = true
  const seekAt = Math.max(0, target - 1)
  console.log(`[player] unbuffered seek → respawn ffmpeg at ${seekAt.toFixed(2)} (target ${target.toFixed(2)})`)
  try {
    // Drop any queued chunks from the old ffmpeg — main will stop sending new
    // ones as soon as the seek IPC below bumps the session generation.
    appendQueue.length = 0
    pendingAckBytes = 0
    const result = await window.api.playerStreamSeek(streamSessionId.value, seekAt)
    if ('error' in result) {
      console.error('[player] stream-seek failed:', result.error)
      return
    }
    // Switch the expected generation so any further in-flight chunks from the
    // old ffmpeg run are dropped, and drain anything stale that arrived in
    // `appendQueue` while we were awaiting the IPC round-trip.
    currentStreamGen = result.generation
    appendQueue.length = 0
    pendingAckBytes = 0
    streamEnded = false
    // Reset the SourceBuffer segment parser. Without this, an interrupted
    // append leaves the parser in PARSING_MEDIA_SEGMENT and any subsequent
    // timestampOffset change or appendBuffer throws. abort() also cancels
    // any in-flight update, so no updateend wait is needed.
    try { sb.abort() } catch (e) { console.warn('[player] sb.abort failed:', e) }
    // Drop old buffered data so the previous audio ahead of us doesn't keep
    // playing while the new fragments arrive and decode.
    try {
      if (sb.buffered.length > 0) {
        sb.remove(sb.buffered.start(0), sb.buffered.end(sb.buffered.length - 1))
        await new Promise<void>((res) => sb.addEventListener('updateend', () => res(), { once: true }))
      }
    } catch (e) {
      console.warn('[player] buffer clear failed:', e)
    }
    if (v.error) {
      console.error('[player] video element errored during seek:', v.error.code, v.error.message)
      return
    }
    try {
      sb.timestampOffset = seekAt
    } catch (e) {
      console.warn('[player] timestampOffset set failed:', e)
    }
    // Release main's buffered prelude for the new ffmpeg run.
    window.api.playerStreamStart(streamSessionId.value)
    // Clear the in-flight flag *before* awaiting the buffer-ahead gate below,
    // otherwise `pumpAppendQueue` refuses to drain incoming chunks (it bails
    // early while the flag is set), the buffer never fills, and the wait
    // times out — manifesting as a ~15s post-seek freeze on transcode.
    unbufferedSeekInFlight = false
    pumpAppendQueue()

    // On the transcode path ffmpeg runs at ~real-time with almost no headroom,
    // so the fresh buffer stays razor-thin and any encoder hiccup stalls the
    // video. Pause playback until we have a few seconds buffered ahead, then
    // let the element resume. Stream-copy doesn't need this — muxing is much
    // faster than real-time and the buffer fills instantly.
    if (transcodingHevc.value) {
      mkvBuffering.value = true
      await waitForBufferAhead(v, sb, 3.0, 15000)
      mkvBuffering.value = false
    }
  } finally {
    unbufferedSeekInFlight = false
    // If the user kept seeking while the respawn was in flight, the playhead
    // may now be outside the fresh buffered range too — re-check.
    maybeRespawnForUnbufferedPosition()
  }
}

let chunkRecvCount = 0
let chunkRecvBytes = 0
function handleStreamChunk(sessionId: string, gen: number, data: Uint8Array): void {
  if (sessionId !== streamSessionId.value) return
  // Drop chunks from an obsolete ffmpeg run. Main bumped its generation on the
  // last seek; anything still arriving with an older `gen` was already in the
  // IPC queue at that point and is now stale media with PTS unrelated to the
  // current timestampOffset.
  if (gen !== currentStreamGen) return
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
  chunkRecvCount++
  chunkRecvBytes += u8.byteLength
  if (chunkRecvCount === 1 || chunkRecvCount % 200 === 0) {
    console.log(`[player] recv chunk #${chunkRecvCount} total=${(chunkRecvBytes / 1024 / 1024).toFixed(1)}MB queue=${appendQueue.length}`)
  }
  appendQueue.push(u8)
  pumpAppendQueue()
}

function handleStreamEnd(sessionId: string): void {
  if (sessionId !== streamSessionId.value) return
  streamEnded = true
  pumpAppendQueue()
}

function handleStreamError(sessionId: string, error: string): void {
  if (sessionId !== streamSessionId.value) return
  console.error('[player] stream error:', error)
  remuxError.value = error
  resetMseState()
}

function resetMseState(): void {
  streamEnded = false
  pendingAckBytes = 0
  appendQueue.length = 0
  mseInitialSeek = 0
  currentStreamGen = 0
  transcodingHevc.value = false
  transcodeSpeed.value = null
  if (sourceBuffer) {
    try { sourceBuffer.removeEventListener('updateend', onSourceBufferUpdateEnd) } catch { /* ignore */ }
    sourceBuffer = null
  }
  if (mediaSource && mediaSource.readyState === 'open') {
    try { mediaSource.endOfStream() } catch { /* ignore */ }
  }
  mediaSource = null
  if (mseSrcUrl.value) {
    try { URL.revokeObjectURL(mseSrcUrl.value) } catch { /* ignore */ }
    mseSrcUrl.value = ''
  }
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// Playback controls
function togglePlay(): void {
  cancelAutoAdvance()
  const video = videoRef.value
  if (!video) return
  if (video.paused) {
    video.play()
  } else {
    video.pause()
  }
}

function seek(time: number): void {
  const video = videoRef.value
  if (!video) return
  video.currentTime = Math.max(0, Math.min(time, duration.value))
}

function seekRelative(delta: number): void {
  const video = videoRef.value
  if (!video) return
  seek(video.currentTime + delta)
}

function setVolume(v: number): void {
  const video = videoRef.value
  if (!video) return
  volume.value = Math.max(0, Math.min(1, v))
  video.volume = volume.value
  if (volume.value > 0 && muted.value) {
    muted.value = false
    video.muted = false
  }
}

function toggleMute(): void {
  const video = videoRef.value
  if (!video) return
  muted.value = !muted.value
  video.muted = muted.value
}

let persistVolumeTimer: ReturnType<typeof setTimeout> | null = null
let suppressVolumePersist = true  // don't write the restored values back on mount
watch([volume, muted], ([v, m]) => {
  if (suppressVolumePersist) return
  if (persistVolumeTimer) clearTimeout(persistVolumeTimer)
  persistVolumeTimer = setTimeout(() => {
    persistVolumeTimer = null
    window.api.setSetting('playerVolume', v)
    window.api.setSetting('playerMuted', m)
  }, 400)
})

function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    containerRef.value?.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
}

function onFullscreenChange(): void {
  isFullscreen.value = !!document.fullscreenElement
  // libass's internal fullscreenchange listener resizes the canvas but does
  // not force a redraw, so a paused frame loses its subtitles. setTrack makes
  // the worker rebuild the track and emit a fresh bitmap at the new canvas
  // size. Delay past the library's own 100ms resize so we hit final geometry.
  setTimeout(() => {
    const content = activeSubtitleContent.value
    if (octopusInstance && content) {
      try { octopusInstance.setTrack(content) } catch { /* ignore */ }
    }
  }, 200)
}

// Controls visibility
function showControlsBriefly(): void {
  showControls.value = true
  if (controlsTimer) clearTimeout(controlsTimer)
  if (playing.value) {
    controlsTimer = setTimeout(() => {
      showControls.value = false
      showPresetMenu.value = false
      showQualityMenu.value = false
      showTranslationMenu.value = false
    }, 3000)
  }
}

function onMouseMove(): void {
  showControlsBriefly()
}

// Video event handlers
function onPlay(): void {
  playing.value = true
  showControlsBriefly()
  lastTimeUpdateAt = Date.now()
  if (Date.now() >= suppressNextLocalEventUntil) {
    syncplayLastRemotePlaying = true
    syncplayLastAppliedPaused = false
    syncplayPausedBy.value = null
  }
  sendSyncplayLocalState('play')
  applySyncplayReadyGate()
}

function onPause(): void {
  playing.value = false
  showControls.value = true
  if (controlsTimer) clearTimeout(controlsTimer)
  lastTimeUpdateAt = 0
  saveProgress(true)
  if (Date.now() >= suppressNextLocalEventUntil) {
    syncplayLastRemotePlaying = false
    syncplayLastAppliedPaused = true
    if (syncplayStatus.value.state === 'ready' && syncplayStatus.value.username) {
      syncplayPausedBy.value = syncplayStatus.value.username
    }
  }
  sendSyncplayLocalState('pause')
}

function onTimeUpdate(): void {
  if (!seeking.value && videoRef.value) {
    currentTime.value = videoRef.value.currentTime
  }
  trackProgressDelta(Date.now())
  saveProgress()
  maybeMarkWatched()
  maybeMarkPendingPrevWatched()
}

function onDurationChange(): void {
  if (videoRef.value) {
    duration.value = videoRef.value.duration
  }
  pushSyncplayFile()
}

function onProgress(): void {
  const video = videoRef.value
  if (!video || video.buffered.length === 0) return
  buffered.value = video.buffered.end(video.buffered.length - 1)
}

function onCanPlay(): void {
  if (mkvBuffering.value) mkvBuffering.value = false
  if (syncplayWaitingTimer) {
    clearTimeout(syncplayWaitingTimer)
    syncplayWaitingTimer = null
  }
  setSyncplayLocalReady(true)
}

function onSeekStart(): void {
  seeking.value = true
}

function onSeekInput(event: Event): void {
  const target = event.target as HTMLInputElement
  const time = parseFloat(target.value)
  currentTime.value = time
  // Apply seek immediately during drag for responsive feedback
  const video = videoRef.value
  if (video) video.currentTime = time
}

function onSeekEnd(): void {
  seeking.value = false
}

function onSeekMouseMove(e: MouseEvent): void {
  const container = (e.currentTarget as HTMLElement).parentElement
  if (!container || duration.value <= 0) return
  const rect = container.getBoundingClientRect()
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
  const ratio = x / rect.width
  const time = ratio * duration.value
  // Append OP/ED label when hovering inside a detected band so the user gets
  // feedback even though the bands themselves are pointer-events: none.
  const ep = currentEpisodeSkip.value
  let label = formatTime(time)
  if (ep) {
    if (ep.op && time >= ep.op.startSec && time < ep.op.endSec) {
      label = `${formatTime(time)} · OP`
    } else if (ep.ed && time >= ep.ed.startSec && time < ep.ed.endSec) {
      label = `${formatTime(time)} · ED`
    }
  }
  seekTooltipTime.value = label
  seekTooltipLeft.value = x
  seekTooltipVisible.value = true
}

function onSeekMouseLeave(): void {
  seekTooltipVisible.value = false
}

function onVolumeInput(event: Event): void {
  const target = event.target as HTMLInputElement
  setVolume(parseFloat(target.value))
}

function handleClose(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    emit('close')
  }
}

function onAuxMouseUp(e: MouseEvent): void {
  if (e.button === 3) {
    e.stopImmediatePropagation()
    e.preventDefault()
    handleClose()
  } else if (e.button === 1) {
    e.stopImmediatePropagation()
    e.preventDefault()
    togglePlay()
  }
}

// Suppress middle-click autoscroll cursor; the actual toggle happens on mouseup.
function onAuxMouseDown(e: MouseEvent): void {
  if (e.button === 1) e.preventDefault()
}

// Keyboard shortcuts
const isMac = navigator.platform.toUpperCase().includes('MAC')

function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase())
  const needCtrl = mods.includes('ctrl')
  const needMeta = mods.includes('meta')
  const needCmdOrCtrl = mods.includes('cmdorctrl')
  const needShift = mods.includes('shift')
  const needAlt = mods.includes('alt')
  const wantCtrl = needCtrl || (needCmdOrCtrl && !isMac)
  const wantMeta = needMeta || (needCmdOrCtrl && isMac)
  if (e.ctrlKey !== wantCtrl) return false
  if (e.metaKey !== wantMeta) return false
  if (e.shiftKey !== needShift) return false
  if (e.altKey !== needAlt) return false
  return e.key.toLowerCase() === key.toLowerCase()
}

function onKeyDown(event: KeyboardEvent): void {
  event.stopPropagation()
  const target = event.target as HTMLElement | null
  const tag = target?.tagName
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

  const prevBinding = playerShortcuts.value.playerPrevEpisode || 'Shift+ArrowLeft'
  const nextBinding = playerShortcuts.value.playerNextEpisode || 'Shift+ArrowRight'
  if (matchesBinding(event, prevBinding)) {
    event.preventDefault()
    if (canPrev.value) goToEpisode('prev')
    return
  }
  if (matchesBinding(event, nextBinding)) {
    event.preventDefault()
    if (canNext.value) goToEpisode('next')
    return
  }

  if (webgpuAvailable.value) {
    const shaderBindings: [string, 'mode-a' | 'mode-b' | 'mode-c' | 'off'][] = [
      [playerShortcuts.value.shaderModeA || 'CmdOrCtrl+1', 'mode-a'],
      [playerShortcuts.value.shaderModeB || 'CmdOrCtrl+2', 'mode-b'],
      [playerShortcuts.value.shaderModeC || 'CmdOrCtrl+3', 'mode-c'],
      [playerShortcuts.value.shaderOff || 'CmdOrCtrl+Backquote', 'off']
    ]
    for (const [binding, preset] of shaderBindings) {
      if (matchesBinding(event, binding)) {
        event.preventDefault()
        selectPreset(preset)
        showControlsBriefly()
        return
      }
    }
  }

  switch (event.key) {
    case ' ':
    case 'k':
    case 'K':
      event.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      event.preventDefault()
      seekRelative(-5)
      showControlsBriefly()
      break
    case 'ArrowRight':
      event.preventDefault()
      seekRelative(5)
      showControlsBriefly()
      break
    case 'ArrowUp':
      event.preventDefault()
      setVolume(volume.value + 0.05)
      showControlsBriefly()
      break
    case 'ArrowDown':
      event.preventDefault()
      setVolume(volume.value - 0.05)
      showControlsBriefly()
      break
    case 'f':
    case 'F':
      event.preventDefault()
      toggleFullscreen()
      break
    case 'm':
    case 'M':
      event.preventDefault()
      toggleMute()
      showControlsBriefly()
      break
    case 'Escape':
      event.preventDefault()
      handleClose()
      break
  }
}

// Anime4K WebGPU setup
async function initWebGPU(): Promise<void> {
  try {
    if (!navigator.gpu) return
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return
    const info = adapter.info
    gpuName.value = info.device || info.description || info.vendor || 'Unknown GPU'
    gpuDevice = await adapter.requestDevice()
    webgpuAvailable.value = true
  } catch (e) {
    console.warn('[player] WebGPU init failed:', e)
  }
}

async function startAnime4KPipeline(): Promise<void> {
  stopAnime4KPipeline()

  const video = videoRef.value
  const canvas = canvasRef.value
  if (!video || !canvas || !gpuDevice || anime4kPreset.value === 'off') return
  if (!video.videoWidth || !video.videoHeight) return

  try {
    const { ModeA, ModeB, ModeC } = await import('anime4k-webgpu')
    const device = gpuDevice

    const PresetClass = {
      'mode-a': ModeA,
      'mode-b': ModeB,
      'mode-c': ModeC
    }[anime4kPreset.value]
    if (!PresetClass) return

    const WIDTH = video.videoWidth
    const HEIGHT = video.videoHeight

    // Create input texture for video frames
    const videoFrameTexture = device.createTexture({
      size: [WIDTH, HEIGHT, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    })

    // Target dimensions: use screen size (capped to avoid excessive GPU load)
    const screenW = Math.round(window.screen.width * window.devicePixelRatio)
    const screenH = Math.round(window.screen.height * window.devicePixelRatio)
    // Don't upscale beyond screen resolution
    const targetW = Math.min(screenW, WIDTH * 2)
    const targetH = Math.min(screenH, HEIGHT * 2)

    // Create the Anime4K pipeline
    const pipeline = new PresetClass({
      device,
      inputTexture: videoFrameTexture,
      nativeDimensions: { width: WIDTH, height: HEIGHT },
      targetDimensions: { width: targetW, height: targetH }
    })

    // Set canvas size to pipeline output
    const outputTex = pipeline.getOutputTexture()
    canvas.width = outputTex.width
    canvas.height = outputTex.height

    // Configure canvas WebGPU context
    const context = canvas.getContext('webgpu') as GPUCanvasContext
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format: presentationFormat, alphaMode: 'premultiplied' })

    // Create render pipeline (fullscreen quad to display output texture)
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }
      ]
    })

    const renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: device.createShaderModule({ code: FULLSCREEN_QUAD_VERT }),
        entryPoint: 'vert_main'
      },
      fragment: {
        module: device.createShaderModule({ code: FULLSCREEN_QUAD_FRAG }),
        entryPoint: 'main',
        targets: [{ format: presentationFormat }]
      },
      primitive: { topology: 'triangle-list' }
    })

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: outputTex.createView() }
      ]
    })

    pipelineActive = true

    function frame(): void {
      if (!pipelineActive) return

      try {
        // Copy current video frame to input texture
        device.queue.copyExternalImageToTexture(
          { source: video! },
          { texture: videoFrameTexture },
          [WIDTH, HEIGHT]
        )

        const commandEncoder = device.createCommandEncoder()

        // Run Anime4K compute shaders
        pipeline.pass(commandEncoder)

        // Render output to canvas
        const passEncoder = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store'
          }]
        })
        passEncoder.setPipeline(renderPipeline)
        passEncoder.setBindGroup(0, bindGroup)
        passEncoder.draw(6)
        passEncoder.end()

        device.queue.submit([commandEncoder.finish()])
      } catch (e) {
        console.warn('[player] Anime4K frame error:', e)
        pipelineActive = false
        return
      }

      video!.requestVideoFrameCallback(frame)
    }

    video.requestVideoFrameCallback(frame)
  } catch (e) {
    console.error('[player] Anime4K pipeline error:', e)
  }
}

function stopAnime4KPipeline(): void {
  pipelineActive = false
}

// Watch preset changes
watch(anime4kPreset, async (newPreset) => {
  await window.api.setSetting('anime4kPreset', newPreset)
  if (newPreset === 'off') {
    stopAnime4KPipeline()
  } else if (webgpuAvailable.value && videoRef.value?.videoWidth) {
    await startAnime4KPipeline()
  }
})

function selectPreset(preset: 'off' | 'mode-a' | 'mode-b' | 'mode-c'): void {
  anime4kPreset.value = preset
  showPresetMenu.value = false
}

const presetLabel = computed(() => {
  const labels: Record<string, string> = {
    'off': 'A4K Off',
    'mode-a': 'A4K: A',
    'mode-b': 'A4K: B',
    'mode-c': 'A4K: C'
  }
  return labels[anime4kPreset.value] || 'A4K'
})

function qualityLabel(height: number): string {
  return height + 'p'
}

const currentQualityLabel = computed(() => {
  if (!selectedHeight.value) return ''
  return qualityLabel(selectedHeight.value)
})

function selectQuality(stream: { height: number; url: string }): void {
  if (stream.height === selectedHeight.value) {
    showQualityMenu.value = false
    return
  }
  const video = videoRef.value
  const savedTime = video ? video.currentTime : 0
  const wasPlaying = video ? !video.paused : false

  activeStreamUrl.value = stream.url
  selectedHeight.value = stream.height
  showQualityMenu.value = false

  nextTick(() => {
    const v = videoRef.value
    if (!v) return
    v.currentTime = savedTime
    if (wasPlaying) v.play()
  })
}

// Translation selector
const TRANSLATION_TYPE_LABELS: Record<string, string> = {
  subRu: 'RU SUB',
  subEn: 'EN SUB',
  voiceRu: 'RU DUB',
  voiceEn: 'EN DUB',
  raw: 'RAW'
}

function translationTypeLabel(type: string): string {
  return TRANSLATION_TYPE_LABELS[type] || type
}

const currentTranslation = computed(() =>
  activeTranslations.value.find(t => t.id === activeTranslationId.value)
)

const currentTranslationLabel = computed(() => {
  const tr = currentTranslation.value
  if (!tr) return 'Translation'
  return `${tr.label}`
})

const translationTypeGroups = computed(() => {
  const groups: Record<string, { id: number; label: string; type: string; height: number }[]> = {}
  for (const tr of activeTranslations.value) {
    const key = tr.type
    if (!groups[key]) groups[key] = []
    groups[key].push(tr)
  }
  return Object.entries(groups).map(([type, items]) => ({ type, label: translationTypeLabel(type), items }))
})

const selectedGroupItems = computed(() => {
  const group = translationTypeGroups.value.find(g => g.type === selectedTypeGroup.value)
  return group ? group.items : []
})

function toggleTranslationMenu(): void {
  showTranslationMenu.value = !showTranslationMenu.value
  if (showTranslationMenu.value) {
    const groups = translationTypeGroups.value
    const current = currentTranslation.value
    if (groups.length === 1) {
      translationMenuLevel.value = 'items'
      selectedTypeGroup.value = groups[0].type
    } else if (current && groups.some(g => g.type === current.type)) {
      translationMenuLevel.value = 'items'
      selectedTypeGroup.value = current.type
    } else {
      translationMenuLevel.value = 'types'
      selectedTypeGroup.value = ''
    }
  }
}

function openTypeGroup(type: string): void {
  selectedTypeGroup.value = type
  translationMenuLevel.value = 'items'
}

function backToTypes(): void {
  translationMenuLevel.value = 'types'
  selectedTypeGroup.value = ''
}

async function selectTranslation(tr: { id: number; label: string; type: string; height: number }): Promise<void> {
  if (tr.id === activeTranslationId.value) {
    showTranslationMenu.value = false
    return
  }

  const video = videoRef.value
  const savedTime = video ? video.currentTime : 0
  const wasPlaying = video ? !video.paused : false

  switchingTranslation.value = true
  showTranslationMenu.value = false

  try {
    // Check if this translation has a local file
    if (activeDownloadedTrIds.value.includes(tr.id)) {
      const currentEp = props.allEpisodes[activeEpisodeIndex.value]
      const friendlyLabel = currentEp?.episodeFull || activeEpisodeLabel.value
      const localResult = await window.api.playerFindLocalFile(props.animeName, activeEpisodeLabel.value, tr.id, friendlyLabel)
      if (localResult) {
        activeTranslationId.value = tr.id

        // Clean up previous remux / stream session if any
        if (remuxedPath.value || streamSessionId.value) {
          await window.api.playerCleanupRemux()
          remuxedPath.value = ''
          streamSessionId.value = ''
          resetMseState()
        }

        // Switch to local file
        activeFilePath.value = localResult.filePath
        activeStreamUrl.value = ''
        activeSubtitleContent.value = localResult.subtitleContent || ''

        if (localResult.filePath.toLowerCase().endsWith('.mkv')) {
          const prep = await prepareMkvForPlayback(localResult.filePath)
          if (!prep.ok) {
            remuxError.value = prep.error
            switchingTranslation.value = false
            return
          }
        }

        // Update subtitles
        destroySubtitles()
        if (activeSubtitleContent.value && video) {
          initSubtitles(video)
        }

        nextTick(() => {
          const v = videoRef.value
          if (!v) return
          v.currentTime = savedTime
          if (wasPlaying) v.play()
          switchingTranslation.value = false
        })
        return
      }
    }

    // Fall back to streaming
    const result = await window.api.playerGetStreamUrl(tr.id, tr.height)
    if (!result) {
      switchingTranslation.value = false
      return
    }

    activeTranslationId.value = tr.id

    // Clean up previous remux / MSE stream if switching from local to stream
    if (remuxedPath.value || streamSessionId.value) {
      await window.api.playerCleanupRemux()
      remuxedPath.value = ''
      streamSessionId.value = ''
      resetMseState()
    }

    activeFilePath.value = ''
    activeStreamUrl.value = result.streamUrl
    activeSubtitleContent.value = result.subtitleContent || ''

    // Update available quality streams
    if (result.availableStreams.length > 0) {
      const current = result.availableStreams.find(s => s.url === result.streamUrl)
      selectedHeight.value = current ? current.height : result.availableStreams[0].height
    }

    // Update subtitles
    destroySubtitles()
    if (result.subtitleContent && video) {
      initSubtitles(video)
    }

    nextTick(() => {
      const v = videoRef.value
      if (!v) return
      v.currentTime = savedTime
      if (wasPlaying) v.play()
      switchingTranslation.value = false
    })
  } catch {
    switchingTranslation.value = false
  }
}

async function goToEpisode(direction: 'prev' | 'next'): Promise<void> {
  const targetIndex = direction === 'prev' ? activeEpisodeIndex.value - 1 : activeEpisodeIndex.value + 1
  if (targetIndex < 0 || targetIndex >= props.allEpisodes.length) return
  if (navigating.value) return

  // Persist current episode progress before leaving
  await saveProgress(true)
  const prevEpisodeInt = currentEpisodeInt.value

  cancelAutoAdvance()
  navigating.value = true
  const video = videoRef.value
  const targetEp = props.allEpisodes[targetIndex]

  // Find the current translation type for resolution
  const currentTr = activeTranslations.value.find(t => t.id === activeTranslationId.value)
  const currentType = currentTr?.type || ''

  // Resolution priority chain
  let resolvedTr: { id: number; label: string; type: string; height: number } | null = null
  let forceLocal = false

  // (a) Prefer any downloaded translation on the target episode
  if (targetEp.downloadedTrIds.length > 0) {
    // Prefer same translationId if it's downloaded
    const sameIdDownloaded = targetEp.translations.find(
      t => t.id === activeTranslationId.value && targetEp.downloadedTrIds.includes(t.id)
    )
    if (sameIdDownloaded) {
      resolvedTr = sameIdDownloaded
    } else {
      // Pick the best quality downloaded translation of the same type, or any downloaded
      const downloadedTrs = targetEp.translations.filter(t => targetEp.downloadedTrIds.includes(t.id))
      const sameTypeDownloaded = downloadedTrs.filter(t => t.type === currentType).sort((a, b) => b.height - a.height)
      resolvedTr = sameTypeDownloaded[0] || downloadedTrs[0] || null
    }
    if (resolvedTr) forceLocal = true
  }

  // (b) Same translationId if available in target episode (stream)
  if (!resolvedTr) {
    resolvedTr = targetEp.translations.find(t => t.id === activeTranslationId.value) || null
  }

  // (c) Best quality of same type (stream)
  if (!resolvedTr) {
    const sameType = targetEp.translations
      .filter(t => t.type === currentType)
      .sort((a, b) => b.height - a.height)
    resolvedTr = sameType[0] || null
  }

  // (d) First available translation (stream)
  if (!resolvedTr) {
    resolvedTr = targetEp.translations[0] || null
  }

  if (!resolvedTr) {
    navigating.value = false
    return
  }

  try {
    // Clean up previous remux / MSE stream
    if (remuxedPath.value || streamSessionId.value) {
      await window.api.playerCleanupRemux()
      remuxedPath.value = ''
      streamSessionId.value = ''
      resetMseState()
    }

    // Update episode state
    activeEpisodeIndex.value = targetIndex
    activeEpisodeLabel.value = targetEp.episodeInt
    activeTranslations.value = targetEp.translations
    activeDownloadedTrIds.value = targetEp.downloadedTrIds
    activeTranslationId.value = resolvedTr.id
    resetEpisodeTracking()
    pendingPrevEpisodeInt = direction === 'next' ? prevEpisodeInt : ''

    // Try local file first if downloaded (forceLocal means we specifically chose a downloaded translation)
    if (forceLocal || targetEp.downloadedTrIds.includes(resolvedTr.id)) {
      const localResult = await window.api.playerFindLocalFile(props.animeName, targetEp.episodeInt, resolvedTr.id, targetEp.episodeFull)
      if (localResult) {
        activeFilePath.value = localResult.filePath
        activeStreamUrl.value = ''
        activeSubtitleContent.value = localResult.subtitleContent || ''

        if (localResult.filePath.toLowerCase().endsWith('.mkv')) {
          if (remuxedPath.value || streamSessionId.value) {
            await window.api.playerCleanupRemux()
            remuxedPath.value = ''
            streamSessionId.value = ''
            resetMseState()
          }
          const prep = await prepareMkvForPlayback(localResult.filePath)
          if (!prep.ok) {
            remuxError.value = prep.error
            navigating.value = false
            return
          }
        }

        destroySubtitles()
        if (activeSubtitleContent.value && video) initSubtitles(video)

        nextTick(() => {
          const v = videoRef.value
          if (v) {
            v.currentTime = 0
            v.addEventListener('loadedmetadata', () => resumeFromSavedPosition(), { once: true })
            v.play()
          }
          navigating.value = false
        })
        return
      }
    }

    // Fall back to streaming
    const result = await window.api.playerGetStreamUrl(resolvedTr.id, resolvedTr.height)
    if (!result) { navigating.value = false; return }

    activeFilePath.value = ''
    activeStreamUrl.value = result.streamUrl
    activeSubtitleContent.value = result.subtitleContent || ''

    if (result.availableStreams.length > 0) {
      const current = result.availableStreams.find(s => s.url === result.streamUrl)
      selectedHeight.value = current ? current.height : result.availableStreams[0].height
    }

    destroySubtitles()
    if (result.subtitleContent && video) initSubtitles(video)

    nextTick(() => {
      const v = videoRef.value
      if (v) {
        v.currentTime = 0
        v.addEventListener('loadedmetadata', () => resumeFromSavedPosition(), { once: true })
        v.play()
      }
      navigating.value = false
    })
  } catch {
    navigating.value = false
  }
}

function cancelAutoAdvance(): void {
  if (autoAdvanceTimer) {
    clearInterval(autoAdvanceTimer)
    autoAdvanceTimer = null
  }
  autoAdvanceCountdown.value = 0
}

function onVideoEnded(): void {
  if (!canNext.value) return
  if (autoAdvanceTimer) return
  autoAdvanceCountdown.value = 5
  autoAdvanceTimer = setInterval(() => {
    autoAdvanceCountdown.value--
    if (autoAdvanceCountdown.value <= 0) {
      cancelAutoAdvance()
      goToEpisode('next')
    }
  }, 1000)
}

function initSubtitles(video: HTMLVideoElement): void {
  const content = activeSubtitleContent.value
  if (!content) return
  destroySubtitles()

  try {
    const libassBase = new URL('./libass/', document.baseURI).href
    octopusInstance = new SubtitlesOctopus({
      video,
      subContent: content,
      workerUrl: libassBase + 'subtitles-octopus-worker.js',
      legacyWorkerUrl: libassBase + 'subtitles-octopus-worker-legacy.js',
      fallbackFont: libassBase + 'default.woff2',
      lossyRender: true,
      prescaleFactor: 0.8,
      maxRenderHeight: 0
    })
  } catch (e) {
    console.error('Failed to initialize subtitle renderer:', e)
  }
}

function destroySubtitles(): void {
  if (octopusInstance) {
    try {
      octopusInstance.dispose()
    } catch { /* ignore cleanup errors */ }
    octopusInstance = null
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('mouseup', onAuxMouseUp, true)
  window.addEventListener('mousedown', onAuxMouseDown, true)
  const savedShortcuts = await window.api.getSetting('keyboardShortcuts') as Record<string, string> | null
  playerShortcuts.value = { ...DEFAULT_PLAYER_SHORTCUTS, ...(savedShortcuts || {}) }

  loadSkipDetections()
  window.api.onSkipDetectorSignatureUpdated((data) => {
    if (data.animeId !== props.animeId) return
    loadSkipDetections()
  })

  // Subtitles extracted from MKV streams arrive asynchronously via IPC.
  window.api.onPlayerStreamSubtitles(({ sessionId, content }) => {
    if (sessionId !== streamSessionId.value) return
    if (activeSubtitleContent.value) return
    activeSubtitleContent.value = content
    const v = videoRef.value
    if (v) {
      destroySubtitles()
      initSubtitles(v)
    }
  })

  // MSE fragmented MP4 chunks / end / error events.
  window.api.onPlayerStreamChunk(({ sessionId, gen, data }) => handleStreamChunk(sessionId, gen, data))
  window.api.onPlayerStreamEnd(({ sessionId }) => handleStreamEnd(sessionId))
  window.api.onPlayerStreamError(({ sessionId, error }) => handleStreamError(sessionId, error))
  window.api.onPlayerStreamProgress(({ sessionId, gen, speed }) => {
    if (sessionId !== streamSessionId.value) return
    if (gen !== currentStreamGen) return
    if (typeof speed === 'number' && isFinite(speed)) transcodeSpeed.value = speed
  })

  // Syncplay listeners
  try {
    syncplayStatus.value = await window.api.syncplayGetStatus()
  } catch { /* ignore */ }
  const cfg = await window.api.getSetting('syncplay') as { lastRoom?: string } | null
  if (cfg?.lastRoom) syncplayRoomInput.value = cfg.lastRoom

  syncplayConnectionStatusHandler = (status): void => {
    const wasReady = syncplayStatus.value.state === 'ready'
    console.log('[syncplay] status:', status.state, status.error ? `error=${status.error}` : '')
    syncplayStatus.value = status
    if (status.state === 'ready' && !wasReady) {
      pushSyncplayFile()
    }
    if (status.state === 'idle' || status.state === 'disconnected') {
      syncplayLocalReady = true
      syncplayLastRemotePlaying = false
      syncplayLastAppliedPaused = null
      syncplayPausedBy.value = null
      if (syncplayWaitingTimer) {
        clearTimeout(syncplayWaitingTimer)
        syncplayWaitingTimer = null
      }
    }
    if (status.state === 'reconnecting') {
      showSyncplayToast('Reconnecting to Syncplay server…', 8000)
    } else if (status.state === 'disconnected') {
      showSyncplayToast(status.error ? `Disconnected: ${status.error}` : 'Disconnected from Syncplay', 8000)
    }
  }
  syncplayRemoteStateHandler = (state): void => {
    applyRemoteState(state)
  }
  syncplayRoomUsersHandler = (users): void => {
    syncplayRoomUsers.value = users
    applySyncplayReadyGate()
  }
  syncplayRoomEventHandler = (ev): void => {
    if (ev.level === 'warn' || ev.level === 'error') {
      console.warn('[syncplay]', ev.text)
    } else {
      console.log('[syncplay]', ev.text)
    }
    const ms = ev.level === 'warn' || ev.level === 'error' ? 8000 : 3500
    showSyncplayToast(ev.text, ms)
  }
  syncplayTraceHandler = (entry): void => {
    const arrow = entry.dir === 'in' ? '<<' : '>>'
    let flat: string
    try {
      flat = JSON.stringify(entry.msg)
    } catch {
      flat = String(entry.msg)
    }
    console.log(`[syncplay] ${arrow} ${entry.keys} ${flat}`)
  }
  syncplayRemoteEpisodeChangeHandler = (ep): void => {
    if (ep.animeId !== props.animeId) {
      showSyncplayToast(`${ep.fromUser} switched to a different anime — not loaded here`)
      return
    }
    const idx = props.allEpisodes.findIndex((e) => e.episodeInt === ep.episodeInt)
    if (idx < 0) {
      showSyncplayToast(`${ep.fromUser} moved to episode ${ep.episodeInt} (not available)`)
      return
    }
    if (idx === activeEpisodeIndex.value) return
    showSyncplayToast(`${ep.fromUser} moved to episode ${ep.episodeInt}`)
    const dir = idx > activeEpisodeIndex.value ? 'next' : 'prev'
    // goToEpisode moves one step; step toward target in a loop.
    const stepTowards = async (): Promise<void> => {
      while (activeEpisodeIndex.value !== idx && !navigating.value) {
        await goToEpisode(dir)
      }
    }
    stepTowards()
  }

  window.api.onSyncplayConnectionStatus(syncplayConnectionStatusHandler)
  window.api.onSyncplayRemoteState(syncplayRemoteStateHandler)
  window.api.onSyncplayRoomUsers(syncplayRoomUsersHandler)
  window.api.onSyncplayRoomEvent(syncplayRoomEventHandler)
  window.api.onSyncplayTrace(syncplayTraceHandler)
  window.api.onSyncplayRemoteEpisodeChange(syncplayRemoteEpisodeChangeHandler)

  // 1-second snapshot push so main's heartbeat has fresh position.
  syncplaySnapshotTimer = setInterval(() => {
    if (syncplayStatus.value.state !== 'ready') return
    const v = videoRef.value
    if (!v) return
    window.api.syncplaySendLocalSnapshot({
      position: v.currentTime,
      paused: v.paused
    })
  }, 1000)

  // Diagnostic listeners on the video element to see why MSE playback stalls.
  watch(videoRef, (v) => {
    if (!v) return
    v.addEventListener('waiting', () => console.warn(`[player] video 'waiting' t=${v.currentTime.toFixed(2)} readyState=${v.readyState}`))
    v.addEventListener('stalled', () => console.warn(`[player] video 'stalled' t=${v.currentTime.toFixed(2)} readyState=${v.readyState}`))
    v.addEventListener('error', () => {
      const e = v.error
      console.error(`[player] video element error: code=${e?.code} message=${e?.message} networkState=${v.networkState} readyState=${v.readyState}`)
    })
    v.addEventListener('timeupdate', () => pumpAppendQueue())
    // Fires on every seek attempt (slider drag, arrow-key auto-repeat). Debounce
    // so a burst collapses into one respawn at the final target — native seeks
    // inside the buffered range are filtered out in the debounced callback.
    v.addEventListener('seeking', () => maybeRespawnForUnbufferedPosition())
  }, { immediate: true })

  // Start MKV remux stream (or fall back to legacy full remux)
  if (isMkv.value && props.filePath) {
    try {
      const prep = await prepareMkvForPlayback(props.filePath)
      if (!prep.ok) {
        remuxError.value = prep.error
        return
      }
    } catch (e) {
      remuxError.value = String(e)
      return
    }
  }

  // Initialize quality from available streams
  if (props.streamUrl && props.availableStreams.length > 0) {
    const current = props.availableStreams.find(s => s.url === props.streamUrl)
    selectedHeight.value = current ? current.height : props.availableStreams[0].height
  }

  // Load saved preset
  const savedPreset = await window.api.getSetting('anime4kPreset') as string
  if (savedPreset && ['off', 'mode-a', 'mode-b', 'mode-c'].includes(savedPreset)) {
    anime4kPreset.value = savedPreset as typeof anime4kPreset.value
  }

  // Restore saved volume + mute
  const savedVolume = await window.api.getSetting('playerVolume') as number | null
  if (typeof savedVolume === 'number' && savedVolume >= 0 && savedVolume <= 1) {
    volume.value = savedVolume
  }
  const savedMuted = await window.api.getSetting('playerMuted') as boolean | null
  if (typeof savedMuted === 'boolean') {
    muted.value = savedMuted
  }
  await nextTick()
  suppressVolumePersist = false

  await initWebGPU()

  // Wait for video to be ready, then start pipeline if needed
  await nextTick()
  const video = videoRef.value
  if (video) {
    video.volume = volume.value
    video.muted = muted.value
    const onVideoReady = async (): Promise<void> => {
      if (anime4kPreset.value !== 'off' && webgpuAvailable.value) {
        await startAnime4KPipeline()
      }
      if (activeSubtitleContent.value) {
        initSubtitles(video)
      }
    }

    if (video.readyState >= 1) {
      onVideoReady()
    } else {
      video.addEventListener('loadedmetadata', onVideoReady, { once: true })
    }

    // Resume from saved position
    if (video.readyState >= 1) {
      resumeFromSavedPosition()
    } else {
      video.addEventListener('loadedmetadata', () => resumeFromSavedPosition(), { once: true })
    }
  }
})

onBeforeUnmount(() => {
  saveProgress(true)
  if (resumeToastTimer) clearTimeout(resumeToastTimer)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.removeEventListener('mouseup', onAuxMouseUp, true)
  window.removeEventListener('mousedown', onAuxMouseDown, true)
  if (controlsTimer) clearTimeout(controlsTimer)
  if (streamingBannerTimer) {
    clearTimeout(streamingBannerTimer)
    streamingBannerTimer = null
  }
  if (persistVolumeTimer) {
    clearTimeout(persistVolumeTimer)
    persistVolumeTimer = null
  }
  if (skipButtonGraceTimer) {
    clearTimeout(skipButtonGraceTimer)
    skipButtonGraceTimer = null
  }
  window.api.offSkipDetectorSignatureUpdated()
  // Unblock any awaiter of askHevcChoice() so prepareMkvForPlayback unwinds.
  if (hevcPromptResolver) {
    const fn = hevcPromptResolver
    hevcPromptResolver = null
    hevcPromptOpen.value = false
    fn('cancel')
  }
  cancelAutoAdvance()
  stopAnime4KPipeline()
  destroySubtitles()
  // Pause and release video
  const video = videoRef.value
  if (video) {
    video.pause()
    video.src = ''
    video.load()
  }
  if (gpuDevice) {
    gpuDevice.destroy()
    gpuDevice = null
  }
  // Stop listening for stream events
  window.api.offPlayerStreamSubtitles()
  window.api.offPlayerStreamChunk()
  window.api.offPlayerStreamEnd()
  window.api.offPlayerStreamError()
  window.api.offPlayerStreamProgress()
  if (syncplayConnectionStatusHandler) {
    window.api.offSyncplayConnectionStatus(syncplayConnectionStatusHandler)
    syncplayConnectionStatusHandler = null
  }
  if (syncplayRemoteStateHandler) {
    window.api.offSyncplayRemoteState(syncplayRemoteStateHandler)
    syncplayRemoteStateHandler = null
  }
  if (syncplayRoomUsersHandler) {
    window.api.offSyncplayRoomUsers(syncplayRoomUsersHandler)
    syncplayRoomUsersHandler = null
  }
  if (syncplayRoomEventHandler) {
    window.api.offSyncplayRoomEvent(syncplayRoomEventHandler)
    syncplayRoomEventHandler = null
  }
  if (syncplayRemoteEpisodeChangeHandler) {
    window.api.offSyncplayRemoteEpisodeChange(syncplayRemoteEpisodeChangeHandler)
    syncplayRemoteEpisodeChangeHandler = null
  }
  if (syncplayTraceHandler) {
    window.api.offSyncplayTrace(syncplayTraceHandler)
    syncplayTraceHandler = null
  }
  if (syncplaySnapshotTimer) {
    clearInterval(syncplaySnapshotTimer)
    syncplaySnapshotTimer = null
  }
  if (syncplayToastTimer) {
    clearTimeout(syncplayToastTimer)
    syncplayToastTimer = null
  }
  if (syncplayWaitingTimer) {
    clearTimeout(syncplayWaitingTimer)
    syncplayWaitingTimer = null
  }
  resetMseState()
  // Clean up remuxed temp files / active stream sessions
  if (remuxedPath.value || streamSessionId.value) {
    window.api.playerCleanupRemux()
  }
})

const seekProgress = computed(() => {
  if (duration.value <= 0) return 0
  return (currentTime.value / duration.value) * 100
})

const bufferedProgress = computed(() => {
  if (duration.value <= 0) return 0
  return (buffered.value / duration.value) * 100
})
</script>

<template>
  <div
    ref="containerRef"
    class="player-overlay"
    @mousemove="onMouseMove"
    @click.self="togglePlay"
  >
    <!-- Remuxing MKV overlay (legacy full-remux fallback only) -->
    <div v-if="remuxing" class="remux-overlay">
      <div class="remux-modal">
        <div class="remux-spinner"></div>
        <p class="remux-title">Preparing MKV for playback...</p>
        <p class="remux-hint">Remuxing to MP4 (stream copy, no re-encoding)</p>
      </div>
    </div>

    <!-- HEVC consent modal when MSE rejects the track -->
    <div v-if="hevcPromptOpen" class="remux-overlay">
      <div class="remux-modal">
        <p class="remux-title">HEVC not supported by the built-in player</p>
        <p class="remux-hint">
          This file uses HEVC (H.265) and your platform has no decoder Chromium can use.
          Transcoding to H.264 on the fly lets the built-in player play it, at the cost of extra CPU/GPU.
        </p>
        <div class="hevc-prompt-buttons">
          <button class="remux-close-btn" @click="resolveHevcPrompt('transcode')">Transcode this file</button>
          <button class="remux-close-btn" @click="resolveHevcPrompt('always-transcode')">Always transcode HEVC</button>
          <button class="remux-close-btn" @click="resolveHevcPrompt('external')">Open in external player</button>
          <button class="remux-close-btn" @click="resolveHevcPrompt('cancel')">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Streaming MKV: subtle toast while the first seconds buffer -->
    <transition name="fade">
      <div v-if="mkvBuffering" class="mkv-buffering-toast">
        {{ transcodingHevc ? transcodeLabel : 'Buffering MKV…' }}
        <button v-if="transcodingHevc" class="mkv-cancel-btn" @click="cancelHevcTranscode">Cancel</button>
      </div>
    </transition>

    <!-- Remux error overlay -->
    <div v-if="remuxError" class="remux-overlay">
      <div class="remux-modal">
        <p class="remux-title remux-error-title">Failed to prepare MKV</p>
        <p class="remux-hint">{{ remuxError }}</p>
        <button class="remux-close-btn" @click="emit('close')">Close</button>
      </div>
    </div>

    <!-- Auto-advance countdown -->
    <div v-if="autoAdvanceCountdown > 0" class="auto-advance-overlay">
      <div class="auto-advance-modal">
        <p class="auto-advance-text">Next episode in {{ autoAdvanceCountdown }}...</p>
        <button class="auto-advance-cancel" @click="cancelAutoAdvance">Cancel</button>
      </div>
    </div>

    <!-- Streaming warning banner -->
    <transition name="fade">
      <div v-if="streamingBannerVisible" class="streaming-banner">
        Streaming from server
      </div>
    </transition>

    <!-- Resume toast -->
    <transition name="fade">
      <div v-if="resumeToast" class="resume-toast">{{ resumeToast }}</div>
    </transition>

    <!-- Syncplay toast -->
    <transition name="fade">
      <div v-if="syncplayToast" class="syncplay-toast">{{ syncplayToast }}</div>
    </transition>

    <!-- Syncplay: persistent "paused by X" badge while paused -->
    <div
      v-if="!playing && syncplayPausedBy && syncplayStatus.state === 'ready'"
      class="syncplay-paused-by"
    >
      <span class="syncplay-paused-icon">⏸</span>
      Paused by {{ syncplayPausedBy === syncplayStatus.username ? 'you' : syncplayPausedBy }}
    </div>

    <!-- Video wrapper: SubtitlesOctopus inserts its canvas after the <video>, so this
         positioned container ensures the subtitle overlay covers the video area -->
    <div class="video-wrapper">
      <video
        ref="videoRef"
        :src="videoSrc || undefined"
        :class="{ hidden: anime4kActive }"
        class="player-video"
        crossorigin="anonymous"
        @play="onPlay"
        @pause="onPause"
        @seeked="onVideoSeeked"
        @timeupdate="onTimeUpdate"
        @durationchange="onDurationChange"
        @progress="onProgress"
        @canplay="onCanPlay"
        @waiting="onVideoWaiting"
        @ended="onVideoEnded"
        @click="togglePlay"
        @dblclick="toggleFullscreen"
        autoplay
      >
      </video>
    </div>

    <!-- Canvas for Anime4K rendering -->
    <canvas
      ref="canvasRef"
      v-show="anime4kActive"
      class="player-canvas"
      @click="togglePlay"
      @dblclick="toggleFullscreen"
    />

    <!-- Title bar -->
    <transition name="fade">
      <div v-show="showControls" class="title-bar">
        <button class="close-btn" @click="emit('close')" title="Close player">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button v-if="props.allEpisodes.length > 1" class="ep-nav-btn" :disabled="!canPrev || navigating" @click="goToEpisode('prev')" title="Previous episode (Shift+←)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span class="title-text">{{ animeName }} — {{ activeEpisodeLabel }}</span>
        <button v-if="props.allEpisodes.length > 1" class="ep-nav-btn" :disabled="!canNext || navigating" @click="goToEpisode('next')" title="Next episode (Shift+→)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </transition>

    <!-- Skip OP/ED overlay button. Anchored bottom-right above the controls
         bar; appears with a brief grace timer once playback enters a detected
         range, hides on rewind once the user has clicked it. -->
    <transition name="fade">
      <button
        v-if="skipButtonVisible && activeSkipRange"
        class="skip-button-overlay"
        @click.stop="onSkipClick"
      >
        Skip {{ activeSkipRange === 'op' ? 'OP' : 'ED' }}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-left: 4px;">
          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
        </svg>
      </button>
    </transition>

    <!-- Controls bar -->
    <transition name="fade">
      <div v-show="showControls" class="controls-bar" @click.stop>
        <!-- Seek bar -->
        <div class="seek-container">
          <div class="seek-track">
            <div class="seek-buffered" :style="{ width: bufferedProgress + '%' }" />
            <div class="seek-progress" :style="{ width: seekProgress + '%' }" />
            <div
              v-if="currentEpisodeSkip?.op && duration > 0"
              class="seek-band seek-band-op"
              :style="{
                left: ((currentEpisodeSkip.op.startSec / duration) * 100) + '%',
                width: (((currentEpisodeSkip.op.endSec - currentEpisodeSkip.op.startSec) / duration) * 100) + '%'
              }"
            />
            <div
              v-if="currentEpisodeSkip?.ed && duration > 0"
              class="seek-band seek-band-ed"
              :style="{
                left: ((currentEpisodeSkip.ed.startSec / duration) * 100) + '%',
                width: (((currentEpisodeSkip.ed.endSec - currentEpisodeSkip.ed.startSec) / duration) * 100) + '%'
              }"
            />
          </div>
          <input
            type="range"
            class="seek-input"
            min="0"
            :max="duration || 0"
            step="0.1"
            :value="currentTime"
            @mousedown="onSeekStart"
            @input="onSeekInput"
            @change="onSeekEnd"
            @mousemove="onSeekMouseMove"
            @mouseleave="onSeekMouseLeave"
          />
          <div
            v-show="seekTooltipVisible"
            class="seek-tooltip"
            :style="{ left: seekTooltipLeft + 'px' }"
          >
            {{ seekTooltipTime }}
          </div>
        </div>

        <div class="controls-row">
          <!-- Play/Pause -->
          <button class="ctrl-btn" @click="togglePlay" :title="playing ? 'Pause' : 'Play'">
            <svg v-if="!playing" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          </button>

          <!-- Volume -->
          <button class="ctrl-btn" @click="toggleMute" :title="muted ? 'Unmute' : 'Mute'">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path v-if="muted || volume === 0" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              <path v-else-if="volume < 0.5" d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
              <path v-else d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
            </svg>
          </button>
          <input
            type="range"
            class="volume-slider"
            min="0"
            max="1"
            step="0.01"
            :value="volume"
            @input="onVolumeInput"
          />

          <!-- Time -->
          <span class="time-display">
            {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
          </span>

          <div class="controls-spacer" />

          <!-- Translation selector -->
          <div class="preset-wrapper" v-if="hasTranslations">
            <button
              class="ctrl-btn preset-btn translation-btn"
              :class="{ loading: switchingTranslation }"
              @click="toggleTranslationMenu()"
              title="Translation"
            >
              {{ switchingTranslation ? '...' : currentTranslationLabel }}
            </button>
            <div v-if="showTranslationMenu" class="preset-menu translation-menu">
              <!-- Level 1: type groups -->
              <template v-if="translationMenuLevel === 'types'">
                <button
                  v-for="group in translationTypeGroups"
                  :key="group.type"
                  class="preset-option group-option"
                  @click="openTypeGroup(group.type)"
                >
                  <span class="tr-label">{{ group.label }}</span>
                  <span class="tr-arrow">›</span>
                </button>
              </template>
              <!-- Level 2: translations in selected type -->
              <template v-else>
                <button
                  v-if="translationTypeGroups.length > 1"
                  class="preset-option back-option"
                  @click="backToTypes()"
                >
                  <span class="tr-arrow back-arrow">‹</span>
                  <span class="tr-label">{{ translationTypeLabel(selectedTypeGroup) }}</span>
                </button>
                <button
                  v-for="tr in selectedGroupItems"
                  :key="tr.id"
                  class="preset-option"
                  :class="{ selected: activeTranslationId === tr.id, downloaded: activeDownloadedTrIds.includes(tr.id) }"
                  @click="selectTranslation(tr)"
                >
                  <span v-if="activeDownloadedTrIds.includes(tr.id)" class="tr-dl-icon">⬇</span>
                  <span class="tr-label">{{ tr.label }}</span>
                  <span class="tr-meta">{{ qualityLabel(tr.height) }}</span>
                </button>
              </template>
            </div>
          </div>

          <!-- Quality selector -->
          <div class="preset-wrapper" v-if="hasQualities && isStreaming">
            <button
              class="ctrl-btn preset-btn"
              @click="showQualityMenu = !showQualityMenu"
              title="Video quality"
            >
              {{ currentQualityLabel }}
            </button>
            <div v-if="showQualityMenu" class="preset-menu">
              <button
                v-for="s in availableStreams"
                :key="s.height"
                class="preset-option"
                :class="{ selected: selectedHeight === s.height }"
                @click="selectQuality(s)"
              >
                {{ qualityLabel(s.height) }}
              </button>
            </div>
          </div>

          <!-- Anime4K preset -->
          <div class="preset-wrapper" v-if="webgpuAvailable">
            <button
              class="ctrl-btn preset-btn"
              :class="{ active: anime4kPreset !== 'off' }"
              @click="showPresetMenu = !showPresetMenu"
              title="Anime4K shaders"
            >
              {{ presetLabel }}
            </button>
            <div v-if="showPresetMenu" class="preset-menu">
              <button
                v-for="p in [
                  { key: 'off', label: 'Off' },
                  { key: 'mode-a', label: 'Mode A (1080p source)' },
                  { key: 'mode-b', label: 'Mode B (720p source)' },
                  { key: 'mode-c', label: 'Mode C (480p source)' }
                ]"
                :key="p.key"
                class="preset-option"
                :class="{ selected: anime4kPreset === p.key }"
                @click="selectPreset(p.key as any)"
              >
                {{ p.label }}
              </button>
              <div class="preset-gpu-info">GPU: {{ gpuName }}</div>
            </div>
          </div>
          <div v-else class="no-gpu-hint" title="WebGPU not available — Anime4K shaders disabled">
            No GPU
          </div>

          <!-- Watch Together (Syncplay) -->
          <div class="preset-wrapper">
            <button
              class="ctrl-btn preset-btn syncplay-btn"
              :class="{ active: syncplayStatus.state === 'ready' }"
              @click="syncplayMenuOpen = !syncplayMenuOpen"
              title="Watch Together"
            >
              <span class="sp-dot" :class="'sp-' + syncplayStatus.state"></span>
              <span class="sp-label">Sync</span>
            </button>
            <div v-if="syncplayMenuOpen" class="preset-menu syncplay-menu" @click.stop>
              <div class="sp-status-line">
                Status: <strong>{{ syncplayStatus.state }}</strong>
                <span v-if="syncplayStatus.tls" class="sp-tls-badge">TLS</span>
              </div>
              <div v-if="syncplayStatus.error" class="sp-error-line">{{ syncplayStatus.error }}</div>
              <label class="sp-label-row" for="sp-room-input">Room</label>
              <input
                id="sp-room-input"
                v-model="syncplayRoomInput"
                type="text"
                class="sp-input"
                placeholder="room name"
                :disabled="syncplayStatus.state !== 'idle' && syncplayStatus.state !== 'disconnected'"
              />
              <button class="sp-action-btn" @click="toggleSyncplayConnection()">
                {{ syncplayStatus.state === 'idle' || syncplayStatus.state === 'disconnected' ? 'Connect' : 'Disconnect' }}
              </button>
              <div v-if="syncplayRoomUsers.length > 0" class="sp-users-list">
                <div class="sp-users-title">In room</div>
                <div v-for="u in syncplayRoomUsers" :key="u.username" class="sp-user-row">
                  <span
                    class="sp-user-dot"
                    :class="u.isReady === false ? 'sp-user-dot-buffering' : 'sp-user-dot-ready'"
                    :title="u.isReady === false ? 'Buffering' : 'Ready'"
                  ></span>
                  <span class="sp-user-name">{{ u.username }}</span>
                  <span v-if="u.file" class="sp-user-file" :title="u.file.name">{{ u.file.name }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Fullscreen -->
          <button class="ctrl-btn" @click="toggleFullscreen" :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path v-if="!isFullscreen" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              <path v-else d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
            </svg>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.player-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: none;
}

.player-overlay:hover {
  cursor: default;
}

.video-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* SubtitlesOctopus creates a .libassjs-canvas-parent wrapper after the <video>.
   Override its positioning so it overlays the video instead of pushing layout. */
.video-wrapper :deep(.libassjs-canvas-parent) {
  position: absolute !important;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.video-wrapper :deep(.libassjs-canvas) {
  pointer-events: none;
}

.player-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.player-video.hidden {
  opacity: 0;
  position: absolute;
}

.player-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: auto;
}

.streaming-banner {
  position: absolute;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(233, 69, 96, 0.85);
  color: #fff;
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 0.8rem;
  z-index: 10;
  pointer-events: none;
}

.resume-toast {
  position: absolute;
  top: 100px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(15, 52, 96, 0.9);
  color: #e0e0e0;
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 0.8rem;
  z-index: 10;
  pointer-events: none;
}

.mkv-buffering-toast {
  position: absolute;
  top: 100px;
  right: 24px;
  background: rgba(15, 52, 96, 0.85);
  color: #e0e0e0;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 0.8rem;
  z-index: 10;
  pointer-events: none;
}

.syncplay-toast {
  position: absolute;
  top: 140px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(15, 52, 96, 0.9);
  color: #e0e0e0;
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 0.8rem;
  z-index: 10;
  pointer-events: none;
  max-width: 60vw;
  text-align: center;
}

.syncplay-paused-by {
  position: absolute;
  top: 72px;
  left: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(15, 52, 96, 0.85);
  color: #e0e0e0;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 0.8rem;
  z-index: 10;
  pointer-events: none;
  border: 1px solid rgba(96, 150, 255, 0.4);
}

.syncplay-paused-icon {
  font-size: 0.9rem;
  line-height: 1;
}

.syncplay-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6a6a8a;
}

.sp-dot.sp-idle,
.sp-dot.sp-disconnected {
  background: #6a6a8a;
}

.sp-dot.sp-connecting,
.sp-dot.sp-tls-probing,
.sp-dot.sp-tls-handshake,
.sp-dot.sp-hello-sent,
.sp-dot.sp-reconnecting {
  background: #f0932b;
}

.sp-dot.sp-ready {
  background: #6ab04c;
}

.sp-label {
  font-size: 0.8rem;
}

.syncplay-menu {
  min-width: 240px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sp-status-line {
  font-size: 0.8rem;
  color: #a0a0b8;
  display: flex;
  align-items: center;
  gap: 6px;
}

.sp-tls-badge {
  font-size: 0.65rem;
  background: #0f3460;
  color: #e0e0e0;
  padding: 1px 5px;
  border-radius: 3px;
}

.sp-error-line {
  color: #e94560;
  font-size: 0.75rem;
}

.sp-label-row {
  font-size: 0.75rem;
  color: #a0a0b8;
  margin-top: 4px;
}

.sp-input {
  width: 100%;
  padding: 6px 8px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.8rem;
}

.sp-input:disabled {
  opacity: 0.55;
}

.sp-action-btn {
  padding: 6px 12px;
  background: #e94560;
  border: none;
  border-radius: 4px;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.sp-action-btn:hover {
  background: #d13b53;
}

.sp-users-list {
  border-top: 1px solid #0f3460;
  padding-top: 6px;
  margin-top: 4px;
}

.sp-users-title {
  font-size: 0.75rem;
  color: #a0a0b8;
  margin-bottom: 4px;
}

.sp-user-row {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 6px;
  font-size: 0.8rem;
  padding: 2px 0;
  align-items: center;
}

.sp-user-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  grid-row: 1 / span 2;
}

.sp-user-dot-ready {
  background: #4ade80;
}

.sp-user-dot-buffering {
  background: #f59e0b;
}

.sp-user-file {
  grid-column: 2;
  font-size: 0.7rem;
  color: #6a6a8a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Remux overlay */
.remux-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.remux-modal {
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 12px;
  padding: 2rem 2.5rem;
  text-align: center;
  min-width: 320px;
}

.remux-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #0f3460;
  border-top-color: #e94560;
  border-radius: 50%;
  margin: 0 auto 1rem;
  animation: remux-spin 0.8s linear infinite;
}

@keyframes remux-spin {
  to { transform: rotate(360deg); }
}

.remux-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: #e0e0e0;
  margin-bottom: 0.5rem;
}

.remux-error-title {
  color: #e94560;
}

.remux-hint {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.hevc-prompt-buttons {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 1rem;
}

.mkv-cancel-btn {
  margin-left: 0.75rem;
  background: transparent;
  border: 1px solid #e94560;
  color: #e94560;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 0.75rem;
}

.remux-close-btn {
  margin-top: 1rem;
  background: #e94560;
  border: none;
  color: #fff;
  padding: 8px 24px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
}

.remux-close-btn:hover {
  background: #d63050;
}

/* Title bar */
.title-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7) 0%, transparent 100%);
  z-index: 5;
}

.close-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.title-text {
  color: #fff;
  font-size: 0.9rem;
  font-weight: 500;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}

.ep-nav-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  opacity: 0.8;
}

.ep-nav-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  opacity: 1;
}

.ep-nav-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.auto-advance-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 15;
  pointer-events: none;
}

.auto-advance-modal {
  background: rgba(0, 0, 0, 0.8);
  border-radius: 12px;
  padding: 1.5rem 2rem;
  text-align: center;
  pointer-events: auto;
}

.auto-advance-text {
  color: #fff;
  font-size: 1.1rem;
  margin: 0 0 0.8rem 0;
}

.auto-advance-cancel {
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.3);
  color: #fff;
  padding: 6px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
}

.auto-advance-cancel:hover {
  background: rgba(255, 255, 255, 0.25);
}

/* Controls bar */
.controls-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.8) 0%, transparent 100%);
  padding: 20px 16px 12px;
  z-index: 5;
}

/* Seek bar */
.seek-container {
  position: relative;
  height: 20px;
  display: flex;
  align-items: center;
  margin-bottom: 4px;
}

.seek-track {
  position: absolute;
  left: 0;
  right: 0;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  pointer-events: none;
}

.seek-buffered {
  position: absolute;
  height: 100%;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 2px;
}

.seek-progress {
  position: absolute;
  height: 100%;
  background: #e94560;
  border-radius: 2px;
}

.seek-band {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 2px;
  pointer-events: none;
  /* Sits above buffered/progress fills so the band tint is visible regardless
     of playback position. Below the seek-input thumb (which is invisible but
     interactive) so clicks still seek normally. */
  z-index: 1;
  opacity: 0.55;
  transition: opacity 0.15s;
}

.seek-container:hover .seek-band {
  opacity: 0.8;
}

.seek-band-op {
  background: #4caf50;
}

.seek-band-ed {
  background: #2196f3;
}

/* Skip OP/ED overlay button — anchored bottom-right of the player so it
   doesn't obscure the seek bar but is still mouse-reachable while paused. */
.skip-button-overlay {
  position: absolute;
  right: 24px;
  bottom: 90px;
  z-index: 12;
  display: inline-flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 8px;
  padding: 10px 18px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.02em;
  transition: background 0.12s, transform 0.12s;
}

.skip-button-overlay:hover {
  background: rgba(20, 20, 20, 0.92);
  transform: translateY(-1px);
}

.seek-input {
  position: absolute;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  -webkit-appearance: none;
}

.seek-container:hover .seek-track {
  height: 6px;
}

.seek-tooltip {
  position: absolute;
  top: -28px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  padding: 2px 6px;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
  user-select: none;
}

/* Controls row */
.controls-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ctrl-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 6px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  font-size: 0.8rem;
  font-weight: 600;
}

.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.volume-slider {
  width: 80px;
  height: 4px;
  -webkit-appearance: none;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 2px;
  cursor: pointer;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  cursor: pointer;
}

.time-display {
  color: rgba(255, 255, 255, 0.8);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.controls-spacer {
  flex: 1;
}

/* Anime4K preset controls */
.preset-wrapper {
  position: relative;
}

.preset-btn {
  font-size: 0.75rem;
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
}

.preset-btn.active {
  border-color: #e94560;
  color: #e94560;
}

.preset-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 8px;
  background: rgba(20, 20, 30, 0.95);
  border: 1px solid #0f3460;
  border-radius: 8px;
  padding: 4px;
  min-width: 200px;
}

.preset-option {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  color: #ccc;
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
}

.preset-option:hover {
  background: rgba(255, 255, 255, 0.1);
}

.preset-option.selected {
  color: #e94560;
  background: rgba(233, 69, 96, 0.1);
}

.preset-gpu-info {
  padding: 6px 12px;
  color: #6a6a8a;
  font-size: 0.7rem;
  border-top: 1px solid #0f3460;
  margin-top: 4px;
}

.no-gpu-hint {
  color: #6a6a8a;
  font-size: 0.7rem;
  padding: 0 4px;
}

/* Translation selector */
.translation-btn {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.translation-btn.loading {
  opacity: 0.6;
  pointer-events: none;
}

.translation-menu {
  min-width: 220px;
  max-height: 300px;
  overflow-y: auto;
}

.translation-menu .preset-option {
  display: flex;
  align-items: center;
  gap: 2px;
}

.group-option {
  justify-content: space-between;
}

.tr-arrow {
  font-size: 1rem;
  color: #8a8aaa;
  flex-shrink: 0;
}

.back-option {
  border-bottom: 1px solid #0f3460;
  margin-bottom: 4px;
  padding-bottom: 8px;
  gap: 6px;
}

.back-option .tr-label {
  color: #8a8aaa;
  font-size: 0.75rem;
}

.back-arrow {
  font-size: 1.1rem;
}

.tr-label {
  font-size: 0.8rem;
  color: #ddd;
}

.tr-meta {
  font-size: 0.65rem;
  color: #8a8aaa;
  margin-left: auto;
}

.preset-option.selected .tr-label {
  color: #e94560;
}

.preset-option.selected .tr-meta {
  color: #e94560;
  opacity: 0.7;
}

.tr-dl-icon {
  font-size: 0.7rem;
  color: #6ab04c;
  flex-shrink: 0;
}

.preset-option.downloaded .tr-label {
  color: #6ab04c;
}

/* Transitions */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
