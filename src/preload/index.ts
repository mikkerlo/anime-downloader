import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'

// Per-channel map of {original-callback → wrapped-handler} so the matching
// off* helper can call ipcRenderer.removeListener with the actual wrapped
// function (the one we registered on ipcRenderer.on). Without this map,
// the only way to remove a listener is removeAllListeners — which would
// also rip out listeners installed by other components in the same view.
type SyncplayHandler<T> = (data: T) => void
type SyncplayWrapped = (event: IpcRendererEvent, data: unknown) => void
const syncplayWrappers = new Map<string, Map<SyncplayHandler<unknown>, SyncplayWrapped>>()

function syncplayOn<T>(channel: string, cb: SyncplayHandler<T>): void {
  const wrapped: SyncplayWrapped = (_event, data) => cb(data as T)
  let bucket = syncplayWrappers.get(channel)
  if (!bucket) {
    bucket = new Map()
    syncplayWrappers.set(channel, bucket)
  }
  bucket.set(cb as SyncplayHandler<unknown>, wrapped)
  ipcRenderer.on(channel, wrapped)
}

function syncplayOff<T>(channel: string, cb: SyncplayHandler<T>): void {
  const bucket = syncplayWrappers.get(channel)
  if (!bucket) return
  const wrapped = bucket.get(cb as SyncplayHandler<unknown>)
  if (!wrapped) return
  ipcRenderer.removeListener(channel, wrapped)
  bucket.delete(cb as SyncplayHandler<unknown>)
}

