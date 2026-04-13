import { app, shell, BrowserWindow, ipcMain, dialog, Notification, protocol, net } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { DownloadManager, sanitizeFilename } from './download-manager'
import type { DownloadRequest } from './download-manager'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import ffbinaries from 'ffbinaries'
import { execFile } from 'child_process'
import * as os from 'os'
import Ffmpeg from 'fluent-ffmpeg'
import { autoUpdater } from 'electron-updater'
import * as shikimori from './shikimori'
import { pathToFileURL } from 'url'
import { Readable } from 'stream'
import { SmotretApi } from './smotret-api'
import type { AnimeSearchResult, AnimeDetail, EpisodeSummary, EpisodeDetail, Translation } from './smotret-api'

// Enable WebGPU support for Anime4K shaders in the renderer
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('enable-features', 'Vulkan')

// Register anime-video:// protocol for serving local video files to <video> elements
protocol.registerSchemesAsPrivileged([
  { scheme: 'anime-video', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } }
])

// Suppress EPIPE errors from broken stdout/stderr pipes (common on WSL2)
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

interface AnimeCacheEntry {
  animeDetail: AnimeDetail | null
  episodes: Record<number, EpisodeDetail>
  qualityProbes: Record<number, number>
  cachedAt: number
  posterCached: boolean
  fullProbeAt?: number
  fullProbeEpisodeCount?: number
}

const store = new Store({
  defaults: {
    token: '',
    translationType: 'subRu',
    downloadDir: '',
    library: {} as Record<string, AnimeSearchResult>,
    autoMerge: false,
    videoCodec: 'copy' as string,
    downloadedAnime: {} as Record<string, AnimeSearchResult>,
    downloadedEpisodes: {} as Record<string, { translationType: string; author: string; quality: number; translationId: number }>,
    animeCache: {} as Record<string, AnimeCacheEntry>,
    lastUpdateCheck: 0,
    notificationMode: 'off' as string,
    downloadSpeedLimit: 0,
    concurrentDownloads: 2,
    keyboardShortcuts: {
      back: 'Escape',
      focusSearch: 'CmdOrCtrl+F',
      goDownloads: 'CmdOrCtrl+D',
      playerPrevEpisode: 'Shift+ArrowLeft',
      playerNextEpisode: 'Shift+ArrowRight'
    } as Record<string, string>,
    shikimoriCredentials: null as shikimori.ShikiCredentials | null,
    shikimoriUser: null as shikimori.ShikiUser | null,
    storageMode: 'simple' as 'simple' | 'advanced',
    hotStorageDir: '' as string,
    coldStorageDir: '' as string,
    autoMoveToCold: false,
    malIdMap: {} as Record<string, AnimeSearchResult>,
    playerMode: 'system' as 'system' | 'builtin',
    anime4kPreset: 'off' as 'off' | 'mode-a' | 'mode-b' | 'mode-c'
  }
})

// --- Anime cache helpers (for offline support of downloaded anime) ---

function isDownloadedAnime(animeId: number): boolean {
  const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
  return !!downloaded[String(animeId)]
}

type FileCheckResult = Record<string, { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]>
const fileCheckCache = new Map<string, FileCheckResult>()

function scanEpisodeFiles(animeName: string): FileCheckResult {
  const animeDirName = sanitizeFilename(animeName)
  const dirsToCheck = [getDownloadDir()]
  if (isAdvancedStorage()) {
    const coldDir = getColdStorageDir()
    if (coldDir) dirsToCheck.push(coldDir)
  }

  const result: FileCheckResult = {}

  for (const dir of dirsToCheck) {
    const animeDir = path.join(dir, animeDirName)
    if (!fs.existsSync(animeDir)) continue

    let files: string[]
    try { files = fs.readdirSync(animeDir) } catch { continue }

    for (const file of files) {
      const match = file.match(/^(.+?) \[(.+?)\]\.(mkv|mp4)$/)
      if (match) {
        const base = match[1]
        const author = match[2]
        const ext = match[3] as 'mkv' | 'mp4'
        if (!result[base]) result[base] = []
        const existing = result[base].find(e => e.author === author)
        if (existing) {
          existing.type = ext
          existing.filePath = path.join(animeDir, file)
        } else {
          result[base].push({ type: ext, filePath: path.join(animeDir, file), author })
        }
        continue
      }

      const legacyMatch = file.match(/^(.+)\.(mkv|mp4)$/)
      if (legacyMatch) {
        const base = legacyMatch[1]
        const ext = legacyMatch[2] as 'mkv' | 'mp4'
        if (!result[base]) result[base] = []
        const hasAuthorVersion = result[base].some(e => e.author)
        if (!hasAuthorVersion || !result[base].some(e => !e.author)) {
          const existing = result[base].find(e => !e.author)
          if (existing) {
            existing.type = ext
            existing.filePath = path.join(animeDir, file)
          } else {
            result[base].push({ type: ext, filePath: path.join(animeDir, file) })
          }
        }
      }
    }
  }
  return result
}

function filterScanResult(fullResult: FileCheckResult, animeName: string, episodeInts: string[]): FileCheckResult {
  const baseMap = new Map<string, string>()
  for (const epInt of episodeInts) {
    const padded = epInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)
    baseMap.set(base, epInt)
  }

  const filtered: FileCheckResult = {}
  for (const [base, files] of Object.entries(fullResult)) {
    const epInt = baseMap.get(base)
    if (epInt) {
      filtered[epInt] = files
    }
  }
  return filtered
}

