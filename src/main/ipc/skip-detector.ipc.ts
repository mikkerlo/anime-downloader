import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import Ffmpeg from 'fluent-ffmpeg'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { fingerprintCacheKey, formatChaptersMetadata } from '../skip-detector'
import type {
  EpisodeInput,
  ShowSkipDetections,
  CachedFingerprint,
  EpisodeSkipDetection
} from '../skip-detector'
import type { AppDeps } from './index'
import type { AnimeSearchResult } from '../smotret-api'

export function register({
  store,
  skipAnalysisService: skip,
  broadcast,
  getFfmpegPath,
  getFfprobePath
}: AppDeps): void {
  ipcMain.handle(CHANNELS.SKIP_DETECTOR_GET_DETECTIONS, (_event, animeId: number) => {
    const all = store.get('skipDetections') as Record<string, ShowSkipDetections>
    return skip.normalizeDetections(all[String(animeId)] ?? null)
  })

  ipcMain.handle(CHANNELS.SKIP_DETECTOR_GET_STATUS, () => {
    return skip.getCurrentAnalysis()
  })

  ipcMain.handle(CHANNELS.SKIP_DETECTOR_CANCEL, () => {
    skip.cancelCurrentAnalysis()
  })

  ipcMain.handle(CHANNELS.SKIP_DETECTOR_CACHE_STATS, () => {
    const cache = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
    return { fingerprintCount: Object.keys(cache).length }
  })

  ipcMain.handle(
    CHANNELS.SKIP_DETECTOR_ANALYZE_SHOW,
    (_event, animeId: number, episodes: EpisodeInput[]) => {
      return skip.runSkipAnalysis(animeId, episodes)
    }
  )

  ipcMain.handle(
    CHANNELS.SKIP_DETECTOR_DETECT_STREAM,
    async (
      event,
      animeId: number,
      episodeInt: string,
      streamUrl: string
    ): Promise<EpisodeSkipDetection | null> => {
      const all = store.get('skipDetections') as Record<string, ShowSkipDetections>
      const detections = skip.normalizeDetections(all[String(animeId)] ?? null)
      if (!detections) return null
      if (!streamUrl) return null
      return skip.runStreamSkipDetection(
        event.sender.id,
        animeId,
        episodeInt,
        streamUrl,
        detections
      )
    }
  )

  ipcMain.handle(CHANNELS.SKIP_DETECTOR_CANCEL_STREAM_DETECT, (event) => {
    skip.cancelStreamSkipDetection(event.sender.id)
  })

  // One-shot backfill for shows downloaded before skip detection was wired in.
  // Honors the dedupe in `enqueueAutoSkipAnalysis` so a manual click doesn't
  // double-queue a show that's already running or pending.
  ipcMain.handle(CHANNELS.SKIP_DETECTOR_BACKFILL_ALL, () => {
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const detections = store.get('skipDetections') as Record<string, ShowSkipDetections>
    let queued = 0
    let alreadyAnalyzed = 0
    let skippedFewEpisodes = 0
    let total = 0
    for (const [idStr, meta] of Object.entries(downloaded)) {
      const animeId = Number(idStr)
      if (!Number.isFinite(animeId) || animeId <= 0) continue
      total++
      if (detections[idStr]) {
        alreadyAnalyzed++
        continue
      }
      const eps = skip.buildAutoSkipEpisodes(meta.title)
      if (eps.length < 2) {
        skippedFewEpisodes++
        continue
      }
      skip.enqueueAutoSkipAnalysis(animeId, meta.title)
      queued++
    }
    return { queued, alreadyAnalyzed, skippedFewEpisodes, total }
  })

  ipcMain.handle(CHANNELS.SKIP_DETECTOR_QUEUE_STATUS, () => {
    return skip.getAutoSkipQueueStatus()
  })

  ipcMain.handle(
    CHANNELS.DOWNLOAD_INJECT_CHAPTERS,
    async (_event, animeId: number, allInputs: EpisodeInput[]) => {
      if (!Number.isFinite(animeId) || animeId <= 0) throw new Error('invalid animeId')
      const ffmpegPath = getFfmpegPath()
      if (!ffmpegPath || !getFfprobePath()) throw new Error('ffmpeg/ffprobe not available')
      if (!Array.isArray(allInputs) || allInputs.length === 0) throw new Error('no episode inputs')

      const episodes = allInputs.filter(
        (e) => e.filePath.toLowerCase().endsWith('.mkv') && fs.existsSync(e.filePath)
      )
      if (episodes.length < 3)
        throw new Error(`need at least 3 downloaded MKV episodes (have ${episodes.length})`)

      let detections =
        (store.get('skipDetections') as Record<string, ShowSkipDetections>)[String(animeId)] ?? null
      if (!detections) {
        broadcast(EVENT_CHANNELS.CHAPTER_INJECT_PROGRESS, {
          animeId,
          phase: 'analyzing',
          current: 0,
          total: episodes.length
        })
        detections = await skip.runSkipAnalysis(animeId, allInputs)
      }

      const cache = store.get('skipFingerprintCache') as Record<string, CachedFingerprint>
      let written = 0
      let skipped = 0
      let failed = 0

      for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i]
        broadcast(EVENT_CHANNELS.CHAPTER_INJECT_PROGRESS, {
          animeId,
          phase: 'writing',
          current: i,
          total: episodes.length,
          episodeLabel: ep.episodeLabel
        })

        const det = detections.perEpisode[ep.episodeInt]
        if (!det) {
          skipped++
          continue
        }
        const chaptersMeta = formatChaptersMetadata(det.durationSec, det.op, det.ed)
        if (!chaptersMeta) {
          skipped++
          continue
        }

        const dir = path.dirname(ep.filePath)
        const base = path.basename(ep.filePath)
        const tmpOut = path.join(dir, `.${base}.chapters.tmp.mkv`)
        const chaptersMetaFile = path.join(
          os.tmpdir(),
          `anime-dl-chapters-${process.pid}-${Date.now()}-${i}.txt`
        )
        try {
          const oldStat = fs.statSync(ep.filePath)
          const oldKey = fingerprintCacheKey(animeId, ep.episodeInt, oldStat.size, oldStat.mtimeMs)
          const cached = cache[oldKey]

          fs.writeFileSync(chaptersMetaFile, chaptersMeta, 'utf8')
          await new Promise<void>((resolve, reject) => {
            Ffmpeg.setFfmpegPath(ffmpegPath)
            Ffmpeg(ep.filePath)
              .input(chaptersMetaFile)
              .outputOptions('-y')
              .outputOptions(['-map', '0', '-map_chapters', '1', '-c', 'copy'])
              .output(tmpOut)
              .on('end', () => resolve())
              .on('error', reject)
              .run()
          })
          fs.renameSync(tmpOut, ep.filePath)

          if (cached) {
            const newStat = fs.statSync(ep.filePath)
            const newKey = fingerprintCacheKey(
              animeId,
              ep.episodeInt,
              newStat.size,
              newStat.mtimeMs
            )
            delete cache[oldKey]
            cache[newKey] = { ...cached, fileSize: newStat.size, fileMtimeMs: newStat.mtimeMs }
            store.set('skipFingerprintCache', cache)
          }
          written++
        } catch (err) {
          failed++
          try {
            fs.unlinkSync(tmpOut)
          } catch {
            /* ignore */
          }
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[chapter-inject] failed for ${ep.episodeLabel}: ${msg}`)
        } finally {
          try {
            fs.unlinkSync(chaptersMetaFile)
          } catch {
            /* ignore */
          }
        }
      }

      broadcast(EVENT_CHANNELS.CHAPTER_INJECT_PROGRESS, {
        animeId,
        phase: 'done',
        current: episodes.length,
        total: episodes.length
      })
      return { written, skipped, failed, total: episodes.length }
    }
  )
}
