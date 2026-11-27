import {
  app,
  dialog,
  shell,
  BrowserWindow,
  Notification,
  protocol,
  safeStorage,
  session
} from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { createStorageService, type MainStorageService } from './store'
import { unreadableConfigMessage } from './store/config-recovery'
import { STORE_DEFAULTS, WRITE_THROUGH_KEYS } from './store/defaults'
import { createCredentialVault, createSafeStorageHolder } from './trackers/credential-vault'
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
  getFfmpegDir,
  ffmpegInstallPaths,
  verifyBinary
} from './ffmpeg-binaries'
import * as shikimori from './shikimori'
import { SmotretApi } from './smotret-api'
import { parseEpisodeFromFilename } from './lib/filename'
import { createEpisodeCompletionHandlers, isMergeExpected } from './lib/episode-completion'
import { createFfmpegStatus } from './lib/ffmpeg-status'
import { installShikimoriReferer } from './lib/shikimori-images'
import {
  applyApiBaseOverrides,
  rewriteLegacySmotretUrl,
  shikimoriOrigin,
  smotretApiBase
} from './lib/api-bases'
import { setNetworkObserver, setOfflineCheck } from './lib/net'
import { installOfflineRequestGate } from './lib/offline-request-gate'
import { createOfflineService } from './services/offline'
import { createOfflineKickoff, type OfflineKickoff } from './services/offline/kickoff'
import { createBinaryInstalls } from './lib/binary-installs'
import { createAnimeVideoHandler } from './streaming/anime-video-protocol'
import { createAnimePosterHandler } from './streaming/anime-poster-protocol'
import { createCacheScope } from './services/anime-cache/scope'
import type { AnimeSearchResult, AnimeDetail } from './smotret-api'
import { ensureFpcalc, getFpcalcPath, fpcalcInstallPath } from './fpcalc-binaries'
import { createPrepareOfflineService } from './services/prepare-offline'
import { createBinariesStep } from './services/prepare-offline/steps/binaries'
import { createShikimoriRatesStep } from './services/prepare-offline/steps/shikimori-rates'
import { createMetadataStep } from './services/prepare-offline/steps/metadata'
import { createLocalIntegrityStep } from './services/prepare-offline/steps/local-integrity'
import {
  localIntegrityDeps,
  metadataDeps,
  registerTrackerRatesSteps
} from './services/prepare-offline/wiring'
import { createAttachedIntegrityStep } from './services/prepare-offline/steps/attached-integrity'
import {
  needReviewFrom,
  createLibrarySyncStep
} from './services/prepare-offline/steps/library-sync'
import { probeDuration } from './lib/probe-duration'
import { syncplay } from './syncplay'
import { registerSyncplayBroadcasts } from './ipc/syncplay-broadcasts'

import { createAnimeCacheService } from './services/anime-cache'
import { createSkipAnalysisService } from './services/skip-analysis'
import { createColdStorageService } from './services/cold-storage'
import { createShikimoriSyncService } from './services/shikimori-sync'
import { createTrackerFanOut } from './services/trackers/fan-out'
import { createTrackerRates } from './services/trackers/rates'
import { createTrackerChoices } from './services/trackers/choices'
import { createShikimoriEventBridge } from './trackers/events'
import { createTrackerLifecycle } from './trackers/lifecycle'
import { connectedAccounts } from './trackers/primary'
import { createTrackerAuthSessions } from './trackers/auth-session'
import { createShikimoriProvider } from './trackers/shikimori.provider'
import { createAniListProvider } from './trackers/anilist/provider'
import { createAniListSyncService } from './trackers/anilist/sync'
import { createAniListEventBridge } from './trackers/anilist/events'
import { createAniListPrimary } from './services/trackers/anilist-primary'
import { newTrackerCardsEnabled } from './trackers/flags'
import { bootDrain, edgeTrackers, kickoffTrackers } from './services/trackers/edges'
import type { TrackerSyncService } from './services/trackers/sync'
import { createStreamingService, PLAYER_DIAG_LOG_FILENAME } from './streaming'
import { createMp4StatsService } from './services/mp4-stats'
import { createPlayerLockService } from './services/player-lock'
import { createPlayerPresenceService } from './services/player-presence'
import { createSharedLibraryExportService } from './services/shared-library-export'
import { createSharedLibraryImportService } from './services/shared-library-import'
import { createAttachedLibraryService } from './services/attached-library'
import { createAvailabilityPoller } from './services/attached-library/poller'
import { createSnapshotCache, SNAPSHOT_DIR } from './services/attached-library/snapshot-cache'
import { createSyncBaseStore } from './lib/sync-state/bases'
import { createSyncRunner, type SyncRunner } from './services/sync-runner'
import { createRunnerRateRefresh } from './services/sync-runner/rate-refresh'
import { createLocalFiles } from './services/sync-runner/local-files'
import { createMountCandidates, mountParents } from './lib/shared-library/mount-candidates'
import { ownerAccountsOf } from './lib/shared-library/owner'
import { App } from './app/core'
import { registerIpcRouters } from './ipc'
import { createEpisodeFileScanner } from './lib/episode-file-scan'
import { windowIconPath } from './window-icon'

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

