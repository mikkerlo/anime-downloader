import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import Ffmpeg from 'fluent-ffmpeg'
import type { SmotretApi } from './smotret-api'

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type MergeStatus = 'pending' | 'merging' | 'completed' | 'failed'

export interface DownloadItem {
  id: string
  translationId: number
  kind: 'video' | 'subtitle'
  url: string
  filename: string
  animeName: string
  episodeLabel: string
  animeId: number
  episodeInt: string
  quality: number
  translationType: string
  author: string
  status: DownloadStatus
  bytesReceived: number
  totalBytes: number
  speed: number
  error?: string
}

export interface EpisodeGroup {
  translationId: number
  animeName: string
  animeId: number
  episodeInt: string
  episodeLabel: string
  quality: number
  translationType: string
  author: string
  video: DownloadItem | null
  subtitle: DownloadItem | null
  mergeStatus: MergeStatus
  mergePercent?: number
  mergeError?: string
}

export interface DownloadRequest {
  translationId: number
  height: number
  animeName: string
  episodeLabel: string
  episodeInt: string
  animeId: number
  translationType: string
  author: string
}

export interface EpisodeCompleteInfo {
  animeName: string
  episodeLabel: string
  animeId: number
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  quality: number
}

const USER_AGENT = 'smotret-anime-dl'
const RETRY_LIMIT = 3
const PROGRESS_INTERVAL_MS = 500

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim()
}

function subtitleLanguage(translationType: string): string {
  if (translationType.endsWith('Ru') || translationType === 'voiceRu' || translationType === 'subRu') return 'rus'
  if (translationType.endsWith('En') || translationType === 'voiceEn' || translationType === 'subEn') return 'eng'
  return 'und'
}

export class DownloadManager {
  private queue: DownloadItem[] = []
  private mergeStatuses = new Map<number, { status: MergeStatus; error?: string; percent?: number }>()
  private activeCount = 0
  private abortControllers = new Map<string, AbortController>()
  private progressTimer: ReturnType<typeof setInterval> | null = null
  private downloadDir: string
  private api: SmotretApi
  private getSpeedLimit: () => number
  private getConcurrentLimit: () => number
  private episodeCompleteCallback: ((info: EpisodeCompleteInfo) => void) | null = null
  private mergeCompleteCallback: ((info: { animeName: string; animeId: number; episodeInt: string; episodeLabel: string }) => void) | null = null
  private queueCompleteCallback: (() => void) | null = null
  private videoDownloadedCallback: ((filePath: string, item: DownloadItem) => void) | null = null
  private merging = false
  private activeFfmpegCmd: ReturnType<typeof Ffmpeg> | null = null
  private activeMergeTranslationId: number | null = null
  private mergeCancelled = false
  private queueFilePath: string
  private persistScheduled = false

  constructor(downloadDir: string, api: SmotretApi, userDataPath: string, getSpeedLimit: () => number = () => 0, getConcurrentLimit: () => number = () => 2) {
    this.downloadDir = downloadDir
    this.api = api
    this.getSpeedLimit = getSpeedLimit
    this.getConcurrentLimit = getConcurrentLimit
    this.queueFilePath = path.join(userDataPath, 'queue.json')
    this.progressTimer = setInterval(() => this.broadcastProgress(), PROGRESS_INTERVAL_MS)
  }

