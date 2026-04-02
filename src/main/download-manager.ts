import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import Ffmpeg from 'fluent-ffmpeg'

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
  quality: number
  status: DownloadStatus
  bytesReceived: number
  totalBytes: number
  speed: number
  error?: string
}

export interface EpisodeGroup {
  translationId: number
  animeName: string
  episodeLabel: string
  quality: number
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

interface EmbedData {
  download: { height: number; url: string }[]
  stream: { height: number; urls: string[] }[]
  subtitlesUrl: string | null
}

const USER_AGENT = 'smotret-anime-dl'
const MAX_CONCURRENT = 2
const RETRY_LIMIT = 3
const PROGRESS_INTERVAL_MS = 500

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim()
}

export class DownloadManager {
  private queue: DownloadItem[] = []
  private mergeStatuses = new Map<number, { status: MergeStatus; error?: string; percent?: number }>()
  private activeCount = 0
  private abortControllers = new Map<string, AbortController>()
  private progressTimer: ReturnType<typeof setInterval> | null = null
  private downloadDir: string
  private getToken: () => string
  private episodeCompleteCallback: (() => void) | null = null
  private merging = false

  constructor(downloadDir: string, getToken: () => string) {
    this.downloadDir = downloadDir
    this.getToken = getToken
    this.progressTimer = setInterval(() => this.broadcastProgress(), PROGRESS_INTERVAL_MS)
  }

  onEpisodeComplete(callback: () => void): void {
    this.episodeCompleteCallback = callback
  }