async function backgroundRescan(animeName: string): Promise<void> {
  const animeDirName = sanitizeFilename(animeName)
  const dirsToCheck = [getDownloadDir()]
  if (isAdvancedStorage()) {
    const coldDir = getColdStorageDir()
    if (coldDir) dirsToCheck.push(coldDir)
  }

  const result: FileCheckResult = {}

  for (const dir of dirsToCheck) {
    const animeDir = path.join(dir, animeDirName)
    let files: string[]
    try { files = await fsPromises.readdir(animeDir) } catch { continue }

    for (const file of files) {
      const match = file.match(/^(.+?) \[(.+?)\]\.(mkv|mp4)$/)
      if (match) {
        const base = match[1]
        const author = match[2]
        const ext = match[3] as 'mkv' | 'mp4'
        if (!result[base]) result[base] = []
        const existing = result[base].find(e => e.author === author)
        if (existing) {
          existing.type = ext
          existing.filePath = path.join(animeDir, file)
        } else {
          result[base].push({ type: ext, filePath: path.join(animeDir, file), author })
        }
        continue
      }

      const legacyMatch = file.match(/^(.+)\.(mkv|mp4)$/)
      if (legacyMatch) {
        const base = legacyMatch[1]
        const ext = legacyMatch[2] as 'mkv' | 'mp4'
        if (!result[base]) result[base] = []
        const hasAuthorVersion = result[base].some(e => e.author)
        if (!hasAuthorVersion || !result[base].some(e => !e.author)) {
          const existing = result[base].find(e => !e.author)
          if (existing) {
            existing.type = ext
            existing.filePath = path.join(animeDir, file)
          } else {
            result[base].push({ type: ext, filePath: path.join(animeDir, file) })
          }
        }
      }
    }
  }

  const cached = fileCheckCache.get(animeName)
  const normalize = (r: FileCheckResult) => {
    const sorted: FileCheckResult = {}
    for (const key of Object.keys(r).sort()) {
      sorted[key] = [...r[key]].sort((a, b) => (a.author || '').localeCompare(b.author || ''))
    }
    return sorted
  }
  const newJson = JSON.stringify(normalize(result))
  const cachedJson = cached ? JSON.stringify(normalize(cached)) : ''
  if (newJson !== cachedJson) {
    fileCheckCache.set(animeName, result)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('file:episodes-changed', animeName, result)
    }
  }
}

function getCacheEntry(animeId: number): AnimeCacheEntry | null {
  const cache = store.get('animeCache') as Record<string, AnimeCacheEntry>
  return cache[String(animeId)] || null
}

function setCacheEntry(animeId: number, entry: AnimeCacheEntry): void {
  const cache = store.get('animeCache') as Record<string, AnimeCacheEntry>
  cache[String(animeId)] = entry
  store.set('animeCache', cache)
}

function deleteCacheEntry(animeId: number): void {
  const cache = store.get('animeCache') as Record<string, AnimeCacheEntry>
  delete cache[String(animeId)]
  store.set('animeCache', cache)
  // Also delete cached poster
  const posterPath = getPosterCachePath(animeId)
  try { fs.unlinkSync(posterPath) } catch { /* ignore */ }
}

function getPosterCacheDir(): string {
  return path.join(app.getPath('userData'), 'poster-cache')
}

function getPosterCachePath(animeId: number): string {
  return path.join(getPosterCacheDir(), `${animeId}.jpg`)
}

async function cachePosterImage(animeId: number, posterUrl: string): Promise<void> {
  if (!posterUrl) return
  const destPath = getPosterCachePath(animeId)
  if (fs.existsSync(destPath)) return
  try {
    fs.mkdirSync(getPosterCacheDir(), { recursive: true })
    const buffer = await smotretApi.fetchPoster(posterUrl)
    if (!buffer) return
    fs.writeFileSync(destPath, buffer)
  } catch {
    // Non-critical, ignore
  }
}

function ensureCacheEntry(animeId: number): AnimeCacheEntry {
  const existing = getCacheEntry(animeId)
  if (existing) return existing
  return { animeDetail: null, episodes: {}, qualityProbes: {}, cachedAt: 0, posterCached: false }
}

function updateAnimeDetailCache(animeId: number, detail: AnimeDetail): void {
  if (!isDownloadedAnime(animeId)) return
  const entry = ensureCacheEntry(animeId)
  entry.animeDetail = detail
  entry.cachedAt = Date.now()
  setCacheEntry(animeId, entry)
  // Cache poster in background
  if (!entry.posterCached) {
    cachePosterImage(animeId, detail.posterUrl || detail.posterUrlSmall).then(() => {
      entry.posterCached = true
      setCacheEntry(animeId, entry)
    }).catch(() => {})
  }
}

function updateEpisodeCache(animeId: number, episodeId: number, detail: EpisodeDetail): void {
  if (!isDownloadedAnime(animeId)) return
  const entry = ensureCacheEntry(animeId)
  entry.episodes[episodeId] = detail
  entry.cachedAt = Date.now()
  setCacheEntry(animeId, entry)
}

function updateQualityProbeCache(animeId: number, translationId: number, height: number): void {
  if (!isDownloadedAnime(animeId)) return
  const entry = ensureCacheEntry(animeId)
  entry.qualityProbes[translationId] = height
  setCacheEntry(animeId, entry)
}

function cleanupStaleCache(): void {
  const cache = store.get('animeCache') as Record<string, AnimeCacheEntry>
  const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
  let changed = false
  for (const key of Object.keys(cache)) {
    if (!downloaded[key]) {
      delete cache[key]
      const posterPath = getPosterCachePath(Number(key))
      try { fs.unlinkSync(posterPath) } catch { /* ignore */ }
      changed = true
    }
  }
  if (changed) store.set('animeCache', cache)
}

const smotretApi = new SmotretApi(() => store.get('token') as string)
let downloadManager: DownloadManager
let ffmpegPath = ''
let ffprobePath = ''

function getFfmpegDir(): string {
  return path.join(app.getPath('userData'), 'ffmpeg')
}

function ensureFfmpeg(win?: BrowserWindow): Promise<string> {
  const dest = getFfmpegDir()
  const ext = process.platform === 'win32' ? '.exe' : ''
  const ffmpegBin = path.join(dest, `ffmpeg${ext}`)
  const ffprobeBin = path.join(dest, `ffprobe${ext}`)

  if (fs.existsSync(ffmpegBin) && fs.existsSync(ffprobeBin)) {
    ffmpegPath = ffmpegBin
    ffprobePath = ffprobeBin
    return Promise.resolve(ffmpegBin)
  }

  fs.mkdirSync(dest, { recursive: true })

  const sendProgress = (status: string, progress?: number): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('ffmpeg:download-progress', { status, progress })
    }
  }

  return new Promise((resolve, reject) => {
    console.log('[ffmpeg] Downloading ffmpeg + ffprobe binaries via ffbinaries...')
    sendProgress('downloading', 0)
    ffbinaries.downloadBinaries(['ffmpeg', 'ffprobe'], {
      platform: ffbinaries.detectPlatform(),
      quiet: false,
      destination: dest,
      version: '6.1',
      tickerFn: (data) => {
        sendProgress('downloading', Math.round(data.progress * 100))
      },
      tickerInterval: 500
    }, (err, results) => {
      if (err) {
        console.error('[ffmpeg] Download failed:', err)
        sendProgress('failed')
        reject(err)
        return
      }
      console.log('[ffmpeg] Download results:', results)
      // Make binaries executable on unix
      if (process.platform !== 'win32') {
        try { fs.chmodSync(ffmpegBin, 0o755) } catch { /* ignore */ }
        try { fs.chmodSync(ffprobeBin, 0o755) } catch { /* ignore */ }
      }
      ffmpegPath = ffmpegBin
      ffprobePath = ffprobeBin
      sendProgress('done', 100)
      resolve(ffmpegBin)
    })
  })
}

