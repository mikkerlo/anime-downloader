import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, EVENT_CHANNELS, type Unsubscribe } from '@shared/ipc/channels'
import { subscribe } from './subscribe'

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
  getEpisodesBatch: (episodeIds: number[], animeId?: number) =>
    ipcRenderer.invoke(CHANNELS.GET_EPISODES_BATCH, episodeIds, animeId),
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
  onCleanupPrompt: subscribe<{ animeId: number; animeName: string; malId: number }>(
    EVENT_CHANNELS.CLEANUP_PROMPT
  ),
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
  // FILE_EPISODES_CHANGED is broadcast with two positional args (animeName + map),
  // unlike every other channel which sends a single payload. Inlined rather than
  // shoehorning the helper to support multi-arg events.
  onFileEpisodesChanged: ((callback) => {
    type Episodes = Record<
      string,
      { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
    >
    const wrapped = (_event: IpcRendererEvent, animeName: string, data: Episodes): void =>
      callback(animeName, data)
    ipcRenderer.on(EVENT_CHANNELS.FILE_EPISODES_CHANGED, wrapped)
    return (): void => {
      ipcRenderer.removeListener(EVENT_CHANNELS.FILE_EPISODES_CHANGED, wrapped)
    }
  }) as (
    callback: (
      animeName: string,
      data: Record<
        string,
        { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
      >
    ) => void
  ) => Unsubscribe,

  // Storage
  storagePickHotDir: () => ipcRenderer.invoke(CHANNELS.STORAGE_PICK_HOT_DIR),
  storagePickColdDir: () => ipcRenderer.invoke(CHANNELS.STORAGE_PICK_COLD_DIR),
  storageMoveToCold: () => ipcRenderer.invoke(CHANNELS.STORAGE_MOVE_TO_COLD),
  onStorageMoveToColdProgress: subscribe<{ current: number; total: number; file: string }>(
    EVENT_CHANNELS.STORAGE_MOVE_TO_COLD_PROGRESS
  ),
  storageGetUsage: () => ipcRenderer.invoke(CHANNELS.STORAGE_GET_USAGE) as Promise<StorageUsage>,
  storageRunCleanup: (opts?: { force?: boolean }) =>
    ipcRenderer.invoke(CHANNELS.STORAGE_RUN_CLEANUP, opts) as Promise<CleanupResult>,
  onStorageUsageProgress: subscribe<{ scanned: number; total: number }>(
    EVENT_CHANNELS.STORAGE_USAGE_PROGRESS
  ),
  onStorageCleanupPending: subscribe<{ candidates: CleanupCandidate[] }>(
    EVENT_CHANNELS.STORAGE_CLEANUP_PENDING
  ),
  onStorageCleanupFinished: subscribe<CleanupResult>(EVENT_CHANNELS.STORAGE_CLEANUP_FINISHED),

  downloadScanMerge: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_SCAN_MERGE),
  downloadFixMetadata: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_FIX_METADATA),
  onFixMetadataProgress: subscribe<unknown>(EVENT_CHANNELS.FIX_METADATA_PROGRESS),

  onDownloadProgress: subscribe<unknown>(EVENT_CHANNELS.DOWNLOAD_PROGRESS),
  onScanMergeProgress: subscribe<unknown>(EVENT_CHANNELS.SCAN_MERGE_PROGRESS),
  onFfmpegDownloadProgress: subscribe<{ status: string; progress?: number }>(
    EVENT_CHANNELS.FFMPEG_DOWNLOAD_PROGRESS
  ),
  onFpcalcDownloadProgress: subscribe<{ status: string; progress?: number }>(
    EVENT_CHANNELS.FPCALC_DOWNLOAD_PROGRESS
  ),

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
  onSkipDetectorProgress: subscribe<SkipDetectorProgress>(
    EVENT_CHANNELS.SKIP_DETECTOR_ANALYZE_PROGRESS
  ),
  onSkipDetectorSignatureUpdated: subscribe<{
    animeId: number
    perEpisode: Record<string, EpisodeSkipDetection>
  }>(EVENT_CHANNELS.SKIP_DETECTOR_SIGNATURE_UPDATED),

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
  onChapterInjectProgress: subscribe<ChapterInjectProgress>(EVENT_CHANNELS.CHAPTER_INJECT_PROGRESS),

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
  onPlayerStreamSubtitles: subscribe<{ sessionId: string; content: string }>(
    EVENT_CHANNELS.PLAYER_STREAM_SUBTITLES
  ),
  onPlayerStreamChunk: subscribe<{ sessionId: string; gen: number; data: Uint8Array }>(
    EVENT_CHANNELS.PLAYER_STREAM_CHUNK
  ),
  onPlayerStreamEnd: subscribe<{ sessionId: string }>(EVENT_CHANNELS.PLAYER_STREAM_END),
  onPlayerStreamError: subscribe<{ sessionId: string; error: string }>(
    EVENT_CHANNELS.PLAYER_STREAM_ERROR
  ),
  onPlayerStreamProgress: subscribe<{
    sessionId: string
    gen: number
    speed: number | null
    time: number | null
  }>(EVENT_CHANNELS.PLAYER_STREAM_PROGRESS),

  // Shikimori
  shikimoriGetAuthUrl: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_AUTH_URL) as Promise<string>,
  shikimoriExchangeCode: (code: string) =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, code),
  shikimoriLogout: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_LOGOUT),
  shikimoriGetUser: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_USER),
  shikimoriGetProfile: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_PROFILE) as Promise<ShikimoriProfile | null>,
  onShikimoriProfileRefreshed: subscribe<ShikimoriProfile>(
    EVENT_CHANNELS.SHIKIMORI_PROFILE_REFRESHED
  ),
  shikimoriGetFriends: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS) as Promise<ShikiFriendCard[] | null>,
  onShikimoriFriendsRefreshed: subscribe<ShikiFriendCard[]>(
    EVENT_CHANNELS.SHIKIMORI_FRIENDS_REFRESHED
  ),
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
  onShikimoriRateUpdated: subscribe<ShikiAnimeRateEntry>(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED),
  onShikimoriRatesRefreshed: subscribe<ShikiAnimeRateEntry[]>(
    EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
  ),
  shikimoriGetOfflineQueueLength: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_OFFLINE_QUEUE_LENGTH) as Promise<number>,
  onShikimoriOfflineQueueChanged: subscribe<{ length: number }>(
    EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED
  ),
  shikimoriGetSyncStatus: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_GET_SYNC_STATUS) as Promise<{
      state: 'idle' | 'syncing'
      queueLength: number
      lastSyncAt: number
      lastSyncError: string | null
    }>,
  shikimoriTriggerSync: () => ipcRenderer.invoke(CHANNELS.SHIKIMORI_TRIGGER_SYNC) as Promise<void>,
  onShikimoriSyncStatus: subscribe<{
    state: 'idle' | 'syncing'
    queueLength: number
    lastSyncAt: number
    lastSyncError: string | null
  }>(EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS),
  shikimoriGetAnimeDetails: (malId: number) =>
    ipcRenderer.invoke(
      CHANNELS.SHIKIMORI_GET_ANIME_DETAILS,
      malId
    ) as Promise<ShikiAnimeDetails | null>,
  shikimoriTriggerDetailPrefetch: () =>
    ipcRenderer.invoke(CHANNELS.SHIKIMORI_TRIGGER_DETAIL_PREFETCH) as Promise<void>,
  onShikimoriAnimeDetailsUpdated: subscribe<{ malId: number; details: ShikiAnimeDetails }>(
    EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED
  ),

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
  onSyncplayConnectionStatus: subscribe<SyncplayStatus>(EVENT_CHANNELS.SYNCPLAY_CONNECTION_STATUS),
  onSyncplayRemoteState: subscribe<SyncplayRemoteState>(EVENT_CHANNELS.SYNCPLAY_REMOTE_STATE),
  onSyncplayRoomUsers: subscribe<SyncplayRoomUser[]>(EVENT_CHANNELS.SYNCPLAY_ROOM_USERS),
  onSyncplayRoomEvent: subscribe<SyncplayRoomEvent>(EVENT_CHANNELS.SYNCPLAY_ROOM_EVENT),
  onSyncplayRemoteEpisodeChange: subscribe<SyncplayRemoteEpisode>(
    EVENT_CHANNELS.SYNCPLAY_REMOTE_EPISODE_CHANGE
  ),
  onSyncplayTrace: subscribe<{ dir: 'in' | 'out'; keys: string; msg: unknown }>(
    EVENT_CHANNELS.SYNCPLAY_TRACE
  ),

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
  onAutoDlTickResult: subscribe<AutoDlTickResult>(EVENT_CHANNELS.AUTO_DL_TICK_RESULT),
  onAutoDlEnqueued: subscribe<{ animeId: number; episodeInt: string; animeName: string }>(
    EVENT_CHANNELS.AUTO_DL_ENQUEUED
  ),

  // Updates
  appVersion: () => ipcRenderer.invoke(CHANNELS.APP_VERSION),
  updateCheck: () => ipcRenderer.invoke(CHANNELS.UPDATE_CHECK),
  updateDownload: () => ipcRenderer.invoke(CHANNELS.UPDATE_DOWNLOAD),
  updateInstall: () => ipcRenderer.invoke(CHANNELS.UPDATE_INSTALL),
  onUpdateStatus: subscribe<unknown>(EVENT_CHANNELS.UPDATE_STATUS)
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
