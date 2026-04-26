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
import { execFile, spawn, type ChildProcess } from 'child_process'
import * as os from 'os'
import Ffmpeg from 'fluent-ffmpeg'
import { autoUpdater } from 'electron-updater'
import * as shikimori from './shikimori'
import { pathToFileURL } from 'url'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { SmotretApi } from './smotret-api'
import type { AnimeSearchResult, AnimeDetail, EpisodeSummary, EpisodeDetail, Translation } from './smotret-api'

// Enable WebGPU (Anime4K shaders) and platform HEVC decoding (HEVC MKV via MSE).
// PlatformHEVCDecoderSupport gates Chromium's HEVC path in <video> and MSE;
// without it, MediaSource.isTypeSupported('…hvc1…') returns false even on
// systems that have a hardware decoder available.
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('enable-features', 'Vulkan,PlatformHEVCDecoderSupport')

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
    watchProgress: {} as Record<string, { position: number; duration: number; updatedAt: number; watched?: boolean }>,
    shikimoriUserRates: [] as unknown[],
    shikimoriUpdateQueue: [] as unknown[],
    shikimoriAnimeDetails: {} as Record<string, { details: shikimori.ShikiAnimeDetails; fetchedAt: number }>,
    recentAnimeMeta: {} as Record<string, AnimeSearchResult>
  }
})

function broadcastToAll(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
])

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  if (err && typeof err === 'object' && 'cause' in err) {
    return errorCode((err as { cause: unknown }).cause)
  }
  return undefined
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof shikimori.ShikiApiError) return false
  if (err instanceof TypeError) return true
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true
  const code = errorCode(err)
  if (code && NETWORK_ERROR_CODES.has(code)) return true
  return false
}

interface QueuedShikimoriUpdate {
  malId: number
  rateId: number | null
  before: { episodes: number; status: shikimori.ShikiUserRateStatus; score: number }
  after: { episodes: number; status: shikimori.ShikiUserRateStatus; score: number }
  queuedAt: number
}

type ShikiSyncState = 'idle' | 'syncing'
interface ShikiSyncStatus {
  state: ShikiSyncState
  queueLength: number
  lastSyncAt: number
  lastSyncError: string | null
}

const SYNC_TIMER_MS = 60_000
const SYNC_ITEM_DELAY_MS = 250

const STATUS_ORDER: Record<shikimori.ShikiUserRateStatus, number> = {
  planned: 0,
  watching: 1,
  rewatching: 1,
  on_hold: 2,
  dropped: 2,
  completed: 3
}

let syncInProgress = false
let syncTimer: NodeJS.Timeout | null = null
let lastSyncAt = 0
let lastSyncError: string | null = null

const PREFETCH_INTER_REQUEST_MS = 2000
const PREFETCH_STALENESS_MS = 30 * 24 * 60 * 60 * 1000
const PREFETCH_STATUSES = new Set<shikimori.ShikiUserRateStatus>(['watching', 'planned'])

let prefetchInProgress = false
let prefetchAbort = false

function getQueueLength(): number {
  return (store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]).length
}

function getSyncStatus(): ShikiSyncStatus {
  return {
    state: syncInProgress ? 'syncing' : 'idle',
    queueLength: getQueueLength(),
    lastSyncAt,
    lastSyncError
  }
}

function broadcastSyncStatus(): void {
  broadcastToAll('shikimori:sync-status', getSyncStatus())
}

function startSyncTimer(): void {
  if (syncTimer) return
  syncTimer = setInterval(() => {
    void syncShikimoriQueue()
  }, SYNC_TIMER_MS)
}

function stopSyncTimer(): void {
  if (!syncTimer) return
  clearInterval(syncTimer)
  syncTimer = null
}

function adjustSyncTimer(): void {
  if (getQueueLength() > 0) startSyncTimer()
  else stopSyncTimer()
}

interface ConsolidatedWorkItem extends QueuedShikimoriUpdate {
  consumedQueuedAts: number[]
}

function consolidateQueue(queue: QueuedShikimoriUpdate[]): ConsolidatedWorkItem[] {
  const map = new Map<number, ConsolidatedWorkItem>()
  for (const entry of queue) {
    const existing = map.get(entry.malId)
    if (existing) {
      existing.after = entry.after
      existing.rateId = entry.rateId ?? existing.rateId
      existing.consumedQueuedAts.push(entry.queuedAt)
    } else {
      map.set(entry.malId, { ...entry, consumedQueuedAts: [entry.queuedAt] })
    }
  }
  return Array.from(map.values())
}

function dropConsumedEntries(malId: number, consumedQueuedAts: number[]): number {
  const consumed = new Set(consumedQueuedAts)
  const queue = (store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]).filter(
    (q) => !(q.malId === malId && consumed.has(q.queuedAt))
  )
  store.set('shikimoriUpdateQueue', queue)
  broadcastToAll('shikimori:offline-queue-changed', { length: queue.length })
  return queue.length
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function reconcileCacheFromRate(malId: number, rate: shikimori.ShikiUserRate): void {
  const cached = store.get('shikimoriUserRates') as {
    rate: Record<string, unknown> & { id?: number; target_id: number; episodes: number; status: shikimori.ShikiUserRateStatus; score: number }
    shikiAnime: unknown
    smotretAnime: unknown
  }[]
  const idx = cached.findIndex((e) => e.rate.target_id === malId)
  if (idx === -1) return
  cached[idx] = {
    ...cached[idx],
    rate: {
      ...cached[idx].rate,
      id: rate.id,
      episodes: rate.episodes,
      status: rate.status,
      score: rate.score,
      updated_at: new Date().toISOString()
    }
  }
  store.set('shikimoriUserRates', cached)
  broadcastToAll('shikimori:rate-updated', cached[idx])
}

function shouldApplyOnDrift(
  current: shikimori.ShikiUserRate,
  after: { episodes: number; status: shikimori.ShikiUserRateStatus; score: number }
): boolean {
  if (after.episodes <= current.episodes) return false
  const currentRank = STATUS_ORDER[current.status]
  const afterRank = STATUS_ORDER[after.status]
  if (currentRank > afterRank) return false
  // Same rank but different value (watching ↔ rewatching) is a user-meaningful side-grade,
  // not pure episode progress — treat as drift and let the server value win
  if (currentRank === afterRank && current.status !== after.status) return false
  return true
}