interface FfmpegInfo {
  available: boolean
  version: string
  path: string
  encoders: string[]
}

function checkFfmpeg(): Promise<FfmpegInfo> {
  const result: FfmpegInfo = { available: false, version: '', path: ffmpegPath, encoders: [] }
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return Promise.resolve(result)

  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.error(`[ffmpeg] Not available at ${ffmpegPath}:`, error.message)
        resolve(result)
        return
      }

      const firstLine = stdout.split('\n')[0] || ''
      const versionMatch = firstLine.match(/ffmpeg version (\S+)/)
      result.available = true
      result.version = versionMatch ? versionMatch[1] : firstLine
      console.log(`[ffmpeg] Found: ${result.version} at ${ffmpegPath}`)

      // Detect available HEVC encoders
      execFile(ffmpegPath, ['-encoders'], { timeout: 5000 }, (err2, stdout2) => {
        if (!err2) {
          const candidates = ['libx265', 'hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'hevc_videotoolbox']
          for (const enc of candidates) {
            if (stdout2.includes(enc)) {
              result.encoders.push(enc)
            }
          }
          console.log(`[ffmpeg] Available HEVC encoders: ${result.encoders.join(', ') || 'none'}`)
        }
        resolve(result)
      })
    })
  })
}

function getDownloadDir(): string {
  const mode = store.get('storageMode') as string
  if (mode === 'advanced') {
    const hotDir = store.get('hotStorageDir') as string
    if (hotDir) return hotDir
  }
  const dir = store.get('downloadDir') as string
  if (dir) return dir
  return join(app.getPath('downloads'), 'anime-dl')
}

function getColdStorageDir(): string {
  return (store.get('coldStorageDir') as string) || ''
}

function isAdvancedStorage(): boolean {
  return (store.get('storageMode') as string) === 'advanced'
}

async function moveFileToCold(src: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.renameSync(src, dest)
  } catch {
    // Cross-filesystem: copy + delete
    await fsPromises.copyFile(src, dest)
    fs.unlinkSync(src)
  }
}

async function moveEpisodeToColdStorage(animeName: string, episodeLabel: string): Promise<void> {
  const coldDir = getColdStorageDir()
  if (!coldDir) return
  const hotDir = getDownloadDir()

  const animeDirName = sanitizeFilename(animeName)
  const hotAnimeDir = path.join(hotDir, animeDirName)
  const coldAnimeDir = path.join(coldDir, animeDirName)

  if (!fs.existsSync(hotAnimeDir)) return

  // episodeLabel is like "01", we need to find matching files
  const padded = episodeLabel.padStart(2, '0')
  const base = sanitizeFilename(`${animeName} - ${padded}`)

  // Move all files matching this episode base (including [Author] tagged variants)
  try {
    const files = fs.readdirSync(hotAnimeDir)
    for (const file of files) {
      if (!file.startsWith(base)) continue
      if (!['.mkv', '.mp4', '.ass'].some(ext => file.endsWith(ext))) continue
      // Never move .part files or files with in-progress downloads
      if (file.endsWith('.mp4') && fs.existsSync(path.join(hotAnimeDir, file + '.part'))) continue
      const src = path.join(hotAnimeDir, file)
      await moveFileToCold(src, path.join(coldAnimeDir, file))
    }
  } catch { /* dir listing failed */ }
}