  private persistQueue(): void {
    const activeItems = this.queue.filter(i => i.status !== 'cancelled')
    if (activeItems.length === 0) {
      try { fs.unlinkSync(this.queueFilePath) } catch { /* ignore */ }
      return
    }
    const data = {
      queue: activeItems.map(item => ({ ...item, speed: 0 })),
      mergeStatuses: Object.fromEntries(this.mergeStatuses)
    }
    const tmpPath = this.queueFilePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.queueFilePath)
  }

  private schedulePersist(): void {
    if (this.persistScheduled) return
    this.persistScheduled = true
    queueMicrotask(() => {
      this.persistScheduled = false
      this.persistQueue()
    })
  }

  loadQueue(): void {
    try {
      if (!fs.existsSync(this.queueFilePath)) return
      const raw = fs.readFileSync(this.queueFilePath, 'utf-8')
      const data = JSON.parse(raw)

      if (Array.isArray(data.queue)) {
        for (const item of data.queue) {
          if (item.status === 'downloading' || item.status === 'queued') {
            item.status = 'paused'
            item.speed = 0
          }
          // Defensive: older queue.json predates animeId/episodeInt on items
          if (typeof item.animeId !== 'number') item.animeId = 0
          if (typeof item.episodeInt !== 'string') item.episodeInt = ''
          this.queue.push(item)
        }
      }

      if (data.mergeStatuses && typeof data.mergeStatuses === 'object') {
        for (const [key, value] of Object.entries(data.mergeStatuses)) {
          const ms = value as { status: MergeStatus; error?: string; percent?: number }
          if (ms.status === 'merging') {
            ms.status = 'pending'
            ms.percent = undefined
          }
          this.mergeStatuses.set(Number(key), ms)
        }
      }

      console.log(`[download] Restored ${this.queue.length} items from queue.json`)
    } catch (err) {
      console.error('[download] Failed to load queue from disk:', err)
    }
  }

  onEpisodeComplete(callback: (info: EpisodeCompleteInfo) => void): void {
    this.episodeCompleteCallback = callback
  }

  onMergeComplete(callback: (info: { animeName: string; animeId: number; episodeInt: string; episodeLabel: string }) => void): void {
    this.mergeCompleteCallback = callback
  }

  onQueueComplete(callback: () => void): void {
    this.queueCompleteCallback = callback
  }

  onVideoDownloaded(callback: (filePath: string, item: DownloadItem) => void): void {
    this.videoDownloadedCallback = callback
  }

  setDownloadDir(dir: string): void {
    this.downloadDir = dir
  }

  getItem(id: string): DownloadItem | null {
    return this.queue.find(i => i.id === id) || null
  }

  findCancellableItems(animeName: string, episodeLabel?: string): DownloadItem[] {
    return this.queue.filter(i =>
      i.animeName === animeName &&
      (!episodeLabel || i.episodeLabel === episodeLabel) &&
      i.status !== 'completed' &&
      i.status !== 'cancelled'
    )
  }

  getEpisodeGroups(): EpisodeGroup[] {
    const groups = new Map<number, EpisodeGroup>()

    for (const item of this.queue) {
      if (item.status === 'cancelled') continue
      if (!groups.has(item.translationId)) {
        const merge = this.mergeStatuses.get(item.translationId)
        groups.set(item.translationId, {
          translationId: item.translationId,
          animeName: item.animeName,
          animeId: item.animeId,
          episodeInt: item.episodeInt,
          episodeLabel: item.episodeLabel,
          quality: item.quality,
          translationType: item.translationType,
          author: item.author,
          video: null,
          subtitle: null,
          mergeStatus: merge?.status || 'pending',
          mergePercent: merge?.percent,
          mergeError: merge?.error
        })
      }
      const group = groups.get(item.translationId)!
      if (item.kind === 'video') group.video = { ...item }
      else group.subtitle = { ...item }
    }

    return [...groups.values()]
  }

  private async fetchEmbed(translationId: number) {
    console.log(`[download] Fetching embed for translation ${translationId}`)
    const data = await this.api.getEmbed(translationId)
    console.log(`[download] Embed response for ${translationId}: ${data.stream?.length || 0} stream URLs, subtitles: ${!!data.subtitlesUrl}`)
    return data
  }

  async enqueue(requests: DownloadRequest[]): Promise<void> {
    for (const req of requests) {
      const padded = req.episodeInt.padStart(2, '0')
      const animeDirName = sanitizeFilename(req.animeName)
      const authorTag = sanitizeFilename(req.author)
      const baseFilename = sanitizeFilename(`${req.animeName} - ${padded}`) + ` [${authorTag}]`

      const videoId = `video-${req.translationId}`
      const existing = this.queue.find(i => i.id === videoId)
      if (existing) {
        if (existing.status === 'completed' || existing.status === 'cancelled' || existing.status === 'failed') {
          // Remove stale entry so it can be re-enqueued
          this.queue = this.queue.filter(i => i.translationId !== req.translationId)
          this.mergeStatuses.delete(req.translationId)
        } else {
          continue // still active — skip
        }
      }

      try {
        const embed = await this.fetchEmbed(req.translationId)

        const sorted = [...embed.stream].sort((a, b) => b.height - a.height)
        const best = sorted.find(d => d.height <= req.height) || sorted[0]

        if (best && best.urls.length > 0) {
          console.log(`[download] Using stream URL for ${req.translationId} at ${best.height}p`)
          this.queue.push({
            id: videoId,
            translationId: req.translationId,
            kind: 'video',
            url: best.urls[0],
            filename: path.join(animeDirName, `${baseFilename}.mp4`),
            animeName: req.animeName,
            episodeLabel: req.episodeLabel,
            animeId: req.animeId,
            episodeInt: req.episodeInt,
            quality: best.height,
            translationType: req.translationType,
            author: req.author,
            status: 'queued',
            bytesReceived: 0,
            totalBytes: 0,
            speed: 0
          })
        }

        if (embed.subtitlesUrl) {
          const subId = `sub-${req.translationId}`
          if (!this.queue.find(i => i.id === subId)) {
            this.queue.push({
              id: subId,
              translationId: req.translationId,
              kind: 'subtitle',
              url: this.api.getSubtitlesUrl(req.translationId),
              filename: path.join(animeDirName, `${baseFilename}.ass`),
              animeName: req.animeName,
              episodeLabel: req.episodeLabel,
              animeId: req.animeId,
              episodeInt: req.episodeInt,
              quality: best?.height || req.height,
              translationType: req.translationType,
              author: req.author,
              status: 'queued',
              bytesReceived: 0,
              totalBytes: 0,
              speed: 0
            })
          }
        }
      } catch (err) {
        this.queue.push({
          id: videoId,
          translationId: req.translationId,
          kind: 'video',
          url: this.api.getFallbackVideoUrl(req.translationId, req.height),
          filename: path.join(animeDirName, `${baseFilename}.mp4`),
          animeName: req.animeName,
          episodeLabel: req.episodeLabel,
          animeId: req.animeId,
          episodeInt: req.episodeInt,
          quality: req.height,
          translationType: req.translationType,
          author: req.author,
          status: 'queued',
          bytesReceived: 0,
          totalBytes: 0,
          speed: 0,
          error: `Embed fetch failed, using fallback URL`
        })
      }
    }

    this.persistQueue()
    this.processQueue()
  }

  pause(id: string): void {
    const item = this.queue.find(i => i.id === id)
    if (!item) return
    if (item.status === 'downloading') {
      const controller = this.abortControllers.get(id)
      controller?.abort()
      this.abortControllers.delete(id)
      item.status = 'paused'
      item.speed = 0
      // Don't decrement activeCount here — the finally block in startDownload handles it
    } else if (item.status === 'queued') {
      item.status = 'paused'
    }
    this.schedulePersist()
  }

  resume(id: string): void {
    const item = this.queue.find(i => i.id === id)
    if (item && (item.status === 'paused' || item.status === 'failed')) {
      item.status = 'queued'
      item.error = undefined
      this.schedulePersist()
      this.processQueue()
    }
  }

  pauseAll(): void {
    for (const item of this.queue) {
      if (item.status === 'downloading' || item.status === 'queued') {
        this.pause(item.id)
      }
    }
  }

  resumeAll(): void {
    for (const item of this.queue) {
      if (item.status === 'paused') {
        item.status = 'queued'
        item.error = undefined
      }
    }
    this.schedulePersist()
    this.processQueue()
  }

  async restart(id: string): Promise<void> {
    const item = this.queue.find(i => i.id === id)
    if (!item || (item.status !== 'failed' && item.status !== 'paused')) return

    // Delete .part file
    const partPath = path.join(this.downloadDir, item.filename + '.part')
    try { fs.unlinkSync(partPath) } catch { /* ignore */ }

    // Re-fetch embed API for fresh URLs
    try {
      const embed = await this.fetchEmbed(item.translationId)

      if (item.kind === 'video') {
        const sorted = [...embed.stream].sort((a, b) => b.height - a.height)
        const best = sorted.find(d => d.height <= item.quality) || sorted[0]
        if (best && best.urls.length > 0) {
          item.url = best.urls[0]
          item.quality = best.height
        }
      } else if (item.kind === 'subtitle' && embed.subtitlesUrl) {
        item.url = this.api.getSubtitlesUrl(item.translationId)
      }
    } catch (err) {
      console.error(`[download] Restart: failed to re-fetch embed for ${item.translationId}`, err)
    }

    item.bytesReceived = 0
    item.totalBytes = 0
    item.speed = 0
    item.error = undefined
    item.status = 'queued'
    this.schedulePersist()
    this.processQueue()
  }

  async restartAllFailed(): Promise<void> {
    const failed = this.queue.filter(i => i.status === 'failed')
    for (const item of failed) {
      await this.restart(item.id)
    }
    this.schedulePersist()
  }

  cancel(id: string): void {
    const item = this.queue.find(i => i.id === id)
    if (!item) return
    if (item.status === 'downloading') {
      const controller = this.abortControllers.get(id)
      controller?.abort()
      this.abortControllers.delete(id)
      // Don't decrement activeCount here — the finally block in startDownload handles it
    }
    item.status = 'cancelled'
    item.speed = 0
    // Delete .part file and completed file
    const partPath = path.join(this.downloadDir, item.filename + '.part')
    const filePath = path.join(this.downloadDir, item.filename)
    try { fs.unlinkSync(partPath) } catch { /* ignore */ }
    try { fs.unlinkSync(filePath) } catch { /* ignore */ }

    // Also cancel and clean up the subtitle for this translation
    if (item.kind === 'video') {
      const subItem = this.queue.find(i => i.translationId === item.translationId && i.kind === 'subtitle')
      if (subItem && subItem.status !== 'cancelled') {
        this.cancel(subItem.id)
      }
    }

    this.schedulePersist()
    this.processQueue()
  }

  cancelMerge(translationId?: number): void {
    if (this.activeFfmpegCmd) {
      if (translationId && this.activeMergeTranslationId !== translationId) return
      this.mergeCancelled = true
      this.activeFfmpegCmd.kill('SIGKILL')
    }
    // Also cancel pending merges by resetting their status
    if (translationId) {
      this.mergeStatuses.delete(translationId)
    }
  }

  cancelByEpisode(animeName: string, episodeLabel?: string): void {
    for (const item of [...this.queue]) {
      if (item.animeName !== animeName) continue
      if (episodeLabel && item.episodeLabel !== episodeLabel) continue
      if (item.status === 'completed' || item.status === 'cancelled') continue
      // Also cancel merge if active for this translation
      const mergeStatus = this.mergeStatuses.get(item.translationId)
      if (mergeStatus?.status === 'merging') {
        this.cancelMerge(item.translationId)
      }
      this.cancel(item.id)
    }
    this.schedulePersist()
  }

  clearCompleted(): void {
    const removedTrIds = new Set<number>()
    for (const item of this.queue) {
      if (item.status === 'cancelled' || item.status === 'failed') {
        removedTrIds.add(item.translationId)
      } else if (item.status === 'completed') {
        // Only clear completed items if merge is done (or no merge needed)
        const merge = this.mergeStatuses.get(item.translationId)
        if (merge?.status === 'completed' || merge?.status === 'failed') {
          removedTrIds.add(item.translationId)
        }
      }
    }
    this.queue = this.queue.filter(i => !removedTrIds.has(i.translationId))
    for (const trId of removedTrIds) {
      this.mergeStatuses.delete(trId)
    }
    this.schedulePersist()
  }

  async mergeCompleted(ffmpegPath: string, ffprobePath: string, videoCodec = 'copy'): Promise<void> {
    if (this.merging) return
    this.merging = true

    try {
      await this._mergeAll(ffmpegPath, ffprobePath, videoCodec)
    } finally {
      this.merging = false
    }
  }

  private async _mergeAll(ffmpegPath: string, ffprobePath: string, videoCodec: string): Promise<void> {
    this.mergeCancelled = false
    const groups = this.getEpisodeGroups()

    for (const group of groups) {
      if (this.mergeCancelled) break
      if (!group.video || group.video.status !== 'completed') continue
      if (group.mergeStatus === 'completed' || group.mergeStatus === 'merging') continue

      const videoPath = path.join(this.downloadDir, group.video.filename)
      if (!fs.existsSync(videoPath)) continue

      const hasSubtitle = group.subtitle && group.subtitle.status === 'completed'
      const subtitlePath = hasSubtitle ? path.join(this.downloadDir, group.subtitle!.filename) : null

      const mkvFilename = group.video.filename.replace(/\.mp4$/, '.mkv')
      const mkvPath = path.join(this.downloadDir, mkvFilename)

      this.mergeStatuses.set(group.translationId, { status: 'merging' })
      this.activeMergeTranslationId = group.translationId

      const subMeta = hasSubtitle ? {
        language: subtitleLanguage(group.translationType),
        title: group.author || 'Subtitles'
      } : undefined

      try {
        await this.runFfmpeg(ffmpegPath, ffprobePath, videoPath, subtitlePath, mkvPath, videoCodec, (pct) => {
          this.mergeStatuses.set(group.translationId, { status: 'merging', percent: pct })
        }, subMeta)
        this.mergeStatuses.set(group.translationId, { status: 'completed' })
        this.schedulePersist()
        console.log(`[merge] Completed: ${mkvFilename}`)
        if (this.mergeCompleteCallback) {
          this.mergeCompleteCallback({
            animeName: group.animeName,
            animeId: group.animeId,
            episodeInt: group.episodeInt,
            episodeLabel: group.episodeLabel
          })
        }
        // Delete source files after successful merge
        try { fs.unlinkSync(videoPath) } catch { /* ignore */ }
        if (subtitlePath) {
          try { fs.unlinkSync(subtitlePath) } catch { /* ignore */ }
        }
      } catch (err) {
        // Clean up partial output file
        try { fs.unlinkSync(mkvPath) } catch { /* ignore */ }
        if (this.mergeCancelled) {
          this.mergeStatuses.delete(group.translationId)
          console.log(`[merge] Cancelled: ${mkvFilename}`)
        } else {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          this.mergeStatuses.set(group.translationId, { status: 'failed', error: msg })
          this.schedulePersist()
          console.error(`[merge] Failed: ${mkvFilename} - ${msg}`)
        }
      }
    }
    this.activeMergeTranslationId = null
  }

  private probeDuration(ffmpegPath: string, ffprobePath: string, videoPath: string): Promise<number> {
    return new Promise((resolve) => {
      Ffmpeg.setFfmpegPath(ffmpegPath)
      Ffmpeg.setFfprobePath(ffprobePath)
      Ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error(`[ffprobe] Error probing ${videoPath}:`, err.message)
          resolve(0)
        } else if (!metadata?.format?.duration) {
          console.warn(`[ffprobe] No duration in metadata for ${videoPath}`)
          resolve(0)
        } else {
          console.log(`[ffprobe] Duration: ${metadata.format.duration}s for ${videoPath}`)
          resolve(metadata.format.duration)
        }
      })
    })
  }

  private async runFfmpeg(ffmpegPath: string, ffprobePath: string, videoPath: string, subtitlePath: string | null, outputPath: string, videoCodec = 'copy', onPercent?: (pct: number) => void, subMeta?: { language: string; title: string }): Promise<void> {
    const totalDuration = await this.probeDuration(ffmpegPath, ffprobePath, videoPath)
    console.log(`[merge] Probed duration: ${totalDuration}s for ${videoPath}`)

    return new Promise((resolve, reject) => {
      Ffmpeg.setFfmpegPath(ffmpegPath)

      let cmd = Ffmpeg(videoPath)
        .outputOptions('-y')
        .videoCodec(videoCodec)
        .audioCodec('copy')

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        cmd = cmd
          .input(subtitlePath)
          .outputOptions(['-map', '0:v', '-map', '0:a', '-map', '1:s'])
          .outputOptions('-c:s', 'ass')
          .outputOptions('-disposition:s:0', 'default')
        if (subMeta) {
          cmd = cmd
            .outputOptions('-metadata:s:s:0', `language=${subMeta.language}`)
            .outputOptions('-metadata:s:s:0', `title=${subMeta.title}`)
        }
      }

      console.log(`[merge] Running ffmpeg: ${videoPath} -> ${outputPath} (codec: ${videoCodec})`)

      cmd
        .output(outputPath)
        .on('progress', (progress) => {
          let pct = progress.percent ?? 0
          // fluent-ffmpeg percent is often NaN/0; calculate from timemark
          if ((!pct || isNaN(pct)) && totalDuration > 0 && progress.timemark) {
            const parts = progress.timemark.split(':').map(Number)
            const currentSec = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)
            pct = (currentSec / totalDuration) * 100
          }
          onPercent?.(Math.min(100, Math.round(pct)))
        })
        .on('end', () => {
          this.activeFfmpegCmd = null
          this.activeMergeTranslationId = null
          resolve()
        })
        .on('error', (err) => {
          this.activeFfmpegCmd = null
          this.activeMergeTranslationId = null
          reject(err)
        })

      this.activeFfmpegCmd = cmd
      cmd.run()
    })
  }

  async scanAndMerge(ffmpegPath: string, ffprobePath: string, videoCodec = 'copy', onProgress?: (current: number, total: number, file: string, percent: number) => void, extraDirs?: string[]): Promise<{ merged: number; failed: string[] }> {
    if (this.merging) return { merged: 0, failed: [] }
    this.merging = true

    const result = { merged: 0, failed: [] as string[] }

    try {
      const scanDirs = [this.downloadDir, ...(extraDirs || [])].filter(d => fs.existsSync(d))

      // Collect all mp4 files that have no matching mkv
      const toMerge: { videoPath: string; subtitlePath: string | null; outputPath: string; label: string }[] = []

      for (const scanDir of scanDirs) {
        const animeDirs = fs.readdirSync(scanDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)

        for (const dir of animeDirs) {
          const dirPath = path.join(scanDir, dir)
          const files = fs.readdirSync(dirPath)

          const mp4Files = files.filter(f => f.endsWith('.mp4'))
          for (const mp4 of mp4Files) {
            const base = mp4.replace(/\.mp4$/, '')
            const mkvPath = path.join(dirPath, `${base}.mkv`)
            if (fs.existsSync(mkvPath)) continue // already merged

            const videoPath = path.join(dirPath, mp4)
            const assFile = `${base}.ass`
            const subtitlePath = files.includes(assFile) ? path.join(dirPath, assFile) : null
            toMerge.push({ videoPath, subtitlePath, outputPath: mkvPath, label: `${dir}/${mp4}` })
          }
        }
      }

      console.log(`[scan-merge] Found ${toMerge.length} files to merge`)

      for (let i = 0; i < toMerge.length; i++) {
        const item = toMerge[i]
        onProgress?.(i + 1, toMerge.length, item.label, 0)

        try {
          await this.runFfmpeg(ffmpegPath, ffprobePath, item.videoPath, item.subtitlePath, item.outputPath, videoCodec, (pct) => {
            onProgress?.(i + 1, toMerge.length, item.label, pct)
          })

          // Delete source files
          try { fs.unlinkSync(item.videoPath) } catch { /* ignore */ }
          if (item.subtitlePath) {
            try { fs.unlinkSync(item.subtitlePath) } catch { /* ignore */ }
          }

          result.merged++
          console.log(`[scan-merge] Merged: ${item.label}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.failed.push(`${item.label}: ${msg}`)
          console.error(`[scan-merge] Failed: ${item.label} - ${msg}`)
        }
      }
    } finally {
      this.merging = false
    }

    return result
  }

  private processQueue(): void {
    while (this.activeCount < this.getConcurrentLimit()) {
      const next = this.queue.find(i => i.status === 'queued')
      if (!next) break
      this.startDownload(next)
    }
  }

  private async startDownload(item: DownloadItem, retryCount = 0): Promise<void> {
    item.status = 'downloading'
    item.error = undefined
    this.activeCount++

    const controller = new AbortController()
    this.abortControllers.set(item.id, controller)

    const filePath = path.join(this.downloadDir, item.filename)
    const partPath = filePath + '.part'

    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    const headers: Record<string, string> = { 'User-Agent': USER_AGENT }

    let existingBytes = 0
    try {
      const stat = fs.statSync(partPath)
      existingBytes = stat.size
      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`
      }
    } catch { /* file doesn't exist yet */ }

    try {
      console.log(`[download] Starting: ${item.filename} -> ${item.url.substring(0, 120)}...`)
      const response = await fetch(item.url, {
        headers,
        signal: controller.signal,
        redirect: 'follow'
      })

      console.log(`[download] Response: ${response.status} ${response.statusText} for ${item.filename}`)

      // Range not satisfiable — .part file is stale, delete and retry from zero
      if (response.status === 416) {
        console.log(`[download] Got 416, deleting .part and retrying from zero: ${item.filename}`)
        try { fs.unlinkSync(partPath) } catch { /* ignore */ }
        this.abortControllers.delete(item.id)
        this.activeCount--
        item.status = 'queued'
        item.bytesReceived = 0
        item.totalBytes = 0
        setTimeout(() => this.processQueue(), 500)
        return
      }

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      if (response.status === 206) {
        item.bytesReceived = existingBytes
        const contentRange = response.headers.get('content-range')
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/)
          if (match) item.totalBytes = parseInt(match[1])
        }
      } else {
        item.bytesReceived = 0
        existingBytes = 0
        const contentLength = response.headers.get('content-length')
        item.totalBytes = contentLength ? parseInt(contentLength) : 0
      }

      if (!response.body) throw new Error('No response body')

      const fileFlags = existingBytes > 0 && response.status === 206 ? 'a' : 'w'
      const fileStream = fs.createWriteStream(partPath, { flags: fileFlags })

      let lastTime = Date.now()
      let lastBytes = item.bytesReceived

      const trackProgress = new (await import('stream')).Transform({
        transform(chunk: Buffer, _encoding, callback) {
          item.bytesReceived += chunk.length
          const now = Date.now()
          const elapsed = (now - lastTime) / 1000
          if (elapsed >= 0.5) {
            item.speed = (item.bytesReceived - lastBytes) / elapsed
            lastBytes = item.bytesReceived
            lastTime = now
          }
          callback(null, chunk)
        }
      })

      const getSpeedLimit = this.getSpeedLimit
      const getActiveCount = (): number => this.activeCount
      let throttleTokens = 0
      let throttleLastTime = Date.now()

      const throttle = new (await import('stream')).Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const limit = getSpeedLimit()
          if (limit <= 0) {
            callback(null, chunk)
            return
          }

          const perDownload = limit / Math.max(1, getActiveCount())
          const now = Date.now()
          const elapsed = (now - throttleLastTime) / 1000
          throttleTokens += elapsed * perDownload
          if (throttleTokens > perDownload) throttleTokens = perDownload
          throttleLastTime = now

          if (chunk.length <= throttleTokens) {
            throttleTokens -= chunk.length
            callback(null, chunk)
          } else {
            const delay = ((chunk.length - throttleTokens) / perDownload) * 1000
            throttleTokens = 0
            setTimeout(() => {
              throttleLastTime = Date.now()
              callback(null, chunk)
            }, delay)
          }
        }
      })

      const readable = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
      await pipeline(readable, trackProgress, throttle, fileStream)

      fs.renameSync(partPath, filePath)
      item.status = 'completed'
      item.speed = 0
      this.schedulePersist()

      if (item.kind === 'video' && this.videoDownloadedCallback) {
        try { this.videoDownloadedCallback(filePath, item) } catch (e) {
          console.warn('[download] videoDownloaded callback failed:', e)
        }
      }

      this.checkEpisodeComplete(item.translationId)

    } catch (err: unknown) {
      this.abortControllers.delete(item.id)

      if (err instanceof Error && err.name === 'AbortError') {
        return
      }

      if (retryCount < RETRY_LIMIT) {
        item.status = 'queued'
        this.activeCount--
        const delay = Math.pow(2, retryCount) * 1000
        setTimeout(() => this.startDownload(item, retryCount + 1), delay)
        return
      }

      item.status = 'failed'
      item.error = err instanceof Error ? err.message : 'Unknown error'
      item.speed = 0
      this.schedulePersist()
    } finally {
      if (item.status !== 'queued') {
        this.abortControllers.delete(item.id)
        this.activeCount--
        this.processQueue()
      }
    }
  }

  private checkEpisodeComplete(translationId: number): void {
    const items = this.queue.filter(i => i.translationId === translationId && i.status !== 'cancelled')
    const allDone = items.length > 0 && items.every(i => i.status === 'completed')
    if (allDone) {
      const first = items[0]
      if (this.episodeCompleteCallback) {
        const info: EpisodeCompleteInfo = {
          animeName: first.animeName,
          episodeLabel: first.episodeLabel,
          animeId: first.animeId,
          episodeInt: first.episodeInt,
          translationId: first.translationId,
          translationType: first.translationType,
          author: first.author,
          quality: first.quality
        }
        setTimeout(() => this.episodeCompleteCallback?.(info), 100)
      }
      this.checkQueueComplete()
    }
  }

  private checkQueueComplete(): void {
    if (!this.queueCompleteCallback) return
    const hasRemaining = this.queue.some(i =>
      i.status === 'queued' || i.status === 'downloading'
    )
    if (!hasRemaining) {
      setTimeout(() => this.queueCompleteCallback?.(), 200)
    }
  }

  private broadcastTick = 0

  private broadcastProgress(): void {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) return
    const data = this.getEpisodeGroups()
    for (const win of windows) {
      win.webContents.send('download:progress', data)
    }
    // Periodic persist every 10 ticks (5s) while downloads are active
    this.broadcastTick++
    if (this.broadcastTick >= 10 && this.activeCount > 0) {
      this.broadcastTick = 0
      this.persistQueue()
    }
  }

  destroy(): void {
    this.persistQueue()
    if (this.progressTimer) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
    }
    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
  }
}
