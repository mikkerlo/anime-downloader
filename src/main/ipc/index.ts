import type { StorageService } from '../store/types'
import type { SmotretApi, AnimeDetail, AnimeSearchResult } from '../smotret-api'
import type { AnimeCacheService } from '../services/anime-cache'
import type { ColdStorageService } from '../services/cold-storage'
import type { SkipAnalysisService } from '../services/skip-analysis'
import type { ShikimoriSyncService } from '../services/shikimori-sync'
import type { DownloadManager } from '../download-manager'
import type { ShikiUserRateStatus } from '../shikimori'
import type { AutoDlReason, AutoDlTickResult } from '../auto-downloader'
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

export interface FfmpegInfo {
  available: boolean
  version: string
  path: string
  encoders: string[]
}

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
}

/**
 * Wires every per-domain `*.ipc.ts` router in order. Phase 3 lands these in
 * slices; the legacy `registerIpcHandlers()` in `src/main/index.ts` keeps the
 * un-migrated handlers until 3d–3g finish.
 */
export function registerIpcRouters(deps: AppDeps): void {
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
}