applyApiBaseOverrides(process.env, app.isPackaged)
// The AniList and MyAnimeList cards (#703/#702): off in a packaged build until the flag lifts.
const newTrackerCards = newTrackerCardsEnabled(app.isPackaged)

const store = openStorageOrExit()

// The AniList / MyAnimeList credential vault (#690). `safeStorage` is attached
// in `bootstrap()`, after `ready`, and is first used only for a non-null
// AniList or MAL credential, so a Shikimori-only profile never reaches it. A
// blob it can't decrypt is an accounts-state change (#696); `trackerLifecycle`
// is declared below, and nothing reads the vault while this module is set up.
const safeStorageHolder = createSafeStorageHolder()
const credentialVault = createCredentialVault({
  store,
  safeStorage: safeStorageHolder,
  onLocked: () => trackerLifecycle.notifyAccountsChanged()
})

function openStorageOrExit(): MainStorageService<typeof STORE_DEFAULTS> {
  const cwd = app.getPath('userData')
  try {
    return createStorageService(STORE_DEFAULTS, {
      cwd,
      // Keys whose last write must survive a crash inside the persist-coalescing
      // window: queued offline tracker edits and auth material. Everything else
      // (caches, watch positions) tolerates losing the final ≤500ms before a crash.
      writeThroughKeys: WRITE_THROUGH_KEYS
    })
  } catch (err) {
    return exitOnUnreadableConfig(err, cwd)
  }
}

// A settings file that can't be read, or can't be moved aside, without writing
// over it (#648). Before `ready`, Linux prints the box to stderr instead.
// `process.exit` stops the main module's evaluation here, so nothing below
// runs without a store.
function exitOnUnreadableConfig(err: unknown, cwd: string): never {
  dialog.showErrorBox('Anime DL', unreadableConfigMessage(err, cwd))
  process.exit(1)
}

