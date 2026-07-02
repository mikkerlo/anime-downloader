import { app, shell, BrowserWindow, Notification, protocol, net, session } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { createStorageService } from './store'
import { type PersistedStoreKey } from './store/keys'
import { DownloadManager, sanitizeFilename } from './download-manager'
import {
  initAutoDownloader,
  startAutoDownloaderTimer,
  runAutoDownloadTick
} from './auto-downloader'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import {
  ensureFfmpeg,
  getFfmpegPath,
  getFfprobePath,
  clearFfmpegPaths,
  getFfmpegDir
} from './ffmpeg-binaries'
import * as shikimori from './shikimori'
import { pathToFileURL } from 'url'
import { Readable } from 'stream'
import { SmotretApi } from './smotret-api'
import { parseEpisodeFromFilename } from './lib/filename'
import { installShikimoriReferer } from './lib/shikimori-images'
import { avcCodecString, hevcCodecString, aacCodecString } from './streaming/codec-strings'
import type { AnimeSearchResult, AnimeDetail, Translation } from './smotret-api'
import { ensureFpcalc, getFpcalcPath } from './fpcalc-binaries'
import type { ShowSkipDetections, CachedFingerprint } from './skip-detector'
import { syncplay } from './syncplay'
import type {
  SyncplayRemoteState,
  SyncplayRoomUser,
  SyncplayRoomEvent,
  SyncplayRemoteEpisode,
  SyncplayStatus
} from './syncplay'
import type { Mp4StreamingStats } from './mp4-faststart'

import { createAnimeCacheService, type AnimeCacheEntry } from './services/anime-cache'
import { createSkipAnalysisService } from './services/skip-analysis'
import { createColdStorageService } from './services/cold-storage'
import { createShikimoriSyncService } from './services/shikimori-sync'
import { createStreamingService, PLAYER_DIAG_LOG_FILENAME } from './streaming'
import { createMp4StatsService } from './services/mp4-stats'
import { App } from './app/core'
import { registerIpcRouters } from './ipc'
import { createEpisodeFileScanner } from './lib/episode-file-scan'

export interface AutoDownloadSubscription {
  animeId: number
  malId: number
  animeName: string
  subscribedAt: number
  lastEnqueuedEpisodeInt: number
  lastCheckedAt: number
  // Episodes_aired snapshot at subscribe time; frozen for life of the
  // subscription. The player's pre-fetch uses this (not the rolling
  // `lastEnqueuedEpisodeInt`) to decide which episodes the auto-downloader
  // owns. Optional for legacy subs created before this field existed.
  initialEpisodesAired?: number
}

