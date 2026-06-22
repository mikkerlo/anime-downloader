// IPC surface contract: `window.api` (renderer ⇆ main) and the libass module shim.
//
// Domain types (AnimeDetail, ShikiUserRate, EpisodeGroup, …) were relocated to
// `src/shared/types/*.d.ts` in #84 Phase 1 (slice 1a). They are still declared as
// ambient globals there — no import is needed here or at any call site.
//
// Phase 4 slice 4a (#111) replaced the `on*`/`off*` subscription pairs with
// `EventSubscriber<T>`-shaped subscribers that return an `Unsubscribe` disposer.
// `Unsubscribe` is mirrored locally as an ambient alias so this file can stay
// declaration-only (importing from `@shared/ipc/channels` would convert it into
// a module and force renderer callers to import `Api`/`Window`).

type Unsubscribe = () => void

declare module 'libass-wasm/dist/js/subtitles-octopus.js' {
  export default class SubtitlesOctopus {
    constructor(options: Record<string, unknown>)
    dispose(): void
    setTrack(content: string): void
    freeTrack(): void
  }
}

interface Api {
  validateToken: () => Promise<{ valid: boolean; error?: string }>
  searchAnime: (query: string) => Promise<{ data: AnimeSearchResult[] }>
  getAnime: (id: number) => Promise<ApiResponse<AnimeDetail>>
  getAnimeCache: (id: number) => Promise<{ data: AnimeDetail; cachedAt: number } | null>
  setAnimeCache: (id: number, data: AnimeDetail) => Promise<boolean>
  getEpisode: (id: number, animeId?: number) => Promise<ApiResponse<EpisodeDetail>>
  getEpisodesBatch: (
    episodeIds: number[],
    animeId?: number
  ) => Promise<ApiResponse<EpisodeDetail[]>>
  probeEmbedQuality: (translationId: number, animeId?: number) => Promise<number | null>
  getCachedPoster: (animeId: number) => Promise<string | null>
  probeFullScanNeeded: (animeId: number, episodeCount: number) => Promise<boolean>
  probeFullScanDone: (animeId: number, episodeCount: number) => Promise<void>
  reportQualityMismatch: (data: {
    translationId: number
    author: string
    type: string
    reported: number
    actual: number
  }) => Promise<void>
  getQualityMismatchCount: () => Promise<number>
  dumpQualityMismatches: () => Promise<{ count: number; path: string }>
  debugGetMp4Stats: () => Promise<Mp4StreamingStats>
  debugResetMp4Stats: () => Promise<void>
  libraryGet: () => Promise<AnimeSearchResult[]>
  libraryToggle: (anime: AnimeSearchResult) => Promise<boolean>
  libraryHas: (id: number) => Promise<boolean>
  libraryGetStatus: (
    ids: number[]
  ) => Promise<Record<number, { starred: boolean; downloaded: boolean }>>
  libraryIsDownloaded: (id: number) => Promise<boolean>
  downloadedAnimeAdd: (anime: AnimeSearchResult) => Promise<void>
  downloadedAnimeDelete: (animeId: number, animeName: string) => Promise<void>
  cleanupGetSize: (animeId: number, animeName: string) => Promise<{ bytes: number; files: number }>
  cleanupGetActiveDownloads: (animeName: string) => Promise<{ active: number }>
  cleanupExecute: (animeId: number, animeName: string) => Promise<void>
  cleanupGetSnoozed: () => Promise<Record<string, { animeName: string }>>
  cleanupSetSnoozed: (animeId: number, snoozed: boolean) => Promise<void>
  onCleanupPrompt: (
    callback: (data: { animeId: number; animeName: string; malId: number }) => void
  ) => Unsubscribe
  getSetting: (key: string) => Promise<unknown>
  setSetting: (key: string, value: unknown) => Promise<void>

  homeGetContinueWatching: () => Promise<ContinueWatchingEntry[]>

  // Watch progress
  watchProgressSave: (
    animeId: number,
    episodeInt: string,
    position: number,
    duration: number,
    watched?: boolean,
    translationId?: number
  ) => Promise<void>
  watchProgressGet: (animeId: number, episodeInt: string) => Promise<WatchProgressEntry | null>
  watchProgressGetAll: (animeId: number) => Promise<Record<string, WatchProgressEntry>>