function broadcastToAll(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

// Owns the mp4-faststart sampling state (Phase 3 slice 3g): the per-session
// probed-paths set + the write-serialization chain now live in the service.
const mp4StatsService = createMp4StatsService({ store })
const playerLockService = createPlayerLockService()
const playerPresenceService = createPlayerPresenceService()
// Attached Shared Libraries (#578). Their roots live only in this service. An
// unplugged library renders from its snapshot cache, and a claim PC's rates
// come from the library base under `sync-bases/` (#582).
// The merge runner (#584), created once the Shikimori sync service exists;
// Forget waits for its run on the library through `syncIdle`.
let syncRunner: SyncRunner | null = null
const attachedLibraryService = createAttachedLibraryService({
  store,
  checkFfmpeg: () => checkFfmpeg(),
  onChanged: () => broadcastToAll(EVENT_CHANNELS.SHARED_LIBRARIES_CHANGED),
  syncIdle: (libraryId) => syncRunner?.idle(libraryId) ?? Promise.resolve(),
  snapshotCache: createSnapshotCache({ dir: path.join(app.getPath('userData'), SNAPSHOT_DIR) }),
  syncBases: createSyncBaseStore(path.join(app.getPath('userData'), 'sync-bases'), fs.promises)
})
// Drive detection (#581). `ANIME_DL_MOUNT_PARENTS` (unpackaged runs only, as
// the API base overrides) points the candidates at test folders.
const mountParentsEnv = !app.isPackaged
  ? process.env.ANIME_DL_MOUNT_PARENTS?.split(path.delimiter).filter(Boolean)
  : undefined
const mountOverrides = mountParentsEnv?.length ? { parents: mountParentsEnv } : {}
const availabilityPoller = createAvailabilityPoller({
  target: attachedLibraryService,
  candidates: createMountCandidates(mountOverrides),
  mountParents: mountParents(mountOverrides),
  onFound: (found) => broadcastToAll(EVENT_CHANNELS.SHARED_LIBRARY_FOUND, found)
})

// --- Anime cache helpers (for offline support + fast-loading detail view) ---

function isDownloadedAnime(animeId: number): boolean {
  const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
  return !!downloaded[String(animeId)]
}

// Starred, downloaded, or watched in the last 90 days (#570), so
// continue-watching titles keep their cache offline.
const { recentWatch, isCachable: isCachableAnime } = createCacheScope(store)

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

// Offline mode (#567). `net.ts` asks the service before every request and
// reports every outcome to it; the edges reach the rest of the app through the
// kick-off, which `bootstrap()` builds once the download manager exists.
let offlineKickoff: OfflineKickoff | null = null
const offlineService = createOfflineService({
  store,
  probeUrls: () => [smotretApiBase(), shikimoriOrigin()],
  onOnline: () => offlineKickoff?.onOnline(),
  onOffline: () => offlineKickoff?.onOffline()
})
const isOffline = (): boolean => offlineService.isOffline()
setOfflineCheck(isOffline)
setNetworkObserver(offlineService.observer)

// The Shikimori broadcast bridge (#694): every Shikimori emitter gets this one,
// which double-emits the four rate, queue and status broadcasts as their
// `tracker:*` twins with `trackerId: 'shikimori'` (#717 removes it).
const shikimoriBroadcast = createShikimoriEventBridge({
  broadcast: broadcastToAll,
  channels: {
    rateUpdated: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
    ratesRefreshed: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
    syncStatus: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
    offlineQueueChanged: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED
  },
  needsSetup: () => shikimoriSyncService.tracker.needsSetup(),
  // `trackerRates` is declared below; the getter runs at emit time, and nothing
  // emits while this module is being set up.
  queuedAfter: () => trackerRates.queuedAfter('shikimori')
})
const shikimoriSyncService = createShikimoriSyncService({
  store,
  broadcast: shikimoriBroadcast,
  syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
  offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
  rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
  animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
  isOffline,
  snapshotsPath: path.join(app.getPath('userData'), 'shikimori-snapshots.json'),
  lookupByMalIds: (malIds) => lookupByMalIds(malIds),
  ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
})
// `ensureFreshToken` is where a dead refresh token is detected, but that module
// only knows about the store. Give it a way to push the transition out so the
// banner appears wherever expiry is discovered — including the fire-and-forget
// background refreshes that would otherwise swallow it (#244). The cleared
// credentials are also an accounts-state change (#696).
shikimori.setOnSessionExpired(() => {
  shikimoriSyncService.broadcastSyncStatus()
  trackerLifecycle.notifyAccountsChanged()
})
// AniList (#703): its provider, on the module-level host limiter, and its sync
// instance, which emits `tracker:*` only through its own bridge. A token
// AniList refuses clears the credential (session expired) and is an
// accounts-state change (#696 § 6); so is each "Needs setup" transition.
const anilistProvider = createAniListProvider({
  store,
  vault: credentialVault,
  lookupByMalIds: (malIds) => lookupByMalIds(malIds),
  isOffline,
  onSessionExpired: () => {
    anilistSync.broadcastSyncStatus()
    trackerLifecycle.notifyAccountsChanged()
  }
})
const anilistSync = createAniListSyncService(anilistProvider, {
  store,
  broadcast: createAniListEventBridge({
    broadcast: broadcastToAll,
    channels: {
      rateUpdated: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
      ratesRefreshed: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
      syncStatus: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
      offlineQueueChanged: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED
    },
    rateCache: anilistProvider.rateCache,
    needsSetup: () => anilistSync.needsSetup(),
    queuedAfter: () => trackerRates.queuedAfter('anilist')
  }),
  syncStatusChannel: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
  offlineQueueChangedChannel: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED,
  rateUpdatedChannel: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
  ratesRefreshedChannel: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
  isOffline,
  onNeedsSetupChanged: () => trackerLifecycle.notifyAccountsChanged()
})
// AniList's primary branch (#703): queue-first, through the instance's drain.
const anilistPrimary = createAniListPrimary({
  store,
  sync: anilistSync as unknown as TrackerSyncService<unknown, unknown>,
  maybeBroadcastCleanupPrompt
})
// The fan-out writer (#692): one entry per tracker whose sync service has
// landed. The Shikimori router sets its primary branch; AniList's is set here.
// Its primary is the lifecycle's (#696 § 0), read at call time: the lifecycle
// is declared below, and nothing writes a rate while this module is set up.
const trackerFanOut = createTrackerFanOut({
  store,
  trackers: [
    { sync: shikimoriSyncService.tracker as TrackerSyncService<unknown, unknown> },
    {
      sync: anilistSync as unknown as TrackerSyncService<unknown, unknown>,
      writePrimary: (malId, change) => anilistPrimary.write(malId, change)
    }
  ],
  primary: () => trackerLifecycle.primary()
})
// The reads and writes behind the `tracker:*` channels and their `shikimori:*` aliases (#694).
const trackerRates = createTrackerRates({ store, trackers: trackerFanOut, isOffline })
// The account lifecycle per tracker and the sign-in attempts (#695). Each
// refers to the other only at call time: a logout cancels the held attempt,
// and an attempt completes through the lifecycle. Every accounts-state change
// is broadcast through the lifecycle's `notifyAccountsChanged()` (#696).
const trackerLifecycle = createTrackerLifecycle({
  store,
  vault: credentialVault,
  trackerRates,
  cancelAttempt: (id) => trackerAuth.cancel(id),
  broadcast: broadcastToAll,
  accountsChangedChannel: EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED,
  // An AniList or MAL login runs the Shared Library login run too (#714), as
  // Shikimori's does from its own steps: it drops a claim, then merges.
  afterLogin: () =>
    void syncRunner
      ?.runAll('login')
      .catch((err) => console.error('[sync] the login run failed:', err)),
  newTrackerCardsEnabled: newTrackerCards
})
// AniList's steps: the instance's own, plus the details prefetch's abort on a
// logout or a switch, so no prefetch outlives the account it was for.
trackerLifecycle.setSteps('anilist', {
  resetExtra: () => anilistProvider.abortPrefetch(),
  startTimer: () => anilistSync.startSyncTimer(),
  drain: () => void anilistSync.syncQueue(),
  stopTimer: () => anilistSync.stopSyncTimer(),
  broadcastStatus: () => anilistSync.broadcastSyncStatus(),
  broadcastQueue: () => anilistSync.broadcastQueueChanged()
})
// MyAnimeList (#702) adds its provider here: the sign-in flows, and the
// capabilities `tracker:set-feature-source` checks (#696).
const trackerProviders = {
  shikimori: createShikimoriProvider({ store }),
  anilist: anilistProvider
}
const trackerAuth = createTrackerAuthSessions({
  lifecycle: trackerLifecycle,
  providers: trackerProviders,
  isOffline,
  openExternal: (url) => shell.openExternal(url)
})
// The primary, mirror and feature-source setters (#696).
const trackerChoices = createTrackerChoices({
  store,
  trackers: trackerFanOut,
  lifecycle: trackerLifecycle,
  providers: trackerProviders
})
let downloadManager: DownloadManager

// First refreshed by the background ffmpeg-ensure task in `bootstrap()`. The
// episode-complete hook awaits `get()`, so a download finishing before ffmpeg
// is ready still merges correctly instead of silently skipping the merge; the
// export's pre-fetch (#577) awaits it before deciding whether a merge is coming.
// Prepare for offline (#592) refreshes it after an install or repair.
const ffmpegStatus = createFfmpegStatus<FfmpegInfo>(() => checkFfmpeg())

// The Shared Library merge (#584): the only writer of state to a drive.
const syncLocalFiles = createLocalFiles({
  store,
  scanEpisodeFiles: (name) => fileScanner.scanEpisodeFiles(name),
  sanitizeFilename,
  displayName: (anime) => getDisplayName(anime)
})
// The runner's wholesale refresh, through the bridge like every other Shikimori emitter (#694).
const runnerRateRefresh = createRunnerRateRefresh({
  store,
  lookupByMalIds: (malIds) => lookupByMalIds(malIds),
  broadcast: shikimoriBroadcast
})
syncRunner = createSyncRunner({
  store,
  userDataDir: app.getPath('userData'),
  attached: attachedLibraryService,
  sync: shikimoriSyncService,
  trackers: trackerFanOut.syncServices(),
  isOffline,
  onOnline: (listener) => {
    let wasOffline = offlineService.isOffline()
    return offlineService.onChange(() => {
      const offline = offlineService.isOffline()
      if (wasOffline && !offline) listener()
      wasOffline = offline
    })
  },
  broadcast: shikimoriBroadcast,
  runFinishedChannel: EVENT_CHANNELS.SYNC_RUN_FINISHED,
  appVersion: app.getVersion(),
  localEpisodeFile: syncLocalFiles.localEpisodeFile,
  resolveEpisodeFile: syncLocalFiles.resolveEpisodeFile,
  refreshRates: () => void runnerRateRefresh()
})

// Export to a Shared Library (#574). Reads the merge status lazily, so the
// manager can be constructed later in `bootstrap()`.
const sharedLibraryExport = createSharedLibraryExportService({
  userDataDir: app.getPath('userData'),
  store,
  scanEpisodeFiles: fileScanner.scanEpisodeFilesAsync,
  sanitizeFilename,
  mergeStatus: (translationId) => downloadManager.getMergeStatus(translationId),
  presence: playerPresenceService,
  // Every connected account (#714): the export creates or takes over a
  // library for the owner the user picked, never through a claim.
  actor: () => ({
    installId: store.ensureInstallId(),
    appVersion: app.getVersion(),
    ...ownerAccountsOf(connectedAccounts(store)),
    claim: null
  }),
  broadcast: (job) => broadcastToAll(EVENT_CHANNELS.EXPORT_JOB_UPDATED, job),
  onLibraryWritten: (libraryId, root) => attachedLibraryService.refresh(libraryId, root),
  // With metadata (#586): the state step is S9's library leg.
  writeLibraryState: (target) => syncRunner!.runExport(target),
  // Merge into MKV on export (#576): the queue's ffmpeg, behind its mutex.
  ffmpegCheck: () => checkFfmpeg(),
  merger: {
    merge: (req) =>
      downloadManager.mergeForExport({
        ...req,
        ffmpegPath: getFfmpegPath(),
        ffprobePath: getFfprobePath()
      }),
    cancel: (jobId) => downloadManager.cancelExportMerge(jobId)
  },
  // Pre-fetch (#577): missing episodes go through the ordinary download queue,
  // and the job watches it through the listener lists (#574).
  downloads: {
    enqueue: (requests) => downloadManager.enqueue(requests),
    getItem: (id) => downloadManager.getItem(id),
    isMergeCycleActive: () => downloadManager.isMergeCycleActive(),
    hasHeldMerge: () => downloadManager.hasHeldMerge(),
    onVideoDownloaded: (cb) => downloadManager.onVideoDownloaded(() => cb()),
    onMergeComplete: (cb) => downloadManager.onMergeComplete(() => cb())
  },
  mergeExpected: async () => {
    const ffmpegInfo = await ffmpegStatus.get()
    return isMergeExpected({
      autoMerge: store.get('autoMerge') as boolean,
      ffmpegInfo,
      ffmpegPath: getFfmpegPath()
    })
  },
  isOffline,
  // The storage roots the episode-file scan reads, hot first.
  downloadRoots: () => {
    const cold = coldStorageService.isAdvanced() ? coldStorageService.getColdStorageDir() : null
    return cold
      ? [coldStorageService.getDownloadDir(), cold]
      : [coldStorageService.getDownloadDir()]
  }
})

// Copy to this PC from an attached Shared Library (#579). It only reads the
// drive; the copies land in the hot (or cold) root and are registered like
// downloads.
const sharedLibraryImport = createSharedLibraryImportService({
  userDataDir: app.getPath('userData'),
  store,
  library: (libraryId) => attachedLibraryService.get(libraryId),
  localRoots: () => ({
    hot: coldStorageService.getDownloadDir(),
    cold: coldStorageService.isAdvanced() ? coldStorageService.getColdStorageDir() || null : null
  }),
  sanitizeFilename,
  mergeStatus: (translationId) => downloadManager.getMergeStatus(translationId),
  presence: playerPresenceService,
  broadcast: (job) => broadcastToAll(EVENT_CHANNELS.IMPORT_JOB_UPDATED, job),
  onImported: ({ dirName }) => {
    invalidateFileCacheByDirName(dirName)
    // The tab's "On this PC" badge and Library read `downloadedAnime`.
    broadcastToAll(EVENT_CHANNELS.SHARED_LIBRARIES_CHANGED)
  },
  candidates: createMountCandidates(mountOverrides)
})

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
  // A mid-episode ffmpeg run on a drive that went away (#582).
  classifyExit: (input, hint) => attachedLibraryService.classifyMissing(input, hint),
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

// Prepare for offline (#592): six steps, run in this order, plus a rates step
// per connected tracker but Shikimori after Shikimori's (#693). Every dependency
// is read when a run reaches it, so the download manager built in
// `bootstrap()` is in place by then.
const prepareOffline = createPrepareOfflineService({
  store,
  isOffline,
  broadcast: broadcastToAll,
  progressChannel: EVENT_CHANNELS.PREPARE_OFFLINE_PROGRESS
})
prepareOffline.registerStep(
  createBinariesStep({
    ensureFfmpeg: () => ensureFfmpeg(undefined, isOffline),
    ensureFpcalc: () => ensureFpcalc(undefined, isOffline),
    paths: () => ({ ...ffmpegInstallPaths(), fpcalc: fpcalcInstallPath() }),
    exists: (p) => fs.existsSync(p),
    verify: (p) => verifyBinary(p),
    remove: (p) => fs.promises.rm(p, { force: true }),
    clearFfmpegPaths,
    refreshFfmpegStatus: () => ffmpegStatus.refresh(),
    ffmpegUser: () => downloadManager?.ffmpegUser() ?? null,
    isPlayerOpen: () => playerPresenceService.isOpen(),
    isSkipAnalysisRunning: () => skipAnalysisService.getCurrentAnalysis() !== null
  })
)
prepareOffline.registerStep(
  createShikimoriRatesStep({
    isLoggedIn: () => store.get('shikimoriUser') !== null,
    drain: () => shikimoriSyncService.drainNow(),
    refreshRates: (opts) => shikimoriSyncService.refreshRates(opts),
    prefetchShikimoriDetails: () => shikimoriSyncService.prefetchShikimoriDetails(),
    abortPrefetch: () => shikimoriSyncService.abortPrefetch()
  })
)
// #693: one rates step per known tracker but Shikimori, connected or not; each
// joins a run only while its tracker is connected. AniList's runs its details
// prefetch as the third phase (#703).
registerTrackerRatesSteps(prepareOffline, {
  store,
  trackers: () => trackerFanOut.syncServices(),
  prefetch: {
    anilist: {
      prefetch: () => anilistProvider.prefetchDetails(),
      abortPrefetch: () => anilistProvider.abortPrefetch()
    }
  }
})
prepareOffline.registerStep(
  createMetadataStep(
    metadataDeps({ store, isCachable: isCachableAnime, smotretApi, animeCacheService })
  )
)
prepareOffline.registerStep(
  createLocalIntegrityStep(
    localIntegrityDeps({
      store,
      coldStorageService,
      getDownloadManager: () => downloadManager,
      getFfprobePath,
      probeDuration,
      sanitizeFilename,
      getDisplayName
    })
  )
)
prepareOffline.registerStep(createAttachedIntegrityStep(attachedLibraryService))
prepareOffline.registerStep(
  createLibrarySyncStep({
    list: () => attachedLibraryService.list(),
    runAll: (trigger) => syncRunner!.runAll(trigger),
    needReview: () => needReviewFrom(syncRunner!)()
  })
)

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

  return verifyBinary(ffmpegPath).then((check) => {
    if (!check.ok) {
      console.error(`[ffmpeg] Not available at ${ffmpegPath}:`, check.error)
      return result
    }

    const firstLine = check.version
    const versionMatch = firstLine.match(/ffmpeg version (\S+)/)
    result.available = true
    result.version = versionMatch ? versionMatch[1] : firstLine
    console.log(`[ffmpeg] Found: ${result.version} at ${ffmpegPath}`)

    // Detect available HEVC encoders
    return new Promise<FfmpegInfo>((resolve) => {
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
    startupNotice: store.startupNotice,
    credentialVault,
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
    trackers: trackerFanOut,
    trackerRates,
    primaryEntries: () => trackerRates.primaryEntries(),
    trackerLifecycle,
    trackerAuth,
    trackerChoices,
    newTrackerCardsEnabled: newTrackerCards,
    lookupByMalIds,
    maybeBroadcastCleanupPrompt,
    runAutoDownloadTick,
    broadcast: shikimoriBroadcast,
    checkEpisodeFiles,
    invalidateFileCacheByDirName,
    clearFileCache: fileScanner.clear,
    streamingService,
    mp4StatsService,
    playerLockService,
    playerPresenceService,
    offlineService,
    recentWatch,
    attachedLibraryService,
    sharedLibraryExport,
    sharedLibraryImport,
    syncRunner: syncRunner ?? undefined,
    prepareOffline
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
    icon: windowIconPath(__dirname, process.platform),
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
    // Renderer gone without a player:closed (crash / reload) — release every
    // player lock so deferred episodes can finalize.
    playerLockService.closeAll()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function bootstrap(): Promise<void> {
  // A getter, so the `safeStorage` module getter runs on the vault's first use.
  safeStorageHolder.attach(() => safeStorage)
  // Satisfy Shikimori's image hotlink protection so friend avatars (loaded by
  // the renderer straight from shikimori.io) render instead of coming back blank.
  installShikimoriReferer(session.defaultSession)
  // Must stay the session's only `onBeforeRequest` listener: Electron keeps the
  // last one, so a second would drop both the offline gate and the redirect of
  // stored legacy smotret poster URLs (#684).
  installOfflineRequestGate(
    session.defaultSession,
    isOffline,
    is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    rewriteLegacySmotretUrl
  )

  // Handle anime-video:// protocol for local video playback with Range request support.
  // Only one URL shape: anime-video://{absolute-path}. MKV streaming now uses MSE via IPC.
  // Growing .part files (watch-while-downloading, #63) are tail-streamed; the
  // handler lives in streaming/anime-video-protocol.ts so it can be unit-tested.
  protocol.handle(
    'anime-video',
    createAnimeVideoHandler({
      getActiveDownload: (fp) => downloadManager?.getActiveDownloadByPath(fp) ?? null,
      // Logs `drive-disconnected` for a file under an attached root (#582).
      onUnreadable: (fp, err) => void attachedLibraryService.reportUnreadable(fp, err)
    })
  )
  protocol.handle(
    'anime-poster',
    createAnimePosterHandler({
      posterDir: animeCacheService.getPosterCacheDir(),
      attachedPoster: (id) => attachedLibraryService.posterFor(id),
      libraryPoster: (libraryId, id) => attachedLibraryService.libraryPosterFor(libraryId, id)
    })
  )

  animeCacheService.cleanupStale()
  animeCacheService.purgeNonImagePosters()
  store.migrateWatchProgressV2()
  store.ensureInstallId()
  // The merge subscribes before the startup read, whose availability
  // transitions are its first trigger (#584).
  syncRunner?.start()
  // Re-reads the attached Shared Libraries (#578) in the background; reading
  // never writes to a drive.
  const sharedLibrariesRead = attachedLibraryService
    .init()
    .then(() => broadcastToAll(EVENT_CHANNELS.SHARED_LIBRARIES_CHANGED))
    .catch((err) => console.error('[shared-library] init failed:', err))

  downloadManager = new DownloadManager(
    coldStorageService.getDownloadDir(),
    smotretApi,
    app.getPath('userData'),
    () => (store.get('downloadSpeedLimit') as number) || 0,
    () => (store.get('concurrentDownloads') as number) || 2
  )
  downloadManager.loadQueue()
  downloadManager.setFileLockCheck(playerLockService.isLocked)
  downloadManager.setMergeHoldCheck(playerPresenceService.isOpen)
  downloadManager.setOfflineCheck(isOffline)
  syncplay.setOfflineCheck(isOffline)

  const showBackgroundNotification = (title: string, body: string): void => {
    if (BrowserWindow.getFocusedWindow() !== null) return
    new Notification({ title, body }).show()
  }

  // The four completion tails live in `lib/episode-completion.ts` (#409) so they
  // can be driven from a test; what stays here is the wiring, plus `notify` —
  // the one seam that needs `BrowserWindow` / `Notification`.
  const episodeCompletion = createEpisodeCompletionHandlers({
    store,
    downloadManager,
    fileScanner,
    coldStorageService,
    skipAnalysisService,
    mp4StatsService,
    getFfmpegInfo: () => ffmpegStatus.get(),
    getFfmpegPath,
    getFfprobePath,
    notify: showBackgroundNotification
  })
  // Watch-while-downloading (#63): when the player releases a file, finish any
  // episode whose .part → final rename (and merge) was deferred under the lock.
  const finalizeDeferredEpisodes = episodeCompletion.finalizeDeferredEpisodes
  playerLockService.onRelease(() => {
    void finalizeDeferredEpisodes().catch((err) =>
      console.error('[download] Deferred finalize failed:', err)
    )
  })
  // Merge hold (#516): the last player view closed — run what the hold
  // stopped. Either release may come first; both orders merge once.
  playerPresenceService.onRelease(() => {
    void episodeCompletion
      .resumeHeldMerges()
      .catch((err) => console.error('[download] Resuming held merges failed:', err))
  })

  downloadManager.onEpisodeComplete(episodeCompletion.handleEpisodeComplete)
  downloadManager.onMergeComplete(episodeCompletion.handleMergeComplete)

  downloadManager.onQueueComplete(() => {
    const mode = store.get('notificationMode') as string
    if (mode === 'queue') {
      showBackgroundNotification('Downloads complete', 'All downloads have finished')
    }
  })

  // A listener list (#574): later subscribers (S6c, S6d) append after this one
  // and can't unregister it. Registered here exactly once, before anything
  // else subscribes, so the metadata write and the mp4-faststart probe run
  // first; `download-manager-episode-metadata.test.ts` guards the single
  // registration and `download-manager-hooks.test.ts` that two listeners both
  // fire. The tail's own write-above-the-filter ordering is asserted
  // behaviourally, in `test/lib/episode-completion.test.ts`.
  downloadManager.onVideoDownloaded(episodeCompletion.handleVideoDownloaded)

  // An export a quit or crash interrupted shows as paused (#574).
  void sharedLibraryExport
    .init()
    .catch((err) => console.error('[export] Loading saved export jobs failed:', err))
  // So does a copy onto this PC (#579).
  void sharedLibraryImport
    .init()
    .catch((err) => console.error('[import] Loading saved import jobs failed:', err))

  // Register IPC BEFORE creating the window: the renderer mounts as soon as
  // the window loads, and it used to race a multi-second awaited ensureFfmpeg
  // download — on a cold start every view's first IPC call failed with
  // "No handler registered" and the UI sat dead (found while profiling #202).
  registerIpcHandlers()

  createWindow()
  const mainWin = BrowserWindow.getAllWindows()[0]
  // The availability poller (#581) starts once the startup read is in (its
  // first tick takes that read as current) and the window has loaded, so the
  // renderer is subscribed before a startup found-on-a-drive event goes out.
  // Window focus asks for a tick.
  const windowLoaded = new Promise<void>((resolve) =>
    mainWin.webContents.once('did-finish-load', () => resolve())
  )
  void Promise.all([sharedLibrariesRead, windowLoaded]).then(() => availabilityPoller.start())
  app.on('browser-window-focus', () => availabilityPoller.poke())
  const binaryInstalls = createBinaryInstalls({
    ensureFfmpeg: () => ensureFfmpeg(mainWin, isOffline),
    ensureFpcalc: () => ensureFpcalc(mainWin, isOffline)
  })

  // First-launch binary downloads run in the background — nothing else in
  // bootstrap may wait on the network. checkFfmpeg() never rejects; a failed
  // install leaves ffmpegStatus at { available: false }. Offline (#567) the
  // install is skipped rather than failed, and the online kick-off retries it.
  void (async () => {
    try {
      await binaryInstalls.ffmpeg()
    } catch (err) {
      console.error('[ffmpeg] Failed to ensure ffmpeg:', err)
    }
    // Best-effort: skip-detector will surface a clear error if fpcalc is missing.
    binaryInstalls.fpcalc().catch((err) => console.error('[fpcalc] Failed to ensure fpcalc:', err))
    await ffmpegStatus.refresh()
    // Crash recovery (#63): no locks exist at boot, so any 'deferred' episode
    // restored from queue.json gets its rename + merge now.
    await finalizeDeferredEpisodes().catch((err) =>
      console.error('[download] Boot deferred finalize failed:', err)
    )
  })()

  initAutoDownloader({
    store,
    smotretApi,
    downloadManager,
    broadcast: broadcastToAll,
    isShikimoriLoggedIn: () => Boolean(store.get('shikimoriCredentials')),
    refreshShikimoriDetails: (malId) => shikimoriSyncService.refreshShikimoriDetailsForMalId(malId),
    isOffline
  })
  offlineKickoff = createOfflineKickoff({
    // Read at each online edge (#693): Shikimori, then every connected tracker.
    trackers: () =>
      kickoffTrackers(
        store,
        trackerFanOut.syncServices(),
        () => shikimoriSyncService.prefetchShikimoriDetails(),
        // AniList's: list titles only, per the AniList terms of use (#703).
        { anilist: () => anilistProvider.prefetchDetails() }
      ),
    suspendDownloads: () => downloadManager.suspendForOffline(),
    resumeDownloads: () => downloadManager.resumeAfterOffline(),
    suspendSyncplay: () => syncplay.suspendForOffline(),
    resumeSyncplay: () => syncplay.resumeAfterOffline(),
    retryBinaries: () => binaryInstalls.retry(),
    runAutoDownloadTick: () => runAutoDownloadTick('timer')
  })
  startAutoDownloaderTimer()
  setTimeout(() => {
    void runAutoDownloadTick('startup').catch((err) =>
      console.warn('[auto-dl] startup tick failed:', err)
    )
  }, 30_000)

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

  // Reconcile `downloadedEpisodes` against disk. This is the only collector now
  // that `downloaded-episodes-get` is a pure read (#423) — startup is a moment
  // that is allowed to write, unlike a page open. The active set is built here
  // rather than at `loadQueue()` time so it reflects the queue at sweep time:
  // `loadQueue` restores interrupted items as `paused`, and those still produce
  // a group, which is what keeps a `.part`-under-lock download's metadata alive.
  setTimeout(() => {
    try {
      const activeTrIds = new Set(downloadManager.getEpisodeGroups().map((g) => g.translationId))
      const r = coldStorageService.reconcileDownloadedEpisodes(activeTrIds)
      if (r.dropped > 0) {
        console.log(
          `[storage] downloadedEpisodes reconcile: kept ${r.kept}, dropped ${r.dropped} stale entries`
        )
      }
    } catch (e) {
      console.warn(
        `[storage] downloadedEpisodes reconcile failed: ${e instanceof Error ? e.message : e}`
      )
    }
  }, 30_000)

  registerSyncplayBroadcasts(syncplay, broadcastToAll)

  // Shikimori signed in or not, as in 6.0.21; every other tracker when connected (#693).
  bootDrain(edgeTrackers(store, trackerFanOut.syncServices()))

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
      availabilityPoller.stop()
      attachedLibraryService.saveLastSeen()
      // Last: persist store writes still sitting on the coalescing timer —
      // without this, writes from the final ≤500ms (including any made by the
      // teardown above) are dropped on quit.
      store.flush()
    }
  })
  .catch((err) => {
    console.error('[app] startup failed:', err)
    app.exit(1)
  })
