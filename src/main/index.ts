import { app, shell, BrowserWindow, ipcMain, dialog, Notification, protocol, net } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { createStorageService } from './store'
import { type PersistedStoreKey } from './store/keys'
import { DownloadManager, sanitizeFilename } from './download-manager'
import {
  initAutoDownloader,
  startAutoDownloaderTimer,
  runAutoDownloadTick,
  getAutoDownloaderStatus,
  listSubscriptions as autoDlListSubscriptions,
  getSubscription as autoDlGetSubscription,
  setSubscription as autoDlSetSubscription
} from './auto-downloader'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import ffbinaries from 'ffbinaries'
import { execFile, type ChildProcess } from 'child_process'
import Ffmpeg from 'fluent-ffmpeg'
import * as shikimori from './shikimori'
import { pathToFileURL } from 'url'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { SmotretApi } from './smotret-api'
import { parseEpisodeFromFilename } from './lib/filename'
import { avcCodecString, hevcCodecString, aacCodecString } from './streaming/codec-strings'
import type { AnimeSearchResult, AnimeDetail, Translation } from './smotret-api'
import { ensureFpcalc, getFpcalcPath } from './fpcalc-binaries'
import type { ShowSkipDetections, CachedFingerprint } from './skip-detector'
import { syncplay } from './syncplay'
import type {
  SyncplayConfig,
  SyncplayFileInfo,
  SyncplayRemoteState,
  SyncplayRoomUser,
  SyncplayRoomEvent,
  SyncplayRemoteEpisode,
  SyncplayStatus
} from './syncplay'
import { probeMp4Faststart } from './mp4-faststart'
import type { Mp4StreamingStats } from './mp4-faststart'

import { createAnimeCacheService, type AnimeCacheEntry } from './services/anime-cache'
import { createSkipAnalysisService } from './services/skip-analysis'
import { createColdStorageService } from './services/cold-storage'
import { createShikimoriSyncService } from './services/shikimori-sync'
import { createStreamingService, type MseSession, type MseOpenResult } from './streaming'
import { App } from './app/core'
import { registerIpcRouters } from './ipc'

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
  autoCleanupSnoozedAnimeIds: {} as Record<string, true>
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

// In-memory set of MP4 paths probed this session, so re-opening the same file
// in the player doesn't double-count. Stats persist across sessions; this set
// resets on app restart, which is fine — it's a sampling check, not an exact
// per-file ledger.
const mp4FaststartChecked = new Set<string>()

// Serialize stats read-modify-write so concurrent download finishes can't
// clobber each other's increments.
let mp4StatsWriteChain: Promise<void> = Promise.resolve()

async function recordMp4FaststartCheck(
  filePath: string,
  context: { animeId: number; animeName: string; episodeInt: string; episodeLabel: string }
): Promise<void> {
  if (mp4FaststartChecked.has(filePath)) return
  mp4FaststartChecked.add(filePath)
  const probe = await probeMp4Faststart(filePath)
  if (!probe) return
  const next = mp4StatsWriteChain.then(() => {
    const stats = store.get('mp4StreamingStats') as Mp4StreamingStats
    stats.totalChecked += 1
    if (probe.faststart) {
      stats.faststartCount += 1
    } else {
      stats.nonFaststartSamples.push({
        animeId: context.animeId,
        animeName: context.animeName,
        episodeInt: context.episodeInt,
        episodeLabel: context.episodeLabel,
        filePath,
        firstNonFtypBox: probe.firstNonFtypBox,
        checkedAt: Date.now()
      })
      if (stats.nonFaststartSamples.length > 10) {
        stats.nonFaststartSamples = stats.nonFaststartSamples.slice(-10)
      }
      console.warn(
        `[mp4-faststart] non-faststart MP4 detected: ${context.animeName} — ${context.episodeLabel} (first non-ftyp box: ${probe.firstNonFtypBox}) at ${filePath}`
      )
    }
    store.set('mp4StreamingStats', stats)
  })
  mp4StatsWriteChain = next.catch(() => undefined)
  await next
}

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

