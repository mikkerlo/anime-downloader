import * as fs from 'fs'
import type { StorageService } from '../../store/types'
import {
  analyzeShow,
  detectStream,
  type EpisodeInput,
  type ShowSkipDetections,
  type CachedFingerprint,
  type AnalyzeProgress,
  type EpisodeSkipDetection
} from '../../skip-detector'

export type SkipAnalysisFileCheckResult = Record<
  string,
  { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
>

const AUTO_SKIP_DEBOUNCE_MS = 5000

export interface SkipAnalysisServiceDeps {
  store: StorageService
  scanEpisodeFiles: (animeName: string) => SkipAnalysisFileCheckResult
  sanitizeFilename: (s: string) => string
  /** Broadcast helper (`broadcastToAll`); used by `dropDetections*` + progress events. */
  broadcast: (channel: string, ...args: unknown[]) => void
  /** Event channel for SKIP_DETECTOR_SIGNATURE_UPDATED. */
  signatureUpdatedChannel: string
  /** Event channel for SKIP_DETECTOR_ANALYZE_PROGRESS. */
  analyzeProgressChannel: string
  /** Live readers for the Chromaprint / ffmpeg binaries (set after first-launch download). */
  getFpcalcPath: () => string
  getFfmpegPath: () => string
  getFfprobePath: () => string
}

export interface SkipAnalysisService {
  /** Normalize legacy detection rows so callers always see a `local` algorithm block with defaults filled. */
  normalizeDetections(detections: ShowSkipDetections | null): ShowSkipDetections | null
  /** Drop fingerprint cache rows for a specific episode. Returns how many keys were dropped. */
  pruneCacheForEpisode(animeId: number, episodeInt: string): number
  /** Drop fingerprint cache rows for an entire anime. Returns how many keys were dropped. */
  pruneCacheForAnime(animeId: number): number
  /** Reconcile the fingerprint cache against disk; drops entries with no live file backing. */
  sweepFingerprintCache(): { kept: number; dropped: number }
  /** Delete cached detections for an anime; broadcasts a clearing event. Returns true if anything was removed. */
  dropDetectionsForAnime(animeId: number): boolean
  /** Delete one episode's detections; broadcasts the new per-episode map. Returns true if anything was removed. */
  dropDetectionsForEpisode(animeId: number, episodeInt: string): boolean
  /** Build `EpisodeInput[]` from disk (one entry per episodeInt, mkv preferred over mp4). */
  buildAutoSkipEpisodes(animeName: string): EpisodeInput[]
  /** Run (or join the in-flight) full-show fingerprint analysis. */
  runSkipAnalysis(animeId: number, episodes: EpisodeInput[]): Promise<ShowSkipDetections>
  /** Status of the single in-flight full-show analysis, or null when idle. */
  getCurrentAnalysis(): { animeId: number; lastProgress: AnalyzeProgress | null } | null
  /** Abort the in-flight full-show analysis, if any. */
  cancelCurrentAnalysis(): void
  /** Per-renderer single-flight stream skip detection. */
  runStreamSkipDetection(
    senderId: number,
    animeId: number,
    episodeInt: string,
    streamUrl: string,
    detections: ShowSkipDetections
  ): Promise<EpisodeSkipDetection | null>
  /** Abort the stream detection owned by a renderer (by `webContents.id`). */
  cancelStreamSkipDetection(senderId: number): void
  /** Debounced auto-trigger from download/merge completion hooks. */
  scheduleAutoSkipAnalysis(animeId: number, animeName: string): void
  /** Enqueue an anime for auto-analysis immediately (no debounce). */
  enqueueAutoSkipAnalysis(animeId: number, animeName: string): void
  /** Snapshot of the auto-skip queue for the renderer's status indicator. */
  getAutoSkipQueueStatus(): { currentAnimeId: number | null; queueLength: number }
}

interface CurrentSkipAnalysis {
  animeId: number
  controller: AbortController
  lastProgress: AnalyzeProgress | null
  promise: Promise<ShowSkipDetections>
}

interface CurrentStreamSkipDetection {
  senderId: number
  controller: AbortController
  promise: Promise<EpisodeSkipDetection | null>
}

/**
 * Skip-analysis service (refactor epic #84). Phase 2 PR4 landed the leaf
 * surface (normalize / prune / sweep / drop / buildAutoSkipEpisodes); Phase 3
 * slice 3e folds in the orchestration that was deferred because it carried
 * in-flight state: the full-show analysis single-flight, the per-renderer
 * stream-detection map, and the debounced auto-skip queue.
 */
export function createSkipAnalysisService(deps: SkipAnalysisServiceDeps): SkipAnalysisService {
  const {
    store,
    scanEpisodeFiles,
    sanitizeFilename,
    broadcast,
    signatureUpdatedChannel,
    analyzeProgressChannel,
    getFpcalcPath,
    getFfmpegPath,
    getFfprobePath
  } = deps

  let currentSkipAnalysis: CurrentSkipAnalysis | null = null
  const currentStreamSkipDetections = new Map<number, CurrentStreamSkipDetection>()

  const autoSkipDebounce = new Map<number, ReturnType<typeof setTimeout>>()
  const autoSkipQueue: { animeId: number; animeName: string }[] = []
  let autoSkipDraining = false

  function normalizeDetections(detections: ShowSkipDetections | null): ShowSkipDetections | null {
    if (!detections) return null
    if (detections.algorithm?.source === 'local') return detections
    const alg = detections.algorithm
    return {
      ...detections,
      algorithm: {
        source: 'local',
        sampleRate: alg?.sampleRate ?? 11025,
        matchBitThreshold: alg?.matchBitThreshold ?? 6,
        minRunSec: alg?.minRunSec ?? 18,
        windowSec: alg?.windowSec ?? 6,
        refineBitThreshold: alg?.refineBitThreshold ?? 4,
        refineSustainHashes: alg?.refineSustainHashes ?? 5
      }
    }
  }

  function pruneCacheForEpisode(animeId: number, episodeInt: string): number {
    if (animeId <= 0 || !episodeInt) return 0
    const cache = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
    const prefix = `${animeId}:${episodeInt}:`
    let dropped = 0
    for (const key of Object.keys(cache)) {
      if (key.startsWith(prefix)) {
        delete cache[key]
        dropped++
      }
    }
    if (dropped > 0) store.set('skipFingerprintCache', cache)
    return dropped
  }

  function pruneCacheForAnime(animeId: number): number {
    if (animeId <= 0) return 0
    const cache = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
    const prefix = `${animeId}:`
    let dropped = 0
    for (const key of Object.keys(cache)) {
      if (key.startsWith(prefix)) {
        delete cache[key]
        dropped++
      }
    }
    if (dropped > 0) store.set('skipFingerprintCache', cache)
    return dropped
  }

  // Reconcile the cache against disk. Per anime: scan the folder, stat each
  // file, compute the (size, mtime) tuple the cache would key under, and
  // drop any cache entry for that animeId that doesn't match a live file.
  // Anime missing from `downloadedAnime` → all entries for that animeId go.
  function sweepFingerprintCache(): { kept: number; dropped: number } {
    const cache = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
    const downloaded = store.get('downloadedAnime') as Record<string, { title: string }>

    const byAnimeId = new Map<
      string,
      { key: string; episodeInt: string; fileSize: number; fileMtimeMs: number }[]
    >()
    for (const [key, val] of Object.entries(cache)) {
      const parts = key.split(':')
      if (parts.length < 4) continue
      const [animeIdStr, episodeInt] = parts
      const list = byAnimeId.get(animeIdStr) ?? []
      list.push({ key, episodeInt, fileSize: val.fileSize, fileMtimeMs: val.fileMtimeMs })
      byAnimeId.set(animeIdStr, list)
    }

    const next: Record<string, CachedFingerprint> = {}
    let kept = 0
    let dropped = 0

    for (const [animeIdStr, entries] of byAnimeId) {
      const meta = downloaded[animeIdStr]
      if (!meta) {
        dropped += entries.length
        continue
      }
      const scan = scanEpisodeFiles(meta.title)
      const sanitized = sanitizeFilename(meta.title)
      const expectedByEpisode = new Map<string, { fileSize: number; fileMtimeMs: number }[]>()
      for (const [base, files] of Object.entries(scan)) {
        if (!base.startsWith(sanitized + ' - ')) continue
        const tail = base.slice(sanitized.length + 3)
        const m = tail.match(/^(\d+(?:\.\d+)?)/)
        if (!m) continue
        const episodeInt = m[1].replace(/^0+(?=\d)/, '')
        for (const f of files) {
          if (!f.filePath) continue
          try {
            const stat = fs.statSync(f.filePath)
            const list = expectedByEpisode.get(episodeInt) ?? []
            list.push({ fileSize: stat.size, fileMtimeMs: stat.mtimeMs })
            expectedByEpisode.set(episodeInt, list)
          } catch {
            /* file vanished between scan and stat — skip */
          }
        }
      }

      for (const e of entries) {
        const candidates = expectedByEpisode.get(e.episodeInt) ?? []
        const match = candidates.some(
          (c) =>
            c.fileSize === e.fileSize && Math.floor(c.fileMtimeMs) === Math.floor(e.fileMtimeMs)
        )
        if (match) {
          next[e.key] = cache[e.key]
          kept++
        } else {
          dropped++
        }
      }
    }

    if (dropped > 0) store.set('skipFingerprintCache', next)
    return { kept, dropped }
  }

  function dropDetectionsForAnime(animeId: number): boolean {
    const detections = store.get('skipDetections') as Record<string, ShowSkipDetections>
    const key = String(animeId)
    if (!(key in detections)) return false
    delete detections[key]
    store.set('skipDetections', detections)
    broadcast(signatureUpdatedChannel, { animeId, perEpisode: {} })
    return true
  }

  function dropDetectionsForEpisode(animeId: number, episodeInt: string): boolean {
    const detections = store.get('skipDetections') as Record<string, ShowSkipDetections>
    const key = String(animeId)
    const show = detections[key]
    if (!show || !show.perEpisode[episodeInt]) return false
    delete show.perEpisode[episodeInt]
    if (Object.keys(show.perEpisode).length === 0) {
      delete detections[key]
    }
    store.set('skipDetections', detections)
    broadcast(signatureUpdatedChannel, {
      animeId,
      perEpisode: detections[key]?.perEpisode ?? {}
    })
    return true
  }

  // Build EpisodeInput[] from disk for an anime folder. Mirrors the renderer's
  // skipEpisodeInputs computed: prefer .mkv (merged) over .mp4 (raw), one entry
  // per episodeInt, sorted by numeric episode.
  function buildAutoSkipEpisodes(animeName: string): EpisodeInput[] {
    const scan = scanEpisodeFiles(animeName)
    const sanitized = sanitizeFilename(animeName)
    const inputs: EpisodeInput[] = []
    for (const [base, files] of Object.entries(scan)) {
      if (!base.startsWith(sanitized + ' - ')) continue
      const tail = base.slice(sanitized.length + 3)
      const m = tail.match(/^(\d+(?:\.\d+)?)/)
      if (!m) continue
      const episodeInt = m[1].replace(/^0+(?=\d)/, '')
      const mkv = files.find((f) => f.type === 'mkv')
      const pick = mkv || files[0]
      if (!pick || !pick.filePath) continue
      if (inputs.some((e) => e.episodeInt === episodeInt)) continue
      inputs.push({ episodeInt, episodeLabel: `Episode ${episodeInt}`, filePath: pick.filePath })
    }
    inputs.sort((a, b) => parseFloat(a.episodeInt) - parseFloat(b.episodeInt))
    return inputs
  }

  function broadcastSkipProgress(animeId: number, p: AnalyzeProgress): void {
    if (currentSkipAnalysis && currentSkipAnalysis.animeId === animeId) {
      currentSkipAnalysis.lastProgress = p
    }
    broadcast(analyzeProgressChannel, { animeId, ...p })
  }

  function runSkipAnalysis(animeId: number, episodes: EpisodeInput[]): Promise<ShowSkipDetections> {
    if (currentSkipAnalysis) {
      if (currentSkipAnalysis.animeId === animeId) return currentSkipAnalysis.promise
      return Promise.reject(
        new Error(
          `Another analysis is in progress for anime ID ${currentSkipAnalysis.animeId}; cancel it first`
        )
      )
    }
    const fpcalcPath = getFpcalcPath()
    if (!fpcalcPath)
      return Promise.reject(
        new Error('fpcalc binary not available — restart the app to retry the download')
      )
    if (!Array.isArray(episodes) || episodes.length < 2) {
      return Promise.reject(new Error('Need at least 2 downloaded episodes to analyze'))
    }

    const controller = new AbortController()
    const runPromise = (async (): Promise<ShowSkipDetections> => {
      const result = await analyzeShow(animeId, episodes, {
        fpcalcPath,
        signal: controller.signal,
        onProgress: (p) => broadcastSkipProgress(animeId, p),
        loadCachedFingerprint: (key) => {
          const cache = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
          return cache[key]
        },
        saveCachedFingerprint: (key, value) => {
          const cache = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
          cache[key] = value
          store.set('skipFingerprintCache', cache)
        }
      })
      const all = store.get('skipDetections') as Record<string, ShowSkipDetections>
      all[String(animeId)] = result
      store.set('skipDetections', all)
      broadcast(signatureUpdatedChannel, { animeId, perEpisode: result.perEpisode })
      return result
    })()

    currentSkipAnalysis = { animeId, controller, lastProgress: null, promise: runPromise }
    runPromise.finally(() => {
      if (currentSkipAnalysis && currentSkipAnalysis.controller === controller) {
        currentSkipAnalysis = null
      }
      void drainAutoSkipQueue()
    })
    return runPromise
  }

  function getCurrentAnalysis(): { animeId: number; lastProgress: AnalyzeProgress | null } | null {
    if (!currentSkipAnalysis) return null
    return { animeId: currentSkipAnalysis.animeId, lastProgress: currentSkipAnalysis.lastProgress }
  }

  function cancelCurrentAnalysis(): void {
    if (currentSkipAnalysis) currentSkipAnalysis.controller.abort()
  }

  function cancelStreamSkipDetection(senderId: number): void {
    const current = currentStreamSkipDetections.get(senderId)
    if (!current) return
    current.controller.abort()
  }

  function runStreamSkipDetection(
    senderId: number,
    animeId: number,
    episodeInt: string,
    streamUrl: string,
    detections: ShowSkipDetections
  ): Promise<EpisodeSkipDetection | null> {
    const fpcalcPath = getFpcalcPath()
    if (!fpcalcPath)
      return Promise.reject(
        new Error('fpcalc binary not available — restart the app to retry the download')
      )
    const ffmpegPath = getFfmpegPath()
    if (!ffmpegPath) return Promise.reject(new Error('ffmpeg not available'))

    cancelStreamSkipDetection(senderId)
    const controller = new AbortController()
    const fingerprintCacheSnapshot = store.get('skipFingerprintCache') as Record<
      string,
      CachedFingerprint
    >
    const runPromise = detectStream(animeId, episodeInt, streamUrl, detections, {
      fpcalcPath,
      ffmpegPath,
      ffprobePath: getFfprobePath() || undefined,
      userAgent: 'smotret-anime-dl',
      signal: controller.signal,
      loadCachedFingerprint: (key) => fingerprintCacheSnapshot[key],
      saveCachedFingerprint: (key, value) => {
        fingerprintCacheSnapshot[key] = value
        const fresh = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
        fresh[key] = value
        store.set('skipFingerprintCache', fresh)
      }
    })

    currentStreamSkipDetections.set(senderId, { senderId, controller, promise: runPromise })
    runPromise.finally(() => {
      const current = currentStreamSkipDetections.get(senderId)
      if (current && current.controller === controller) {
        currentStreamSkipDetections.delete(senderId)
      }
    })
    return runPromise
  }

  function scheduleAutoSkipAnalysis(animeId: number, animeName: string): void {
    if (animeId <= 0) return
    if (!(store.get('enableLocalSkipDetection') as boolean)) return
    // Coalesce bursts (e.g. bulk download): each new event resets the debounce
    // so the analysis fires once after activity settles, with all newly-arrived
    // episodes included.
    const existing = autoSkipDebounce.get(animeId)
    if (existing) clearTimeout(existing)
    autoSkipDebounce.set(
      animeId,
      setTimeout(() => {
        autoSkipDebounce.delete(animeId)
        enqueueAutoSkipAnalysis(animeId, animeName)
      }, AUTO_SKIP_DEBOUNCE_MS)
    )
  }

  function enqueueAutoSkipAnalysis(animeId: number, animeName: string): void {
    if (autoSkipQueue.some((x) => x.animeId === animeId)) return
    if (currentSkipAnalysis && currentSkipAnalysis.animeId === animeId) return
    autoSkipQueue.push({ animeId, animeName })
    void drainAutoSkipQueue()
  }

  async function drainAutoSkipQueue(): Promise<void> {
    if (autoSkipDraining) return
    if (currentSkipAnalysis) return
    autoSkipDraining = true
    try {
      while (autoSkipQueue.length > 0 && !currentSkipAnalysis) {
        const next = autoSkipQueue.shift()!
        try {
          const episodes = buildAutoSkipEpisodes(next.animeName)
          if (episodes.length < 2) continue
          await runSkipAnalysis(next.animeId, episodes)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`[skip-detector] auto-analysis failed for animeId=${next.animeId}: ${msg}`)
        }
      }
    } finally {
      autoSkipDraining = false
    }
  }

  function getAutoSkipQueueStatus(): { currentAnimeId: number | null; queueLength: number } {
    return {
      currentAnimeId: currentSkipAnalysis?.animeId ?? null,
      queueLength: autoSkipQueue.length
    }
  }

  return {
    normalizeDetections,
    pruneCacheForEpisode,
    pruneCacheForAnime,
    sweepFingerprintCache,
    dropDetectionsForAnime,
    dropDetectionsForEpisode,
    buildAutoSkipEpisodes,
    runSkipAnalysis,
    getCurrentAnalysis,
    cancelCurrentAnalysis,
    runStreamSkipDetection,
    cancelStreamSkipDetection,
    scheduleAutoSkipAnalysis,
    enqueueAutoSkipAnalysis,
    getAutoSkipQueueStatus
  }
}
