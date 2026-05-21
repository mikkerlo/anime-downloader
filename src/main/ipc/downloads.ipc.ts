import * as fs from 'fs'
import * as path from 'path'
import { ipcMain, BrowserWindow, dialog } from 'electron'
import Ffmpeg from 'fluent-ffmpeg'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { sanitizeFilename, type DownloadRequest } from '../download-manager'
import type { AppDeps } from './index'
import type { AnimeSearchResult } from '../smotret-api'

export function register({
  store,
  downloadManager,
  coldStorageService,
  animeCacheService,
  getFfmpegPath,
  getFfprobePath
}: AppDeps): void {
  ipcMain.handle(CHANNELS.DOWNLOAD_ENQUEUE, async (_event, requests: DownloadRequest[]) => {
    await downloadManager.enqueue(requests)
    // Metadata in `downloadedEpisodes` is written by the onEpisodeComplete callback
    // once the video is actually on disk — premature writes here caused stale ⬇ icons
    // to survive cancelled or never-finished downloads.
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_PAUSE, (_event, id: string) => {
    downloadManager.pause(id)
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_RESUME, (_event, id: string) => {
    downloadManager.resume(id)
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_RESTART, async (_event, id: string) => {
    await downloadManager.restart(id)
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_RESTART_ALL_FAILED, async () => {
    await downloadManager.restartAllFailed()
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_PAUSE_ALL, () => {
    downloadManager.pauseAll()
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_RESUME_ALL, () => {
    downloadManager.resumeAll()
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_CANCEL, (_event, id: string) => {
    const item = downloadManager.getItem(id)
    downloadManager.cancel(id)
    if (item && item.animeId > 0 && item.episodeInt) {
      coldStorageService.pruneDownloadedEpisode(
        item.animeId,
        item.episodeInt,
        item.translationId,
        item.animeName,
        item.author
      )
    }
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_GET_QUEUE, () => {
    return downloadManager.getEpisodeGroups()
  })

  ipcMain.handle(
    CHANNELS.DOWNLOAD_CANCEL_BY_EPISODE,
    (_event, animeName: string, episodeLabel?: string) => {
      // Snapshot items before cancellation so we can prune metadata for any translation
      // whose file never landed on disk.
      const toPrune = downloadManager
        .findCancellableItems(animeName, episodeLabel)
        .filter((i) => i.kind === 'video' && i.animeId > 0 && i.episodeInt)
        .map((i) => ({
          animeId: i.animeId,
          episodeInt: i.episodeInt,
          translationId: i.translationId,
          animeName: i.animeName,
          author: i.author
        }))

      downloadManager.cancelByEpisode(animeName, episodeLabel)

      for (const p of toPrune) {
        coldStorageService.pruneDownloadedEpisode(
          p.animeId,
          p.episodeInt,
          p.translationId,
          p.animeName,
          p.author
        )
      }

      // If no active downloads remain for this anime and no files on disk, remove from downloaded list.
      const groups = downloadManager.getEpisodeGroups()
      const hasActive = groups.some((g) => g.animeName === animeName)
      if (!hasActive) {
        const animeDirName = sanitizeFilename(animeName)
        const animeDir = path.join(coldStorageService.getDownloadDir(), animeDirName)
        let hasFiles = false
        try {
          const files = fs.readdirSync(animeDir)
          hasFiles = files.some((f) => f.endsWith('.mkv') || f.endsWith('.mp4'))
        } catch {
          /* dir doesn't exist */
        }

        if (!hasFiles) {
          const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
          const key = Object.keys(downloaded).find((k) => {
            const a = downloaded[k]
            const name = a.titles?.romaji || a.titles?.ru || a.title
            return name === animeName
          })
          if (key) {
            delete downloaded[key]
            store.set('downloadedAnime', downloaded)
            animeCacheService.deleteEntry(Number(key))
          }
        }
      }
    }
  )

  ipcMain.handle(CHANNELS.DOWNLOADED_EPISODES_GET, (_event, animeId: number) => {
    const episodes = store.get('downloadedEpisodes') as Record<
      string,
      { translationType: string; author: string; quality: number; translationId: number }
    >
    const result: Record<
      string,
      { translationType: string; author: string; quality: number; translationId: number }[]
    > = {}
    const prefix = `${animeId}:`

    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const animeRec = downloaded[String(animeId)]
    const animeName = animeRec
      ? animeRec.titles?.romaji || animeRec.titles?.ru || animeRec.title
      : ''

    // Active downloads (kept even without a file yet so the UI lock / in-progress indicators work).
    const activeTrIds = new Set(
      downloadManager
        .getEpisodeGroups()
        .filter((g) => g.animeName === animeName)
        .map((g) => g.translationId)
    )

    let mutated = false
    for (const [key, val] of Object.entries(episodes)) {
      if (!key.startsWith(prefix)) continue
      const rest = key.substring(prefix.length)
      const colonIdx = rest.indexOf(':')
      const episodeInt = colonIdx >= 0 ? rest.substring(0, colonIdx) : rest

      // GC stale metadata whose file is not on disk and which isn't an active download.
      if (
        animeName &&
        !activeTrIds.has(val.translationId) &&
        !coldStorageService.episodeFileExists(animeName, episodeInt, val.author)
      ) {
        delete episodes[key]
        mutated = true
        continue
      }

      if (!result[episodeInt]) result[episodeInt] = []
      result[episodeInt].push(val)
    }

    if (mutated) store.set('downloadedEpisodes', episodes)
    return result
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_CANCEL_MERGE, () => {
    downloadManager.cancelMerge()
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_CLEAR_COMPLETED, () => {
    downloadManager.clearCompleted()
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_MERGE, async () => {
    const ffmpegPath = getFfmpegPath()
    if (!ffmpegPath) throw new Error('ffmpeg binary not found')
    const codec = (store.get('videoCodec') as string) || 'copy'
    await downloadManager.mergeCompleted(ffmpegPath, getFfprobePath(), codec)
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_SCAN_MERGE, async () => {
    const ffmpegPath = getFfmpegPath()
    if (!ffmpegPath) throw new Error('ffmpeg binary not found')
    const codec = (store.get('videoCodec') as string) || 'copy'
    const extraDirs =
      coldStorageService.isAdvanced() && coldStorageService.getColdStorageDir()
        ? [coldStorageService.getColdStorageDir()]
        : undefined
    return await downloadManager.scanAndMerge(
      ffmpegPath,
      getFfprobePath(),
      codec,
      (current, total, file, percent) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(EVENT_CHANNELS.SCAN_MERGE_PROGRESS, {
            current,
            total,
            file,
            percent
          })
        }
      },
      extraDirs
    )
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_FIX_METADATA, async () => {
    const ffmpegPath = getFfmpegPath()
    const ffprobePath = getFfprobePath()
    if (!ffmpegPath || !ffprobePath) throw new Error('ffmpeg/ffprobe not found')

    Ffmpeg.setFfmpegPath(ffmpegPath)
    Ffmpeg.setFfprobePath(ffprobePath)

    const downloadDir = coldStorageService.getDownloadDir()
    if (!fs.existsSync(downloadDir)) return { fixed: 0, failed: [] as string[] }

    const episodeMeta = store.get('downloadedEpisodes') as Record<
      string,
      { translationType: string; author: string; quality: number; translationId: number }
    >

    const downloadedAnime = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const metaByFile = new Map<string, { language: string; title: string }>()

    for (const [key, meta] of Object.entries(episodeMeta)) {
      const parts = key.split(':')
      const animeIdStr = parts[0]
      const epInt = parts[1]
      if (!animeIdStr || !epInt) continue
      const animeEntry = downloadedAnime[animeIdStr]
      if (!animeEntry) continue
      const animeName = animeEntry.titles?.romaji || animeEntry.titles?.ru || animeEntry.title
      const padded = epInt.padStart(2, '0')
      const dirName = sanitizeFilename(animeName)

      const authorTag = sanitizeFilename(meta.author)
      const taggedBase = sanitizeFilename(`${animeName} - ${padded}`) + ` [${authorTag}]`
      const legacyBase = sanitizeFilename(`${animeName} - ${padded}`)
      const taggedMkvPath = path.join(downloadDir, dirName, `${taggedBase}.mkv`)
      const legacyMkvPath = path.join(downloadDir, dirName, `${legacyBase}.mkv`)
      const mkvPath = fs.existsSync(taggedMkvPath) ? taggedMkvPath : legacyMkvPath

      const lang =
        meta.translationType.endsWith('Ru') ||
        meta.translationType === 'subRu' ||
        meta.translationType === 'voiceRu'
          ? 'rus'
          : meta.translationType.endsWith('En') ||
              meta.translationType === 'subEn' ||
              meta.translationType === 'voiceEn'
            ? 'eng'
            : 'und'
      metaByFile.set(mkvPath, { language: lang, title: meta.author || 'Subtitles' })
    }

    const toFix: { mkvPath: string; language: string; title: string; label: string }[] = []
    for (const [mkvPath, meta] of metaByFile) {
      if (!fs.existsSync(mkvPath)) continue
      const hasSubs = await new Promise<boolean>((resolve) => {
        Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
          if (err) {
            resolve(false)
            return
          }
          const subStream = metadata.streams?.find((s) => s.codec_type === 'subtitle')
          resolve(!!subStream)
        })
      })
      if (hasSubs) {
        const label = path.relative(downloadDir, mkvPath)
        toFix.push({ mkvPath, ...meta, label })
      }
    }

    console.log(`[fix-metadata] Found ${toFix.length} MKV files to fix`)
    const result = { fixed: 0, failed: [] as string[] }

    for (let i = 0; i < toFix.length; i++) {
      const item = toFix[i]
      const tempPath = item.mkvPath + '.fixing.mkv'

      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(EVENT_CHANNELS.FIX_METADATA_PROGRESS, {
          current: i + 1,
          total: toFix.length,
          file: item.label
        })
      }

      try {
        await new Promise<void>((resolve, reject) => {
          Ffmpeg(item.mkvPath)
            .outputOptions('-y')
            .outputOptions('-c', 'copy')
            .outputOptions('-disposition:s:0', 'default')
            .outputOptions('-metadata:s:s:0', `language=${item.language}`)
            .outputOptions('-metadata:s:s:0', `title=${item.title}`)
            .output(tempPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run()
        })

        fs.unlinkSync(item.mkvPath)
        fs.renameSync(tempPath, item.mkvPath)
        result.fixed++
        console.log(`[fix-metadata] Fixed: ${item.label}`)
      } catch (err) {
        try {
          fs.unlinkSync(tempPath)
        } catch {
          /* ignore */
        }
        const msg = err instanceof Error ? err.message : 'Unknown error'
        result.failed.push(`${item.label}: ${msg}`)
        console.error(`[fix-metadata] Failed: ${item.label} - ${msg}`)
      }
    }

    return result
  })

  ipcMain.handle(CHANNELS.DOWNLOAD_PICK_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select download directory'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    store.set('downloadDir', dir)
    downloadManager.setDownloadDir(dir)
    return dir
  })
}