  setDownloadDir(dir: string): void {
    this.downloadDir = dir
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
          episodeLabel: item.episodeLabel,
          quality: item.quality,
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

  private async fetchEmbed(translationId: number): Promise<EmbedData> {
    const token = this.getToken()
    const url = `https://smotret-anime.ru/api/translations/embed/${translationId}?access_token=${token}`
    console.log(`[download] Fetching embed: ${url.replace(token, 'TOKEN')}`)
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    })
    if (!response.ok) {
      console.error(`[download] Embed API error: ${response.status} for translation ${translationId}`)
      throw new Error(`Embed API error: ${response.status}`)
    }
    const json = await response.json() as { data: EmbedData }
    console.log(`[download] Embed response for ${translationId}: ${json.data.stream?.length || 0} stream URLs, subtitles: ${!!json.data.subtitlesUrl}`)
    return json.data
  }

  async enqueue(requests: DownloadRequest[]): Promise<void> {
    for (const req of requests) {
      const padded = req.episodeInt.padStart(2, '0')
      const animeDirName = sanitizeFilename(req.animeName)
      const baseFilename = sanitizeFilename(`${req.animeName} - ${padded}`)

      const videoId = `video-${req.translationId}`
      if (this.queue.find(i => i.id === videoId)) continue

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
            quality: best.height,
            status: 'queued',
            bytesReceived: 0,
            totalBytes: 0,
            speed: 0
          })
        }

        if (embed.subtitlesUrl) {
          const subId = `sub-${req.translationId}`
          if (!this.queue.find(i => i.id === subId)) {
            const token = this.getToken()
            const subUrl = `https://smotret-anime.ru/translations/ass/${req.translationId}?download=1`
              + (token ? `&access_token=${token}` : '')
            this.queue.push({
              id: subId,
              translationId: req.translationId,
              kind: 'subtitle',
              url: subUrl,
              filename: path.join(animeDirName, `${baseFilename}.ass`),
              animeName: req.animeName,
              episodeLabel: req.episodeLabel,
              quality: best?.height || req.height,
              status: 'queued',
              bytesReceived: 0,
              totalBytes: 0,
              speed: 0
            })
          }
        }
      } catch (err) {
        const token = this.getToken()
        const fallbackUrl = `https://smotret-anime.ru/translations/mp4/${req.translationId}?format=mp4&height=${req.height}`
          + (token ? `&access_token=${token}` : '')
        this.queue.push({
          id: videoId,
          translationId: req.translationId,
          kind: 'video',
          url: fallbackUrl,
          filename: path.join(animeDirName, `${baseFilename}.mp4`),
          animeName: req.animeName,
          episodeLabel: req.episodeLabel,
          quality: req.height,
          status: 'queued',
          bytesReceived: 0,
          totalBytes: 0,
          speed: 0,
          error: `Embed fetch failed, using fallback URL`
        })
      }
    }

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
      this.activeCount--
      this.processQueue()
    } else if (item.status === 'queued') {
      item.status = 'paused'
    }
  }

  resume(id: string): void {
    const item = this.queue.find(i => i.id === id)
    if (item && (item.status === 'paused' || item.status === 'failed')) {
      item.status = 'queued'
      item.error = undefined
      this.processQueue()
    }
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
        const token = this.getToken()
        item.url = `https://smotret-anime.ru/translations/ass/${item.translationId}?download=1`
          + (token ? `&access_token=${token}` : '')
      }
    } catch (err) {
      console.error(`[download] Restart: failed to re-fetch embed for ${item.translationId}`, err)
    }

    item.bytesReceived = 0
    item.totalBytes = 0
    item.speed = 0
    item.error = undefined
    item.status = 'queued'
    this.processQueue()
  }

  cancel(id: string): void {
    const item = this.queue.find(i => i.id === id)
    if (!item) return
    if (item.status === 'downloading') {
      const controller = this.abortControllers.get(id)
      controller?.abort()
      this.abortControllers.delete(id)
      this.activeCount--
    }
    item.status = 'cancelled'
    item.speed = 0
    const filePath = path.join(this.downloadDir, item.filename + '.part')
    try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    this.processQueue()
  }

  cancelByEpisode(animeName: string, episodeLabel?: string): void {
    for (const item of [...this.queue]) {
      if (item.animeName !== animeName) continue
      if (episodeLabel && item.episodeLabel !== episodeLabel) continue
      if (item.status === 'completed' || item.status === 'cancelled') continue
      this.cancel(item.id)
    }
  }

  clearCompleted(): void {
    const removedTrIds = new Set<number>()
    for (const item of this.queue) {
      if (item.status === 'completed' || item.status === 'cancelled' || item.status === 'failed') {
        removedTrIds.add(item.translationId)
      }
    }
    this.queue = this.queue.filter(i => i.status !== 'completed' && i.status !== 'cancelled' && i.status !== 'failed')
    for (const trId of removedTrIds) {
      // only remove merge status if no items left for this translation
      if (!this.queue.find(i => i.translationId === trId)) {
        this.mergeStatuses.delete(trId)
      }
    }
  }

  async mergeCompleted(ffmpegPath: string, videoCodec = 'copy'): Promise<void> {
    if (this.merging) return
    this.merging = true

    try {
      await this._mergeAll(ffmpegPath, videoCodec)
    } finally {
      this.merging = false
    }
  }

  private async _mergeAll(ffmpegPath: string, videoCodec: string): Promise<void> {
    const groups = this.getEpisodeGroups()

    for (const group of groups) {
      if (!group.video || group.video.status !== 'completed') continue
      if (group.mergeStatus === 'completed' || group.mergeStatus === 'merging') continue

      const videoPath = path.join(this.downloadDir, group.video.filename)
      if (!fs.existsSync(videoPath)) continue

      const hasSubtitle = group.subtitle && group.subtitle.status === 'completed'
      const subtitlePath = hasSubtitle ? path.join(this.downloadDir, group.subtitle!.filename) : null

      const mkvFilename = group.video.filename.replace(/\.mp4$/, '.mkv')
      const mkvPath = path.join(this.downloadDir, mkvFilename)

      this.mergeStatuses.set(group.translationId, { status: 'merging' })

      try {
        await this.runFfmpeg(ffmpegPath, videoPath, subtitlePath, mkvPath, videoCodec, (pct) => {
          this.mergeStatuses.set(group.translationId, { status: 'merging', percent: pct })
        })
        this.mergeStatuses.set(group.translationId, { status: 'completed' })
        console.log(`[merge] Completed: ${mkvFilename}`)
        // Delete source files after successful merge
        try { fs.unlinkSync(videoPath) } catch { /* ignore */ }
        if (subtitlePath) {
          try { fs.unlinkSync(subtitlePath) } catch { /* ignore */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        this.mergeStatuses.set(group.translationId, { status: 'failed', error: msg })
        console.error(`[merge] Failed: ${mkvFilename} - ${msg}`)
      }
    }
  }

  private probeDuration(ffmpegPath: string, videoPath: string): Promise<number> {
    return new Promise((resolve) => {
      Ffmpeg.setFfmpegPath(ffmpegPath)
      Ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err || !metadata?.format?.duration) {
          resolve(0)
        } else {
          resolve(metadata.format.duration)
        }
      })
    })
  }

  private async runFfmpeg(ffmpegPath: string, videoPath: string, subtitlePath: string | null, outputPath: string, videoCodec = 'copy', onPercent?: (pct: number) => void): Promise<void> {
    const totalDuration = await this.probeDuration(ffmpegPath, videoPath)
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
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  }

  async scanAndMerge(ffmpegPath: string, videoCodec = 'copy', onProgress?: (current: number, total: number, file: string, percent: number) => void): Promise<{ merged: number; failed: string[] }> {
    if (this.merging) return { merged: 0, failed: [] }
    this.merging = true

    const result = { merged: 0, failed: [] as string[] }

    try {
      if (!fs.existsSync(this.downloadDir)) return result

      const animeDirs = fs.readdirSync(this.downloadDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)

      // Collect all mp4 files that have no matching mkv
      const toMerge: { videoPath: string; subtitlePath: string | null; outputPath: string; label: string }[] = []

      for (const dir of animeDirs) {
        const dirPath = path.join(this.downloadDir, dir)
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

      console.log(`[scan-merge] Found ${toMerge.length} files to merge`)

      for (let i = 0; i < toMerge.length; i++) {
        const item = toMerge[i]
        onProgress?.(i + 1, toMerge.length, item.label, 0)

        try {
          await this.runFfmpeg(ffmpegPath, item.videoPath, item.subtitlePath, item.outputPath, videoCodec, (pct) => {
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
    while (this.activeCount < MAX_CONCURRENT) {
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

      const readable = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
      await pipeline(readable, trackProgress, fileStream)

      fs.renameSync(partPath, filePath)
      item.status = 'completed'
      item.speed = 0

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
    if (allDone && this.episodeCompleteCallback) {
      // Defer to avoid blocking the download pipeline
      setTimeout(() => this.episodeCompleteCallback?.(), 100)
    }
  }

  private broadcastProgress(): void {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) return
    const data = this.getEpisodeGroups()
    for (const win of windows) {
      win.webContents.send('download:progress', data)
    }
  }

  destroy(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
    }
    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
  }
}