async function syncShikimoriQueue(): Promise<void> {
  if (syncInProgress) return
  const queue = store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]
  if (queue.length === 0) {
    stopSyncTimer()
    return
  }
  const creds = store.get('shikimoriCredentials') as shikimori.ShikiCredentials | null
  const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
  if (!creds || !user) return

  syncInProgress = true
  broadcastSyncStatus()

  let accessToken: string
  try {
    accessToken = await shikimori.ensureFreshToken(store)
  } catch (err) {
    syncInProgress = false
    if (!isNetworkError(err)) {
      lastSyncError = err instanceof Error ? err.message : String(err)
      console.warn('[shikimori sync] auth refresh failed:', err)
    }
    broadcastSyncStatus()
    return
  }

  const work = consolidateQueue(queue)
  let aborted = false

  for (const item of work) {
    try {
      const current = await shikimori.getUserRate(accessToken, user.id, item.malId)

      if (!current) {
        const created = await shikimori.createUserRate(
          accessToken,
          user.id,
          item.malId,
          item.after.episodes,
          item.after.status,
          item.after.score
        )
        reconcileCacheFromRate(item.malId, created)
      } else {
        const driftMatches =
          current.episodes === item.before.episodes &&
          current.status === item.before.status &&
          current.score === item.before.score

        if (driftMatches) {
          const updated = await shikimori.updateUserRate(
            accessToken,
            current.id,
            item.after.episodes,
            item.after.status,
            item.after.score
          )
          reconcileCacheFromRate(item.malId, updated)
        } else if (shouldApplyOnDrift(current, item.after)) {
          const updated = await shikimori.updateUserRate(
            accessToken,
            current.id,
            item.after.episodes,
            item.after.status,
            item.after.score
          )
          reconcileCacheFromRate(item.malId, updated)
        } else {
          reconcileCacheFromRate(item.malId, current)
        }
      }

      dropConsumedEntries(item.malId, item.consumedQueuedAts)
    } catch (err) {
      if (isNetworkError(err)) {
        aborted = true
        break
      }
      if (err instanceof shikimori.ShikiApiError && (err.status === 401 || err.status === 403)) {
        aborted = true
        lastSyncError = err.message
        console.warn('[shikimori sync] auth error, stopping drain:', err)
        break
      }
      console.warn('[shikimori sync] dropping item', item.malId, err)
      dropConsumedEntries(item.malId, item.consumedQueuedAts)
    }

    if (work.indexOf(item) < work.length - 1) await sleep(SYNC_ITEM_DELAY_MS)
  }

  syncInProgress = false
  if (!aborted) {
    lastSyncAt = Date.now()
    lastSyncError = null
  }
  adjustSyncTimer()
  broadcastSyncStatus()
}