const api = {
  validateToken: () => ipcRenderer.invoke(CHANNELS.VALIDATE_TOKEN),
  searchAnime: (query: string) => ipcRenderer.invoke(CHANNELS.SEARCH_ANIME, query),
  getAnime: (id: number) => ipcRenderer.invoke(CHANNELS.GET_ANIME, id),
  getAnimeCache: (id: number) =>
    ipcRenderer.invoke(CHANNELS.GET_ANIME_CACHE, id) as Promise<{
      data: AnimeDetail
      cachedAt: number
    } | null>,
  setAnimeCache: (id: number, data: AnimeDetail) =>
    ipcRenderer.invoke(CHANNELS.SET_ANIME_CACHE, id, data) as Promise<boolean>,
  getEpisode: (id: number, animeId?: number) =>
    ipcRenderer.invoke(CHANNELS.GET_EPISODE, id, animeId),
  probeEmbedQuality: (translationId: number, animeId?: number) =>
    ipcRenderer.invoke(CHANNELS.PROBE_EMBED_QUALITY, translationId, animeId) as Promise<
      number | null
    >,
  probeFullScanNeeded: (animeId: number, episodeCount: number) =>
    ipcRenderer.invoke(CHANNELS.PROBE_FULL_SCAN_NEEDED, animeId, episodeCount) as Promise<boolean>,
  probeFullScanDone: (animeId: number, episodeCount: number) =>
    ipcRenderer.invoke(CHANNELS.PROBE_FULL_SCAN_DONE, animeId, episodeCount) as Promise<void>,
  reportQualityMismatch: (data: {
    translationId: number
    author: string
    type: string
    reported: number
    actual: number
  }) => ipcRenderer.invoke(CHANNELS.REPORT_QUALITY_MISMATCH, data),
  getQualityMismatchCount: () =>
    ipcRenderer.invoke(CHANNELS.GET_QUALITY_MISMATCH_COUNT) as Promise<number>,
  dumpQualityMismatches: () =>
    ipcRenderer.invoke(CHANNELS.DUMP_QUALITY_MISMATCHES) as Promise<{
      count: number
      path: string
    }>,
  debugGetMp4Stats: () =>
    ipcRenderer.invoke(CHANNELS.DEBUG_GET_MP4_STATS) as Promise<Mp4StreamingStats>,
  debugResetMp4Stats: () => ipcRenderer.invoke(CHANNELS.DEBUG_RESET_MP4_STATS) as Promise<void>,
  getCachedPoster: (animeId: number) =>
    ipcRenderer.invoke(CHANNELS.CACHE_GET_POSTER, animeId) as Promise<string | null>,
  libraryGet: () => ipcRenderer.invoke(CHANNELS.LIBRARY_GET),
  libraryToggle: (anime: unknown) => ipcRenderer.invoke(CHANNELS.LIBRARY_TOGGLE, anime),
  libraryHas: (id: number) => ipcRenderer.invoke(CHANNELS.LIBRARY_HAS, id),
  libraryGetStatus: (ids: number[]) =>
    ipcRenderer.invoke(CHANNELS.LIBRARY_GET_STATUS, ids) as Promise<
      Record<number, { starred: boolean; downloaded: boolean }>
    >,
  libraryIsDownloaded: (id: number) => ipcRenderer.invoke(CHANNELS.LIBRARY_IS_DOWNLOADED, id),
  downloadedAnimeAdd: (anime: unknown) => ipcRenderer.invoke(CHANNELS.DOWNLOADED_ANIME_ADD, anime),
  downloadedAnimeDelete: (animeId: number, animeName: string) =>
    ipcRenderer.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, animeId, animeName),
  cleanupGetSize: (animeId: number, animeName: string) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_GET_SIZE, animeId, animeName) as Promise<{
      bytes: number
      files: number
    }>,
  cleanupGetActiveDownloads: (animeName: string) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_GET_ACTIVE_DOWNLOADS, animeName) as Promise<{
      active: number
    }>,
  cleanupExecute: (animeId: number, animeName: string) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_EXECUTE, animeId, animeName) as Promise<void>,
  cleanupGetSnoozed: () =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_GET_SNOOZED) as Promise<
      Record<string, { animeName: string }>
    >,
  cleanupSetSnoozed: (animeId: number, snoozed: boolean) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_SET_SNOOZED, animeId, snoozed) as Promise<void>,
  onCleanupPrompt: (
    callback: (data: { animeId: number; animeName: string; malId: number }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.CLEANUP_PROMPT, (_event, data) => callback(data))
  },
  offCleanupPrompt: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.CLEANUP_PROMPT)
  },
  getSetting: (key: string) => ipcRenderer.invoke(CHANNELS.GET_SETTING, key),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke(CHANNELS.SET_SETTING, key, value),

  homeGetContinueWatching: () =>
    ipcRenderer.invoke(CHANNELS.HOME_GET_CONTINUE_WATCHING) as Promise<ContinueWatchingEntry[]>,

  // Watch progress
  watchProgressSave: (
    animeId: number,
    episodeInt: string,
    position: number,
    duration: number,
    watched?: boolean,
    translationId?: number
  ) =>
    ipcRenderer.invoke(
      CHANNELS.WATCH_PROGRESS_SAVE,
      animeId,
      episodeInt,
      position,
      duration,
      watched,
      translationId
    ),
  watchProgressGet: (animeId: number, episodeInt: string) =>
    ipcRenderer.invoke(CHANNELS.WATCH_PROGRESS_GET, animeId, episodeInt) as Promise<{
      position: number
      duration: number
      updatedAt: number
      watched?: boolean
      translationId?: number
    } | null>,
  watchProgressGetAll: (animeId: number) =>
    ipcRenderer.invoke(CHANNELS.WATCH_PROGRESS_GET_ALL, animeId) as Promise<
      Record<
        string,
        {
          position: number
          duration: number
          updatedAt: number
          watched?: boolean
          translationId?: number
        }
      >
    >,

  // Downloads
  downloadEnqueue: (requests: unknown[]) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_ENQUEUE, requests),
  downloadPause: (id: string) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_PAUSE, id),
  downloadResume: (id: string) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_RESUME, id),
  downloadRestart: (id: string) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_RESTART, id),
  downloadRestartAllFailed: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_RESTART_ALL_FAILED),
  downloadPauseAll: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_PAUSE_ALL),
  downloadResumeAll: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_RESUME_ALL),
  downloadCancel: (id: string) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_CANCEL, id),
  downloadGetQueue: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_GET_QUEUE),
  downloadCancelByEpisode: (animeName: string, episodeLabel?: string) =>
    ipcRenderer.invoke(CHANNELS.DOWNLOAD_CANCEL_BY_EPISODE, animeName, episodeLabel),
  downloadedEpisodesGet: (animeId: number) =>
    ipcRenderer.invoke(CHANNELS.DOWNLOADED_EPISODES_GET, animeId),
  downloadClearCompleted: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_CLEAR_COMPLETED),
  downloadCancelMerge: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_CANCEL_MERGE),
  downloadMerge: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_MERGE),
  ffmpegCheck: () => ipcRenderer.invoke(CHANNELS.FFMPEG_CHECK),
  ffmpegDelete: () => ipcRenderer.invoke(CHANNELS.FFMPEG_DELETE),
  downloadPickDir: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_PICK_DIR),
  // File management
  fileCheckEpisodes: (animeName: string, episodeInts: string[]) =>
    ipcRenderer.invoke(CHANNELS.FILE_CHECK_EPISODES, animeName, episodeInts),
  fileOpen: (filePath: string) => ipcRenderer.invoke(CHANNELS.FILE_OPEN, filePath),
  fileShowInFolder: (filePath: string) =>
    ipcRenderer.invoke(CHANNELS.FILE_SHOW_IN_FOLDER, filePath),
  fileDeleteEpisode: (
    animeName: string,
    episodeInt: string,
    animeId?: number,
    translationId?: number
  ) =>
    ipcRenderer.invoke(CHANNELS.FILE_DELETE_EPISODE, animeName, episodeInt, animeId, translationId),
  onFileEpisodesChanged: (
    callback: (
      animeName: string,
      data: Record<
        string,
        { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
      >
    ) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.FILE_EPISODES_CHANGED, (_event, animeName, data) =>
      callback(animeName, data)
    )
  },
  offFileEpisodesChanged: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.FILE_EPISODES_CHANGED)
  },

  // Storage
  storagePickHotDir: () => ipcRenderer.invoke(CHANNELS.STORAGE_PICK_HOT_DIR),
  storagePickColdDir: () => ipcRenderer.invoke(CHANNELS.STORAGE_PICK_COLD_DIR),
  storageMoveToCold: () => ipcRenderer.invoke(CHANNELS.STORAGE_MOVE_TO_COLD),
  onStorageMoveToColdProgress: (
    callback: (data: { current: number; total: number; file: string }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.STORAGE_MOVE_TO_COLD_PROGRESS, (_event, data) => callback(data))
  },
  offStorageMoveToColdProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.STORAGE_MOVE_TO_COLD_PROGRESS)
  },
  storageGetUsage: () => ipcRenderer.invoke(CHANNELS.STORAGE_GET_USAGE) as Promise<StorageUsage>,
  storageRunCleanup: (opts?: { force?: boolean }) =>
    ipcRenderer.invoke(CHANNELS.STORAGE_RUN_CLEANUP, opts) as Promise<CleanupResult>,
  onStorageUsageProgress: (callback: (data: { scanned: number; total: number }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.STORAGE_USAGE_PROGRESS, (_event, data) => callback(data))
  },
  offStorageUsageProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.STORAGE_USAGE_PROGRESS)
  },
  onStorageCleanupPending: (callback: (data: { candidates: CleanupCandidate[] }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.STORAGE_CLEANUP_PENDING, (_event, data) => callback(data))
  },
  offStorageCleanupPending: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.STORAGE_CLEANUP_PENDING)
  },
  onStorageCleanupFinished: (callback: (data: CleanupResult) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.STORAGE_CLEANUP_FINISHED, (_event, data) => callback(data))
  },
  offStorageCleanupFinished: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.STORAGE_CLEANUP_FINISHED)
  },

  downloadScanMerge: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_SCAN_MERGE),
  downloadFixMetadata: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_FIX_METADATA),
  onFixMetadataProgress: (callback: (data: unknown) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.FIX_METADATA_PROGRESS, (_event, data) => callback(data))
  },
  offFixMetadataProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.FIX_METADATA_PROGRESS)
  },

  onDownloadProgress: (callback: (data: unknown) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.DOWNLOAD_PROGRESS, (_event, data) => callback(data))
  },
  offDownloadProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.DOWNLOAD_PROGRESS)
  },
  onScanMergeProgress: (callback: (data: unknown) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.SCAN_MERGE_PROGRESS, (_event, data) => callback(data))
  },
  offScanMergeProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SCAN_MERGE_PROGRESS)
  },
  onFfmpegDownloadProgress: (callback: (data: { status: string; progress?: number }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.FFMPEG_DOWNLOAD_PROGRESS, (_event, data) => callback(data))
  },
  offFfmpegDownloadProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.FFMPEG_DOWNLOAD_PROGRESS)
  },
  onFpcalcDownloadProgress: (callback: (data: { status: string; progress?: number }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.FPCALC_DOWNLOAD_PROGRESS, (_event, data) => callback(data))
  },
  offFpcalcDownloadProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.FPCALC_DOWNLOAD_PROGRESS)
  },

  // Skip detection (Phase 1: debug panel only)
  skipDetectorAnalyzeShow: (
    animeId: number,
    episodes: { episodeInt: string; episodeLabel: string; filePath: string }[]
  ) =>
    ipcRenderer.invoke(
      CHANNELS.SKIP_DETECTOR_ANALYZE_SHOW,
      animeId,
      episodes
    ) as Promise<ShowSkipDetections>,
  skipDetectorGetDetections: (animeId: number) =>
    ipcRenderer.invoke(
      CHANNELS.SKIP_DETECTOR_GET_DETECTIONS,
      animeId
    ) as Promise<ShowSkipDetections | null>,
  skipDetectorDetectStream: (animeId: number, episodeInt: string, streamUrl: string) =>
    ipcRenderer.invoke(
      CHANNELS.SKIP_DETECTOR_DETECT_STREAM,
      animeId,
      episodeInt,
      streamUrl
    ) as Promise<EpisodeSkipDetection | null>,
  skipDetectorCancelStreamDetect: () =>
    ipcRenderer.invoke(CHANNELS.SKIP_DETECTOR_CANCEL_STREAM_DETECT) as Promise<void>,
  skipDetectorGetStatus: () =>
    ipcRenderer.invoke(CHANNELS.SKIP_DETECTOR_GET_STATUS) as Promise<{
      animeId: number
      lastProgress: SkipDetectorProgress | null
    } | null>,
  skipDetectorCancel: () => ipcRenderer.invoke(CHANNELS.SKIP_DETECTOR_CANCEL) as Promise<void>,
  skipDetectorCacheStats: () =>
    ipcRenderer.invoke(CHANNELS.SKIP_DETECTOR_CACHE_STATS) as Promise<{ fingerprintCount: number }>,
  skipDetectorBackfillAll: () =>
    ipcRenderer.invoke(CHANNELS.SKIP_DETECTOR_BACKFILL_ALL) as Promise<{
      queued: number
      alreadyAnalyzed: number
      skippedFewEpisodes: number
      total: number
    }>,
  skipDetectorQueueStatus: () =>
    ipcRenderer.invoke(CHANNELS.SKIP_DETECTOR_QUEUE_STATUS) as Promise<{
      currentAnimeId: number | null
      queueLength: number
    }>,
  onSkipDetectorProgress: (callback: (data: SkipDetectorProgress) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.SKIP_DETECTOR_ANALYZE_PROGRESS, (_event, data) => callback(data))
  },
  offSkipDetectorProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SKIP_DETECTOR_ANALYZE_PROGRESS)
  },
  onSkipDetectorSignatureUpdated: (
    callback: (data: { animeId: number; perEpisode: Record<string, EpisodeSkipDetection> }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.SKIP_DETECTOR_SIGNATURE_UPDATED, (_event, data) => callback(data))
  },
  offSkipDetectorSignatureUpdated: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SKIP_DETECTOR_SIGNATURE_UPDATED)
  },

  injectChapters: (
    animeId: number,
    episodes: { episodeInt: string; episodeLabel: string; filePath: string }[]
  ) =>
    ipcRenderer.invoke(CHANNELS.DOWNLOAD_INJECT_CHAPTERS, animeId, episodes) as Promise<{
      written: number
      skipped: number
      failed: number
      total: number
    }>,
  onChapterInjectProgress: (callback: (data: ChapterInjectProgress) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.CHAPTER_INJECT_PROGRESS, (_event, data) => callback(data))
  },
  offChapterInjectProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.CHAPTER_INJECT_PROGRESS)
  },

  shellOpenExternal: (url: string) =>
    ipcRenderer.invoke(CHANNELS.SHELL_OPEN_EXTERNAL, url) as Promise<boolean>,

  // Player
  playerGetStreamUrl: (translationId: number, maxHeight: number) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_GET_STREAM_URL, translationId, maxHeight),
  playerGetLocalSubtitles: (filePath: string) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_GET_LOCAL_SUBTITLES, filePath) as Promise<string | null>,
  playerFindLocalFile: (
    animeName: string,
    episodeInt: string,
    translationId: number,
    episodeLabel: string
  ) =>
    ipcRenderer.invoke(
      CHANNELS.PLAYER_FIND_LOCAL_FILE,
      animeName,
      episodeInt,
      translationId,
      episodeLabel
    ) as Promise<{ filePath: string; subtitleContent: string | null } | null>,
  playerRemuxMkv: (mkvPath: string) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_REMUX_MKV, mkvPath) as Promise<
      { mp4Path: string; subtitleContent?: string } | { error: string }
    >,
  playerRemuxMkvStream: (mkvPath: string, initialSeek?: number) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_REMUX_MKV_STREAM, mkvPath, initialSeek) as Promise<
      | {
          sessionId: string
          generation: number
          duration: number
          mimeType: string
          hasSubtitlesPending: boolean
          initialSeek: number
        }
      | { error: string }
    >,
  playerRemuxMkvStreamTranscode: (mkvPath: string, initialSeek?: number) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE, mkvPath, initialSeek) as Promise<
      | {
          sessionId: string
          generation: number
          duration: number
          mimeType: string
          hasSubtitlesPending: boolean
          initialSeek: number
        }
      | { error: string }
    >,
  shellOpenExternalFile: (filePath: string) =>
    ipcRenderer.invoke(CHANNELS.SHELL_OPEN_EXTERNAL_FILE, filePath) as Promise<{
      ok: boolean
      error?: string
    }>,
  playerStreamStart: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_STREAM_START, sessionId) as Promise<void>,
  playerStreamAck: (sessionId: string, bytes: number) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_STREAM_ACK, sessionId, bytes) as Promise<void>,
  playerStreamSeek: (sessionId: string, seekSeconds: number) =>
    ipcRenderer.invoke(CHANNELS.PLAYER_STREAM_SEEK, sessionId, seekSeconds) as Promise<
      { ok: true; generation: number; keyframeTime: number } | { error: string }
    >,
  playerCleanupRemux: () => ipcRenderer.invoke(CHANNELS.PLAYER_CLEANUP_REMUX) as Promise<void>,
  onPlayerStreamSubtitles: (callback: (data: { sessionId: string; content: string }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.PLAYER_STREAM_SUBTITLES, (_event, data) => callback(data))
  },
  offPlayerStreamSubtitles: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.PLAYER_STREAM_SUBTITLES)
  },
  onPlayerStreamChunk: (
    callback: (data: { sessionId: string; gen: number; data: Uint8Array }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.PLAYER_STREAM_CHUNK, (_event, data) => callback(data))
  },
  offPlayerStreamChunk: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.PLAYER_STREAM_CHUNK)
  },
  onPlayerStreamEnd: (callback: (data: { sessionId: string }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.PLAYER_STREAM_END, (_event, data) => callback(data))
  },
  offPlayerStreamEnd: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.PLAYER_STREAM_END)
  },
  onPlayerStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.PLAYER_STREAM_ERROR, (_event, data) => callback(data))
  },
  offPlayerStreamError: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.PLAYER_STREAM_ERROR)
  },
  onPlayerStreamProgress: (
    callback: (data: {
      sessionId: string
      gen: number
      speed: number | null
      time: number | null
    }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.PLAYER_STREAM_PROGRESS, (_event, data) => callback(data))
  },
  offPlayerStreamProgress: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.PLAYER_STREAM_PROGRESS)
  },

  // Shikimori
  shikimoriGetAuthUrl: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_AUTH_URL) as Promise<string>,
  shikimoriExchangeCode: (code: string) =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, code),
  shikimoriLogout: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_LOGOUT),
  shikimoriGetUser: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_USER),
  shikimoriGetRate: (malId: number) => ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_RATE, malId),
  shikimoriUpdateRate: (
    malId: number,
    episodes: number,
    status: string,
    score: number,
    rewatches: number
  ) =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, malId, episodes, status, score, rewatches),
  shikimoriGetFriendsRates: (malId: number) =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS_RATES, malId) as Promise<ShikiFriendRate[]>,
  shikimoriGetAnimeRates: (status?: string) =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_ANIME_RATES, status) as Promise<
      ShikiAnimeRateEntry[]
    >,
  shikimoriGetFriendsActivity: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS_ACTIVITY) as Promise<
      ShikiFriendActivityEntry[]
    >,
  shikimoriGetCalendar: (force = false) =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_CALENDAR, force) as Promise<CalendarEntry[]>,
  shikimoriGetRelated: (malId: number) =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_RELATED, malId) as Promise<ShikiRelatedEntry[]>,
  onShikimoriRateUpdated: (callback: (entry: ShikiAnimeRateEntry) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED, (_event, entry) => callback(entry))
  },
  offShikimoriRateUpdated: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED)
  },
  onShikimoriRatesRefreshed: (callback: (entries: ShikiAnimeRateEntry[]) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED, (_event, entries) => callback(entries))
  },
  offShikimoriRatesRefreshed: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED)
  },
  shikimoriGetOfflineQueueLength: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_OFFLINE_QUEUE_LENGTH) as Promise<number>,
  onShikimoriOfflineQueueChanged: (callback: (data: { length: number }) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, (_event, data) => callback(data))
  },
  offShikimoriOfflineQueueChanged: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED)
  },
  shikimoriGetSyncStatus: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_SYNC_STATUS) as Promise<{
      state: 'idle' | 'syncing'
      queueLength: number
      lastSyncAt: number
      lastSyncError: string | null
    }>,
  shikimoriTriggerSync: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_TRIGGER_SYNC) as Promise<void>,
  onShikimoriSyncStatus: (
    callback: (data: {
      state: 'idle' | 'syncing'
      queueLength: number
      lastSyncAt: number
      lastSyncError: string | null
    }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS, (_event, data) => callback(data))
  },
  offShikimoriSyncStatus: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS)
  },
  shikimoriGetAnimeDetails: (malId: number) =>
    ipcRenderer.invoke(
      CHANNELS.SHIKIMORI_GET_ANIME_DETAILS,
      malId
    ) as Promise<ShikiAnimeDetails | null>,
  shikimoriTriggerDetailPrefetch: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_TRIGGER_DETAIL_PREFETCH) as Promise<void>,
  onShikimoriAnimeDetailsUpdated: (
    callback: (data: { malId: number; details: ShikiAnimeDetails }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED, (_event, data) => callback(data))
  },
  offShikimoriAnimeDetailsUpdated: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED)
  },

  // Syncplay (Watch Together)
  syncplayConnect: (cfg: {
    host: string
    port: number
    room: string
    username: string
    password?: string
    autoReconnect: boolean
  }) => ipcRenderer.invoke(CHANNELS.SYNCPLAY_CONNECT, cfg) as Promise<void>,
  syncplayDisconnect: () => ipcRenderer.invoke(CHANNELS.SYNCPLAY_DISCONNECT) as Promise<void>,
  syncplaySetFile: (file: {
    animeId: number
    malId: number | null
    episodeInt: string
    translationId: number | null
    canonicalName: string
    duration: number
  }) => ipcRenderer.invoke(CHANNELS.SYNCPLAY_SET_FILE, file) as Promise<void>,
  syncplaySendLocalState: (payload: {
    paused: boolean
    position: number
    cause: 'play' | 'pause' | 'seek'
  }) => ipcRenderer.invoke(CHANNELS.SYNCPLAY_LOCAL_STATE, payload) as Promise<void>,
  syncplaySendLocalSnapshot: (snap: { position: number; paused: boolean }) =>
    ipcRenderer.invoke(CHANNELS.SYNCPLAY_LOCAL_SNAPSHOT, snap) as Promise<void>,
  syncplaySetReady: (isReady: boolean) =>
    ipcRenderer.invoke(CHANNELS.SYNCPLAY_SET_READY, isReady) as Promise<void>,
  syncplayGetStatus: () =>
    ipcRenderer.invoke(CHANNELS.SYNCPLAY_GET_STATUS) as Promise<SyncplayStatus>,
  onSyncplayConnectionStatus: (callback: (status: SyncplayStatus) => void) =>
    syncplayOn('syncplay:connection-status', callback),
  offSyncplayConnectionStatus: (callback: (status: SyncplayStatus) => void) =>
    syncplayOff('syncplay:connection-status', callback),
  onSyncplayRemoteState: (callback: (state: SyncplayRemoteState) => void) =>
    syncplayOn('syncplay:remote-state', callback),
  offSyncplayRemoteState: (callback: (state: SyncplayRemoteState) => void) =>
    syncplayOff('syncplay:remote-state', callback),
  onSyncplayRoomUsers: (callback: (users: SyncplayRoomUser[]) => void) =>
    syncplayOn('syncplay:room-users', callback),
  offSyncplayRoomUsers: (callback: (users: SyncplayRoomUser[]) => void) =>
    syncplayOff('syncplay:room-users', callback),
  onSyncplayRoomEvent: (callback: (ev: SyncplayRoomEvent) => void) =>
    syncplayOn('syncplay:room-event', callback),
  offSyncplayRoomEvent: (callback: (ev: SyncplayRoomEvent) => void) =>
    syncplayOff('syncplay:room-event', callback),
  onSyncplayRemoteEpisodeChange: (callback: (ep: SyncplayRemoteEpisode) => void) =>
    syncplayOn('syncplay:remote-episode-change', callback),
  offSyncplayRemoteEpisodeChange: (callback: (ep: SyncplayRemoteEpisode) => void) =>
    syncplayOff('syncplay:remote-episode-change', callback),
  onSyncplayTrace: (callback: (entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => void) =>
    syncplayOn('syncplay:trace', callback),
  offSyncplayTrace: (
    callback: (entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => void
  ) => syncplayOff('syncplay:trace', callback),

  // Auto-downloader
  autoDlGetSubscription: (animeId: number) =>
    ipcRenderer.invoke(
      CHANNELS.AUTO_DL_GET_SUBSCRIPTION,
      animeId
    ) as Promise<AutoDownloadSubscription | null>,
  autoDlSetSubscription: (
    animeId: number,
    enabled: boolean,
    meta?: { malId: number; animeName: string }
  ) =>
    ipcRenderer.invoke(
      CHANNELS.AUTO_DL_SET_SUBSCRIPTION,
      animeId,
      enabled,
      meta
    ) as Promise<AutoDownloadSubscription | null>,
  autoDlListSubscriptions: () =>
    ipcRenderer.invoke(CHANNELS.AUTO_DL_LIST_SUBSCRIPTIONS) as Promise<AutoDownloadSubscription[]>,
  autoDlTrigger: () => ipcRenderer.invoke(CHANNELS.AUTO_DL_TRIGGER) as Promise<AutoDlTickResult>,
  autoDlGetStatus: () =>
    ipcRenderer.invoke(CHANNELS.AUTO_DL_GET_STATUS) as Promise<{
      lastResult: AutoDlTickResult | null
      locked: boolean
      enabled: boolean
    }>,
  autoDlGetEnabled: () => ipcRenderer.invoke(CHANNELS.AUTO_DL_GET_ENABLED) as Promise<boolean>,
  autoDlSetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(CHANNELS.AUTO_DL_SET_ENABLED, enabled) as Promise<boolean>,
  onAutoDlTickResult: (callback: (result: AutoDlTickResult) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.AUTO_DL_TICK_RESULT, (_event, result) => callback(result))
  },
  offAutoDlTickResult: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.AUTO_DL_TICK_RESULT)
  },
  onAutoDlEnqueued: (
    callback: (data: { animeId: number; episodeInt: string; animeName: string }) => void
  ) => {
    ipcRenderer.on(EVENT_CHANNELS.AUTO_DL_ENQUEUED, (_event, data) => callback(data))
  },
  offAutoDlEnqueued: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.AUTO_DL_ENQUEUED)
  },

  // Updates
  appVersion: () => ipcRenderer.invoke(CHANNELS.APP_VERSION),
  updateCheck: () => ipcRenderer.invoke(CHANNELS.UPDATE_CHECK),
  updateDownload: () => ipcRenderer.invoke(CHANNELS.UPDATE_DOWNLOAD),
  updateInstall: () => ipcRenderer.invoke(CHANNELS.UPDATE_INSTALL),
  onUpdateStatus: (callback: (data: unknown) => void) => {
    ipcRenderer.on(EVENT_CHANNELS.UPDATE_STATUS, (_event, data) => callback(data))
  },
  offUpdateStatus: () => {
    ipcRenderer.removeAllListeners(EVENT_CHANNELS.UPDATE_STATUS)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.api = api
}