const STORE_DEFAULTS = {
  token: '',
  translationType: 'subRu',
  downloadDir: '',
  library: {} as Record<string, AnimeSearchResult>,
  autoMerge: false,
  videoCodec: 'copy' as string,
  downloadedAnime: {} as Record<string, AnimeSearchResult>,
  downloadedEpisodes: {} as Record<
    string,
    { translationType: string; author: string; quality: number; translationId: number }
  >,
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
    playerNextEpisode: 'Shift+ArrowRight',
    shaderModeA: 'CmdOrCtrl+1',
    shaderModeB: 'CmdOrCtrl+2',
    shaderModeC: 'CmdOrCtrl+3',
    shaderOff: 'CmdOrCtrl+Backquote'
  } as Record<string, string>,
  shikimoriCredentials: null as shikimori.ShikiCredentials | null,
  shikimoriUser: null as shikimori.ShikiUser | null,
  storageMode: 'simple' as 'simple' | 'advanced',
  hotStorageDir: '' as string,
  coldStorageDir: '' as string,
  autoMoveToCold: false,
  malIdMap: {} as Record<string, AnimeSearchResult>,
  playerMode: 'system' as 'system' | 'builtin',
  playerVolume: 1 as number,
  playerMuted: false,
  anime4kPreset: 'off' as 'off' | 'mode-a' | 'mode-b' | 'mode-c',
  hevcTranscodeOnPlay: 'ask' as 'ask' | 'always' | 'never',
  prefetchNextEpisode: 'progress-50' as 'off' | 'open' | 'time-5min' | 'progress-50',
  watchProgress: {} as Record<
    string,
    {
      position: number
      duration: number
      updatedAt: number
      watched?: boolean
      watchedAt?: number
      translationId?: number
    }
  >,
  watchProgressMigrationV2: false,
  autoCleanupWatchedDays: 0,
  autoCleanupConfirm: true,
  autoCleanupLastRun: null as { ranAt: number; deletedCount: number; freedBytes: number } | null,
  cleanupLog: [] as {
    ranAt: number
    animeId: number
    animeName: string
    episodeInt: string
    bytes: number
  }[],
  shikimoriUserRates: [] as unknown[],
  shikimoriUpdateQueue: [] as unknown[],
  shikimoriAnimeDetails: {} as Record<
    string,
    { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
  >,
  autoDownloadSubscriptions: {} as Record<string, AutoDownloadSubscription>,
  autoDownloadEnabled: true,
  recentAnimeMeta: {} as Record<string, AnimeSearchResult>,
  skipDetections: {} as Record<string, ShowSkipDetections>,
  skipFingerprintCache: {} as Record<string, CachedFingerprint>,
  enableLocalSkipDetection: true,
  calendarView: 'week' as 'week' | 'month',
  syncplay: {
    lastHost: 'syncplay.pl',
    lastPort: 8999,
    lastRoom: '',
    username: '',
    autoReconnect: true
  } as {
    lastHost: string
    lastPort: number
    lastRoom: string
    username: string
    autoReconnect: boolean
  },
  mp4StreamingStats: {
    totalChecked: 0,
    faststartCount: 0,
    nonFaststartSamples: [] as {
      animeId: number
      animeName: string
      episodeInt: string
      episodeLabel: string
      filePath: string
      firstNonFtypBox: string
      checkedAt: number
    }[]
  } as Mp4StreamingStats,
  autoCleanupSnoozedAnimeIds: {} as Record<string, true>,
  dismissedContinueWatching: [] as string[],
  shikimoriProfile: null as ShikimoriProfile | null,
  shikimoriFriends: [] as ShikiFriendCard[]
}

const store = createStorageService(STORE_DEFAULTS)

// Compile-time guard: `STORE_DEFAULTS` keys must equal `PERSISTED_STORE_KEYS`.
// Renaming a default key without updating the tuple breaks this assertion,
// stopping the build before a release silently orphans user data.
type _AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _storeKeysInSync: _AssertExact<keyof typeof STORE_DEFAULTS & string, PersistedStoreKey> = true
void _storeKeysInSync