function getStaleOrMissingMalIds(): number[] {
  const rates = store.get('shikimoriUserRates') as {
    rate: { target_id?: number; status: shikimori.ShikiUserRateStatus }
    shikiAnime?: { id?: number }
  }[]
  const cache = store.get('shikimoriAnimeDetails') as Record<
    string,
    { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
  >
  const now = Date.now()
  const result: number[] = []
  for (const entry of rates) {
    if (!PREFETCH_STATUSES.has(entry.rate.status)) continue
    const malId = entry.rate.target_id ?? entry.shikiAnime?.id
    if (typeof malId !== 'number' || !Number.isFinite(malId) || malId <= 0) continue
    const cached = cache[String(malId)]
    if (!cached || now - cached.fetchedAt > PREFETCH_STALENESS_MS) {
      result.push(malId)
    }
  }
  return result
}

async function prefetchShikimoriDetails(): Promise<void> {
  if (prefetchInProgress) return
  const creds = store.get('shikimoriCredentials') as shikimori.ShikiCredentials | null
  const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
  if (!creds || !user) return

  const work = getStaleOrMissingMalIds()
  if (work.length === 0) return

  prefetchInProgress = true
  prefetchAbort = false

  try {
    let accessToken: string
    try {
      accessToken = await shikimori.ensureFreshToken(store)
    } catch (err) {
      if (!isNetworkError(err)) {
        console.warn('[shikimori prefetch] auth refresh failed:', err)
      }
      return
    }

    for (let i = 0; i < work.length; i++) {
      if (prefetchAbort) break
      const malId = work[i]
      try {
        const details = await shikimori.getAnimeDetails(accessToken, malId)
        const cache = store.get('shikimoriAnimeDetails') as Record<
          string,
          { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
        >
        cache[String(malId)] = { details, fetchedAt: Date.now() }
        store.set('shikimoriAnimeDetails', cache)
        broadcastToAll('shikimori:anime-details-updated', { malId, details })
      } catch (err) {
        if (isNetworkError(err)) {
          console.warn('[shikimori prefetch] network error, aborting loop:', err)
          break
        }
        if (
          err instanceof shikimori.ShikiApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          console.warn('[shikimori prefetch] auth error, aborting loop:', err)
          break
        }
        if (err instanceof shikimori.ShikiApiError && err.status === 404) {
          console.warn('[shikimori prefetch] anime', malId, 'not found, skipping')
        } else {
          console.warn('[shikimori prefetch] error fetching', malId, err)
        }
      }
      if (i < work.length - 1) {
        await sleep(PREFETCH_INTER_REQUEST_MS)
      }
    }
  } finally {
    prefetchInProgress = false
  }
}

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

function storageDirsForScan(): string[] {
  const dirs = [getDownloadDir()]
  if (isAdvancedStorage()) {
    const cold = getColdStorageDir()
    if (cold) dirs.push(cold)
  }
  return dirs
}

// Drops `downloadedEpisodes[animeId:episodeInt:translationId]` (and the legacy
// `animeId:episodeInt` key if it points at the same translation) when no file
// for that translation exists on disk. Called after cancel / cancel-by-episode.
function pruneDownloadedEpisode(animeId: number, episodeInt: string, translationId: number, animeName: string, author: string): void {
  if (episodeFileExists(animeName, episodeInt, author)) return
  const episodes = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>
  const key = `${animeId}:${episodeInt}:${translationId}`
  const legacyKey = `${animeId}:${episodeInt}`
  let changed = false
  if (key in episodes) {
    delete episodes[key]
    changed = true
  }
  if (episodes[legacyKey]?.translationId === translationId) {
    delete episodes[legacyKey]
    changed = true
  }
  if (changed) store.set('downloadedEpisodes', episodes)
}

// Returns true iff a .mkv or .mp4 for (animeName, episodeInt, author) exists in any storage dir.
// Used to validate `downloadedEpisodes` metadata against the filesystem.
function episodeFileExists(animeName: string, episodeInt: string, author: string): boolean {
  const animeDirName = sanitizeFilename(animeName)
  const padded = episodeInt.padStart(2, '0')
  const base = sanitizeFilename(`${animeName} - ${padded}`)
  const authorTag = sanitizeFilename(author || '')
  const taggedBase = authorTag ? `${base} [${authorTag}]` : base
  for (const dir of storageDirsForScan()) {
    const animeDir = path.join(dir, animeDirName)
    for (const candidate of [`${taggedBase}.mkv`, `${taggedBase}.mp4`, `${base}.mkv`, `${base}.mp4`]) {
      if (fs.existsSync(path.join(animeDir, candidate))) return true
    }
  }
  return false
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
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 5000)
          )
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
      rememberAnimeMeta(result.data)
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

  ipcMain.handle('home:get-continue-watching', async () => {
    const lib = store.get('library') as Record<string, AnimeSearchResult>
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const malMap = store.get('malIdMap') as Record<string, AnimeSearchResult>
    const cache = store.get('animeCache') as Record<string, AnimeCacheEntry>
    const recent = store.get('recentAnimeMeta') as Record<string, AnimeSearchResult>

    function localResolve(animeId: number, malId?: number): AnimeSearchResult | null {
      const idKey = String(animeId)
      return lib[idKey] || downloaded[idKey] || recent[idKey] || (malId ? malMap[String(malId)] : null) || null
    }

    function entryToNamePoster(entry: AnimeSearchResult | null, fallbackName?: string): { name: string; poster: string } {
      if (!entry) return { name: fallbackName || '', poster: '' }
      return { name: entry.titles?.ru || entry.titles?.romaji || entry.title || '', poster: entry.posterUrlSmall || '' }
    }

    // smotret-anime episodes for some shows lead with a `preview`/trailer entry
    // that shares `episodeInt` with the real episode (see e.g. Guimi Zhi Zhu:
    // Xiaochou Pian, smotret id 34496). AnimeDetailView already filters these
    // out with `episodeType !== 'preview'`; mirror that here so HomeView labels
    // don't say "Трейлер" instead of "Episode 1".
    function isContentEpisode(ep: EpisodeSummary): boolean {
      return ep.episodeType !== 'preview'
    }

    function episodeLabelFor(animeId: number, episodeInt: string): string {
      const entry = cache[String(animeId)]
      const ep = entry?.animeDetail?.episodes?.find(
        (e) => e.episodeInt === episodeInt && isContentEpisode(e)
      )
      return ep?.episodeFull || `Episode ${episodeInt}`
    }

    type Entry = {
      kind: 'resume' | 'next'
      animeId: number
      animeName: string
      posterUrl: string
      episodeInt: string
      episodeLabel: string
      position?: number
      duration?: number
      updatedAt: number
      malId?: number
    }

    type Raw = Entry & {
      shikiPosterFallback?: string
      shikiNameFallback?: string
    }

    const resumeKeys = new Set<string>()
    const raw: Raw[] = []

    // Collapse to the most-recently-updated unfinished episode per anime.
    const bestByAnime = new Map<number, { episodeInt: string; position: number; duration: number; updatedAt: number }>()
    const progress = store.get('watchProgress') as Record<string, { position: number; duration: number; updatedAt: number; watched?: boolean }>
    for (const [key, val] of Object.entries(progress)) {
      if (val.watched) continue
      if (!val.duration || val.duration <= 0) continue
      if (!val.position || val.position <= 5) continue
      if (val.position / val.duration >= 0.95) continue
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const animeId = Number(key.slice(0, sep))
      const episodeInt = key.slice(sep + 1)
      if (!animeId || !episodeInt) continue
      const prev = bestByAnime.get(animeId)
      if (!prev || val.updatedAt > prev.updatedAt) {
        bestByAnime.set(animeId, {
          episodeInt,
          position: val.position,
          duration: val.duration,
          updatedAt: val.updatedAt
        })
      }
    }

    for (const [animeId, val] of bestByAnime) {
      const { name, poster } = entryToNamePoster(localResolve(animeId))
      resumeKeys.add(`${animeId}`)
      raw.push({
        kind: 'resume',
        animeId,
        animeName: name,
        posterUrl: poster,
        episodeInt: val.episodeInt,
        episodeLabel: episodeLabelFor(animeId, val.episodeInt),
        position: val.position,
        duration: val.duration,
        updatedAt: val.updatedAt
      })
    }

    type CachedRate = {
      rate: { target_id: number; episodes: number; status: string; updated_at?: string }
      shikiAnime?: { id: number; name?: string; russian?: string; image?: { preview?: string; x96?: string; original?: string }; episodes_aired?: number }
      smotretAnime?: AnimeSearchResult | null
    }
    const rates = store.get('shikimoriUserRates') as CachedRate[]
    const SHIKI_BASE = 'https://shikimori.one'

    // Map smotret-anime id -> Shikimori rate.updated_at (ms). Used to override
    // Resume rows' sort key with the Shikimori clock so the Home view orders
    // entries the same way as the Shikimori "To Watch" tab.
    const rateUpdatedByAnimeId = new Map<number, number>()
    for (const r of rates) {
      const animeId = r.smotretAnime?.id ?? (r.rate.target_id ? malMap[String(r.rate.target_id)]?.id : undefined)
      if (!animeId || !r.rate.updated_at) continue
      const ms = Date.parse(r.rate.updated_at)
      if (Number.isFinite(ms)) rateUpdatedByAnimeId.set(animeId, ms)
    }
    for (const r of raw) {
      if (r.kind !== 'resume') continue
      const ms = rateUpdatedByAnimeId.get(r.animeId)
      if (ms) r.updatedAt = ms
    }

    for (const entry of rates) {
      const status = entry.rate.status
      if (status !== 'watching' && status !== 'rewatching') continue
      const malId = entry.rate.target_id
      const watched = entry.rate.episodes
      const aired = entry.shikiAnime?.episodes_aired ?? 0
      const next = watched + 1
      if (aired > 0 && next > aired) continue
      const smotret = entry.smotretAnime || (malId ? malMap[String(malId)] : null)
      const animeId = smotret?.id ?? 0
      if (animeId && resumeKeys.has(String(animeId))) continue
      const fallbackName = entry.shikiAnime?.russian || entry.shikiAnime?.name || ''
      const resolved = entryToNamePoster(animeId ? localResolve(animeId, malId) : null, fallbackName)
      let poster = resolved.poster
      if (!poster && entry.shikiAnime?.image) {
        const img = entry.shikiAnime.image.preview || entry.shikiAnime.image.x96 || entry.shikiAnime.image.original || ''
        poster = img && (img.startsWith('http') ? img : `${SHIKI_BASE}${img}`)
      }
      const updatedAt = entry.rate.updated_at ? Date.parse(entry.rate.updated_at) || Date.now() : Date.now()
      raw.push({
        kind: 'next',
        animeId,
        animeName: resolved.name,
        posterUrl: poster,
        episodeInt: String(next),
        episodeLabel: animeId ? episodeLabelFor(animeId, String(next)) : `Episode ${next}`,
        updatedAt,
        malId,
        shikiPosterFallback: poster,
        shikiNameFallback: fallbackName
      })
    }

    // Lazy resolve any rows where we still don't have a name + poster locally.
    // Typical case: anime the user only streamed (no library/downloadedAnime/animeCache entry).
    const unresolvedIds = Array.from(
      new Set(
        raw
          .filter((r) => {
            if (!r.animeId) return false
            // recentAnimeMeta is the freshest source (set on every get-anime
            // call). If we already have it, skip the fetch.
            if (recent[String(r.animeId)]) return false
            // No name → must fetch.
            if (!r.animeName) return true
            // Empty poster → must fetch.
            if (!r.posterUrl) return true
            // Poster is only the Shikimori fallback (which can be a 'missing'
            // placeholder URL when smotret-anime's bulk lookup didn't return a
            // poster). The detail endpoint usually does — so try.
            if (r.shikiPosterFallback && r.posterUrl === r.shikiPosterFallback) return true
            return false
          })
          .map((r) => r.animeId)
      )
    )

    if (unresolvedIds.length > 0) {
      const fetched: Record<number, AnimeDetail | null> = {}
      const concurrency = 4
      let cursor = 0
      async function worker(): Promise<void> {
        while (cursor < unresolvedIds.length) {
          const id = unresolvedIds[cursor++]
          try {
            const result = await Promise.race([
              smotretApi.getAnime(id),
              new Promise<{ data: null }>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 5000)
              )
            ])
            const detail = (result as { data: AnimeDetail | null }).data
            if (detail) {
              fetched[id] = detail
              rememberAnimeMeta(detail)
            }
          } catch {
            fetched[id] = null
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, unresolvedIds.length) }, () => worker()))

      for (const r of raw) {
        if (!r.animeId) continue
        const meta = fetched[r.animeId]
        if (!meta) continue
        if (!r.animeName) {
          r.animeName = meta.titles?.ru || meta.titles?.romaji || meta.title || r.shikiNameFallback || ''
        }
        // Always prefer a smotret-anime poster when we have one — it overrides
        // the (potentially broken) Shikimori fallback.
        const fetchedPoster = meta.posterUrlSmall || meta.posterUrl
        if (fetchedPoster) {
          r.posterUrl = fetchedPoster
        } else if (!r.posterUrl) {
          r.posterUrl = r.shikiPosterFallback || ''
        }
        if (r.episodeLabel.startsWith('Episode ')) {
          const ep = meta.episodes?.find(
            (e) => e.episodeInt === r.episodeInt && isContentEpisode(e)
          )
          if (ep?.episodeFull) r.episodeLabel = ep.episodeFull
        }
      }
    }

    const out: Entry[] = raw
      .map(({ shikiPosterFallback: _p, shikiNameFallback: _n, ...rest }) => rest)
      .filter((r) => r.animeId && r.animeName)

    // Sort by Shikimori rate.updated_at descending — same rule as the
    // ShikimoriView "To Watch" tab. Resume rows whose anime isn't tracked on
    // Shikimori fall back to local watchProgress.updatedAt.
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out.slice(0, 24)
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

  // Watch progress tracking
  ipcMain.handle('watch-progress:save', (_event, animeId: number, episodeInt: string, position: number, duration: number, watched?: boolean) => {
    const all = store.get('watchProgress') as Record<string, { position: number; duration: number; updatedAt: number; watched?: boolean }>
    const key = `${animeId}:${episodeInt}`
    const prev = all[key]
    all[key] = {
      position,
      duration,
      updatedAt: Date.now(),
      watched: watched || prev?.watched || false
    }
    store.set('watchProgress', all)
  })

  ipcMain.handle('watch-progress:get', (_event, animeId: number, episodeInt: string) => {
    const all = store.get('watchProgress') as Record<string, { position: number; duration: number; updatedAt: number; watched?: boolean }>
    return all[`${animeId}:${episodeInt}`] || null
  })

  ipcMain.handle('watch-progress:get-all', (_event, animeId: number) => {
    const all = store.get('watchProgress') as Record<string, { position: number; duration: number; updatedAt: number; watched?: boolean }>
    const prefix = `${animeId}:`
    const out: Record<string, { position: number; duration: number; updatedAt: number; watched?: boolean }> = {}
    for (const [key, val] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        out[key.slice(prefix.length)] = val
      }
    }
    return out
  })

  // Download handlers
  ipcMain.handle('download:enqueue', async (_event, requests: DownloadRequest[]) => {
    await downloadManager.enqueue(requests)
    // Metadata in `downloadedEpisodes` is written by the onEpisodeComplete callback
    // once the video is actually on disk — premature writes here caused stale ⬇ icons
    // to survive cancelled or never-finished downloads.
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
    const item = downloadManager.getItem(id)
    downloadManager.cancel(id)
    if (item && item.animeId > 0 && item.episodeInt) {
      pruneDownloadedEpisode(item.animeId, item.episodeInt, item.translationId, item.animeName, item.author)
    }
  })

  ipcMain.handle('download:get-queue', () => {
    return downloadManager.getEpisodeGroups()
  })

  ipcMain.handle('download:cancel-by-episode', (_event, animeName: string, episodeLabel?: string) => {
    // Snapshot items before cancellation so we can prune metadata for any translation
    // whose file never landed on disk.
    const toPrune = downloadManager.findCancellableItems(animeName, episodeLabel)
      .filter(i => i.kind === 'video' && i.animeId > 0 && i.episodeInt)
      .map(i => ({ animeId: i.animeId, episodeInt: i.episodeInt, translationId: i.translationId, animeName: i.animeName, author: i.author }))

    downloadManager.cancelByEpisode(animeName, episodeLabel)

    for (const p of toPrune) {
      pruneDownloadedEpisode(p.animeId, p.episodeInt, p.translationId, p.animeName, p.author)
    }

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

    // Resolve anime name so we can validate each entry against the filesystem.
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const animeRec = downloaded[String(animeId)]
    const animeName = animeRec ? (animeRec.titles?.romaji || animeRec.titles?.ru || animeRec.title) : ''

    // Active downloads (kept even without a file yet so the UI lock / in-progress indicators work).
    const activeTrIds = new Set(
      downloadManager.getEpisodeGroups()
        .filter(g => g.animeName === animeName)
        .map(g => g.translationId)
    )

    let mutated = false
    for (const [key, val] of Object.entries(episodes)) {
      if (!key.startsWith(prefix)) continue
      const rest = key.substring(prefix.length)
      const colonIdx = rest.indexOf(':')
      const episodeInt = colonIdx >= 0 ? rest.substring(0, colonIdx) : rest

      // GC stale metadata whose file is not on disk and which isn't an active download.
      if (animeName && !activeTrIds.has(val.translationId)
          && !episodeFileExists(animeName, episodeInt, val.author)) {
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
    store.set('shikimoriUserRates', [])
    store.set('shikimoriUpdateQueue', [])
    store.set('shikimoriAnimeDetails', {})
    prefetchAbort = true
    stopSyncTimer()
    broadcastToAll('shikimori:offline-queue-changed', { length: 0 })
    broadcastSyncStatus()
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
      const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
      if (!user) throw new Error('Not logged in to Shikimori')

      const cached = store.get('shikimoriUserRates') as { rate: Record<string, unknown> & { id?: number; target_id: number; episodes: number; status: shikimori.ShikiUserRateStatus; score: number }; shikiAnime: unknown; smotretAnime: unknown }[]
      const idx = cached.findIndex((e) => e.rate.target_id === malId)

      try {
        const accessToken = await shikimori.ensureFreshToken(store)
        const existing = await shikimori.getUserRate(accessToken, user.id, malId)
        const updatedRate = existing
          ? await shikimori.updateUserRate(accessToken, existing.id, episodes, status, score)
          : await shikimori.createUserRate(accessToken, user.id, malId, episodes, status, score)

        if (idx !== -1) {
          cached[idx] = {
            ...cached[idx],
            rate: {
              id: updatedRate.id,
              score: updatedRate.score,
              status: updatedRate.status,
              episodes: updatedRate.episodes,
              updated_at: new Date().toISOString(),
              target_id: updatedRate.target_id
            }
          }
          store.set('shikimoriUserRates', cached)
          broadcastToAll('shikimori:rate-updated', cached[idx])
        } else {
          refreshShikimoriRatesInBackground()
        }

        void syncShikimoriQueue()
        return updatedRate
      } catch (err) {
        if (!isNetworkError(err) || idx === -1) throw err

        const cachedEntry = cached[idx]
        const rateId = typeof cachedEntry.rate.id === 'number' ? cachedEntry.rate.id : null
        const before = {
          episodes: cachedEntry.rate.episodes,
          status: cachedEntry.rate.status,
          score: cachedEntry.rate.score
        }
        const after = { episodes, status, score }

        const queue = store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]
        queue.push({ malId, rateId, before, after, queuedAt: Date.now() })
        store.set('shikimoriUpdateQueue', queue)

        cached[idx] = {
          ...cachedEntry,
          rate: {
            ...cachedEntry.rate,
            episodes,
            status,
            score,
            updated_at: new Date().toISOString()
          }
        }
        store.set('shikimoriUserRates', cached)
        broadcastToAll('shikimori:rate-updated', cached[idx])
        broadcastToAll('shikimori:offline-queue-changed', { length: queue.length })
        startSyncTimer()

        return {
          id: rateId ?? -1,
          score,
          status,
          episodes,
          target_id: malId,
          target_type: 'Anime'
        } satisfies shikimori.ShikiUserRate
      }
    }
  )

  ipcMain.handle('shikimori:get-friends-rates', async (_event, malId: number) => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    return shikimori.getFriendsRatesForAnime(accessToken, user.id, malId)
  })

  async function fetchAndCacheShikimoriRates(status?: string): Promise<unknown[]> {
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
    const entries = rates.map((rate) => ({
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
    if (!status) {
      store.set('shikimoriUserRates', entries)
    }
    return entries
  }

  function refreshShikimoriRatesInBackground(): void {
    fetchAndCacheShikimoriRates()
      .then((entries) => {
        broadcastToAll('shikimori:rates-refreshed', entries)
        void syncShikimoriQueue()
        void prefetchShikimoriDetails()
      })
      .catch((err) => console.warn('[shikimori] background refresh failed:', err))
  }

  ipcMain.handle('shikimori:get-anime-rates', async (_event, status?: string) => {
    if (!status) {
      const cached = store.get('shikimoriUserRates') as unknown[]
      if (cached.length > 0) {
        refreshShikimoriRatesInBackground()
        return cached
      }
    }
    const entries = await fetchAndCacheShikimoriRates(status)
    if (!status) void prefetchShikimoriDetails()
    return entries
  })

  ipcMain.handle('shikimori:get-anime-details', (_event, malId: number) => {
    const cache = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >
    const entry = cache[String(malId)]
    if (!entry) {
      const creds = store.get('shikimoriCredentials') as shikimori.ShikiCredentials | null
      if (creds) void prefetchShikimoriDetails()
      return null
    }
    return entry.details
  })

  ipcMain.handle('shikimori:trigger-detail-prefetch', () => {
    void prefetchShikimoriDetails()
  })

  ipcMain.handle('shikimori:get-offline-queue-length', () => {
    return (store.get('shikimoriUpdateQueue') as unknown[]).length
  })

  ipcMain.handle('shikimori:get-sync-status', () => getSyncStatus())

  ipcMain.handle('shikimori:trigger-sync', () => {
    void syncShikimoriQueue()
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

  ipcMain.handle('shikimori:get-related', async (_event, malId: number) => {
    const franchise = await shikimori.getFranchise(malId)

    const CANONICAL_RELATIONS = new Set([
      'sequel',
      'prequel',
      'side_story',
      'parent_story',
      'alternative_version',
      'summary',
      'full_story',
      'spin_off',
      'alternative_setting'
    ])

    const adjacency = new Map<number, { nodeId: number; relation: string }[]>()
    for (const link of franchise.links) {
      if (!CANONICAL_RELATIONS.has(link.relation)) continue
      if (!adjacency.has(link.source_id)) adjacency.set(link.source_id, [])
      adjacency.get(link.source_id)!.push({ nodeId: link.target_id, relation: link.relation })
      if (!adjacency.has(link.target_id)) adjacency.set(link.target_id, [])
      adjacency.get(link.target_id)!.push({ nodeId: link.source_id, relation: link.relation })
    }

    const reachable = new Set<number>([franchise.current_id])
    const queue = [franchise.current_id]
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]
      for (const { nodeId } of adjacency.get(cur) || []) {
        if (reachable.has(nodeId)) continue
        reachable.add(nodeId)
        queue.push(nodeId)
      }
    }

    const filteredNodes = franchise.nodes.filter((n) => reachable.has(n.id))
    const malIds = Array.from(new Set(filteredNodes.map((n) => n.id)))
    const malMap = await lookupByMalIds(malIds)

    const relationByNodeId = new Map<number, string>()
    for (const link of franchise.links) {
      if (link.source_id === franchise.current_id) {
        relationByNodeId.set(link.target_id, link.relation)
      }
    }

    const cachedDetails = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >
    const cachedRates = store.get('shikimoriUserRates') as {
      rate: { status: shikimori.ShikiUserRateStatus }
      shikiAnime: { id: number; kind?: string }
    }[]
    const kindByMalId = new Map<number, string>()
    const statusByMalId = new Map<number, shikimori.ShikiUserRateStatus>()
    for (const r of cachedRates) {
      const id = r.shikiAnime?.id
      if (id == null) continue
      if (r.shikiAnime.kind) kindByMalId.set(id, r.shikiAnime.kind)
      if (r.rate?.status) statusByMalId.set(id, r.rate.status)
    }

    function normalizeKind(node: shikimori.ShikiFranchiseNode, smotretType: string | undefined): string | null {
      const cached = cachedDetails[String(node.id)]?.details?.kind
      if (cached) return cached
      const rated = kindByMalId.get(node.id)
      if (rated) return rated
      if (smotretType) return smotretType.toLowerCase()
      const k = (node.kind || '').toLowerCase()
      if (k.includes('проморолик') || k === 'pv') return 'pv'
      if (k.includes('реклама') || k === 'cm') return 'cm'
      if (k.includes('клип') || k === 'music') return 'music'
      if (k.includes('тв-спешл') || k === 'tv_special') return 'tv_special'
      if (k.includes('спешл') || k === 'special') return 'special'
      if (k.includes('полнометраж') || k === 'movie') return 'movie'
      if (k.includes('ova')) return 'ova'
      if (k.includes('ona')) return 'ona'
      if (k.includes('tv')) return 'tv'
      return node.kind ?? null
    }

    const EXCLUDED_KINDS = new Set(['pv', 'cm', 'music'])

    const sorted = [...filteredNodes].sort((a, b) => {
      if (a.date == null && b.date == null) return 0
      if (a.date == null) return 1
      if (b.date == null) return -1
      return a.date - b.date
    })

    return sorted
      .map((n) => {
        const smotret = malMap[n.id] ?? null
        const kind = normalizeKind(n, smotret?.type)
        return {
          relation: relationByNodeId.get(n.id) ?? null,
          shikiAnime: {
            id: n.id,
            name: n.name,
            image_url: n.image_url,
            url: n.url,
            year: n.year,
            kind,
            date: n.date
          },
          smotretAnime: smotret,
          isCurrent: n.id === franchise.current_id,
          watchStatus: statusByMalId.get(n.id) ?? null
        }
      })
      .filter((e) => e.isCurrent || !(e.shikiAnime.kind && EXCLUDED_KINDS.has(e.shikiAnime.kind)))
  })

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('shell:open-external-file', async (_event, filePath: string) => {
    try {
      const err = await shell.openPath(filePath)
      return { ok: err === '', error: err || undefined }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
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

  // Remux MKV to fragmented MP4 (stream copy) for progressive HTML5 playback.
  // See protocol.handle('anime-video', …) below for the streaming reader.
  ipcMain.handle('player:remux-mkv', async (_event, mkvPath: string): Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }> => {
    if (!ffmpegPath) return { error: 'ffmpeg not available' }
    if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

    fs.mkdirSync(remuxTmpDir, { recursive: true })

    const stamp = Date.now()
    const baseName = path.basename(mkvPath, path.extname(mkvPath))
    const mp4Path = path.join(remuxTmpDir, `${baseName}-${stamp}.mp4`)

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

    const subtitlePromise = extractFirstSubtitle(mkvPath, path.join(remuxTmpDir, `${baseName}-${stamp}.ass`))

    try {
      const [, subtitleContent] = await Promise.all([remuxPromise, subtitlePromise])
      return { mp4Path, ...(subtitleContent ? { subtitleContent } : {}) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  // Start an MSE-friendly fragmented MP4 pipe. Returns duration + codecs MIME so the
  // renderer can set MediaSource.duration and addSourceBuffer(mimeType) upfront.
  // Video bytes are pushed to the renderer via 'player:stream-chunk' events.
  ipcMain.handle('player:remux-mkv-stream', async (event, mkvPath: string, initialSeek?: number): Promise<MseOpenResult | { error: string }> => {
    if (!ffmpegPath) return { error: 'ffmpeg not available' }
    if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

    const probe = await probeMkvForMse(mkvPath)
    if (!probe || !probe.streamCopyMimeType) return { error: 'Codecs not supported for MSE' }
    const streamCopyMime = probe.streamCopyMimeType

    fs.mkdirSync(remuxTmpDir, { recursive: true })

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
    mseSessions.set(sessionId, session)
    const startSeek = typeof initialSeek === 'number' && isFinite(initialSeek) && initialSeek > 0 ? initialSeek : 0
    console.log(`[remux-stream] open session ${sessionId.slice(0, 8)} codec=${probe.videoCodec} mime="${streamCopyMime}"`)
    session.proc = spawnFfmpegForSession(session, event, sessionId, startSeek)

    // Kick off subtitle extraction in parallel; push to renderer when ready.
    const assPath = path.join(remuxTmpDir, `${baseName}-${sessionId}.ass`)
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
    } catch { /* ignore probe failures */ }

    if (hasSubtitlesPending) {
      extractFirstSubtitle(mkvPath, assPath).then((content) => {
        if (!content) return
        const sender = event.sender
        if (sender && !sender.isDestroyed()) {
          sender.send('player:stream-subtitles', { sessionId, content })
        }
      }).catch(() => { /* already logged */ })
    }

    return {
      sessionId,
      generation: session.generation,
      duration: probe.duration,
      mimeType: streamCopyMime,
      hasSubtitlesPending,
      initialSeek: startSeek
    }
  })

  // Same as `player:remux-mkv-stream` but re-encodes video to H.264 on the fly.
  // Used when the platform has no decoder for the source codec (typically HEVC
  // on Linux without VA-API). Audio is copied when AAC, otherwise transcoded
  // to AAC so MSE can play it.
  ipcMain.handle('player:remux-mkv-stream-transcode', async (event, mkvPath: string, initialSeek?: number): Promise<MseOpenResult | { error: string }> => {
    if (!ffmpegPath) return { error: 'ffmpeg not available' }
    if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

    const probe = await probeMkvForMse(mkvPath)
    if (!probe) return { error: 'Probe failed' }

    fs.mkdirSync(remuxTmpDir, { recursive: true })

    const encoder = await pickH264Encoder()
    // When the audio is being stream-copied, reflect its actual AAC object type
    // (mp4a.40.2 / .5 / .29) in the mime — otherwise MediaSource.isTypeSupported
    // will reject a perfectly valid HE-AAC stream. When we transcode audio we
    // force LC AAC, so mp4a.40.2 is always correct on that branch.
    const audioCodecForMime = probe.audioStrategy === 'copy' && probe.audioCodecString
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
    mseSessions.set(sessionId, session)
    const startSeek = typeof initialSeek === 'number' && isFinite(initialSeek) && initialSeek > 0 ? initialSeek : 0
    console.log(`[remux-stream] open TRANSCODE session ${sessionId.slice(0, 8)} encoder=${encoder.name} audio=${probe.audioStrategy} mime="${mimeType}"`)
    session.proc = spawnFfmpegForSession(session, event, sessionId, startSeek)

    const assPath = path.join(remuxTmpDir, `${baseName}-${sessionId}.ass`)
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
    } catch { /* ignore */ }

    if (hasSubtitlesPending) {
      extractFirstSubtitle(mkvPath, assPath).then((content) => {
        if (!content) return
        const sender = event.sender
        if (sender && !sender.isDestroyed()) {
          sender.send('player:stream-subtitles', { sessionId, content })
        }
      }).catch(() => { /* already logged */ })
    }

    return {
      sessionId,
      generation: session.generation,
      duration: probe.duration,
      mimeType,
      hasSubtitlesPending,
      initialSeek: startSeek
    }
  })

  // Forward seek past the buffered region: respawn ffmpeg with `-ss` so output
  // starts at (or just before) the requested timestamp. The renderer will have
  // already set sourceBuffer.timestampOffset to place fragments on the correct
  // MSE timeline position. Stale chunks from the old proc are filtered out by
  // the generation counter captured in spawnFfmpegForSession.
  ipcMain.handle('player:stream-seek', (event, sessionId: string, seekSeconds: number) => {
    const session = mseSessions.get(sessionId)
    if (!session) return { error: 'session not found' }
    session.generation++
    try { session.proc.kill('SIGKILL') } catch { /* ignore */ }
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
      try { session.proc.stdout.resume() } catch { /* ignore */ }
    }
    session.proc = spawnFfmpegForSession(session, event, sessionId, Math.max(0, seekSeconds))
    return { ok: true, generation: session.generation }
  })

  // Handshake: renderer's MediaSource + SourceBuffer are ready to receive chunks.
  // Flush any buffered prelude (the MP4 moov header lives in here) and switch to
  // forwarding subsequent chunks directly.
  ipcMain.handle('player:stream-start', (event, sessionId: string) => {
    const session = mseSessions.get(sessionId)
    if (!session) return
    if (session.ready) return
    session.ready = true
    const sender = event.sender
    if (sender && !sender.isDestroyed()) {
      const gen = session.generation
      for (const chunk of session.prelude) {
        sender.send('player:stream-chunk', { sessionId, gen, data: chunk })
      }
    }
    session.prelude = []
  })

  // Backpressure ack: renderer reports bytes it has appended into its SourceBuffer.
  // When enough data has been consumed we resume the ffmpeg stdout pipe.
  ipcMain.handle('player:stream-ack', (_event, sessionId: string, bytesConsumed: number) => {
    const session = mseSessions.get(sessionId)
    if (!session) return
    session.pendingBytes = Math.max(0, session.pendingBytes - bytesConsumed)
    if (
      session.pendingBytes < STREAM_BACKPRESSURE_LOW_WATERMARK &&
      session.proc.stdout?.isPaused()
    ) {
      session.proc.stdout.resume()
    }
  })

  ipcMain.handle('player:cleanup-remux', async () => {
    for (const sessionId of Array.from(mseSessions.keys())) {
      cleanupMseSession(sessionId)
    }
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

interface MseOpenResult {
  sessionId: string
  generation: number
  duration: number
  mimeType: string
  hasSubtitlesPending: boolean
  initialSeek: number
}

interface MseSession {
  proc: ChildProcess
  pendingBytes: number
  stderrTail: string[]
  done: boolean
  error: string | null
  senderId: number
  ready: boolean
  prelude: Buffer[]
  mkvPath: string
  generation: number
  videoCodec: 'h264' | 'hevc'
  transcode: boolean
  audioStrategy: 'copy' | 'transcode'
  h264Encoder: string | null
}

function spawnFfmpegForSession(
  session: MseSession,
  event: Electron.IpcMainInvokeEvent,
  sessionId: string,
  seekSeconds: number
): ChildProcess {
  const args: string[] = ['-fflags', '+genpts']
  if (session.transcode) {
    const choice = h264EncoderCandidates().find((c) => c.name === session.h264Encoder) || h264EncoderCandidates().slice(-1)[0]
    if (choice.extraInputArgs) args.push(...choice.extraInputArgs)
    if (seekSeconds > 0) args.push('-ss', String(seekSeconds))
    args.push('-i', session.mkvPath, '-map', '0:v:0', '-map', '0:a:0?')
    args.push(...choice.videoArgs)
    if (session.audioStrategy === 'copy') args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '192k')
    args.push('-avoid_negative_ts', 'make_zero', '-muxpreload', '0', '-muxdelay', '0')
  } else {
    if (seekSeconds > 0) args.push('-ss', String(seekSeconds))
    args.push(
      '-i', session.mkvPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-muxpreload', '0',
      '-muxdelay', '0'
    )
    // HEVC tracks in fMP4 must be tagged `hvc1` (parameter sets in sample entry)
    // so Chromium's MSE decoder accepts them. ffmpeg defaults to `hev1`
    // (parameter sets in-band), which many browsers reject for MSE.
    if (session.videoCodec === 'hevc') args.push('-tag:v', 'hvc1')
  }
  args.push(
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof+separate_moof',
    '-frag_duration', '1000000',
    '-f', 'mp4',
    'pipe:1'
  )
  const proc = spawn(ffmpegPath!, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const procGen = session.generation

  // Throttle transcode progress IPC: ffmpeg emits progress lines ~4x/sec which
  // is too noisy for a UI label, so we coalesce to at most one send per 500 ms.
  let lastProgressSentAt = 0
  proc.stderr?.on('data', (data: Buffer) => {
    if (procGen !== session.generation) return
    const line = data.toString()
    session.stderrTail.push(line)
    if (session.stderrTail.length > 40) session.stderrTail.shift()
    if (!session.transcode) return
    // Lines look like:
    //   frame= 1234 fps= 60 q=-1.0 size=... time=00:01:23.45 bitrate=... speed=2.5x
    const speedMatch = /speed=\s*([\d.]+)x/.exec(line)
    const timeMatch = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line)
    if (!speedMatch && !timeMatch) return
    const now = Date.now()
    if (now - lastProgressSentAt < 500) return
    lastProgressSentAt = now
    const sender = event.sender
    if (!sender || sender.isDestroyed()) return
    const speed = speedMatch ? parseFloat(speedMatch[1]) : null
    const time = timeMatch
      ? parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3])
      : null
    sender.send('player:stream-progress', { sessionId, gen: procGen, speed, time })
  })

  // Coalesce small ffmpeg stdout chunks into ~256 KB IPC messages. ffmpeg
  // emits 50–60 KB writes; at transcode speed that floods the renderer main
  // thread with hundreds of IPC events per second and starves the video
  // compositor, showing up as playback stutter.
  const BATCH_FLUSH_BYTES = 256 * 1024
  let batchBuf: Buffer[] = []
  let batchLen = 0
  const flushBatch = (): void => {
    if (batchLen === 0) return
    const out = batchBuf.length === 1 ? batchBuf[0] : Buffer.concat(batchBuf, batchLen)
    batchBuf = []
    batchLen = 0
    if (session.ready) {
      const sender = event.sender
      if (sender && !sender.isDestroyed()) {
        sender.send('player:stream-chunk', { sessionId, gen: procGen, data: out })
      }
    } else {
      session.prelude.push(out)
    }
  }
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (procGen !== session.generation) return
    session.pendingBytes += chunk.length
    batchBuf.push(chunk)
    batchLen += chunk.length
    if (batchLen >= BATCH_FLUSH_BYTES) flushBatch()
    if (session.pendingBytes > STREAM_BACKPRESSURE_HIGH_WATERMARK) {
      proc.stdout?.pause()
    }
  })

  proc.stdout?.on('pause', flushBatch)

  proc.stdout?.on('end', () => {
    if (procGen !== session.generation) return
    if (session.done) return
    flushBatch()
    session.done = true
    const sender = event.sender
    if (sender && !sender.isDestroyed()) {
      sender.send('player:stream-end', { sessionId })
    }
  })

  proc.on('error', (err) => {
    if (procGen !== session.generation) return
    if (session.done) return
    session.done = true
    session.error = err.message
    console.error('[remux-stream] spawn error:', err.message)
    const sender = event.sender
    if (sender && !sender.isDestroyed()) {
      sender.send('player:stream-error', { sessionId, error: err.message })
    }
  })

  proc.on('exit', (code, signal) => {
    if (procGen !== session.generation) return
    if (signal === 'SIGKILL') return
    if (code !== 0 && !session.done) {
      const msg = `ffmpeg exited with code ${code}: ${session.stderrTail.slice(-3).join('').trim()}`
      session.error = msg
      session.done = true
      console.error('[remux-stream]', msg)
      const sender = event.sender
      if (sender && !sender.isDestroyed()) {
        sender.send('player:stream-error', { sessionId, error: msg })
      }
    }
  })

  return proc
}

const remuxTmpDir = path.join(os.tmpdir(), 'anime-dl-remux')
const mseSessions = new Map<string, MseSession>()
const STREAM_BACKPRESSURE_HIGH_WATERMARK = 64 * 1024 * 1024
const STREAM_BACKPRESSURE_LOW_WATERMARK = 16 * 1024 * 1024

function cleanupMseSession(sessionId: string): void {
  const session = mseSessions.get(sessionId)
  if (!session) return
  session.done = true
  try { session.proc.kill('SIGKILL') } catch { /* ignore */ }
  mseSessions.delete(sessionId)
}

interface MkvProbeResult {
  duration: number
  videoCodec: 'h264' | 'hevc'
  audioCodecName: string
  audioStrategy: 'copy' | 'transcode'
  streamCopyMimeType: string | null
  // Set when the source audio is AAC — carries the precise AAC object-type
  // codec string (e.g. mp4a.40.2, mp4a.40.5) for HE-AAC/HE-AACv2 variants.
  audioCodecString: string | null
}

async function probeMkvForMse(mkvPath: string): Promise<MkvProbeResult | null> {
  if (!ffprobePath) return null
  try {
    Ffmpeg.setFfprobePath(ffprobePath)
    const metadata = await new Promise<Ffmpeg.FfprobeData>((res, rej) => {
      Ffmpeg.ffprobe(mkvPath, (err, m) => (err ? rej(err) : res(m)))
    })
    const durationStr = metadata.format?.duration
    const duration = typeof durationStr === 'number' ? durationStr : parseFloat(String(durationStr))
    if (!isFinite(duration) || duration <= 0) return null
    const video = metadata.streams?.find((s) => s.codec_type === 'video')
    const audio = metadata.streams?.find((s) => s.codec_type === 'audio')
    if (!video || !audio) return null
    let videoCodec: 'h264' | 'hevc'
    let videoCodecStr: string | null = null
    const avc = avcCodecString(video)
    if (avc) { videoCodec = 'h264'; videoCodecStr = avc }
    else {
      const hevc = hevcCodecString(video)
      if (hevc) { videoCodec = 'hevc'; videoCodecStr = hevc }
      else return null
    }
    const audioCodecName = (audio.codec_name || '').toString()
    const aStr = aacCodecString(audio)
    const audioStrategy: 'copy' | 'transcode' = aStr ? 'copy' : 'transcode'
    const streamCopyMimeType = aStr && videoCodecStr ? `video/mp4; codecs="${videoCodecStr}, ${aStr}"` : null
    return { duration, videoCodec, audioCodecName, audioStrategy, streamCopyMimeType, audioCodecString: aStr }
  } catch {
    return null
  }
}

function avcCodecString(stream: Ffmpeg.FfprobeStream): string | null {
  if (stream.codec_name !== 'h264') return null
  const profile = (stream.profile || '').toString().toLowerCase()
  let pp: string, cc: string
  if (profile.includes('constrained baseline')) { pp = '42'; cc = 'E0' }
  else if (profile.includes('baseline')) { pp = '42'; cc = '00' }
  else if (profile.includes('main')) { pp = '4D'; cc = '40' }
  else if (profile.includes('high 10')) { pp = '6E'; cc = '00' }
  else if (profile.includes('high 4:2:2')) { pp = '7A'; cc = '00' }
  else if (profile.includes('high 4:4:4')) { pp = 'F4'; cc = '00' }
  else if (profile.includes('high')) { pp = '64'; cc = '00' }
  else return null
  const level = typeof stream.level === 'number' ? stream.level : 0
  if (level <= 0) return null
  const ll = level.toString(16).padStart(2, '0').toUpperCase()
  return `avc1.${pp}${cc}${ll}`
}

function hevcCodecString(stream: Ffmpeg.FfprobeStream): string | null {
  if (stream.codec_name !== 'hevc') return null
  // Format: hvc1.<profile_space><profile_idc>.<compat_flags_hex_reversed>.<tier><level_idc>.<constraint_bytes>
  // Reference: ISO/IEC 14496-15 Annex E, Chromium spec at
  // https://source.chromium.org/chromium/chromium/src/+/main:media/base/video_codecs.cc
  const profile = (stream.profile || '').toString().toLowerCase()
  let profileIdc: number
  let compatFlags: number
  // `compatFlags` holds the raw general_profile_compatibility_flag bitfield
  // exactly as laid out in ISO/IEC 14496-15 §E.3 (MSB = flag[0] = Main profile,
  // next bit = Main 10, next = Main Still Picture, …). The codec string wants
  // the bit-reversed (LSB-first) hex form, which `reverseBits32` below produces:
  //   Main           → raw 0x60000000 → codec hex "6"  → hvc1.1.6.Lxx.B0
  //   Main 10        → raw 0x20000000 → codec hex "4"  → hvc1.2.4.Lxx.B0
  //   Main Still Pic → raw 0x40000000 → codec hex "2"  → hvc1.3.2.Lxx.B0
  if (profile.includes('main 10')) {
    profileIdc = 2
    compatFlags = 0x20000000
  } else if (profile.includes('main still')) {
    profileIdc = 3
    compatFlags = 0x40000000
  } else if (profile.includes('main')) {
    // Main-profile bitstreams are also decodable by Main 10 decoders, hence two bits set.
    profileIdc = 1
    compatFlags = 0x60000000
  } else {
    return null
  }
  // For HEVC, ffprobe's `level` is the raw HEVC level_idc value (for example
  // 120 → level 4.0, 150 → 5.0, 153 → 5.1, 156 → 5.2 in human-readable form).
  // The codec string uses that raw value directly, so we emit `L<level_idc>`
  // (for example `L120`, `L150`) rather than converting it to a decimal level.
  const levelIdc = typeof stream.level === 'number' ? stream.level : 0
  if (levelIdc <= 0) return null
  // Reverse 32-bit compatibility flags and emit as hex without leading zeros.
  const reversed = reverseBits32(compatFlags)
  const compatHex = reversed.toString(16).toUpperCase()
  // Tier: assume Main tier (L) — High tier (H) is rare outside 8K broadcast content.
  const tierAndLevel = `L${levelIdc}`
  // Constraint indicator flags: 6 bytes, typically all zero; Chromium accepts a
  // trailing `.B0` (or even truncation). Use `.B0` as a compact default.
  return `hvc1.${profileIdc}.${compatHex}.${tierAndLevel}.B0`
}

let cachedH264Encoder: string | null | undefined = undefined

interface H264EncoderChoice {
  name: string
  videoArgs: string[]
  extraInputArgs?: string[]
}

function listVaapiRenderNodes(): string[] {
  // Common default is /dev/dri/renderD128, but multi-GPU systems expose
  // renderD129, renderD130, ... The right one for hardware H.264 encode isn't
  // knowable without probing, so enumerate all of them and let pickH264Encoder
  // dry-run each in order.
  try {
    const entries = fs.readdirSync('/dev/dri')
    return entries
      .filter((n) => /^renderD\d+$/.test(n))
      .sort()
      .map((n) => `/dev/dri/${n}`)
  } catch {
    return []
  }
}

function h264EncoderCandidates(): H264EncoderChoice[] {
  // Force a keyframe every second via a time-based expression so fragments
  // emitted with `+frag_keyframe` land every ~1 s instead of waiting for the
  // encoder's default ~10 s GOP. Without this, the first post-seek fragment
  // takes many seconds to appear and the MSE buffer stays empty.
  const keyframeEverySecond = ['-force_key_frames', 'expr:gte(t,n_forced*1)']
  const candidates: H264EncoderChoice[] = []
  if (process.platform === 'linux') {
    for (const node of listVaapiRenderNodes()) {
      candidates.push({
        name: `h264_vaapi(${node})`,
        extraInputArgs: ['-init_hw_device', `vaapi=va:${node}`, '-filter_hw_device', 'va'],
        videoArgs: ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-profile:v', 'high', '-level', '40', ...keyframeEverySecond]
      })
    }
  }
  candidates.push({
    name: 'h264_nvenc',
    videoArgs: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0', ...keyframeEverySecond]
  })
  if (process.platform === 'win32' || process.platform === 'linux') {
    candidates.push({
      name: 'h264_qsv',
      videoArgs: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-pix_fmt', 'nv12', '-profile:v', 'high', '-level', '4.0', ...keyframeEverySecond]
    })
  }
  candidates.push({
    // No `-tune zerolatency`: it forces slice-threads only and disables frame-threading,
    // which roughly halves libx264's throughput. `-threads 0` lets x264 auto-pick.
    name: 'libx264',
    videoArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '0', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0', ...keyframeEverySecond]
  })
  return candidates
}

function dryRunEncoder(choice: H264EncoderChoice): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false)
    const args: string[] = []
    if (choice.extraInputArgs) args.push(...choice.extraInputArgs)
    args.push('-f', 'lavfi', '-i', 'testsrc=duration=0.1:size=320x240:rate=30', '-frames:v', '1')
    args.push(...choice.videoArgs)
    args.push('-an', '-f', 'null', '-')
    try {
      execFile(ffmpegPath, args, { timeout: 5000 }, (err) => resolve(!err))
    } catch {
      resolve(false)
    }
  })
}

