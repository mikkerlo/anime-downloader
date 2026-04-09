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
}

interface AnimeDetail extends AnimeSearchResult {
  posterUrl: string
  descriptions: { source: string; value: string }[]
  episodes: EpisodeSummary[]
  genres: { id: number; title: string }[]
  myAnimeListId?: number
}

interface EpisodeSummary {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  isActive: number
}

interface EpisodeDetail {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  translations: Translation[]
}

interface Translation {
  id: number
  type: string
  typeKind: string
  typeLang: string
  authorsSummary: string
  isActive: number
  width: number
  height: number
  duration: string
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
      goDownloads: 'CmdOrCtrl+D'
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

interface AnimeSearchResult {
  id: number
  title: string
  titles: { ru?: string; romaji?: string; ja?: string }
  posterUrlSmall: string
  numberOfEpisodes: number
  type: string
  typeTitle: string
  year: number
  season: string
}

const API_BASE = 'https://smotret-anime.ru/api'
const USER_AGENT = 'smotret-anime-dl'

// --- Anime cache helpers (for offline support of downloaded anime) ---

function isDownloadedAnime(animeId: number): boolean {
  const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
  return !!downloaded[String(animeId)]
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
    const response = await fetch(posterUrl, { headers: { 'User-Agent': USER_AGENT } })
    if (!response.ok || !response.body) return
    const buffer = Buffer.from(await response.arrayBuffer())
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

  for (const ext of ['.mkv', '.mp4', '.ass']) {
    const src = path.join(hotAnimeDir, `${base}${ext}`)
    // Never move .part files or files with in-progress downloads
    if (ext === '.mp4' && fs.existsSync(src + '.part')) continue
    if (fs.existsSync(src)) {
      await moveFileToCold(src, path.join(coldAnimeDir, `${base}${ext}`))
    }
  }
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

async function apiRequest(path: string): Promise<unknown> {
  const token = store.get('token') as string
  const url = token ? `${API_BASE}${path}${path.includes('?') ? '&' : '?'}access_token=${token}` : `${API_BASE}${path}`

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
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

  const BATCH_SIZE = 50
  for (let i = 0; i < uncachedIds.length; i += BATCH_SIZE) {
    const batch = uncachedIds.slice(i, i + BATCH_SIZE)
    const params = batch.map((id) => `myAnimeListId[]=${id}`).join('&')
    const fields = 'id,title,titles,posterUrlSmall,numberOfEpisodes,type,typeTitle,year,season,myAnimeListId'
    const response = (await apiRequest(`/series/?${params}&fields=${fields}`)) as {
      data: (AnimeSearchResult & { myAnimeListId?: number })[]
    }
    for (const anime of response.data) {
      if (anime.myAnimeListId) {
        result[anime.myAnimeListId] = anime
        cached[String(anime.myAnimeListId)] = anime
      }
    }
  }

  if (uncachedIds.length > 0) {
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

  ipcMain.handle('validate-token', async () => {
    const token = store.get('token') as string
    if (!token) return { valid: false, error: 'No token configured' }
    try {
      const response = await fetch(`${API_BASE}/translations/embed/4336179?access_token=${token}`, {
        headers: { 'User-Agent': USER_AGENT }
      })
      const json = await response.json() as { error?: { code: number; message: string }; data?: unknown }
      if (json.error?.code === 403) return { valid: false, error: 'Invalid token' }
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('search-anime', async (_event, query: string) => {
    return apiRequest(`/series/?query=${encodeURIComponent(query)}&fields=id,title,posterUrlSmall,numberOfEpisodes,type,typeTitle,year,season,titles`)
  })

  ipcMain.handle('get-anime', async (_event, id: number) => {
    try {
      const result = await apiRequest(`/series/${id}`) as { data: AnimeDetail }
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
    const token = store.get('token') as string
    const url = `https://smotret-anime.ru/api/translations/embed/${translationId}${token ? `?access_token=${token}` : ''}`
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (!response.ok) return null
      const json = await response.json() as { data: { stream: { height: number; urls: string[] }[] } }
      const streams = json.data?.stream || []
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
      const result = await apiRequest(`/episodes/${id}`) as { data: EpisodeDetail }
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
    // Save episode metadata
    const episodes = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>
    for (const req of requests) {
      episodes[`${req.animeId}:${req.episodeInt}`] = {
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
    const result: Record<string, { translationType: string; author: string; quality: number; translationId: number }> = {}
    const prefix = `${animeId}:`
    for (const [key, val] of Object.entries(episodes)) {
      if (key.startsWith(prefix)) {
        result[key.substring(prefix.length)] = val
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
      const [animeIdStr, epInt] = key.split(':')
      const animeEntry = downloadedAnime[animeIdStr]
      if (!animeEntry) continue
      const animeName = animeEntry.titles?.romaji || animeEntry.titles?.ru || animeEntry.title
      const padded = epInt.padStart(2, '0')
      const base = sanitizeFilename(`${animeName} - ${padded}`)
      const dirName = sanitizeFilename(animeName)
      const mkvPath = path.join(downloadDir, dirName, `${base}.mkv`)

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
    const animeDirName = sanitizeFilename(animeName)
    const dirsToCheck = [getDownloadDir()]
    if (isAdvancedStorage()) {
      const coldDir = getColdStorageDir()
      if (coldDir) dirsToCheck.push(coldDir)
    }

    const result: Record<string, { type: 'mkv' | 'mp4'; filePath: string }> = {}
    // Check dirs in reverse so cold storage (last) takes priority
    for (const dir of dirsToCheck) {
      const animeDir = path.join(dir, animeDirName)
      if (!fs.existsSync(animeDir)) continue

      for (const epInt of episodeInts) {
        const padded = epInt.padStart(2, '0')
        const base = sanitizeFilename(`${animeName} - ${padded}`)
        const mkvPath = path.join(animeDir, `${base}.mkv`)
        const mp4Path = path.join(animeDir, `${base}.mp4`)

        if (fs.existsSync(mkvPath)) {
          result[epInt] = { type: 'mkv', filePath: mkvPath }
        } else if (fs.existsSync(mp4Path)) {
          result[epInt] = { type: 'mp4', filePath: mp4Path }
        }
      }
    }
    return result
  })

  ipcMain.handle('file:open', async (_event, filePath: string) => {
    return shell.openPath(filePath)
  })

  ipcMain.handle('file:show-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('file:delete-episode', (_event, animeName: string, episodeInt: string, animeId?: number) => {
    const animeDirName = sanitizeFilename(animeName)
    const dirsToCheck = [getDownloadDir()]
    if (isAdvancedStorage()) {
      const coldDir = getColdStorageDir()
      if (coldDir) dirsToCheck.push(coldDir)
    }

    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)

    for (const dir of dirsToCheck) {
      const animeDir = path.join(dir, animeDirName)
      for (const ext of ['.mkv', '.mp4', '.ass']) {
        const fp = path.join(animeDir, `${base}${ext}`)
        try { fs.unlinkSync(fp) } catch { /* ignore */ }
      }
    }

    // Clean up episode metadata
    if (animeId) {
      const episodes = store.get('downloadedEpisodes') as Record<string, unknown>
      delete episodes[`${animeId}:${episodeInt}`]
      store.set('downloadedEpisodes', episodes)
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

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

  function assToVtt(ass: string): string {
    const lines = ass.split(/\r?\n/)
    let vtt = 'WEBVTT\n\n'
    let formatFields: string[] = []

    for (const line of lines) {
      if (line.startsWith('Format:') && line.toLowerCase().includes('text')) {
        formatFields = line.substring(7).split(',').map(f => f.trim().toLowerCase())
      } else if (line.startsWith('Dialogue:')) {
        const values = line.substring(9).split(',')
        const startIdx = formatFields.indexOf('start')
        const endIdx = formatFields.indexOf('end')
        const textIdx = formatFields.indexOf('text')
        if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue

        const start = values[startIdx]?.trim()
        const end = values[endIdx]?.trim()
        // Text field is everything from textIdx onward (may contain commas)
        const text = values.slice(textIdx).join(',').trim()
          .replace(/\{[^}]*\}/g, '') // strip ASS style tags like {\b1}
          .replace(/\\N/g, '\n')     // ASS newline
          .replace(/\\n/g, '\n')

        if (!start || !end || !text) continue

        // Convert ASS time (H:MM:SS.CC) to VTT time (HH:MM:SS.MMM)
        const toVttTime = (t: string): string => {
          const m = t.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/)
          if (!m) return t
          return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4]}0`
        }

        vtt += `${toVttTime(start)} --> ${toVttTime(end)} line:85%\n${text}\n\n`
      }
    }
    return vtt
  }

  ipcMain.handle('player:get-stream-url', async (_event, translationId: number, maxHeight: number) => {
    const token = store.get('token') as string
    const url = `${API_BASE}/translations/embed/${translationId}${token ? `?access_token=${token}` : ''}`
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (!response.ok) return null
      const json = await response.json() as { data: { stream: { height: number; urls: string[] }[]; subtitlesUrl: string | null } }
      const streams = json.data?.stream || []
      if (streams.length === 0) return null
      const sorted = [...streams].sort((a, b) => b.height - a.height)
      const best = sorted.find(s => s.height <= maxHeight) || sorted[0]
      const streamUrl = best && best.urls.length > 0 ? best.urls[0] : null
      if (!streamUrl) return null

      // Build list of all available streams for quality selector
      const availableStreams = sorted
        .filter(s => s.urls.length > 0)
        .map(s => ({ height: s.height, url: s.urls[0] }))

      // Fetch ASS subtitle content if available
      let subtitleContent: string | null = null
      if (json.data.subtitlesUrl) {
        try {
          const subUrl = `https://smotret-anime.ru/translations/ass/${translationId}?download=1`
            + (token ? `&access_token=${token}` : '')
          const subResp = await fetch(subUrl, { headers: { 'User-Agent': USER_AGENT } })
          if (subResp.ok) {
            const assContent = await subResp.text()
            subtitleContent = assToVtt(assContent)
          }
        } catch { /* subtitle fetch failed, continue without subs */ }
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
        const assContent = fs.readFileSync(assPath, 'utf-8')
        return assToVtt(assContent)
      }
    } catch { /* ignore */ }
    return null
  })

  // Remux MKV to MP4 (stream copy) for HTML5 playback
  const remuxTmpDir = path.join(os.tmpdir(), 'anime-dl-remux')

  ipcMain.handle('player:remux-mkv', async (_event, mkvPath: string): Promise<{ mp4Path: string } | { error: string }> => {
    if (!ffmpegPath) return { error: 'ffmpeg not available' }
    if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

    // Create temp dir
    fs.mkdirSync(remuxTmpDir, { recursive: true })

    const baseName = path.basename(mkvPath, path.extname(mkvPath))
    const mp4Path = path.join(remuxTmpDir, `${baseName}-${Date.now()}.mp4`)

    Ffmpeg.setFfmpegPath(ffmpegPath)

    return new Promise((resolve) => {
      Ffmpeg(mkvPath)
        .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
        .output(mp4Path)
        .on('error', (err) => {
          console.error('[remux] FFmpeg error:', err.message)
          resolve({ error: err.message })
        })
        .on('end', () => {
          console.log('[remux] Completed:', mp4Path)
          resolve({ mp4Path })
        })
        .run()
    })
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
    () => store.get('token') as string,
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