function broadcastToAll(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

// Owns the mp4-faststart sampling state (Phase 3 slice 3g): the per-session
// probed-paths set + the write-serialization chain now live in the service.
const mp4StatsService = createMp4StatsService({ store })

// --- Anime cache helpers (for offline support + fast-loading detail view) ---

function isDownloadedAnime(animeId: number): boolean {
  const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
  return !!downloaded[String(animeId)]
}

function isStarredAnime(animeId: number): boolean {
  const lib = store.get('library') as Record<string, AnimeSearchResult>
  return !!lib[String(animeId)]
}

function isCachableAnime(animeId: number): boolean {
  return isDownloadedAnime(animeId) || isStarredAnime(animeId)
}

function getDisplayName(anime: AnimeSearchResult): string {
  return anime.titles?.romaji || anime.titles?.ru || anime.title
}

function isCleanupSnoozed(animeId: number): boolean {
  const snoozed = store.get('autoCleanupSnoozedAnimeIds') as Record<string, true>
  return !!snoozed[String(animeId)]
}

async function resolveSmotretFromMalId(
  malId: number,
  fallback: unknown
): Promise<AnimeSearchResult | null> {
  if (
    fallback &&
    typeof fallback === 'object' &&
    typeof (fallback as { id?: unknown }).id === 'number'
  ) {
    return fallback as AnimeSearchResult
  }
  const map = store.get('malIdMap') as Record<string, AnimeSearchResult>
  const cached = map[String(malId)]
  if (cached?.id) return cached
  try {
    const resolved = await lookupByMalIds([malId])
    return resolved[malId] ?? null
  } catch {
    return null
  }
}

async function maybeBroadcastCleanupPrompt(
  smotretAnime: unknown,
  malId: number,
  status: shikimori.ShikiUserRateStatus,
  prevStatus?: shikimori.ShikiUserRateStatus
): Promise<void> {
  if (status !== 'completed' || prevStatus === 'completed') return
  const sa = await resolveSmotretFromMalId(malId, smotretAnime)
  if (!sa || typeof sa.id !== 'number') return
  if (!isDownloadedAnime(sa.id)) return
  if (isCleanupSnoozed(sa.id)) return
  broadcastToAll(EVENT_CHANNELS.CLEANUP_PROMPT, {
    animeId: sa.id,
    animeName: getDisplayName(sa),
    malId
  })
}

async function sumShowFiles(animeName: string): Promise<{ bytes: number; files: number }> {
  const animeDirName = sanitizeFilename(animeName)
  let bytes = 0
  let files = 0
  for (const dir of coldStorageService.dirsForScan()) {
    const showDir = path.join(dir, animeDirName)
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(showDir, { withFileTypes: true })
    } catch {
      continue
    }
    const targets = entries.filter((entry) => {
      if (!entry.isFile()) return false
      const lower = entry.name.toLowerCase()
      return (
        lower.endsWith('.mkv') ||
        lower.endsWith('.mp4') ||
        lower.endsWith('.ass') ||
        lower.endsWith('.srt')
      )
    })
    const sizes = await Promise.all(
      targets.map(async (entry) => {
        try {
          const stat = await fs.promises.stat(path.join(showDir, entry.name))
          return stat.size
        } catch {
          return null
        }
      })
    )
    for (const size of sizes) {
      if (size === null) continue
      bytes += size
      files++
    }
  }
  return { bytes, files }
}

// Episode-file scan cache backing `CHANNELS.FILE_CHECK_EPISODES` (#196). The
// scanner lives in `lib/episode-file-scan.ts` so the cache-first / async-scan /
// concurrent-dedupe behavior is unit-testable. `getDirsToScan` reads
// `coldStorageService` lazily (declared below) — only invoked at scan time, so
// the forward reference resolves at runtime. The synchronous
// `fileScanner.scanEpisodeFiles` is what skip-analysis + cold-storage consume.
const fileScanner = createEpisodeFileScanner({
  getDirsToScan: () => {
    const dirs = [coldStorageService.getDownloadDir()]
    if (coldStorageService.isAdvanced()) {
      const coldDir = coldStorageService.getColdStorageDir()
      if (coldDir) dirs.push(coldDir)
    }
    return dirs
  },
  sanitizeFilename,
  onEpisodesChanged: (animeName, result) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENT_CHANNELS.FILE_EPISODES_CHANGED, animeName, result)
    }
  }
})
const scanEpisodeFiles = fileScanner.scanEpisodeFiles
const checkEpisodeFiles = fileScanner.checkEpisodeFiles
const invalidateFileCacheByDirName = fileScanner.invalidateByDirName

const smotretApi = new SmotretApi(() => store.get('token') as string)

const animeCacheService = createAnimeCacheService({
  store,
  userDataDir: app.getPath('userData'),
  fetchPoster: (url) => smotretApi.fetchPoster(url),
  isCachable: isCachableAnime
})

const coldStorageService = createColdStorageService({
  store,
  downloadsFallbackDir: app.getPath('downloads'),
  sanitizeFilename,
  parseEpisodeFromFilename,
  scanEpisodeFiles,
  invalidateFileCache: fileScanner.invalidate,
  broadcast: broadcastToAll,
  usageProgressChannel: EVENT_CHANNELS.STORAGE_USAGE_PROGRESS,
  cleanupPendingChannel: EVENT_CHANNELS.STORAGE_CLEANUP_PENDING,
  cleanupFinishedChannel: EVENT_CHANNELS.STORAGE_CLEANUP_FINISHED,
  fileEpisodesChangedChannel: EVENT_CHANNELS.FILE_EPISODES_CHANGED
})