  // Downloads
  downloadEnqueue: (requests: DownloadRequest[]) => Promise<void>
  downloadPause: (id: string) => Promise<void>
  downloadResume: (id: string) => Promise<void>
  downloadRestart: (id: string) => Promise<void>
  downloadRestartAllFailed: () => Promise<void>
  downloadPauseAll: () => Promise<void>
  downloadResumeAll: () => Promise<void>
  downloadCancel: (id: string) => Promise<void>
  downloadGetQueue: () => Promise<EpisodeGroup[]>
  downloadCancelByEpisode: (animeName: string, episodeLabel?: string) => Promise<void>
  downloadedEpisodesGet: (animeId: number) => Promise<Record<string, EpisodeMeta[]>>
  downloadClearCompleted: () => Promise<void>
  downloadCancelMerge: () => Promise<void>
  downloadMerge: () => Promise<void>
  downloadScanMerge: () => Promise<{ merged: number; failed: string[] }>
  downloadFixMetadata: () => Promise<{ fixed: number; failed: string[] }>
  onFixMetadataProgress: (
    callback: (data: { current: number; total: number; file: string }) => void
  ) => Unsubscribe
  ffmpegCheck: () => Promise<{
    available: boolean
    version: string
    path: string
    encoders: string[]
  }>
  ffmpegDelete: () => Promise<void>
  downloadPickDir: () => Promise<string | null>
  // Storage
  storagePickHotDir: () => Promise<string | null>
  storagePickColdDir: () => Promise<string | null>
  storageMoveToCold: () => Promise<{ moved: number; failed: string[] }>
  onStorageMoveToColdProgress: (
    callback: (data: { current: number; total: number; file: string }) => void
  ) => Unsubscribe
  storageGetUsage: () => Promise<StorageUsage>
  storageRunCleanup: (opts?: { force?: boolean }) => Promise<CleanupResult>
  onStorageUsageProgress: (
    callback: (data: { scanned: number; total: number }) => void
  ) => Unsubscribe
  onStorageCleanupPending: (
    callback: (data: { candidates: CleanupCandidate[] }) => void
  ) => Unsubscribe
  onStorageCleanupFinished: (callback: (data: CleanupResult) => void) => Unsubscribe
  // File management
  fileCheckEpisodes: (
    animeName: string,
    episodeInts: string[]
  ) => Promise<
    Record<
      string,
      { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
    >
  >
  fileOpen: (filePath: string) => Promise<string>
  fileShowInFolder: (filePath: string) => Promise<void>
  fileDeleteEpisode: (
    animeName: string,
    episodeInt: string,
    animeId?: number,
    translationId?: number
  ) => Promise<void>
  onFileEpisodesChanged: (
    callback: (
      animeName: string,
      data: Record<
        string,
        { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
      >
    ) => void
  ) => Unsubscribe

  onDownloadProgress: (callback: (data: EpisodeGroup[]) => void) => Unsubscribe
  onScanMergeProgress: (callback: (data: ScanMergeProgress) => void) => Unsubscribe
  onFfmpegDownloadProgress: (
    callback: (data: { status: string; progress?: number }) => void
  ) => Unsubscribe
  onFpcalcDownloadProgress: (
    callback: (data: { status: string; progress?: number }) => void
  ) => Unsubscribe

  // Skip detection (Chromaprint)
  skipDetectorAnalyzeShow: (
    animeId: number,
    episodes: { episodeInt: string; episodeLabel: string; filePath: string }[]
  ) => Promise<ShowSkipDetections>
  skipDetectorGetDetections: (animeId: number) => Promise<ShowSkipDetections | null>
  skipDetectorDetectStream: (
    animeId: number,
    episodeInt: string,
    streamUrl: string
  ) => Promise<EpisodeSkipDetection | null>
  skipDetectorCancelStreamDetect: () => Promise<void>
  skipDetectorGetStatus: () => Promise<{
    animeId: number
    lastProgress: SkipDetectorProgress | null
  } | null>
  skipDetectorCancel: () => Promise<void>
  skipDetectorCacheStats: () => Promise<{ fingerprintCount: number }>
  skipDetectorBackfillAll: () => Promise<{
    queued: number
    alreadyAnalyzed: number
    skippedFewEpisodes: number
    total: number
  }>
  skipDetectorQueueStatus: () => Promise<{ currentAnimeId: number | null; queueLength: number }>
  onSkipDetectorProgress: (callback: (data: SkipDetectorProgress) => void) => Unsubscribe
  onSkipDetectorSignatureUpdated: (
    callback: (data: { animeId: number; perEpisode: Record<string, EpisodeSkipDetection> }) => void
  ) => Unsubscribe

  injectChapters: (
    animeId: number,
    episodes: { episodeInt: string; episodeLabel: string; filePath: string }[]
  ) => Promise<{ written: number; skipped: number; failed: number; total: number }>
  onChapterInjectProgress: (callback: (data: ChapterInjectProgress) => void) => Unsubscribe

  shellOpenExternal: (url: string) => Promise<boolean>
  shellOpenExternalFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>

  // Player
  playerGetStreamUrl: (
    translationId: number,
    maxHeight: number
  ) => Promise<{
    streamUrl: string
    subtitleContent: string | null
    availableStreams: { height: number; url: string }[]
  } | null>
  playerGetLocalSubtitles: (filePath: string) => Promise<string | null>
  playerFindLocalFile: (
    animeName: string,
    episodeInt: string,
    translationId: number,
    episodeLabel: string
  ) => Promise<{ filePath: string; subtitleContent: string | null } | null>
  playerRemuxMkv: (
    mkvPath: string
  ) => Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }>
  playerRemuxMkvStream: (
    mkvPath: string,
    initialSeek?: number
  ) => Promise<
    | {
        sessionId: string
        generation: number
        duration: number
        mimeType: string
        hasSubtitlesPending: boolean
        initialSeek: number
      }
    | { error: string }
  >
  playerRemuxMkvStreamTranscode: (
    mkvPath: string,
    initialSeek?: number
  ) => Promise<
    | {
        sessionId: string
        generation: number
        duration: number
        mimeType: string
        hasSubtitlesPending: boolean
        initialSeek: number
      }
    | { error: string }
  >
  playerStreamStart: (sessionId: string) => Promise<void>
  playerStreamAck: (sessionId: string, bytes: number) => Promise<void>
  playerStreamSeek: (
    sessionId: string,
    seekSeconds: number
  ) => Promise<{ ok: true; generation: number; keyframeTime: number } | { error: string }>
  playerCleanupRemux: () => Promise<void>
  onPlayerStreamSubtitles: (
    callback: (data: { sessionId: string; content: string }) => void
  ) => Unsubscribe
  onPlayerStreamChunk: (
    callback: (data: { sessionId: string; gen: number; data: Uint8Array }) => void
  ) => Unsubscribe
  onPlayerStreamEnd: (callback: (data: { sessionId: string }) => void) => Unsubscribe
  onPlayerStreamError: (
    callback: (data: { sessionId: string; error: string }) => void
  ) => Unsubscribe
  onPlayerStreamProgress: (
    callback: (data: {
      sessionId: string
      gen: number
      speed: number | null
      time: number | null
    }) => void
  ) => Unsubscribe

  // Shikimori
  shikimoriGetAuthUrl: () => Promise<string>
  shikimoriExchangeCode: (code: string) => Promise<ShikiUser>
  shikimoriLogout: () => Promise<void>
  shikimoriGetUser: () => Promise<ShikiUser | null>
  shikimoriGetProfile: () => Promise<ShikimoriProfile | null>
  onShikimoriProfileRefreshed: (callback: (profile: ShikimoriProfile) => void) => Unsubscribe
  shikimoriGetFriends: () => Promise<ShikiFriendCard[] | null>
  onShikimoriFriendsRefreshed: (callback: (friends: ShikiFriendCard[]) => void) => Unsubscribe
  shikimoriGetRecommendations: () => Promise<RecommendationEntry[] | null>
  onShikimoriRecommendationsRefreshed: (
    callback: (recommendations: RecommendationEntry[]) => void
  ) => Unsubscribe
  shikimoriGetRate: (malId: number) => Promise<ShikiUserRate | null>
  shikimoriUpdateRate: (
    malId: number,
    episodes: number,
    status: ShikiUserRateStatus,
    score: number,
    rewatches: number
  ) => Promise<ShikiUserRate>
  shikimoriGetFriendsRates: (malId: number) => Promise<ShikiFriendRate[]>
  shikimoriGetAnimeRates: (status?: string) => Promise<ShikiAnimeRateEntry[]>
  shikimoriGetFriendsActivity: () => Promise<ShikiFriendActivityEntry[]>
  shikimoriGetCalendar: (force?: boolean) => Promise<CalendarEntry[]>
  shikimoriGetRelated: (malId: number) => Promise<ShikiRelatedEntry[]>
  onShikimoriRateUpdated: (callback: (entry: ShikiAnimeRateEntry) => void) => Unsubscribe
  onShikimoriRatesRefreshed: (callback: (entries: ShikiAnimeRateEntry[]) => void) => Unsubscribe
  shikimoriGetOfflineQueueLength: () => Promise<number>
  onShikimoriOfflineQueueChanged: (callback: (data: { length: number }) => void) => Unsubscribe
  shikimoriGetSyncStatus: () => Promise<{
    state: 'idle' | 'syncing'
    queueLength: number
    lastSyncAt: number
    lastSyncError: string | null
  }>
  shikimoriTriggerSync: () => Promise<void>
  onShikimoriSyncStatus: (
    callback: (data: {
      state: 'idle' | 'syncing'
      queueLength: number
      lastSyncAt: number
      lastSyncError: string | null
    }) => void
  ) => Unsubscribe
  shikimoriGetAnimeDetails: (malId: number) => Promise<ShikiAnimeDetails | null>
  shikimoriTriggerDetailPrefetch: () => Promise<void>
  onShikimoriAnimeDetailsUpdated: (
    callback: (data: { malId: number; details: ShikiAnimeDetails }) => void
  ) => Unsubscribe

  // Syncplay (Watch Together)
  syncplayConnect: (cfg: SyncplayConnectConfig) => Promise<void>
  syncplayDisconnect: () => Promise<void>
  syncplaySetFile: (file: SyncplayFilePayload) => Promise<void>
  syncplaySendLocalState: (payload: {
    paused: boolean
    position: number
    cause: 'play' | 'pause' | 'seek'
  }) => Promise<void>
  syncplaySendLocalSnapshot: (snap: { position: number; paused: boolean }) => Promise<void>
  syncplaySetReady: (isReady: boolean) => Promise<void>
  syncplayGetStatus: () => Promise<SyncplayStatus>
  onSyncplayConnectionStatus: (callback: (status: SyncplayStatus) => void) => Unsubscribe
  onSyncplayRemoteState: (callback: (state: SyncplayRemoteState) => void) => Unsubscribe
  onSyncplayRoomUsers: (callback: (users: SyncplayRoomUser[]) => void) => Unsubscribe
  onSyncplayRoomEvent: (callback: (ev: SyncplayRoomEvent) => void) => Unsubscribe
  onSyncplayRemoteEpisodeChange: (callback: (ep: SyncplayRemoteEpisode) => void) => Unsubscribe
  onSyncplayTrace: (
    callback: (entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => void
  ) => Unsubscribe

  // Auto-downloader
  autoDlGetSubscription: (animeId: number) => Promise<AutoDownloadSubscription | null>
  autoDlSetSubscription: (
    animeId: number,
    enabled: boolean,
    meta?: { malId: number; animeName: string }
  ) => Promise<AutoDownloadSubscription | null>
  autoDlListSubscriptions: () => Promise<AutoDownloadSubscription[]>
  autoDlTrigger: () => Promise<AutoDlTickResult>
  autoDlGetStatus: () => Promise<{
    lastResult: AutoDlTickResult | null
    locked: boolean
    enabled: boolean
  }>
  autoDlGetEnabled: () => Promise<boolean>
  autoDlSetEnabled: (enabled: boolean) => Promise<boolean>
  onAutoDlTickResult: (callback: (result: AutoDlTickResult) => void) => Unsubscribe
  onAutoDlEnqueued: (
    callback: (data: { animeId: number; episodeInt: string; animeName: string }) => void
  ) => Unsubscribe

  // Updates
  appVersion: () => Promise<string>
  updateCheck: () => Promise<void>
  updateDownload: () => Promise<void>
  updateInstall: () => void
  onUpdateStatus: (callback: (data: UpdateStatus) => void) => Unsubscribe
}

interface Window {
  api: Api
}
