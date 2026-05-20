import * as fs from 'fs'
import type { StorageService } from '../../store/types'
import type { EpisodeInput, ShowSkipDetections, CachedFingerprint } from '../../skip-detector'

export type SkipAnalysisFileCheckResult = Record<
  string,
  { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
>

export interface SkipAnalysisServiceDeps {
  store: StorageService
  scanEpisodeFiles: (animeName: string) => SkipAnalysisFileCheckResult
  sanitizeFilename: (s: string) => string
  /** Broadcast helper (`broadcastToAll`); used by `dropDetections*`. */
  broadcast: (channel: string, ...args: unknown[]) => void
  /** Event channel for SKIP_DETECTOR_SIGNATURE_UPDATED. */
  signatureUpdatedChannel: string
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
}

export function createSkipAnalysisService(deps: SkipAnalysisServiceDeps): SkipAnalysisService {
  const { store, scanEpisodeFiles, sanitizeFilename, broadcast, signatureUpdatedChannel } = deps

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

  return {
    normalizeDetections,
    pruneCacheForEpisode,
    pruneCacheForAnime,
    sweepFingerprintCache,
    dropDetectionsForAnime,
    dropDetectionsForEpisode,
    buildAutoSkipEpisodes
  }
}
