import { ipcMain } from 'electron'
import { markSlow, SLOW_IPC_MS } from '../lib/perf'
import type { StorageService } from '../store/types'
import type { SmotretApi, AnimeDetail, AnimeSearchResult } from '../smotret-api'
import type { AnimeCacheService } from '../services/anime-cache'
import type { ColdStorageService } from '../services/cold-storage'
import type { SkipAnalysisService } from '../services/skip-analysis'
import type { ShikimoriSyncService } from '../services/shikimori-sync'
import type { DownloadManager } from '../download-manager'
import type { ShikiUserRateStatus } from '../shikimori'
import type { AutoDlReason, AutoDlTickResult } from '../auto-downloader'
import type { StreamingService } from '../streaming'
import type { Mp4StatsService } from '../services/mp4-stats'
import * as appRouter from './app.ipc'
import * as animeRouter from './anime.ipc'
import * as libraryRouter from './library.ipc'
import * as cacheRouter from './cache.ipc'
import * as homeRouter from './home.ipc'
import * as downloadsRouter from './downloads.ipc'
import * as ffmpegRouter from './ffmpeg.ipc'
import * as cleanupRouter from './cleanup.ipc'
import * as downloadedAnimeRouter from './downloaded-anime.ipc'
import * as shikimoriRouter from './shikimori.ipc'
import * as skipDetectorRouter from './skip-detector.ipc'
import * as storageRouter from './storage.ipc'
import * as fileRouter from './file.ipc'
import * as shellRouter from './shell.ipc'
import * as settingsRouter from './settings.ipc'
import * as watchProgressRouter from './watch-progress.ipc'
import * as autoDownloadRouter from './auto-download.ipc'
import * as playerRouter from './player.ipc'
import * as syncplayRouter from './syncplay.ipc'
import * as debugRouter from './debug.ipc'
import type { FileCheckResult } from '../lib/episode-file-scan'

export interface FfmpegInfo {
  available: boolean
  version: string
  path: string
  encoders: string[]
}

// The episode-file scan result type lives with the scanner (#196). Re-exported
// here so the long-standing `import { FileCheckResult } from './ipc'` sites stay
// put.
export type { FileCheckResult }

/**
 * Dependencies passed to every per-domain IPC router (refactor epic #84,
 * Phase 3 — decision 3). Grows as later slices extract more services out of
 * `index.ts`; routers must never reach for module-level singletons.
 */
export interface AppDeps {
  store: StorageService
  smotretApi: SmotretApi
  animeCacheService: AnimeCacheService
  coldStorageService: ColdStorageService
  skipAnalysisService: SkipAnalysisService
  downloadManager: DownloadManager
  /**
   * Updates `store.recentAnimeMeta[detail.id]` with the freshest poster/title
   * snapshot. Hoisted as a dep so the anime + home routers don't import the
   * index.ts closure.
   */
  rememberAnimeMeta: (detail: AnimeDetail) => void
  /**
   * Live readers for the ffmpeg/ffprobe paths set by `ensureFfmpeg`. The
   * paths are mutated by `FFMPEG_DELETE`, so handlers must read through the
   * getter on every invocation instead of capturing the value at register-time.
   */
  getFfmpegPath: () => string
  getFfprobePath: () => string
  clearFfmpegPaths: () => void
  /** Resets the file-existence cache in `index.ts` after a delete. */
  invalidateFileCache: (animeName: string) => void
  /** `app.getPath('userData')`/ffmpeg working directory used by `FFMPEG_DELETE`. */
  getFfmpegDir: () => string
  sumShowFiles: (animeName: string) => Promise<{ bytes: number; files: number }>
  checkFfmpeg: () => Promise<FfmpegInfo>
  getDisplayName: (anime: AnimeSearchResult) => string
  shikimoriSyncService: ShikimoriSyncService
  /** Resolves smotret-anime entries for a batch of MAL ids (poster-enriched). */
  lookupByMalIds: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  /** Emits `cleanup:prompt` when a downloaded show transitions to `completed`. */
  maybeBroadcastCleanupPrompt: (
    smotretAnime: unknown,
    malId: number,
    status: ShikiUserRateStatus,
    prevStatus?: ShikiUserRateStatus
  ) => Promise<void>
  runAutoDownloadTick: (reason: AutoDlReason) => Promise<AutoDlTickResult>
  /** Fan-out broadcaster to every renderer window (the index.ts `broadcastToAll`). */
  broadcast: (channel: string, ...args: unknown[]) => void
  /**
   * Episode-file scanner for `CHANNELS.FILE_CHECK_EPISODES` — cache-first, with
   * a background rescan kicked off when a cache hit is served. The scan cache +
   * helpers stay in `index.ts` because `coldStorageService` also feeds off them.
   */
  checkEpisodeFiles: (animeName: string, episodeInts: string[]) => Promise<FileCheckResult>
  /** Drops the file-scan cache entry whose key sanitizes to `dirName`. */
  invalidateFileCacheByDirName: (dirName: string) => void
  /** Clears the entire file-scan cache (used before a bulk move-to-cold). */
  clearFileCache: () => void
  /** MSE remux/transcode session manager backing the `player:*` channels. */
  streamingService: StreamingService
  /** mp4-faststart sampling service backing `player:find-local-file` + the mp4 debug channels. */
  mp4StatsService: Mp4StatsService
}

/**
 * Wires every per-domain `*.ipc.ts` router in order. As of Phase 3 slice 3g
 * this is the single IPC entry point — `src/main/index.ts` no longer carries
 * any `ipcMain.handle` calls of its own.
 */
export function registerIpcRouters(deps: AppDeps): void {
  // Every reply below shares the main-process event loop, so one slow handler
  // stalls all of them. Intercept `ipcMain.handle` for the duration of router
  // registration so every channel gets a wall-clock probe that logs replies
  // slower than SLOW_IPC_MS — the profiling that surfaced the store-thrash
  // behind the slow anime-detail open.
  const originalHandle = ipcMain.handle
  ipcMain.handle = ((
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ) => {
    originalHandle.call(ipcMain, channel, async (event, ...args) => {
      const t0 = performance.now()
      try {
        return await handler(event, ...args)
      } finally {
        markSlow(`ipc ${channel}`, t0, SLOW_IPC_MS)
      }
    })
  }) as typeof ipcMain.handle
  try {
    registerAllRouters(deps)
  } finally {
    ipcMain.handle = originalHandle
  }
}

function registerAllRouters(deps: AppDeps): void {
  appRouter.register(deps)
  animeRouter.register(deps)
  libraryRouter.register(deps)
  cacheRouter.register(deps)
  homeRouter.register(deps)
  downloadsRouter.register(deps)
  ffmpegRouter.register(deps)
  cleanupRouter.register(deps)
  downloadedAnimeRouter.register(deps)
  shikimoriRouter.register(deps)
  skipDetectorRouter.register(deps)
  storageRouter.register(deps)
  fileRouter.register(deps)
  shellRouter.register(deps)
  settingsRouter.register(deps)
  watchProgressRouter.register(deps)
  autoDownloadRouter.register(deps)
  playerRouter.register(deps)
  syncplayRouter.register(deps)
  debugRouter.register(deps)
}