async function pickH264Encoder(): Promise<H264EncoderChoice> {
  const candidates = h264EncoderCandidates()
  if (cachedH264Encoder !== undefined) {
    const hit = candidates.find((c) => c.name === cachedH264Encoder)
    if (hit) return hit
  }
  for (const c of candidates) {
    const ok = await dryRunEncoder(c)
    if (ok) {
      cachedH264Encoder = c.name
      console.log(`[remux-stream] picked H.264 encoder: ${c.name}`)
      return c
    }
  }
  // libx264 should always work but if even that fails, still return it so the spawn surfaces a real error later.
  cachedH264Encoder = 'libx264'
  return candidates[candidates.length - 1]
}

function reverseBits32(value: number): number {
  let v = value >>> 0
  let result = 0
  for (let i = 0; i < 32; i++) {
    result = (result << 1) | (v & 1)
    v >>>= 1
  }
  return result >>> 0
}

function aacCodecString(stream: Ffmpeg.FfprobeStream): string | null {
  if (stream.codec_name !== 'aac') return null
  const profile = (stream.profile || '').toString().toUpperCase()
  if (profile === 'HE-AAC') return 'mp4a.40.5'
  if (profile === 'HE-AACV2' || profile === 'HE-AAC V2') return 'mp4a.40.29'
  return 'mp4a.40.2'
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

  downloadManager.onEpisodeComplete(async (info) => {
    const { animeName, episodeLabel, animeId, episodeInt, translationId, translationType, author, quality } = info
    fileCheckCache.delete(animeName)

    // Persist episode metadata now that the video is on disk. Writing this at enqueue
    // time caused stale ⬇ icons to survive cancelled / failed downloads.
    if (animeId > 0 && episodeInt) {
      const episodes = store.get('downloadedEpisodes') as Record<string, { translationType: string; author: string; quality: number; translationId: number }>
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

  if (getQueueLength() > 0) {
    startSyncTimer()
    void syncShikimoriQueue()
  }

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
