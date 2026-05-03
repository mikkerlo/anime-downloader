import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

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
  validateToken: () => ipcRenderer.invoke('validate-token'),
  searchAnime: (query: string) => ipcRenderer.invoke('search-anime', query),
  getAnime: (id: number) => ipcRenderer.invoke('get-anime', id),
  getEpisode: (id: number, animeId?: number) => ipcRenderer.invoke('get-episode', id, animeId),
  probeEmbedQuality: (translationId: number, animeId?: number) => ipcRenderer.invoke('probe-embed-quality', translationId, animeId) as Promise<number | null>,
  probeFullScanNeeded: (animeId: number, episodeCount: number) =>
    ipcRenderer.invoke('probe-full-scan-needed', animeId, episodeCount) as Promise<boolean>,
  probeFullScanDone: (animeId: number, episodeCount: number) =>
    ipcRenderer.invoke('probe-full-scan-done', animeId, episodeCount) as Promise<void>,
  reportQualityMismatch: (data: { translationId: number; author: string; type: string; reported: number; actual: number }) =>
    ipcRenderer.invoke('report-quality-mismatch', data),
  getQualityMismatchCount: () => ipcRenderer.invoke('get-quality-mismatch-count') as Promise<number>,
  dumpQualityMismatches: () => ipcRenderer.invoke('dump-quality-mismatches') as Promise<{ count: number; path: string }>,
  getCachedPoster: (animeId: number) => ipcRenderer.invoke('cache-get-poster', animeId) as Promise<string | null>,
  libraryGet: () => ipcRenderer.invoke('library-get'),
  libraryToggle: (anime: unknown) => ipcRenderer.invoke('library-toggle', anime),
  libraryHas: (id: number) => ipcRenderer.invoke('library-has', id),
  libraryGetStatus: (ids: number[]) => ipcRenderer.invoke('library-get-status', ids) as Promise<Record<number, { starred: boolean; downloaded: boolean }>>,
  libraryIsDownloaded: (id: number) => ipcRenderer.invoke('library-is-downloaded', id),
  downloadedAnimeAdd: (anime: unknown) => ipcRenderer.invoke('downloaded-anime-add', anime),
  downloadedAnimeDelete: (animeId: number, animeName: string) => ipcRenderer.invoke('downloaded-anime-delete', animeId, animeName),
  getSetting: (key: string) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('set-setting', key, value),

  homeGetContinueWatching: () =>
    ipcRenderer.invoke('home:get-continue-watching') as Promise<ContinueWatchingEntry[]>,

  // Watch progress
  watchProgressSave: (animeId: number, episodeInt: string, position: number, duration: number, watched?: boolean) =>
    ipcRenderer.invoke('watch-progress:save', animeId, episodeInt, position, duration, watched),
  watchProgressGet: (animeId: number, episodeInt: string) =>
    ipcRenderer.invoke('watch-progress:get', animeId, episodeInt) as Promise<{ position: number; duration: number; updatedAt: number; watched?: boolean } | null>,
  watchProgressGetAll: (animeId: number) =>
    ipcRenderer.invoke('watch-progress:get-all', animeId) as Promise<Record<string, { position: number; duration: number; updatedAt: number; watched?: boolean }>>,

  // Downloads
  downloadEnqueue: (requests: unknown[]) => ipcRenderer.invoke('download:enqueue', requests),
  downloadPause: (id: string) => ipcRenderer.invoke('download:pause', id),
  downloadResume: (id: string) => ipcRenderer.invoke('download:resume', id),
  downloadRestart: (id: string) => ipcRenderer.invoke('download:restart', id),
  downloadRestartAllFailed: () => ipcRenderer.invoke('download:restart-all-failed'),
  downloadPauseAll: () => ipcRenderer.invoke('download:pause-all'),
  downloadResumeAll: () => ipcRenderer.invoke('download:resume-all'),
  downloadCancel: (id: string) => ipcRenderer.invoke('download:cancel', id),
  downloadGetQueue: () => ipcRenderer.invoke('download:get-queue'),
  downloadCancelByEpisode: (animeName: string, episodeLabel?: string) =>
    ipcRenderer.invoke('download:cancel-by-episode', animeName, episodeLabel),
  downloadedEpisodesGet: (animeId: number) => ipcRenderer.invoke('downloaded-episodes-get', animeId),
  downloadClearCompleted: () => ipcRenderer.invoke('download:clear-completed'),
  downloadCancelMerge: () => ipcRenderer.invoke('download:cancel-merge'),
  downloadMerge: () => ipcRenderer.invoke('download:merge'),
  ffmpegCheck: () => ipcRenderer.invoke('ffmpeg:check'),
  ffmpegDelete: () => ipcRenderer.invoke('ffmpeg:delete'),
  downloadPickDir: () => ipcRenderer.invoke('download:pick-dir'),
  // File management
  fileCheckEpisodes: (animeName: string, episodeInts: string[]) =>
    ipcRenderer.invoke('file:check-episodes', animeName, episodeInts),
  fileOpen: (filePath: string) => ipcRenderer.invoke('file:open', filePath),
  fileShowInFolder: (filePath: string) => ipcRenderer.invoke('file:show-in-folder', filePath),
  fileDeleteEpisode: (animeName: string, episodeInt: string, animeId?: number, translationId?: number) =>
    ipcRenderer.invoke('file:delete-episode', animeName, episodeInt, animeId, translationId),
  onFileEpisodesChanged: (callback: (animeName: string, data: Record<string, { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]>) => void) => {
    ipcRenderer.on('file:episodes-changed', (_event, animeName, data) => callback(animeName, data))
  },
  offFileEpisodesChanged: () => {
    ipcRenderer.removeAllListeners('file:episodes-changed')
  },

  // Storage
  storagePickHotDir: () => ipcRenderer.invoke('storage:pick-hot-dir'),
  storagePickColdDir: () => ipcRenderer.invoke('storage:pick-cold-dir'),
  storageMoveToCold: () => ipcRenderer.invoke('storage:move-to-cold'),
  onStorageMoveToColdProgress: (callback: (data: { current: number; total: number; file: string }) => void) => {
    ipcRenderer.on('storage:move-to-cold-progress', (_event, data) => callback(data))
  },
  offStorageMoveToColdProgress: () => {
    ipcRenderer.removeAllListeners('storage:move-to-cold-progress')
  },
  storageGetUsage: () => ipcRenderer.invoke('storage:get-usage') as Promise<StorageUsage>,
  storageRunCleanup: (opts?: { force?: boolean }) =>
    ipcRenderer.invoke('storage:run-cleanup', opts) as Promise<CleanupResult>,
  onStorageUsageProgress: (callback: (data: { scanned: number; total: number }) => void) => {
    ipcRenderer.on('storage:usage-progress', (_event, data) => callback(data))
  },
  offStorageUsageProgress: () => {
    ipcRenderer.removeAllListeners('storage:usage-progress')
  },
  onStorageCleanupPending: (callback: (data: { candidates: CleanupCandidate[] }) => void) => {
    ipcRenderer.on('storage:cleanup-pending', (_event, data) => callback(data))
  },
  offStorageCleanupPending: () => {
    ipcRenderer.removeAllListeners('storage:cleanup-pending')
  },
  onStorageCleanupFinished: (callback: (data: CleanupResult) => void) => {
    ipcRenderer.on('storage:cleanup-finished', (_event, data) => callback(data))
  },
  offStorageCleanupFinished: () => {
    ipcRenderer.removeAllListeners('storage:cleanup-finished')
  },

  downloadScanMerge: () => ipcRenderer.invoke('download:scan-merge'),
  downloadFixMetadata: () => ipcRenderer.invoke('download:fix-metadata'),
  onFixMetadataProgress: (callback: (data: unknown) => void) => {
    ipcRenderer.on('fix-metadata:progress', (_event, data) => callback(data))
  },
  offFixMetadataProgress: () => {
    ipcRenderer.removeAllListeners('fix-metadata:progress')
  },

  onDownloadProgress: (callback: (data: unknown) => void) => {
    ipcRenderer.on('download:progress', (_event, data) => callback(data))
  },
  offDownloadProgress: () => {
    ipcRenderer.removeAllListeners('download:progress')
  },
  onScanMergeProgress: (callback: (data: unknown) => void) => {
    ipcRenderer.on('scan-merge:progress', (_event, data) => callback(data))
  },
  offScanMergeProgress: () => {
    ipcRenderer.removeAllListeners('scan-merge:progress')
  },
  onFfmpegDownloadProgress: (callback: (data: { status: string; progress?: number }) => void) => {
    ipcRenderer.on('ffmpeg:download-progress', (_event, data) => callback(data))
  },
  offFfmpegDownloadProgress: () => {
    ipcRenderer.removeAllListeners('ffmpeg:download-progress')
  },
  onFpcalcDownloadProgress: (callback: (data: { status: string; progress?: number }) => void) => {
    ipcRenderer.on('fpcalc:download-progress', (_event, data) => callback(data))
  },
  offFpcalcDownloadProgress: () => {
    ipcRenderer.removeAllListeners('fpcalc:download-progress')
  },

  // Skip detection (Phase 1: debug panel only)
  skipDetectorAnalyzeShow: (animeId: number, episodes: { episodeInt: string; episodeLabel: string; filePath: string }[]) =>
    ipcRenderer.invoke('skip-detector:analyze-show', animeId, episodes) as Promise<ShowSkipDetections>,
  skipDetectorGetDetections: (animeId: number) =>
    ipcRenderer.invoke('skip-detector:get-detections', animeId) as Promise<ShowSkipDetections | null>,
  skipDetectorGetStatus: () =>
    ipcRenderer.invoke('skip-detector:get-status') as Promise<{ animeId: number; lastProgress: SkipDetectorProgress | null } | null>,
  skipDetectorCancel: () => ipcRenderer.invoke('skip-detector:cancel') as Promise<void>,
  skipDetectorCacheStats: () =>
    ipcRenderer.invoke('skip-detector:cache-stats') as Promise<{ fingerprintCount: number }>,
  skipDetectorBackfillAll: () =>
    ipcRenderer.invoke('skip-detector:backfill-all') as Promise<{ queued: number; alreadyAnalyzed: number; skippedFewEpisodes: number; total: number }>,
  skipDetectorQueueStatus: () =>
    ipcRenderer.invoke('skip-detector:queue-status') as Promise<{ currentAnimeId: number | null; queueLength: number }>,
  onSkipDetectorProgress: (callback: (data: SkipDetectorProgress) => void) => {
    ipcRenderer.on('skip-detector:analyze-progress', (_event, data) => callback(data))
  },
  offSkipDetectorProgress: () => {
    ipcRenderer.removeAllListeners('skip-detector:analyze-progress')
  },
  onSkipDetectorSignatureUpdated: (callback: (data: { animeId: number; perEpisode: Record<string, EpisodeSkipDetection> }) => void) => {
    ipcRenderer.on('skip-detector:signature-updated', (_event, data) => callback(data))
  },
  offSkipDetectorSignatureUpdated: () => {
    ipcRenderer.removeAllListeners('skip-detector:signature-updated')
  },

  shellOpenExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<boolean>,

  // Player
  playerGetStreamUrl: (translationId: number, maxHeight: number) =>
    ipcRenderer.invoke('player:get-stream-url', translationId, maxHeight),
  playerGetLocalSubtitles: (filePath: string) =>
    ipcRenderer.invoke('player:get-local-subtitles', filePath) as Promise<string | null>,
  playerFindLocalFile: (animeName: string, episodeInt: string, translationId: number) =>
    ipcRenderer.invoke('player:find-local-file', animeName, episodeInt, translationId) as Promise<{ filePath: string; subtitleContent: string | null } | null>,
  playerRemuxMkv: (mkvPath: string) =>
    ipcRenderer.invoke('player:remux-mkv', mkvPath) as Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }>,
  playerRemuxMkvStream: (mkvPath: string, initialSeek?: number) =>
    ipcRenderer.invoke('player:remux-mkv-stream', mkvPath, initialSeek) as Promise<
      | { sessionId: string; generation: number; duration: number; mimeType: string; hasSubtitlesPending: boolean; initialSeek: number }
      | { error: string }
    >,
  playerRemuxMkvStreamTranscode: (mkvPath: string, initialSeek?: number) =>
    ipcRenderer.invoke('player:remux-mkv-stream-transcode', mkvPath, initialSeek) as Promise<
      | { sessionId: string; generation: number; duration: number; mimeType: string; hasSubtitlesPending: boolean; initialSeek: number }
      | { error: string }
    >,
  shellOpenExternalFile: (filePath: string) =>
    ipcRenderer.invoke('shell:open-external-file', filePath) as Promise<{ ok: boolean; error?: string }>,
  playerStreamStart: (sessionId: string) =>
    ipcRenderer.invoke('player:stream-start', sessionId) as Promise<void>,
  playerStreamAck: (sessionId: string, bytes: number) =>
    ipcRenderer.invoke('player:stream-ack', sessionId, bytes) as Promise<void>,
  playerStreamSeek: (sessionId: string, seekSeconds: number) =>
    ipcRenderer.invoke('player:stream-seek', sessionId, seekSeconds) as Promise<{ ok: true; generation: number } | { error: string }>,
  playerCleanupRemux: () =>
    ipcRenderer.invoke('player:cleanup-remux') as Promise<void>,
  onPlayerStreamSubtitles: (callback: (data: { sessionId: string; content: string }) => void) => {
    ipcRenderer.on('player:stream-subtitles', (_event, data) => callback(data))
  },
  offPlayerStreamSubtitles: () => {
    ipcRenderer.removeAllListeners('player:stream-subtitles')
  },
  onPlayerStreamChunk: (callback: (data: { sessionId: string; gen: number; data: Uint8Array }) => void) => {
    ipcRenderer.on('player:stream-chunk', (_event, data) => callback(data))
  },
  offPlayerStreamChunk: () => {
    ipcRenderer.removeAllListeners('player:stream-chunk')
  },
  onPlayerStreamEnd: (callback: (data: { sessionId: string }) => void) => {
    ipcRenderer.on('player:stream-end', (_event, data) => callback(data))
  },
  offPlayerStreamEnd: () => {
    ipcRenderer.removeAllListeners('player:stream-end')
  },
  onPlayerStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
    ipcRenderer.on('player:stream-error', (_event, data) => callback(data))
  },
  offPlayerStreamError: () => {
    ipcRenderer.removeAllListeners('player:stream-error')
  },
  onPlayerStreamProgress: (callback: (data: { sessionId: string; gen: number; speed: number | null; time: number | null }) => void) => {
    ipcRenderer.on('player:stream-progress', (_event, data) => callback(data))
  },
  offPlayerStreamProgress: () => {
    ipcRenderer.removeAllListeners('player:stream-progress')
  },

  // Shikimori
  shikimoriGetAuthUrl: () => ipcRenderer.invoke('shikimori:get-auth-url') as Promise<string>,
  shikimoriExchangeCode: (code: string) => ipcRenderer.invoke('shikimori:exchange-code', code),
  shikimoriLogout: () => ipcRenderer.invoke('shikimori:logout'),
  shikimoriGetUser: () => ipcRenderer.invoke('shikimori:get-user'),
  shikimoriGetRate: (malId: number) => ipcRenderer.invoke('shikimori:get-rate', malId),
  shikimoriUpdateRate: (malId: number, episodes: number, status: string, score: number) =>
    ipcRenderer.invoke('shikimori:update-rate', malId, episodes, status, score),
  shikimoriGetFriendsRates: (malId: number) =>
    ipcRenderer.invoke('shikimori:get-friends-rates', malId) as Promise<ShikiFriendRate[]>,
  shikimoriGetAnimeRates: (status?: string) =>
    ipcRenderer.invoke('shikimori:get-anime-rates', status) as Promise<ShikiAnimeRateEntry[]>,
  shikimoriGetFriendsActivity: () =>
    ipcRenderer.invoke('shikimori:get-friends-activity') as Promise<ShikiFriendActivityEntry[]>,
  shikimoriGetCalendar: (force = false) =>
    ipcRenderer.invoke('shikimori:get-calendar', force) as Promise<CalendarEntry[]>,
  shikimoriGetRelated: (malId: number) =>
    ipcRenderer.invoke('shikimori:get-related', malId) as Promise<ShikiRelatedEntry[]>,
  onShikimoriRateUpdated: (callback: (entry: ShikiAnimeRateEntry) => void) => {
    ipcRenderer.on('shikimori:rate-updated', (_event, entry) => callback(entry))
  },
  offShikimoriRateUpdated: () => {
    ipcRenderer.removeAllListeners('shikimori:rate-updated')
  },
  onShikimoriRatesRefreshed: (callback: (entries: ShikiAnimeRateEntry[]) => void) => {
    ipcRenderer.on('shikimori:rates-refreshed', (_event, entries) => callback(entries))
  },
  offShikimoriRatesRefreshed: () => {
    ipcRenderer.removeAllListeners('shikimori:rates-refreshed')
  },
  shikimoriGetOfflineQueueLength: () =>
    ipcRenderer.invoke('shikimori:get-offline-queue-length') as Promise<number>,
  onShikimoriOfflineQueueChanged: (callback: (data: { length: number }) => void) => {
    ipcRenderer.on('shikimori:offline-queue-changed', (_event, data) => callback(data))
  },
  offShikimoriOfflineQueueChanged: () => {
    ipcRenderer.removeAllListeners('shikimori:offline-queue-changed')
  },
  shikimoriGetSyncStatus: () =>
    ipcRenderer.invoke('shikimori:get-sync-status') as Promise<{
      state: 'idle' | 'syncing'
      queueLength: number
      lastSyncAt: number
      lastSyncError: string | null
    }>,
  shikimoriTriggerSync: () =>
    ipcRenderer.invoke('shikimori:trigger-sync') as Promise<void>,
  onShikimoriSyncStatus: (
    callback: (data: {
      state: 'idle' | 'syncing'
      queueLength: number
      lastSyncAt: number
      lastSyncError: string | null
    }) => void
  ) => {
    ipcRenderer.on('shikimori:sync-status', (_event, data) => callback(data))
  },
  offShikimoriSyncStatus: () => {
    ipcRenderer.removeAllListeners('shikimori:sync-status')
  },
  shikimoriGetAnimeDetails: (malId: number) =>
    ipcRenderer.invoke('shikimori:get-anime-details', malId) as Promise<ShikiAnimeDetails | null>,
  shikimoriTriggerDetailPrefetch: () =>
    ipcRenderer.invoke('shikimori:trigger-detail-prefetch') as Promise<void>,
  onShikimoriAnimeDetailsUpdated: (
    callback: (data: { malId: number; details: ShikiAnimeDetails }) => void
  ) => {
    ipcRenderer.on('shikimori:anime-details-updated', (_event, data) => callback(data))
  },
  offShikimoriAnimeDetailsUpdated: () => {
    ipcRenderer.removeAllListeners('shikimori:anime-details-updated')
  },

  // Syncplay (Watch Together)
  syncplayConnect: (cfg: {
    host: string
    port: number
    room: string
    username: string
    password?: string
    autoReconnect: boolean
  }) => ipcRenderer.invoke('syncplay:connect', cfg) as Promise<void>,
  syncplayDisconnect: () => ipcRenderer.invoke('syncplay:disconnect') as Promise<void>,
  syncplaySetFile: (file: {
    animeId: number
    malId: number | null
    episodeInt: string
    translationId: number | null
    canonicalName: string
    duration: number
  }) => ipcRenderer.invoke('syncplay:set-file', file) as Promise<void>,
  syncplaySendLocalState: (payload: {
    paused: boolean
    position: number
    cause: 'play' | 'pause' | 'seek'
  }) => ipcRenderer.invoke('syncplay:local-state', payload) as Promise<void>,
  syncplaySendLocalSnapshot: (snap: { position: number; paused: boolean }) =>
    ipcRenderer.invoke('syncplay:local-snapshot', snap) as Promise<void>,
  syncplaySetReady: (isReady: boolean) =>
    ipcRenderer.invoke('syncplay:set-ready', isReady) as Promise<void>,
  syncplayGetStatus: () => ipcRenderer.invoke('syncplay:get-status') as Promise<SyncplayStatus>,
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
  offSyncplayTrace: (callback: (entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => void) =>
    syncplayOff('syncplay:trace', callback),

  // Updates
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback: (data: unknown) => void) => {
    ipcRenderer.on('update:status', (_event, data) => callback(data))
  },
  offUpdateStatus: () => {
    ipcRenderer.removeAllListeners('update:status')
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