const shikimoriSyncService = createShikimoriSyncService({
  store,
  broadcast: broadcastToAll,
  syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
  offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
  rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
  animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED
})
let downloadManager: DownloadManager

const skipAnalysisService = createSkipAnalysisService({
  store,
  scanEpisodeFiles,
  sanitizeFilename,
  broadcast: broadcastToAll,
  signatureUpdatedChannel: EVENT_CHANNELS.SKIP_DETECTOR_SIGNATURE_UPDATED,
  analyzeProgressChannel: EVENT_CHANNELS.SKIP_DETECTOR_ANALYZE_PROGRESS,
  getFpcalcPath,
  getFfmpegPath,
  getFfprobePath
})

const streamingService = createStreamingService({
  getFfmpegPath,
  getFfprobePath,
  // Live-read so the Settings → Debug toggle applies without a restart; the
  // env var stays as a force-on override for one-off runs.
  isPlayerDiagEnabled: () =>
    process.env.ANIME_DL_PLAYER_DIAG === '1' || store.get('playerDiagLogging') === true,
  // Packaged builds have no visible main-process console, so diag lines are
  // also appended to userData/player-diag.log (surfaced in the Debug tab).
  // Async and chained: diag lines fire exactly during seek storms, so a sync
  // write on slow storage would stall the event loop that pumps the stream
  // chunks; the promise chain keeps line order without blocking.
  playerDiagSink: (() => {
    let diagWriteChain = Promise.resolve()
    return (line: string): void => {
      diagWriteChain = diagWriteChain
        .then(() =>
          fs.promises.appendFile(
            path.join(app.getPath('userData'), PLAYER_DIAG_LOG_FILENAME),
            `${new Date().toISOString()} ${line}\n`
          )
        )
        .catch(() => {
          /* diagnostics must never break streaming */
        })
    }
  })(),
  channels: {
    streamChunk: EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
    streamEnd: EVENT_CHANNELS.PLAYER_STREAM_END,
    streamError: EVENT_CHANNELS.PLAYER_STREAM_ERROR,
    streamProgress: EVENT_CHANNELS.PLAYER_STREAM_PROGRESS
  }
})

interface FfmpegInfo {
  available: boolean
  version: string
  path: string
  encoders: string[]
}