async function moveAllFilesToColdStorage(
  onProgress?: (current: number, total: number, file: string) => void
): Promise<{ moved: number; failed: string[] }> {
  const coldDir = getColdStorageDir()
  const hotDir = getDownloadDir()
  const result = { moved: 0, failed: [] as string[] }

  if (!coldDir || !fs.existsSync(hotDir)) return result

  // Collect all finished files
  const filesToMove: { src: string; dest: string; label: string }[] = []
  const animeDirs = fs.readdirSync(hotDir, { withFileTypes: true }).filter(d => d.isDirectory())

  for (const dir of animeDirs) {
    const dirPath = path.join(hotDir, dir.name)
    const files = fs.readdirSync(dirPath)

    for (const file of files) {
      // Skip .part files (in-progress downloads)
      if (file.endsWith('.part')) continue
      // Skip mp4 if a .part exists (download in progress)
      if (file.endsWith('.mp4') && files.includes(file + '.part')) continue
      // Only move media/subtitle files
      if (!['.mkv', '.mp4', '.ass'].some(ext => file.endsWith(ext))) continue

      filesToMove.push({
        src: path.join(dirPath, file),
        dest: path.join(coldDir, dir.name, file),
        label: `${dir.name}/${file}`
      })
    }
  }

  for (let i = 0; i < filesToMove.length; i++) {
    const item = filesToMove[i]
    onProgress?.(i + 1, filesToMove.length, item.label)
    try {
      await moveFileToCold(item.src, item.dest)
      result.moved++
    } catch (err) {
      result.failed.push(`${item.label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

async function lookupByMalIds(malIds: number[]): Promise<Record<number, AnimeSearchResult>> {
  const cached = store.get('malIdMap') as Record<string, AnimeSearchResult>
  const result: Record<number, AnimeSearchResult> = {}
  const uncachedIds: number[] = []

  for (const id of malIds) {
    if (cached[String(id)]) {
      result[id] = cached[String(id)]
    } else {
      uncachedIds.push(id)
    }
  }

  if (uncachedIds.length > 0) {
    const fetched = await smotretApi.lookupByMalIds(uncachedIds)
    for (const anime of fetched) {
      if (anime.myAnimeListId) {
        result[anime.myAnimeListId] = anime
        cached[String(anime.myAnimeListId)] = anime
      }
    }
    store.set('malIdMap', cached)
  }
  return result
}

function registerIpcHandlers(): void {
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('update:status', {
            status: 'error',
            error: 'Update check not available in development mode'
          })
        }
      }
    } catch (err) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('update:status', {
          status: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  })

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('update:status', {
          status: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  })

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('validate-token', () => smotretApi.validateToken())

  ipcMain.handle('search-anime', async (_event, query: string) => {
    return smotretApi.searchAnime(query)
  })

  ipcMain.handle('get-anime', async (_event, id: number) => {
    try {
      const result = await smotretApi.getAnime(id)
      updateAnimeDetailCache(id, result.data)
      return { ...result, source: 'api' }
    } catch (err) {
      const cached = getCacheEntry(id)
      if (cached?.animeDetail) {
        return { data: cached.animeDetail, source: 'cache' }
      }
      throw err
    }
  })

  ipcMain.handle('probe-embed-quality', async (_event, translationId: number, animeId?: number) => {
    try {
      const embed = await smotretApi.getEmbed(translationId)
      const streams = embed.stream || []
      if (streams.length === 0) return null
      const best = streams.reduce((a, b) => a.height > b.height ? a : b)
      if (animeId) updateQualityProbeCache(animeId, translationId, best.height)
      return best.height
    } catch {
      if (animeId) {
        const cached = getCacheEntry(animeId)
        return cached?.qualityProbes[translationId] ?? null
      }
      return null
    }
  })

  ipcMain.handle('probe-full-scan-needed', (_event, animeId: number, episodeCount: number) => {
    const entry = getCacheEntry(animeId)
    if (!entry?.fullProbeAt) return true
    if (entry.fullProbeEpisodeCount !== episodeCount) return true
    const weekMs = 7 * 24 * 60 * 60 * 1000
    return Date.now() - entry.fullProbeAt > weekMs
  })

  ipcMain.handle('probe-full-scan-done', (_event, animeId: number, episodeCount: number) => {
    const entry = getCacheEntry(animeId)
    if (!entry) return
    entry.fullProbeAt = Date.now()
    entry.fullProbeEpisodeCount = episodeCount
    setCacheEntry(animeId, entry)
  })

  const qualityMismatches = new Map<number, { translationId: number; author: string; type: string; reported: number; actual: number }>()

  ipcMain.handle('report-quality-mismatch', (_event, data: { translationId: number; author: string; type: string; reported: number; actual: number }) => {
    qualityMismatches.set(data.translationId, data)
  })

  ipcMain.handle('get-quality-mismatch-count', () => {
    return qualityMismatches.size
  })

  ipcMain.handle('dump-quality-mismatches', () => {
    const outPath = path.join(getDownloadDir(), 'quality-mismatches.json')
    const data = [...qualityMismatches.values()]
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2))
    console.log(`[debug] Wrote ${data.length} quality mismatches to ${outPath}`)
    return { count: data.length, path: outPath }
  })

  ipcMain.handle('get-episode', async (_event, id: number, animeId?: number) => {
    try {
      const result = await smotretApi.getEpisode(id)
      if (animeId) updateEpisodeCache(animeId, id, result.data)
      return { ...result, source: 'api' }
    } catch (err) {
      if (animeId) {
        const cached = getCacheEntry(animeId)
        if (cached?.episodes[id]) {
          return { data: cached.episodes[id], source: 'cache' }
        }
      }
      throw err
    }
  })

  ipcMain.handle('library-get', () => {
    const lib = store.get('library') as Record<string, AnimeSearchResult>
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const merged = new Map<string, AnimeSearchResult>()
    for (const [k, v] of Object.entries(lib)) merged.set(k, v)
    for (const [k, v] of Object.entries(downloaded)) {
      if (!merged.has(k)) merged.set(k, v)
    }
    return [...merged.values()]
  })

  ipcMain.handle('library-is-downloaded', (_event, id: number) => {
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    return !!downloaded[String(id)]
  })

  ipcMain.handle('library-toggle', (_event, anime: AnimeSearchResult) => {
    const lib = store.get('library') as Record<string, AnimeSearchResult>
    const key = String(anime.id)
    if (lib[key]) {
      delete lib[key]
      store.set('library', lib)
      return false
    } else {
      lib[key] = anime
      store.set('library', lib)
      return true
    }
  })

  ipcMain.handle('library-has', (_event, id: number) => {
    const lib = store.get('library') as Record<string, AnimeSearchResult>
    return !!lib[String(id)]
  })

  ipcMain.handle('library-get-status', (_event, ids: number[]) => {
    const lib = store.get('library') as Record<string, AnimeSearchResult>
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const result: Record<number, { starred: boolean; downloaded: boolean }> = {}
    for (const id of ids) {
      const key = String(id)
      result[id] = { starred: !!lib[key], downloaded: !!downloaded[key] }
    }
    return result
  })

  ipcMain.handle('downloaded-anime-add', (_event, anime: AnimeSearchResult) => {
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    downloaded[String(anime.id)] = anime
    store.set('downloadedAnime', downloaded)
  })

  ipcMain.handle('downloaded-anime-delete', (_event, animeId: number, animeName: string) => {
    // Remove from store
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    delete downloaded[String(animeId)]
    store.set('downloadedAnime', downloaded)
    // Delete the folder from all storage dirs
    const dirName = sanitizeFilename(animeName)
    const dirsToCheck = [getDownloadDir()]
    if (isAdvancedStorage()) {
      const coldDir = getColdStorageDir()
      if (coldDir) dirsToCheck.push(coldDir)
    }
    for (const dir of dirsToCheck) {
      const dirPath = path.join(dir, dirName)
      try { fs.rmSync(dirPath, { recursive: true }) } catch { /* ignore */ }
    }
    // Clean cache
    deleteCacheEntry(animeId)
  })

  ipcMain.handle('get-setting', (_event, key: string) => {
    if (key === 'downloadDir') return getDownloadDir()
    return store.get(key)
  })

  ipcMain.handle('set-setting', (_event, key: string, value: unknown) => {
    store.set(key, value)
  })

  // Download handlers
  ipcMain.handle('download:enqueue', async (_event, requests: DownloadRequest[]) => {
    await downloadManager.enqueue(requests)
    // Save episode metadata (keyed by animeId:episodeInt:translationId for multi-translation support)
    const episodes = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>
    for (const req of requests) {
      // Remove legacy key if present
      delete episodes[`${req.animeId}:${req.episodeInt}`]
      episodes[`${req.animeId}:${req.episodeInt}:${req.translationId}`] = {
        translationType: req.translationType,
        author: req.author,
        quality: req.height,
        translationId: req.translationId
      }
    }
    store.set('downloadedEpisodes', episodes)
  })

  ipcMain.handle('download:pause', (_event, id: string) => {
    downloadManager.pause(id)
  })

  ipcMain.handle('download:resume', (_event, id: string) => {
    downloadManager.resume(id)
  })

  ipcMain.handle('download:restart', async (_event, id: string) => {
    await downloadManager.restart(id)
  })

  ipcMain.handle('download:restart-all-failed', async () => {
    await downloadManager.restartAllFailed()
  })

  ipcMain.handle('download:pause-all', () => {
    downloadManager.pauseAll()
  })

  ipcMain.handle('download:resume-all', () => {
    downloadManager.resumeAll()
  })

  ipcMain.handle('download:cancel', (_event, id: string) => {
    downloadManager.cancel(id)
  })

  ipcMain.handle('download:get-queue', () => {
    return downloadManager.getEpisodeGroups()
  })

  ipcMain.handle('download:cancel-by-episode', (_event, animeName: string, episodeLabel?: string) => {
    downloadManager.cancelByEpisode(animeName, episodeLabel)

    // If no active downloads remain for this anime and no files on disk, remove from downloaded list
    const groups = downloadManager.getEpisodeGroups()
    const hasActive = groups.some(g => g.animeName === animeName)
    if (!hasActive) {
      const animeDirName = sanitizeFilename(animeName)
      const animeDir = path.join(getDownloadDir(), animeDirName)
      let hasFiles = false
      try {
        const files = fs.readdirSync(animeDir)
        hasFiles = files.some(f => f.endsWith('.mkv') || f.endsWith('.mp4'))
      } catch { /* dir doesn't exist */ }

      if (!hasFiles) {
        // Remove from downloadedAnime store
        const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
        const key = Object.keys(downloaded).find(k => {
          const a = downloaded[k]
          const name = a.titles?.romaji || a.titles?.ru || a.title
          return name === animeName
        })
        if (key) {
          delete downloaded[key]
          store.set('downloadedAnime', downloaded)
          deleteCacheEntry(Number(key))
        }
      }
    }
  })

  ipcMain.handle('downloaded-episodes-get', (_event, animeId: number) => {
    const episodes = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>
    const result: Record<string, { translationType: string; author: string; quality: number; translationId: number }[]> = {}
    const prefix = `${animeId}:`
    for (const [key, val] of Object.entries(episodes)) {
      if (key.startsWith(prefix)) {
        const rest = key.substring(prefix.length)
        // New format: episodeInt:translationId — extract episodeInt
        // Legacy format: episodeInt (no colon) — also supported
        const colonIdx = rest.indexOf(':')
        const episodeInt = colonIdx >= 0 ? rest.substring(0, colonIdx) : rest
        if (!result[episodeInt]) result[episodeInt] = []
        result[episodeInt].push(val)
      }
    }
    return result
  })

  ipcMain.handle('download:cancel-merge', () => {
    downloadManager.cancelMerge()
  })

  ipcMain.handle('download:clear-completed', () => {
    downloadManager.clearCompleted()
  })

  ipcMain.handle('download:merge', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg binary not found')
    const codec = store.get('videoCodec') as string || 'copy'
    await downloadManager.mergeCompleted(ffmpegPath, ffprobePath, codec)
  })

  ipcMain.handle('ffmpeg:check', () => checkFfmpeg())

  ipcMain.handle('ffmpeg:delete', () => {
    const dest = getFfmpegDir()
    const ext = process.platform === 'win32' ? '.exe' : ''
    const ffmpegBin = path.join(dest, `ffmpeg${ext}`)
    const ffprobeBin = path.join(dest, `ffprobe${ext}`)
    try { fs.unlinkSync(ffmpegBin) } catch { /* ignore */ }
    try { fs.unlinkSync(ffprobeBin) } catch { /* ignore */ }
    // Also clear ffbinaries zip cache so next download is a real network fetch
    const cacheDir = path.join(os.tmpdir(), 'ffbinaries-cache')
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        fs.unlinkSync(path.join(cacheDir, f))
      }
    } catch { /* ignore */ }
    ffmpegPath = ''
    ffprobePath = ''
  })

  ipcMain.handle('download:scan-merge', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg binary not found')
    const codec = store.get('videoCodec') as string || 'copy'
    const extraDirs = isAdvancedStorage() && getColdStorageDir() ? [getColdStorageDir()] : undefined
    const result = await downloadManager.scanAndMerge(ffmpegPath, ffprobePath, codec, (current, total, file, percent) => {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('scan-merge:progress', { current, total, file, percent })
      }
    }, extraDirs)
    return result
  })

  ipcMain.handle('download:fix-metadata', async () => {
    if (!ffmpegPath || !ffprobePath) throw new Error('ffmpeg/ffprobe not found')

    Ffmpeg.setFfmpegPath(ffmpegPath)
    Ffmpeg.setFfprobePath(ffprobePath)

    const downloadDir = getDownloadDir()
    if (!fs.existsSync(downloadDir)) return { fixed: 0, failed: [] as string[] }

    const episodeMeta = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>

    // Build lookup: animeName -> { episodeInt -> meta }
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

      // Try new tagged filename first, then legacy
      const authorTag = sanitizeFilename(meta.author)
      const taggedBase = sanitizeFilename(`${animeName} - ${padded}`) + ` [${authorTag}]`
      const legacyBase = sanitizeFilename(`${animeName} - ${padded}`)
      const taggedMkvPath = path.join(downloadDir, dirName, `${taggedBase}.mkv`)
      const legacyMkvPath = path.join(downloadDir, dirName, `${legacyBase}.mkv`)
      const mkvPath = fs.existsSync(taggedMkvPath) ? taggedMkvPath : legacyMkvPath

      const lang = meta.translationType.endsWith('Ru') || meta.translationType === 'subRu' || meta.translationType === 'voiceRu' ? 'rus'
        : meta.translationType.endsWith('En') || meta.translationType === 'subEn' || meta.translationType === 'voiceEn' ? 'eng'
        : 'und'
      metaByFile.set(mkvPath, { language: lang, title: meta.author || 'Subtitles' })
    }

    const toFix: { mkvPath: string; language: string; title: string; label: string }[] = []

    for (const [mkvPath, meta] of metaByFile) {
      if (!fs.existsSync(mkvPath)) continue

      // Check if MKV has subtitle tracks using ffprobe
      const hasSubs = await new Promise<boolean>((resolve) => {
        Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
          if (err) { resolve(false); return }
          const subStream = metadata.streams?.find(s => s.codec_type === 'subtitle')
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

      // Broadcast progress
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('fix-metadata:progress', { current: i + 1, total: toFix.length, file: item.label })
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

        // Replace original with fixed file
        fs.unlinkSync(item.mkvPath)
        fs.renameSync(tempPath, item.mkvPath)
        result.fixed++
        console.log(`[fix-metadata] Fixed: ${item.label}`)
      } catch (err) {
        try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
        const msg = err instanceof Error ? err.message : 'Unknown error'
        result.failed.push(`${item.label}: ${msg}`)
        console.error(`[fix-metadata] Failed: ${item.label} - ${msg}`)
      }
    }

    return result
  })

  ipcMain.handle('cache-get-poster', (_event, animeId: number) => {
    const posterPath = getPosterCachePath(animeId)
    if (fs.existsSync(posterPath)) return `file://${posterPath}`
    return null
  })

  // File management handlers
  ipcMain.handle('file:check-episodes', (_event, animeName: string, episodeInts: string[]) => {
    const cached = fileCheckCache.get(animeName)
    if (cached) {
      backgroundRescan(animeName).catch(err => console.error('Background rescan failed:', err))
      return filterScanResult(cached, animeName, episodeInts)
    }

    const fullResult = scanEpisodeFiles(animeName)
    fileCheckCache.set(animeName, fullResult)
    return filterScanResult(fullResult, animeName, episodeInts)
  })

  ipcMain.handle('file:open', async (_event, filePath: string) => {
    if (!fs.existsSync(filePath)) {
      const animeDirName = path.basename(path.dirname(filePath))
      for (const [key] of fileCheckCache) {
        if (sanitizeFilename(key) === animeDirName) {
          fileCheckCache.delete(key)
          break
        }
      }
      return 'File not found'
    }
    return shell.openPath(filePath)
  })

  ipcMain.handle('file:show-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('file:delete-episode', (_event, animeName: string, episodeInt: string, animeId?: number, translationId?: number) => {
    fileCheckCache.delete(animeName)
    const animeDirName = sanitizeFilename(animeName)
    const dirsToCheck = [getDownloadDir()]
    if (isAdvancedStorage()) {
      const coldDir = getColdStorageDir()
      if (coldDir) dirsToCheck.push(coldDir)
    }

    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)

    if (translationId && animeId) {
      // Delete specific translation's files — find by author tag from metadata
      const episodes = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>
      const metaKey = `${animeId}:${episodeInt}:${translationId}`
      const legacyKey = `${animeId}:${episodeInt}`
      const meta = episodes[metaKey] || episodes[legacyKey]
      if (meta) {
        const authorTag = sanitizeFilename(meta.author)
        const taggedBase = `${base} [${authorTag}]`
        for (const dir of dirsToCheck) {
          const animeDir = path.join(dir, animeDirName)
          for (const ext of ['.mkv', '.mp4', '.ass']) {
            // Try tagged filename first
            const taggedPath = path.join(animeDir, `${taggedBase}${ext}`)
            try { fs.unlinkSync(taggedPath) } catch { /* ignore */ }
            // Also try legacy filename (for older downloads)
            const legacyPath = path.join(animeDir, `${base}${ext}`)
            try { fs.unlinkSync(legacyPath) } catch { /* ignore */ }
          }
        }
        delete episodes[metaKey]
        delete episodes[legacyKey]
        store.set('downloadedEpisodes', episodes)
      }
    } else {
      // Delete all versions of this episode (legacy behavior)
      for (const dir of dirsToCheck) {
        const animeDir = path.join(dir, animeDirName)
        // List directory and delete all matching files for this episode
        try {
          const files = fs.readdirSync(animeDir)
          for (const file of files) {
            if (file.startsWith(base) && (file.endsWith('.mkv') || file.endsWith('.mp4') || file.endsWith('.ass'))) {
              try { fs.unlinkSync(path.join(animeDir, file)) } catch { /* ignore */ }
            }
          }
        } catch { /* dir doesn't exist */ }
      }

      // Clean up all episode metadata for this episode
      if (animeId) {
        const episodes = store.get('downloadedEpisodes') as Record<string, unknown>
        const prefix = `${animeId}:${episodeInt}`
        for (const key of Object.keys(episodes)) {
          if (key === prefix || key.startsWith(prefix + ':')) {
            delete episodes[key]
          }
        }
        store.set('downloadedEpisodes', episodes)
      }
    }
  })

  ipcMain.handle('download:pick-dir', async () => {
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

  ipcMain.handle('storage:pick-hot-dir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select hot storage directory (active downloads)'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    store.set('hotStorageDir', dir)
    downloadManager.setDownloadDir(dir)
    return dir
  })

  ipcMain.handle('storage:pick-cold-dir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select cold storage directory (finished files)'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    store.set('coldStorageDir', dir)
    return dir
  })

  ipcMain.handle('storage:move-to-cold', async () => {
    fileCheckCache.clear()
    const result = await moveAllFilesToColdStorage((current, total, file) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('storage:move-to-cold-progress', { current, total, file })
      }
    })
    return result
  })

  // Shikimori integration
  ipcMain.handle('shikimori:get-auth-url', () => {
    return shikimori.getAuthUrl()
  })

  ipcMain.handle('shikimori:exchange-code', async (_event, code: string) => {
    const creds = await shikimori.exchangeCode(code)
    store.set('shikimoriCredentials', creds)
    const user = await shikimori.getUser(creds.access_token)
    store.set('shikimoriUser', user)
    return user
  })

  ipcMain.handle('shikimori:logout', () => {
    store.set('shikimoriCredentials', null)
    store.set('shikimoriUser', null)
  })

  ipcMain.handle('shikimori:get-user', () => {
    return store.get('shikimoriUser') as shikimori.ShikiUser | null
  })

  ipcMain.handle('shikimori:get-rate', async (_event, malId: number) => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    return shikimori.getUserRate(accessToken, user.id, malId)
  })

  ipcMain.handle(
    'shikimori:update-rate',
    async (_event, malId: number, episodes: number, status: shikimori.ShikiUserRateStatus, score: number) => {
      const accessToken = await shikimori.ensureFreshToken(store)
      const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
      if (!user) throw new Error('Not logged in to Shikimori')
      const existing = await shikimori.getUserRate(accessToken, user.id, malId)
      if (existing) {
        return shikimori.updateUserRate(accessToken, existing.id, episodes, status, score)
      }
      return shikimori.createUserRate(accessToken, user.id, malId, episodes, status, score)
    }
  )

  ipcMain.handle('shikimori:get-friends-rates', async (_event, malId: number) => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    return shikimori.getFriendsRatesForAnime(accessToken, user.id, malId)
  })

  ipcMain.handle('shikimori:get-anime-rates', async (_event, status?: string) => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')

    const rates = await shikimori.getUserAnimeRates(
      accessToken,
      user.id,
      status as shikimori.ShikiUserRateStatus | undefined
    )

    const malIds = rates.map((r) => r.anime.id)
    const malMap = await lookupByMalIds(malIds)

    return rates.map((rate) => ({
      rate: {
        id: rate.id,
        score: rate.score,
        status: rate.status,
        episodes: rate.episodes,
        updated_at: rate.updated_at,
        target_id: rate.target_id
      },
      shikiAnime: rate.anime,
      smotretAnime: malMap[rate.anime.id] ?? null
    }))
  })

  ipcMain.handle('shikimori:get-friends-activity', async () => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')

    const activities = await shikimori.getFriendsActivity(accessToken, user.id)
    const malIds = Array.from(new Set(activities.map((a) => a.malId)))
    const malMap = await lookupByMalIds(malIds)

    return activities.map((a) => ({
      ...a,
      smotretAnime: malMap[a.malId] ?? null
    }))
  })

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('player:get-stream-url', async (_event, translationId: number, maxHeight: number) => {
    try {
      const embed = await smotretApi.getEmbed(translationId)
      const streams = embed.stream || []
      if (streams.length === 0) return null
      const sorted = [...streams].sort((a, b) => b.height - a.height)
      const best = sorted.find(s => s.height <= maxHeight) || sorted[0]
      const streamUrl = best && best.urls.length > 0 ? best.urls[0] : null
      if (!streamUrl) return null

      // Build list of all available streams for quality selector
      const availableStreams = sorted
        .filter(s => s.urls.length > 0)
        .map(s => ({ height: s.height, url: s.urls[0] }))

      // Fetch raw ASS subtitle content if available (rendered natively by JASSUB in the player)
      let subtitleContent: string | null = null
      if (embed.subtitlesUrl) {
        subtitleContent = await smotretApi.fetchSubtitleContent(translationId)
      }

      return { streamUrl, subtitleContent, availableStreams }
    } catch {
      return null
    }
  })

  ipcMain.handle('player:get-local-subtitles', async (_event, filePath: string) => {
    const assPath = filePath.replace(/\.(mp4|mkv)$/i, '.ass')
    try {
      if (fs.existsSync(assPath)) {
        return fs.readFileSync(assPath, 'utf-8')
      }
    } catch { /* ignore */ }
    return null
  })

  ipcMain.handle('player:find-local-file', async (_event, animeName: string, episodeInt: string, translationId: number) => {
    const episodes = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>
    // Find meta for this translation — try new key format, then scan for legacy
    let meta: { author: string } | null = null
    for (const [key, val] of Object.entries(episodes)) {
      if (val.translationId === translationId) {
        // Verify key belongs to right anime episode (starts with some animeId:episodeInt)
        const parts = key.split(':')
        if (parts.length >= 2 && parts[1] === episodeInt) {
          meta = val
          break
        }
      }
    }
    if (!meta) return null

    const animeDirName = sanitizeFilename(animeName)
    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)
    const authorTag = sanitizeFilename(meta.author)
    const taggedBase = `${base} [${authorTag}]`

    const dirsToCheck = [getDownloadDir()]
    if (isAdvancedStorage()) {
      const coldDir = getColdStorageDir()
      if (coldDir) dirsToCheck.push(coldDir)
    }

    for (const dir of dirsToCheck) {
      const animeDir = path.join(dir, animeDirName)
      // Try tagged filename first
      for (const ext of ['.mkv', '.mp4']) {
        const fp = path.join(animeDir, `${taggedBase}${ext}`)
        if (fs.existsSync(fp)) {
          const subtitleContent = await (async () => {
            const assPath = fp.replace(/\.(mp4|mkv)$/i, '.ass')
            try { return fs.existsSync(assPath) ? fs.readFileSync(assPath, 'utf-8') : null } catch { return null }
          })()
          return { filePath: fp, subtitleContent }
        }
      }
      // Try legacy filename
      for (const ext of ['.mkv', '.mp4']) {
        const fp = path.join(animeDir, `${base}${ext}`)
        if (fs.existsSync(fp)) {
          const subtitleContent = await (async () => {
            const assPath = fp.replace(/\.(mp4|mkv)$/i, '.ass')
            try { return fs.existsSync(assPath) ? fs.readFileSync(assPath, 'utf-8') : null } catch { return null }
          })()
          return { filePath: fp, subtitleContent }
        }
      }
    }
    return null
  })

  // Remux MKV to MP4 (stream copy) for HTML5 playback
  const remuxTmpDir = path.join(os.tmpdir(), 'anime-dl-remux')

  ipcMain.handle('player:remux-mkv', async (_event, mkvPath: string): Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }> => {
    if (!ffmpegPath) return { error: 'ffmpeg not available' }
    if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

    // Create temp dir
    fs.mkdirSync(remuxTmpDir, { recursive: true })

    const stamp = Date.now()
    const baseName = path.basename(mkvPath, path.extname(mkvPath))
    const mp4Path = path.join(remuxTmpDir, `${baseName}-${stamp}.mp4`)

    Ffmpeg.setFfmpegPath(ffmpegPath)

    // Run remux and subtitle extraction in parallel
    const remuxPromise = new Promise<void>((resolve, reject) => {
      Ffmpeg(mkvPath)
        .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
        .output(mp4Path)
        .on('error', (err) => {
          console.error('[remux] FFmpeg error:', err.message)
          reject(err)
        })
        .on('end', () => {
          console.log('[remux] Completed:', mp4Path)
          resolve()
        })
        .run()
    })

    // Extract first subtitle stream (if any) to a temp .ass file
    const subtitlePromise = (async (): Promise<string | undefined> => {
      try {
        if (!ffprobePath) return undefined
        Ffmpeg.setFfprobePath(ffprobePath)
        const hasSubStream = await new Promise<boolean>((res) => {
          Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
            res(err ? false : !!metadata.streams?.find(s => s.codec_type === 'subtitle'))
          })
        })
        if (!hasSubStream) return undefined

        const assPath = path.join(remuxTmpDir, `${baseName}-${stamp}.ass`)
        await new Promise<void>((res, rej) => {
          Ffmpeg(mkvPath)
            .outputOptions(['-map', '0:s:0', '-c:s', 'ass'])
            .output(assPath)
            .on('error', (err) => {
              console.error('[remux] Subtitle extraction error:', err.message)
              rej(err)
            })
            .on('end', () => res())
            .run()
        })
        const content = fs.readFileSync(assPath, 'utf-8')
        console.log('[remux] Subtitle extracted:', assPath)
        return content
      } catch {
        return undefined
      }
    })()

    try {
      const [, subtitleContent] = await Promise.all([remuxPromise, subtitlePromise])
      return { mp4Path, ...(subtitleContent ? { subtitleContent } : {}) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  ipcMain.handle('player:cleanup-remux', async () => {
    try {
      if (fs.existsSync(remuxTmpDir)) {
        const files = fs.readdirSync(remuxTmpDir)
        for (const file of files) {
          try { fs.unlinkSync(path.join(remuxTmpDir, file)) } catch { /* ignore */ }
        }
        try { fs.rmdirSync(remuxTmpDir) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, process.platform === 'win32' ? '../../resources/icon.ico' : '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Handle anime-video:// protocol for local video playback with Range request support
  protocol.handle('anime-video', async (request) => {
    const filePath = decodeURIComponent(request.url.replace('anime-video://', ''))

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('File not found', { status: 404 })
    }

    const fileSize = stat.size
    const rangeHeader = request.headers.get('Range')

    const ext = path.extname(filePath).toLowerCase()
    const mimeType = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'application/octet-stream'

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const chunkSize = end - start + 1

        const nodeStream = fs.createReadStream(filePath, { start, end })
        const webStream = Readable.toWeb(nodeStream) as ReadableStream

        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }
    }

    const nodeStream = fs.createReadStream(filePath)
    const webStream = Readable.toWeb(nodeStream) as ReadableStream

    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes'
      }
    })
  })

  cleanupStaleCache()
  createWindow()
  const mainWin = BrowserWindow.getAllWindows()[0]

  try {
    await ensureFfmpeg(mainWin)
  } catch (err) {
    console.error('[ffmpeg] Failed to ensure ffmpeg:', err)
  }
  const ffmpegInfo = await checkFfmpeg()
  downloadManager = new DownloadManager(
    getDownloadDir(),
    smotretApi,
    app.getPath('userData'),
    () => store.get('downloadSpeedLimit') as number || 0,
    () => store.get('concurrentDownloads') as number || 2
  )
  downloadManager.loadQueue()
  const showBackgroundNotification = (title: string, body: string): void => {
    if (BrowserWindow.getFocusedWindow() !== null) return
    new Notification({ title, body }).show()
  }

  downloadManager.onEpisodeComplete(async (animeName, episodeLabel) => {
    fileCheckCache.delete(animeName)
    const autoMerge = store.get('autoMerge') as boolean
    if (autoMerge && ffmpegInfo.available && ffmpegPath) {
      const codec = store.get('videoCodec') as string || 'copy'
      await downloadManager.mergeCompleted(ffmpegPath, ffprobePath, codec)
    } else {
      // Auto-move to cold if merge is disabled
      if (isAdvancedStorage() && (store.get('autoMoveToCold') as boolean)) {
        await moveEpisodeToColdStorage(animeName, episodeLabel)
      }
      const mode = store.get('notificationMode') as string
      if (mode === 'each') {
        showBackgroundNotification('Download complete', `${animeName} \u2014 ${episodeLabel}`)
      }
    }
  })

  downloadManager.onMergeComplete(async (animeName, episodeLabel) => {
    fileCheckCache.delete(animeName)
    // Auto-move to cold after merge
    if (isAdvancedStorage() && (store.get('autoMoveToCold') as boolean)) {
      await moveEpisodeToColdStorage(animeName, episodeLabel)
    }
    const mode = store.get('notificationMode') as string
    if (mode === 'each') {
      showBackgroundNotification('Merge complete', `${animeName} \u2014 ${episodeLabel}`)
    }
  })

  downloadManager.onQueueComplete(() => {
    const mode = store.get('notificationMode') as string
    if (mode === 'queue') {
      showBackgroundNotification('Downloads complete', 'All downloads have finished')
    }
  })

  registerIpcHandlers()

  // Auto-updater setup
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const broadcastUpdateStatus = (data: Record<string, unknown>): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update:status', data)
    }
  }

  autoUpdater.on('update-available', (info) => {
    broadcastUpdateStatus({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    store.set('lastUpdateCheck', Date.now())
    broadcastUpdateStatus({ status: 'up-to-date' })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdateStatus({ status: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', () => {
    broadcastUpdateStatus({ status: 'ready' })
  })

  autoUpdater.on('error', (err) => {
    broadcastUpdateStatus({ status: 'error', error: err.message })
  })

  // Auto-check on launch if last check was >24h ago
  const lastCheck = store.get('lastUpdateCheck') as number
  if (Date.now() - lastCheck > 24 * 60 * 60 * 1000) {
    autoUpdater.checkForUpdates().catch(() => {})
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  downloadManager?.destroy()
})
