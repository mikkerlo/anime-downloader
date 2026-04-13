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
const isStreaming = computed(() => !!activeStreamUrl.value && !activeFilePath.value)
let controlsTimer: ReturnType<typeof setTimeout> | null = null

// MKV remux state
const activeFilePath = ref(props.filePath)
const isMkv = computed(() => !!activeFilePath.value && activeFilePath.value.toLowerCase().endsWith('.mkv'))
const remuxing = ref(false)
const remuxError = ref('')
const remuxedPath = ref('')

// Quality selector state
const activeStreamUrl = ref(props.streamUrl)
const selectedHeight = ref(0)
const hasQualities = computed(() => props.availableStreams.length > 0)

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
const playerShortcuts = ref<Record<string, string>>({})

// Watch progress tracking
const currentEpisodeInt = computed(() => props.allEpisodes[activeEpisodeIndex.value]?.episodeInt || '')
let cumulativePlayTime = 0
let lastTimeUpdateAt = 0
let lastSaveAt = 0
let watchedReported = false
let episodeOpenedAt = Date.now()
let pendingPrevEpisodeInt = ''
const resumeToast = ref('')
let resumeToastTimer: ReturnType<typeof setTimeout> | null = null

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
    // For MKV files, use the remuxed MP4 path
    if (isMkv.value) {
      if (remuxedPath.value) {
        return 'anime-video://' + encodeURIComponent(remuxedPath.value)
      }
      return '' // Not ready yet — remuxing in progress
    }
    return 'anime-video://' + encodeURIComponent(activeFilePath.value)
  }
  return activeStreamUrl.value
})

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

function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    containerRef.value?.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
}

function onFullscreenChange(): void {
  isFullscreen.value = !!document.fullscreenElement
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
}

function onPause(): void {
  playing.value = false
  showControls.value = true
  if (controlsTimer) clearTimeout(controlsTimer)
  lastTimeUpdateAt = 0
  saveProgress(true)
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
}

function onProgress(): void {
  const video = videoRef.value
  if (!video || video.buffered.length === 0) return
  buffered.value = video.buffered.end(video.buffered.length - 1)
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
  seekTooltipTime.value = formatTime(time)
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

function onMouseBack(e: MouseEvent): void {
  if (e.button === 3) {
    e.stopImmediatePropagation()
    e.preventDefault()
    handleClose()
  }
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
  // Don't handle if a preset menu input is focused
  if ((event.target as HTMLElement)?.tagName === 'SELECT') return

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
      const localResult = await window.api.playerFindLocalFile(props.animeName, activeEpisodeLabel.value, tr.id)
      if (localResult) {
        activeTranslationId.value = tr.id

        // Clean up previous remux if any
        if (remuxedPath.value) {
          await window.api.playerCleanupRemux()
          remuxedPath.value = ''
        }

        // Switch to local file
        activeFilePath.value = localResult.filePath
        activeStreamUrl.value = ''
        activeSubtitleContent.value = localResult.subtitleContent || ''

        // Remux MKV if needed
        if (localResult.filePath.toLowerCase().endsWith('.mkv')) {
          remuxing.value = true
          const remuxResult = await window.api.playerRemuxMkv(localResult.filePath)
          remuxing.value = false
          if ('error' in remuxResult) {
            remuxError.value = remuxResult.error
            switchingTranslation.value = false
            return
          }
          remuxedPath.value = remuxResult.mp4Path
          if (!activeSubtitleContent.value && remuxResult.subtitleContent) {
            activeSubtitleContent.value = remuxResult.subtitleContent
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

    // Clean up previous remux if switching from local to stream
    if (remuxedPath.value) {
      await window.api.playerCleanupRemux()
      remuxedPath.value = ''
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
    // Clean up previous remux
    if (remuxedPath.value) {
      await window.api.playerCleanupRemux()
      remuxedPath.value = ''
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
      const localResult = await window.api.playerFindLocalFile(props.animeName, targetEp.episodeInt, resolvedTr.id)
      if (localResult) {
        activeFilePath.value = localResult.filePath
        activeStreamUrl.value = ''
        activeSubtitleContent.value = localResult.subtitleContent || ''

        if (localResult.filePath.toLowerCase().endsWith('.mkv')) {
          remuxing.value = true
          const remuxResult = await window.api.playerRemuxMkv(localResult.filePath)
          remuxing.value = false
          if ('error' in remuxResult) {
            remuxError.value = remuxResult.error
            navigating.value = false
            return
          }
          remuxedPath.value = remuxResult.mp4Path
          if (!activeSubtitleContent.value && remuxResult.subtitleContent) {
            activeSubtitleContent.value = remuxResult.subtitleContent
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
  window.addEventListener('mouseup', onMouseBack, true)
  const savedShortcuts = await window.api.getSetting('keyboardShortcuts') as Record<string, string> | null
  if (savedShortcuts) playerShortcuts.value = savedShortcuts

  // Remux MKV to MP4 if needed
  if (isMkv.value && props.filePath) {
    remuxing.value = true
    remuxError.value = ''
    try {
      const result = await window.api.playerRemuxMkv(props.filePath)
      if ('error' in result) {
        remuxError.value = result.error
        remuxing.value = false
        return
      }
      remuxedPath.value = result.mp4Path
      if (!activeSubtitleContent.value && result.subtitleContent) {
        activeSubtitleContent.value = result.subtitleContent
      }
    } catch (e) {
      remuxError.value = String(e)
      remuxing.value = false
      return
    }
    remuxing.value = false
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

  await initWebGPU()

  // Wait for video to be ready, then start pipeline if needed
  await nextTick()
  const video = videoRef.value
  if (video) {
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
  window.removeEventListener('mouseup', onMouseBack, true)
  if (controlsTimer) clearTimeout(controlsTimer)
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
  // Clean up remuxed temp files
  if (remuxedPath.value) {
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
    <!-- Remuxing MKV overlay -->
    <div v-if="remuxing" class="remux-overlay">
      <div class="remux-modal">
        <div class="remux-spinner"></div>
        <p class="remux-title">Preparing MKV for playback...</p>
        <p class="remux-hint">Remuxing to MP4 (stream copy, no re-encoding)</p>
      </div>
    </div>

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
      <div v-if="isStreaming" class="streaming-banner">
        Streaming from server
      </div>
    </transition>

    <!-- Resume toast -->
    <transition name="fade">
      <div v-if="resumeToast" class="resume-toast">{{ resumeToast }}</div>
    </transition>

    <!-- Video wrapper: SubtitlesOctopus inserts its canvas after the <video>, so this
         positioned container ensures the subtitle overlay covers the video area -->
    <div class="video-wrapper">
      <video
        ref="videoRef"
        :src="videoSrc"
        :class="{ hidden: anime4kActive }"
        class="player-video"
        crossorigin="anonymous"
        @play="onPlay"
        @pause="onPause"
        @timeupdate="onTimeUpdate"
        @durationchange="onDurationChange"
        @progress="onProgress"
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

    <!-- Controls bar -->
    <transition name="fade">
      <div v-show="showControls" class="controls-bar" @click.stop>
        <!-- Seek bar -->
        <div class="seek-container">
          <div class="seek-track">
            <div class="seek-buffered" :style="{ width: bufferedProgress + '%' }" />
            <div class="seek-progress" :style="{ width: seekProgress + '%' }" />
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