function checkFfmpeg(): Promise<FfmpegInfo> {
  const ffmpegPath = getFfmpegPath()
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

function rememberAnimeMeta(detail: AnimeDetail): void {
  if (!detail || !detail.id) return
  const meta = store.get('recentAnimeMeta') as Record<string, AnimeSearchResult>
  meta[String(detail.id)] = {
    id: detail.id,
    title: detail.title,
    titles: detail.titles,
    // Some smotret entries return only the full-size `posterUrl`; fall back
    // to it so HomeView never has an empty thumbnail when one is available.
    posterUrlSmall: detail.posterUrlSmall || detail.posterUrl,
    numberOfEpisodes: detail.numberOfEpisodes,
    type: detail.type,
    typeTitle: detail.typeTitle,
    year: detail.year,
    season: detail.season
  }
  store.set('recentAnimeMeta', meta)
}

// Smotret's bulk `series/?myAnimeListId[]=…` endpoint occasionally returns
// entries with an empty `posterUrlSmall`. The single-anime detail endpoint
// (`/series/:id`) usually has one. Enrich any poster-less entries by hitting
// the detail endpoint, with a small concurrency limit and a per-call timeout.
// Caches the resolved poster in `recentAnimeMeta` so future lookups skip the
// fetch entirely.
async function enrichMissingPosters(
  entries: AnimeSearchResult[],
  recent: Record<string, AnimeSearchResult>
): Promise<void> {
  const idsToFetch: number[] = []
  for (const e of entries) {
    if (e.posterUrlSmall || !e.id) continue
    const cachedRecent = recent[String(e.id)]
    if (cachedRecent?.posterUrlSmall) {
      e.posterUrlSmall = cachedRecent.posterUrlSmall
      continue
    }
    idsToFetch.push(e.id)
  }
  if (idsToFetch.length === 0) return

  // Cap to avoid runaway fan-out on first sync of a large list. Anything past
  // the cap will be enriched lazily on next interaction.
  const MAX_ENRICH = 20
  const ids = idsToFetch.slice(0, MAX_ENRICH)
  const concurrency = 4
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const id = ids[cursor++]
      try {
        const result = await Promise.race([
          smotretApi.getAnime(id),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ])
        const detail = (result as { data: AnimeDetail }).data
        if (!detail) continue
        rememberAnimeMeta(detail)
        const poster = detail.posterUrlSmall || detail.posterUrl || ''
        if (!poster) continue
        for (const e of entries) {
          if (e.id === id && !e.posterUrlSmall) e.posterUrlSmall = poster
        }
      } catch {
        // best-effort; leave empty so renderer fallback can decide
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
}

async function lookupByMalIds(malIds: number[]): Promise<Record<number, AnimeSearchResult>> {
  const cached = store.get('malIdMap') as Record<string, AnimeSearchResult>
  const recent = store.get('recentAnimeMeta') as Record<string, AnimeSearchResult>
  const result: Record<number, AnimeSearchResult> = {}
  const uncachedIds: number[] = []

  for (const id of malIds) {
    if (cached[String(id)]) {
      let entry = cached[String(id)]
      // If the cached MAL→smotret entry has no poster, try the freshest
      // smotret meta we have (populated on every get-anime call). This
      // heals stale entries that were cached before we enriched.
      if (!entry.posterUrlSmall && recent[String(entry.id)]?.posterUrlSmall) {
        entry = { ...entry, posterUrlSmall: recent[String(entry.id)].posterUrlSmall }
        cached[String(id)] = entry
      }
      result[id] = entry
    } else {
      uncachedIds.push(id)
    }
  }

  if (uncachedIds.length > 0) {
    const fetched = await smotretApi.lookupByMalIds(uncachedIds)
    await enrichMissingPosters(fetched, recent)
    for (const anime of fetched) {
      if (anime.myAnimeListId) {
        result[anime.myAnimeListId] = anime
        cached[String(anime.myAnimeListId)] = anime
      }
    }
  }
  store.set('malIdMap', cached)
  return result
}

// Wires every per-domain IPC router. As of Phase 3 slice 3g this is the whole
// of `index.ts`'s IPC surface — no `ipcMain.handle` calls remain here.
function registerIpcHandlers(): void {
  registerIpcRouters({
    store,
    smotretApi,
    animeCacheService,
    coldStorageService,
    skipAnalysisService,
    downloadManager,
    rememberAnimeMeta,
    getFfmpegPath,
    getFfprobePath,
    clearFfmpegPaths,
    invalidateFileCache: fileScanner.invalidate,
    getFfmpegDir,
    sumShowFiles,
    checkFfmpeg,
    getDisplayName,
    shikimoriSyncService,
    lookupByMalIds,
    maybeBroadcastCleanupPrompt,
    runAutoDownloadTick,
    broadcast: broadcastToAll,
    checkEpisodeFiles,
    invalidateFileCacheByDirName,
    clearFileCache: fileScanner.clear,
    streamingService,
    mp4StatsService
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: join(
      __dirname,
      process.platform === 'win32' ? '../../resources/icon.ico' : '../../resources/icon.png'
    ),
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

  mainWindow.webContents.on('destroyed', () => {
    skipAnalysisService.cancelStreamSkipDetection(mainWindow.webContents.id)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function bootstrap(): Promise<void> {
  // Satisfy Shikimori's image hotlink protection so friend avatars (loaded by
  // the renderer straight from shikimori.io) render instead of coming back blank.
  installShikimoriReferer(session.defaultSession)

  // Handle anime-video:// protocol for local video playback with Range request support.
  // Only one URL shape: anime-video://{absolute-path}. MKV streaming now uses MSE via IPC.
  protocol.handle('anime-video', async (request) => {
    const raw = request.url.replace('anime-video://', '')
    const filePath = decodeURIComponent(raw)

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('File not found', { status: 404 })
    }

    const fileSize = stat.size
    const rangeHeader = request.headers.get('Range')

    const ext = path.extname(filePath).toLowerCase()
    const mimeType =
      ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'application/octet-stream'

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

  animeCacheService.cleanupStale()
  createWindow()
  const mainWin = BrowserWindow.getAllWindows()[0]

  try {
    await ensureFfmpeg(mainWin)
  } catch (err) {
    console.error('[ffmpeg] Failed to ensure ffmpeg:', err)
  }
  // Best-effort: skip-detector will surface a clear error if fpcalc is missing.
  ensureFpcalc(mainWin).catch((err) => console.error('[fpcalc] Failed to ensure fpcalc:', err))
  const ffmpegInfo = await checkFfmpeg()
  downloadManager = new DownloadManager(
    coldStorageService.getDownloadDir(),
    smotretApi,
    app.getPath('userData'),
    () => (store.get('downloadSpeedLimit') as number) || 0,
    () => (store.get('concurrentDownloads') as number) || 2
  )
  downloadManager.loadQueue()
  const showBackgroundNotification = (title: string, body: string): void => {
    if (BrowserWindow.getFocusedWindow() !== null) return
    new Notification({ title, body }).show()
  }

  downloadManager.onEpisodeComplete(async (info) => {
    const {
      animeName,
      episodeLabel,
      animeId,
      episodeInt,
      translationId,
      translationType,
      author,
      quality
    } = info
    fileScanner.invalidate(animeName)

    // Persist episode metadata now that the video is on disk. Writing this at enqueue
    // time caused stale ⬇ icons to survive cancelled / failed downloads.
    if (animeId > 0 && episodeInt) {
      const episodes = store.get('downloadedEpisodes') as Record<
        string,
        { translationType: string; author: string; quality: number; translationId: number }
      >
      delete episodes[`${animeId}:${episodeInt}`]
      episodes[`${animeId}:${episodeInt}:${translationId}`] = {
        translationType,
        author,
        quality,
        translationId
      }
      store.set('downloadedEpisodes', episodes)
    }

    const autoMerge = store.get('autoMerge') as boolean
    const ffmpegPath = getFfmpegPath()
    if (autoMerge && ffmpegInfo.available && ffmpegPath) {
      const codec = (store.get('videoCodec') as string) || 'copy'
      await downloadManager.mergeCompleted(ffmpegPath, getFfprobePath(), codec)
    } else {
      // Auto-move to cold if merge is disabled
      if (coldStorageService.isAdvanced() && (store.get('autoMoveToCold') as boolean)) {
        await coldStorageService.moveEpisodeToColdStorage(animeName, episodeLabel)
      }
      const mode = store.get('notificationMode') as string
      if (mode === 'each') {
        showBackgroundNotification('Download complete', `${animeName} \u2014 ${episodeLabel}`)
      }
      // With autoMerge off, the .mp4 is the final artifact \u2014 trigger here.
      // With autoMerge on, the merge-complete hook below triggers against the
      // .mkv instead, so we don't double-fingerprint.
      if (animeId > 0) skipAnalysisService.scheduleAutoSkipAnalysis(animeId, animeName)
    }
  })

  downloadManager.onMergeComplete(async ({ animeName, animeId, episodeLabel }) => {
    fileScanner.invalidate(animeName)
    // Auto-move to cold after merge
    if (coldStorageService.isAdvanced() && (store.get('autoMoveToCold') as boolean)) {
      await coldStorageService.moveEpisodeToColdStorage(animeName, episodeLabel)
    }
    const mode = store.get('notificationMode') as string
    if (mode === 'each') {
      showBackgroundNotification('Merge complete', `${animeName} \u2014 ${episodeLabel}`)
    }
    if (animeId > 0) skipAnalysisService.scheduleAutoSkipAnalysis(animeId, animeName)
  })

  downloadManager.onQueueComplete(() => {
    const mode = store.get('notificationMode') as string
    if (mode === 'queue') {
      showBackgroundNotification('Downloads complete', 'All downloads have finished')
    }
  })

  downloadManager.onVideoDownloaded((filePath, item) => {
    if (!filePath.toLowerCase().endsWith('.mp4')) return
    void mp4StatsService.recordCheck(filePath, {
      animeId: item.animeId,
      animeName: item.animeName,
      episodeInt: item.episodeInt,
      episodeLabel: item.episodeLabel
    })
  })

  registerIpcHandlers()

  initAutoDownloader({
    store,
    smotretApi,
    downloadManager,
    broadcast: broadcastToAll,
    isShikimoriLoggedIn: () => Boolean(store.get('shikimoriCredentials')),
    refreshShikimoriDetails: (malId) => shikimoriSyncService.refreshShikimoriDetailsForMalId(malId)
  })
  startAutoDownloaderTimer()
  setTimeout(() => {
    void runAutoDownloadTick('startup').catch((err) =>
      console.warn('[auto-dl] startup tick failed:', err)
    )
  }, 30_000)

  store.migrateWatchProgressV2()

  // Auto-cleanup of watched episodes — opt-in. Run 60s after launch (warmup),
  // then once every 24h. First run that finds candidates while
  // `autoCleanupConfirm` is still true emits `storage:cleanup-pending` instead
  // of deleting; the renderer's confirm modal then calls back with force=true.
  setTimeout(() => {
    void coldStorageService.runWatchedCleanup()
  }, 60_000)
  setInterval(
    () => {
      void coldStorageService.runWatchedCleanup()
    },
    24 * 60 * 60 * 1000
  )

  // Reconcile the skip-detector fingerprint cache against disk. Runs once at
  // startup as the backstop for anything the file:delete-episode and
  // downloaded-anime-delete hooks miss (external rm, in-place rename,
  // file replaced outside the app, leftover .mp4 cache after merge, etc.).
  setTimeout(() => {
    try {
      const r = skipAnalysisService.sweepFingerprintCache()
      if (r.dropped > 0) {
        console.log(
          `[skip-detector] cache sweep: kept ${r.kept}, dropped ${r.dropped} stale entries`
        )
      }
    } catch (e) {
      console.warn(`[skip-detector] cache sweep failed: ${e instanceof Error ? e.message : e}`)
    }
  }, 30_000)

  syncplay.on('connection-status', (status: SyncplayStatus) => {
    broadcastToAll(EVENT_CHANNELS.SYNCPLAY_CONNECTION_STATUS, status)
  })
  syncplay.on('remote-state', (state: SyncplayRemoteState) => {
    broadcastToAll(EVENT_CHANNELS.SYNCPLAY_REMOTE_STATE, state)
  })
  syncplay.on('room-users', (users: SyncplayRoomUser[]) => {
    broadcastToAll(EVENT_CHANNELS.SYNCPLAY_ROOM_USERS, users)
  })
  syncplay.on('room-event', (ev: SyncplayRoomEvent) => {
    broadcastToAll(EVENT_CHANNELS.SYNCPLAY_ROOM_EVENT, ev)
  })
  syncplay.on('remote-episode-change', (ep: SyncplayRemoteEpisode) => {
    broadcastToAll(EVENT_CHANNELS.SYNCPLAY_REMOTE_EPISODE_CHANGE, ep)
  })
  syncplay.on('trace', (entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => {
    broadcastToAll(EVENT_CHANNELS.SYNCPLAY_TRACE, entry)
  })

  if (shikimoriSyncService.getQueueLength() > 0) {
    shikimoriSyncService.startSyncTimer()
    void shikimoriSyncService.syncShikimoriQueue()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

new App()
  .start({
    onReady: bootstrap,
    onBeforeQuit: () => {
      // Persist quality probes still sitting on the debounce timer — without
      // this, probes buffered in the last ≤500ms before quit are dropped.
      animeCacheService.flushQualityProbes()
      downloadManager?.destroy()
      syncplay.disconnect()
    }
  })
  .catch((err) => {
    console.error('[app] startup failed:', err)
    app.exit(1)
  })