type FileCheckResult = Record<
  string,
  { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
>
const fileCheckCache = new Map<string, FileCheckResult>()

function scanEpisodeFiles(animeName: string): FileCheckResult {
  const animeDirName = sanitizeFilename(animeName)
  const dirsToCheck = [coldStorageService.getDownloadDir()]
  if (coldStorageService.isAdvanced()) {
    const coldDir = coldStorageService.getColdStorageDir()
    if (coldDir) dirsToCheck.push(coldDir)
  }

  const result: FileCheckResult = {}

  for (const dir of dirsToCheck) {
    const animeDir = path.join(dir, animeDirName)
    if (!fs.existsSync(animeDir)) continue

    let files: string[]
    try {
      files = fs.readdirSync(animeDir)
    } catch {
      continue
    }

    for (const file of files) {
      const match = file.match(/^(.+?) \[(.+?)\]\.(mkv|mp4)$/)
      if (match) {
        const base = match[1]
        const author = match[2]
        const ext = match[3] as 'mkv' | 'mp4'
        if (!result[base]) result[base] = []
        const existing = result[base].find((e) => e.author === author)
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
        const hasAuthorVersion = result[base].some((e) => e.author)
        if (!hasAuthorVersion || !result[base].some((e) => !e.author)) {
          const existing = result[base].find((e) => !e.author)
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

function filterScanResult(
  fullResult: FileCheckResult,
  animeName: string,
  episodeInts: string[]
): FileCheckResult {
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
  const dirsToCheck = [coldStorageService.getDownloadDir()]
  if (coldStorageService.isAdvanced()) {
    const coldDir = coldStorageService.getColdStorageDir()
    if (coldDir) dirsToCheck.push(coldDir)
  }

  const result: FileCheckResult = {}

  for (const dir of dirsToCheck) {
    const animeDir = path.join(dir, animeDirName)
    let files: string[]
    try {
      files = await fsPromises.readdir(animeDir)
    } catch {
      continue
    }

    for (const file of files) {
      const match = file.match(/^(.+?) \[(.+?)\]\.(mkv|mp4)$/)
      if (match) {
        const base = match[1]
        const author = match[2]
        const ext = match[3] as 'mkv' | 'mp4'
        if (!result[base]) result[base] = []
        const existing = result[base].find((e) => e.author === author)
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
        const hasAuthorVersion = result[base].some((e) => e.author)
        if (!hasAuthorVersion || !result[base].some((e) => !e.author)) {
          const existing = result[base].find((e) => !e.author)
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
      win.webContents.send(EVENT_CHANNELS.FILE_EPISODES_CHANGED, animeName, result)
    }
  }
}

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
  invalidateFileCache: (animeName) => fileCheckCache.delete(animeName),
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
let ffmpegPath = ''
let ffprobePath = ''

const skipAnalysisService = createSkipAnalysisService({
  store,
  scanEpisodeFiles,
  sanitizeFilename,
  broadcast: broadcastToAll,
  signatureUpdatedChannel: EVENT_CHANNELS.SKIP_DETECTOR_SIGNATURE_UPDATED,
  analyzeProgressChannel: EVENT_CHANNELS.SKIP_DETECTOR_ANALYZE_PROGRESS,
  getFpcalcPath,
  getFfmpegPath: () => ffmpegPath,
  getFfprobePath: () => ffprobePath
})

const streamingService = createStreamingService({
  getFfmpegPath: () => ffmpegPath,
  getFfprobePath: () => ffprobePath,
  channels: {
    streamChunk: EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
    streamEnd: EVENT_CHANNELS.PLAYER_STREAM_END,
    streamError: EVENT_CHANNELS.PLAYER_STREAM_ERROR,
    streamProgress: EVENT_CHANNELS.PLAYER_STREAM_PROGRESS
  }
})

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
      win.webContents.send(EVENT_CHANNELS.FFMPEG_DOWNLOAD_PROGRESS, { status, progress })
    }
  }

  return new Promise((resolve, reject) => {
    console.log('[ffmpeg] Downloading ffmpeg + ffprobe binaries via ffbinaries...')
    sendProgress('downloading', 0)
    ffbinaries.downloadBinaries(
      ['ffmpeg', 'ffprobe'],
      {
        platform: ffbinaries.detectPlatform(),
        quiet: false,
        destination: dest,
        version: '6.1',
        tickerFn: (data) => {
          sendProgress('downloading', Math.round(data.progress * 100))
        },
        tickerInterval: 500
      },
      (err, results) => {
        if (err) {
          console.error('[ffmpeg] Download failed:', err)
          sendProgress('failed')
          reject(err)
          return
        }
        console.log('[ffmpeg] Download results:', results)
        // Make binaries executable on unix
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(ffmpegBin, 0o755)
          } catch {
            /* ignore */
          }
          try {
            fs.chmodSync(ffprobeBin, 0o755)
          } catch {
            /* ignore */
          }
        }
        ffmpegPath = ffmpegBin
        ffprobePath = ffprobeBin
        sendProgress('done', 100)
        resolve(ffmpegBin)
      }
    )
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

// Phase 4 — cache GC. The fingerprint cache is keyed by
// `animeId:episodeInt:fileSize:mtime` and grows unbounded otherwise:
// every successful merge produces a new key (mkv vs the source mp4),
// every re-download produces a new key (mtime differs), and deletes
// orphan their entries. The event-driven helpers below catch the
// common cases immediately; `sweepSkipFingerprintCache` runs at startup
// as a backstop for anything we miss (external rm, file replaced,
// in-place rename outside the app).

function registerIpcHandlers(): void {
  registerIpcRouters({
    store,
    smotretApi,
    animeCacheService,
    coldStorageService,
    skipAnalysisService,
    downloadManager,
    rememberAnimeMeta,
    getFfmpegPath: () => ffmpegPath,
    getFfprobePath: () => ffprobePath,
    clearFfmpegPaths: () => {
      ffmpegPath = ''
      ffprobePath = ''
    },
    invalidateFileCache: (animeName) => fileCheckCache.delete(animeName),
    getFfmpegDir,
    sumShowFiles,
    checkFfmpeg,
    getDisplayName,
    shikimoriSyncService,
    lookupByMalIds,
    maybeBroadcastCleanupPrompt,
    runAutoDownloadTick,
    broadcast: broadcastToAll
  })

  const qualityMismatches = new Map<
    number,
    { translationId: number; author: string; type: string; reported: number; actual: number }
  >()

  ipcMain.handle(
    CHANNELS.REPORT_QUALITY_MISMATCH,
    (
      _event,
      data: {
        translationId: number
        author: string
        type: string
        reported: number
        actual: number
      }
    ) => {
      qualityMismatches.set(data.translationId, data)
    }
  )

  ipcMain.handle(CHANNELS.GET_QUALITY_MISMATCH_COUNT, () => {
    return qualityMismatches.size
  })

  ipcMain.handle(CHANNELS.DEBUG_GET_MP4_STATS, () => {
    return store.get('mp4StreamingStats') as Mp4StreamingStats
  })

  ipcMain.handle(CHANNELS.DEBUG_RESET_MP4_STATS, () => {
    store.set('mp4StreamingStats', { totalChecked: 0, faststartCount: 0, nonFaststartSamples: [] })
    mp4FaststartChecked.clear()
  })

  ipcMain.handle(CHANNELS.DUMP_QUALITY_MISMATCHES, () => {
    const outPath = path.join(coldStorageService.getDownloadDir(), 'quality-mismatches.json')
    const data = [...qualityMismatches.values()]
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2))
    console.log(`[debug] Wrote ${data.length} quality mismatches to ${outPath}`)
    return { count: data.length, path: outPath }
  })

  ipcMain.handle(CHANNELS.GET_SETTING, (_event, key: string) => {
    if (key === 'downloadDir') return coldStorageService.getDownloadDir()
    return store.get(key)
  })

  ipcMain.handle(CHANNELS.SET_SETTING, (_event, key: string, value: unknown) => {
    store.set(key, value)
  })

  // Watch progress tracking
  ipcMain.handle(
    CHANNELS.WATCH_PROGRESS_SAVE,
    (
      _event,
      animeId: number,
      episodeInt: string,
      position: number,
      duration: number,
      watched?: boolean,
      translationId?: number
    ) => {
      const all = store.get('watchProgress') as Record<
        string,
        {
          position: number
          duration: number
          updatedAt: number
          watched?: boolean
          watchedAt?: number
          translationId?: number
        }
      >
      const key = `${animeId}:${episodeInt}`
      const prev = all[key]
      const nowWatched = watched || prev?.watched || false
      const justWatched = nowWatched && !prev?.watched
      all[key] = {
        position,
        duration,
        updatedAt: Date.now(),
        watched: nowWatched,
        watchedAt: justWatched ? Date.now() : prev?.watchedAt,
        translationId: translationId !== undefined ? translationId : prev?.translationId
      }
      store.set('watchProgress', all)
    }
  )

  ipcMain.handle(CHANNELS.WATCH_PROGRESS_GET, (_event, animeId: number, episodeInt: string) => {
    const all = store.get('watchProgress') as Record<
      string,
      {
        position: number
        duration: number
        updatedAt: number
        watched?: boolean
        watchedAt?: number
        translationId?: number
      }
    >
    return all[`${animeId}:${episodeInt}`] || null
  })

  ipcMain.handle(CHANNELS.WATCH_PROGRESS_GET_ALL, (_event, animeId: number) => {
    const all = store.get('watchProgress') as Record<
      string,
      {
        position: number
        duration: number
        updatedAt: number
        watched?: boolean
        watchedAt?: number
        translationId?: number
      }
    >
    const prefix = `${animeId}:`
    const out: Record<
      string,
      {
        position: number
        duration: number
        updatedAt: number
        watched?: boolean
        watchedAt?: number
        translationId?: number
      }
    > = {}
    for (const [key, val] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        out[key.slice(prefix.length)] = val
      }
    }
    return out
  })

  // File management handlers
  ipcMain.handle(
    CHANNELS.FILE_CHECK_EPISODES,
    (_event, animeName: string, episodeInts: string[]) => {
      const cached = fileCheckCache.get(animeName)
      if (cached) {
        backgroundRescan(animeName).catch((err) => console.error('Background rescan failed:', err))
        return filterScanResult(cached, animeName, episodeInts)
      }

      const fullResult = scanEpisodeFiles(animeName)
      fileCheckCache.set(animeName, fullResult)
      return filterScanResult(fullResult, animeName, episodeInts)
    }
  )

  ipcMain.handle(CHANNELS.FILE_OPEN, async (_event, filePath: string) => {
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

  ipcMain.handle(CHANNELS.FILE_SHOW_IN_FOLDER, (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle(
    CHANNELS.FILE_DELETE_EPISODE,
    (_event, animeName: string, episodeInt: string, animeId?: number, translationId?: number) => {
      coldStorageService.deleteEpisodeFiles(animeName, episodeInt, animeId, translationId)
      if (animeId && animeId > 0) {
        skipAnalysisService.pruneCacheForEpisode(animeId, episodeInt)
        skipAnalysisService.dropDetectionsForEpisode(animeId, episodeInt)
      }
    }
  )

  ipcMain.handle(CHANNELS.STORAGE_PICK_HOT_DIR, async () => {
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

  ipcMain.handle(CHANNELS.STORAGE_PICK_COLD_DIR, async () => {
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

  ipcMain.handle(CHANNELS.STORAGE_MOVE_TO_COLD, async () => {
    fileCheckCache.clear()
    const result = await coldStorageService.moveAllFilesToColdStorage((current, total, file) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(EVENT_CHANNELS.STORAGE_MOVE_TO_COLD_PROGRESS, { current, total, file })
      }
    })
    return result
  })

  ipcMain.handle(CHANNELS.STORAGE_GET_USAGE, async () => {
    return coldStorageService.scanUsage()
  })

  ipcMain.handle(CHANNELS.STORAGE_RUN_CLEANUP, async (_event, opts?: { force?: boolean }) => {
    return coldStorageService.runWatchedCleanup(!!opts?.force)
  })

  ipcMain.handle(CHANNELS.SHELL_OPEN_EXTERNAL, async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(CHANNELS.SHELL_OPEN_EXTERNAL_FILE, async (_event, filePath: string) => {
    try {
      const err = await shell.openPath(filePath)
      return { ok: err === '', error: err || undefined }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    CHANNELS.PLAYER_GET_STREAM_URL,
    async (_event, translationId: number, maxHeight: number) => {
      try {
        const embed = await smotretApi.getEmbed(translationId)
        const streams = embed.stream || []
        if (streams.length === 0) return null
        const sorted = [...streams].sort((a, b) => b.height - a.height)
        const best = sorted.find((s) => s.height <= maxHeight) || sorted[0]
        const streamUrl = best && best.urls.length > 0 ? best.urls[0] : null
        if (!streamUrl) return null

        // Build list of all available streams for quality selector
        const availableStreams = sorted
          .filter((s) => s.urls.length > 0)
          .map((s) => ({ height: s.height, url: s.urls[0] }))

        // Fetch raw ASS subtitle content if available (rendered natively by JASSUB in the player)
        let subtitleContent: string | null = null
        if (embed.subtitlesUrl) {
          subtitleContent = await smotretApi.fetchSubtitleContent(translationId)
        }

        return { streamUrl, subtitleContent, availableStreams }
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(CHANNELS.PLAYER_GET_LOCAL_SUBTITLES, async (_event, filePath: string) => {
    const assPath = filePath.replace(/\.(mp4|mkv)$/i, '.ass')
    try {
      if (fs.existsSync(assPath)) {
        return fs.readFileSync(assPath, 'utf-8')
      }
    } catch {
      /* ignore */
    }
    return null
  })

  ipcMain.handle(
    CHANNELS.PLAYER_FIND_LOCAL_FILE,
    async (
      _event,
      animeName: string,
      episodeInt: string,
      translationId: number,
      episodeLabel: string
    ) => {
      const episodes = store.get('downloadedEpisodes') as Record<
        string,
        { translationType: string; author: string; quality: number; translationId: number }
      >
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

      const dirsToCheck = [coldStorageService.getDownloadDir()]
      if (coldStorageService.isAdvanced()) {
        const coldDir = coldStorageService.getColdStorageDir()
        if (coldDir) dirsToCheck.push(coldDir)
      }

      const onResolved = (fp: string): void => {
        if (fp.toLowerCase().endsWith('.mp4')) {
          // animeId is 0 here because this handler only receives animeName; resolving
          // back to an id would require scanning recentAnimeMeta. The stats sample is
          // for human inspection (anime title + episode + filepath), so the missing
          // id is acceptable.
          void recordMp4FaststartCheck(fp, {
            animeId: 0,
            animeName,
            episodeInt,
            episodeLabel
          })
        }
      }

      for (const dir of dirsToCheck) {
        const animeDir = path.join(dir, animeDirName)
        // Try tagged filename first
        for (const ext of ['.mkv', '.mp4']) {
          const fp = path.join(animeDir, `${taggedBase}${ext}`)
          if (fs.existsSync(fp)) {
            const subtitleContent = await (async () => {
              const assPath = fp.replace(/\.(mp4|mkv)$/i, '.ass')
              try {
                return fs.existsSync(assPath) ? fs.readFileSync(assPath, 'utf-8') : null
              } catch {
                return null
              }
            })()
            onResolved(fp)
            return { filePath: fp, subtitleContent }
          }
        }
        // Try legacy filename
        for (const ext of ['.mkv', '.mp4']) {
          const fp = path.join(animeDir, `${base}${ext}`)
          if (fs.existsSync(fp)) {
            const subtitleContent = await (async () => {
              const assPath = fp.replace(/\.(mp4|mkv)$/i, '.ass')
              try {
                return fs.existsSync(assPath) ? fs.readFileSync(assPath, 'utf-8') : null
              } catch {
                return null
              }
            })()
            onResolved(fp)
            return { filePath: fp, subtitleContent }
          }
        }
      }
      return null
    }
  )

  // Remux MKV to fragmented MP4 (stream copy) for progressive HTML5 playback.
  // See protocol.handle('anime-video', …) below for the streaming reader.
  ipcMain.handle(
    CHANNELS.PLAYER_REMUX_MKV,
    async (
      _event,
      mkvPath: string
    ): Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }> => {
      if (!ffmpegPath) return { error: 'ffmpeg not available' }
      if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

      fs.mkdirSync(streamingService.tmpDir, { recursive: true })

      const stamp = Date.now()
      const baseName = path.basename(mkvPath, path.extname(mkvPath))
      const mp4Path = path.join(streamingService.tmpDir, `${baseName}-${stamp}.mp4`)

      Ffmpeg.setFfmpegPath(ffmpegPath)

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

      const subtitlePromise = extractFirstSubtitle(
        mkvPath,
        path.join(streamingService.tmpDir, `${baseName}-${stamp}.ass`)
      )

      try {
        const [, subtitleContent] = await Promise.all([remuxPromise, subtitlePromise])
        return { mp4Path, ...(subtitleContent ? { subtitleContent } : {}) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  // Start an MSE-friendly fragmented MP4 pipe. Returns duration + codecs MIME so the
  // renderer can set MediaSource.duration and addSourceBuffer(mimeType) upfront.
  // Video bytes are pushed to the renderer via 'player:stream-chunk' events.
  ipcMain.handle(
    CHANNELS.PLAYER_REMUX_MKV_STREAM,
    async (
      event,
      mkvPath: string,
      initialSeek?: number
    ): Promise<MseOpenResult | { error: string }> => {
      if (!ffmpegPath) return { error: 'ffmpeg not available' }
      if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

      const probe = await streamingService.probeMkvForMse(mkvPath)
      if (!probe || !probe.streamCopyMimeType) return { error: 'Codecs not supported for MSE' }
      const streamCopyMime = probe.streamCopyMimeType

      fs.mkdirSync(streamingService.tmpDir, { recursive: true })

      const sessionId = randomUUID()
      const baseName = path.basename(mkvPath, path.extname(mkvPath))

      const session: MseSession = {
        proc: null as unknown as ChildProcess,
        pendingBytes: 0,
        stderrTail: [],
        done: false,
        error: null,
        senderId: event.sender.id,
        ready: false,
        prelude: [],
        mkvPath,
        generation: 0,
        videoCodec: probe.videoCodec,
        transcode: false,
        audioStrategy: 'copy',
        h264Encoder: null
      }
      streamingService.registerSession(sessionId, session)
      const requestedSeek =
        typeof initialSeek === 'number' && isFinite(initialSeek) && initialSeek > 0
          ? initialSeek
          : 0
      const startSeek =
        requestedSeek > 0 ? await streamingService.findKeyframeBefore(mkvPath, requestedSeek) : 0
      console.log(
        `[remux-stream] open session ${sessionId.slice(0, 8)} codec=${probe.videoCodec} mime="${streamCopyMime}" requested=${requestedSeek.toFixed(2)} keyframe=${startSeek.toFixed(2)}`
      )
      session.proc = streamingService.spawnFfmpegForSession(session, event, sessionId, startSeek)

      // Kick off subtitle extraction in parallel; push to renderer when ready.
      const assPath = path.join(streamingService.tmpDir, `${baseName}-${sessionId}.ass`)
      let hasSubtitlesPending = false
      try {
        if (ffprobePath) {
          Ffmpeg.setFfprobePath(ffprobePath)
          hasSubtitlesPending = await new Promise<boolean>((res) => {
            Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
              res(err ? false : !!metadata.streams?.find((s) => s.codec_type === 'subtitle'))
            })
          })
        }
      } catch {
        /* ignore probe failures */
      }

      if (hasSubtitlesPending) {
        extractFirstSubtitle(mkvPath, assPath)
          .then((content) => {
            if (!content) return
            const sender = event.sender
            if (sender && !sender.isDestroyed()) {
              sender.send(EVENT_CHANNELS.PLAYER_STREAM_SUBTITLES, { sessionId, content })
            }
          })
          .catch(() => {
            /* already logged */
          })
      }

      return {
        sessionId,
        generation: session.generation,
        duration: probe.duration,
        mimeType: streamCopyMime,
        hasSubtitlesPending,
        initialSeek: startSeek
      }
    }
  )

  // Same as `player:remux-mkv-stream` but re-encodes video to H.264 on the fly.
  // Used when the platform has no decoder for the source codec (typically HEVC
  // on Linux without VA-API). Audio is copied when AAC, otherwise transcoded
  // to AAC so MSE can play it.
  ipcMain.handle(
    CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE,
    async (
      event,
      mkvPath: string,
      initialSeek?: number
    ): Promise<MseOpenResult | { error: string }> => {
      if (!ffmpegPath) return { error: 'ffmpeg not available' }
      if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

      const probe = await streamingService.probeMkvForMse(mkvPath)
      if (!probe) return { error: 'Probe failed' }

      fs.mkdirSync(streamingService.tmpDir, { recursive: true })

      const encoder = await streamingService.pickH264Encoder()
      // When the audio is being stream-copied, reflect its actual AAC object type
      // (mp4a.40.2 / .5 / .29) in the mime — otherwise MediaSource.isTypeSupported
      // will reject a perfectly valid HE-AAC stream. When we transcode audio we
      // force LC AAC, so mp4a.40.2 is always correct on that branch.
      const audioCodecForMime =
        probe.audioStrategy === 'copy' && probe.audioCodecString
          ? probe.audioCodecString
          : 'mp4a.40.2'
      const mimeType = `video/mp4; codecs="avc1.640028, ${audioCodecForMime}"`

      const sessionId = randomUUID()
      const baseName = path.basename(mkvPath, path.extname(mkvPath))

      const session: MseSession = {
        proc: null as unknown as ChildProcess,
        pendingBytes: 0,
        stderrTail: [],
        done: false,
        error: null,
        senderId: event.sender.id,
        ready: false,
        prelude: [],
        mkvPath,
        generation: 0,
        videoCodec: probe.videoCodec,
        transcode: true,
        audioStrategy: probe.audioStrategy,
        h264Encoder: encoder.name
      }
      streamingService.registerSession(sessionId, session)
      const requestedSeek =
        typeof initialSeek === 'number' && isFinite(initialSeek) && initialSeek > 0
          ? initialSeek
          : 0
      const startSeek =
        requestedSeek > 0 ? await streamingService.findKeyframeBefore(mkvPath, requestedSeek) : 0
      console.log(
        `[remux-stream] open TRANSCODE session ${sessionId.slice(0, 8)} encoder=${encoder.name} audio=${probe.audioStrategy} mime="${mimeType}" requested=${requestedSeek.toFixed(2)} keyframe=${startSeek.toFixed(2)}`
      )
      session.proc = streamingService.spawnFfmpegForSession(session, event, sessionId, startSeek)

      const assPath = path.join(streamingService.tmpDir, `${baseName}-${sessionId}.ass`)
      let hasSubtitlesPending = false
      try {
        if (ffprobePath) {
          Ffmpeg.setFfprobePath(ffprobePath)
          hasSubtitlesPending = await new Promise<boolean>((res) => {
            Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
              res(err ? false : !!metadata.streams?.find((s) => s.codec_type === 'subtitle'))
            })
          })
        }
      } catch {
        /* ignore */
      }

      if (hasSubtitlesPending) {
        extractFirstSubtitle(mkvPath, assPath)
          .then((content) => {
            if (!content) return
            const sender = event.sender
            if (sender && !sender.isDestroyed()) {
              sender.send(EVENT_CHANNELS.PLAYER_STREAM_SUBTITLES, { sessionId, content })
            }
          })
          .catch(() => {
            /* already logged */
          })
      }

      return {
        sessionId,
        generation: session.generation,
        duration: probe.duration,
        mimeType,
        hasSubtitlesPending,
        initialSeek: startSeek
      }
    }
  )

  // Forward seek past the buffered region: respawn ffmpeg with `-ss` so output
  // starts at (or just before) the requested timestamp. The renderer will have
  // already set sourceBuffer.timestampOffset to place fragments on the correct
  // MSE timeline position. Stale chunks from the old proc are filtered out by
  // the generation counter captured in spawnFfmpegForSession.
  ipcMain.handle(
    CHANNELS.PLAYER_STREAM_SEEK,
    async (event, sessionId: string, seekSeconds: number) => {
      const session = streamingService.getSession(sessionId)
      if (!session) return { error: 'session not found' }
      const requestedSeek = Math.max(0, seekSeconds)
      const keyframeTime =
        requestedSeek > 0
          ? await streamingService.findKeyframeBefore(session.mkvPath, requestedSeek)
          : 0
      session.generation++
      try {
        session.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      session.pendingBytes = 0
      session.prelude = []
      session.done = false
      session.error = null
      // Hold new chunks in the prelude until the renderer has set its
      // SourceBuffer.timestampOffset and called player:stream-start again.
      // Otherwise first frames of the new run race ahead of the offset change
      // and get placed on the wrong MSE timeline.
      session.ready = false
      if (session.proc.stdout && session.proc.stdout.isPaused()) {
        try {
          session.proc.stdout.resume()
        } catch {
          /* ignore */
        }
      }
      session.proc = streamingService.spawnFfmpegForSession(session, event, sessionId, keyframeTime)
      return { ok: true, generation: session.generation, keyframeTime }
    }
  )

  // Handshake: renderer's MediaSource + SourceBuffer are ready to receive chunks.
  // Flush any buffered prelude (the MP4 moov header lives in here) and switch to
  // forwarding subsequent chunks directly.
  ipcMain.handle(CHANNELS.PLAYER_STREAM_START, (event, sessionId: string) => {
    const session = streamingService.getSession(sessionId)
    if (!session) return
    if (session.ready) return
    session.ready = true
    const sender = event.sender
    if (sender && !sender.isDestroyed()) {
      const gen = session.generation
      for (const chunk of session.prelude) {
        sender.send(EVENT_CHANNELS.PLAYER_STREAM_CHUNK, { sessionId, gen, data: chunk })
      }
    }
    session.prelude = []
  })

  // Backpressure ack: renderer reports bytes it has appended into its SourceBuffer.
  // When enough data has been consumed we resume the ffmpeg stdout pipe.
  ipcMain.handle(CHANNELS.PLAYER_STREAM_ACK, (_event, sessionId: string, bytesConsumed: number) => {
    const session = streamingService.getSession(sessionId)
    if (!session) return
    session.pendingBytes = Math.max(0, session.pendingBytes - bytesConsumed)
    if (session.pendingBytes < streamingService.lowWatermark && session.proc.stdout?.isPaused()) {
      session.proc.stdout.resume()
    }
  })

  ipcMain.handle(CHANNELS.PLAYER_CLEANUP_REMUX, async () => {
    for (const sessionId of streamingService.allSessionIds()) {
      streamingService.cleanupSession(sessionId)
    }
    try {
      if (fs.existsSync(streamingService.tmpDir)) {
        const files = fs.readdirSync(streamingService.tmpDir)
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(streamingService.tmpDir, file))
          } catch {
            /* ignore */
          }
        }
        try {
          fs.rmdirSync(streamingService.tmpDir)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_CONNECT, (_event, cfg: SyncplayConfig) => {
    const persisted = store.get('syncplay')
    store.set('syncplay', {
      ...persisted,
      lastHost: cfg.host,
      lastPort: cfg.port,
      lastRoom: cfg.room,
      username: cfg.username,
      autoReconnect: Boolean(cfg.autoReconnect)
    })
    syncplay.connect(cfg)
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_DISCONNECT, () => {
    syncplay.disconnect()
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_SET_FILE, (_event, file: SyncplayFileInfo) => {
    syncplay.setFile(file)
  })

  ipcMain.handle(
    CHANNELS.SYNCPLAY_LOCAL_STATE,
    (_event, payload: { paused: boolean; position: number; cause: 'play' | 'pause' | 'seek' }) => {
      syncplay.sendLocalState(payload)
    }
  )

  ipcMain.handle(
    CHANNELS.SYNCPLAY_LOCAL_SNAPSHOT,
    (_event, snap: { position: number; paused: boolean }) => {
      syncplay.updateSnapshot(snap)
    }
  )

  ipcMain.handle(CHANNELS.SYNCPLAY_SET_READY, (_event, isReady: boolean) => {
    syncplay.setReady(isReady)
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_GET_STATUS, () => syncplay.getStatus())

  // Auto-downloader
  ipcMain.handle(CHANNELS.AUTO_DL_GET_SUBSCRIPTION, (_event, animeId: number) => {
    return autoDlGetSubscription(animeId)
  })

  ipcMain.handle(
    CHANNELS.AUTO_DL_SET_SUBSCRIPTION,
    async (
      _event,
      animeId: number,
      enabled: boolean,
      meta?: { malId: number; animeName: string }
    ) => {
      const sub = await autoDlSetSubscription(animeId, enabled, meta)
      if (enabled && sub) {
        // Fire a tick shortly after subscribing so the user sees the system catch up
        // (forward-only stamp ensures nothing backfills, this just exercises the path).
        setTimeout(() => {
          void runAutoDownloadTick('manual')
        }, 1000)
      }
      return sub
    }
  )

  ipcMain.handle(CHANNELS.AUTO_DL_LIST_SUBSCRIPTIONS, () => autoDlListSubscriptions())

  ipcMain.handle(CHANNELS.AUTO_DL_TRIGGER, async () => {
    return runAutoDownloadTick('manual')
  })

  ipcMain.handle(CHANNELS.AUTO_DL_GET_STATUS, () => getAutoDownloaderStatus())

  ipcMain.handle(CHANNELS.AUTO_DL_GET_ENABLED, () => Boolean(store.get('autoDownloadEnabled')))

  ipcMain.handle(CHANNELS.AUTO_DL_SET_ENABLED, (_event, enabled: boolean) => {
    store.set('autoDownloadEnabled', Boolean(enabled))
    return Boolean(enabled)
  })
}

async function extractFirstSubtitle(mkvPath: string, assPath: string): Promise<string | undefined> {
  try {
    if (!ffmpegPath || !ffprobePath) return undefined
    // fluent-ffmpeg resolves the ffmpeg binary from PATH unless setFfmpegPath
    // was called. On Windows the ffbinaries-downloaded ffmpeg is not on PATH,
    // so this must be set explicitly here even if setFfprobePath was called.
    Ffmpeg.setFfmpegPath(ffmpegPath)
    Ffmpeg.setFfprobePath(ffprobePath)
    const hasSubStream = await new Promise<boolean>((res) => {
      Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
        res(err ? false : !!metadata.streams?.find((s) => s.codec_type === 'subtitle'))
      })
    })
    if (!hasSubStream) return undefined
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
    fileCheckCache.delete(animeName)

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
    if (autoMerge && ffmpegInfo.available && ffmpegPath) {
      const codec = (store.get('videoCodec') as string) || 'copy'
      await downloadManager.mergeCompleted(ffmpegPath, ffprobePath, codec)
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
    fileCheckCache.delete(animeName)
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
    void recordMp4FaststartCheck(filePath, {
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
      downloadManager?.destroy()
      syncplay.disconnect()
    }
  })
  .catch((err) => {
    console.error('[app] startup failed:', err)
    app.exit(1)
  })
