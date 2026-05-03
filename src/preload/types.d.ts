declare module 'libass-wasm/dist/js/subtitles-octopus.js' {
  export default class SubtitlesOctopus {
    constructor(options: Record<string, unknown>)
    dispose(): void
    setTrack(content: string): void
    freeTrack(): void
  }
}

interface ApiResponse<T> {
  data: T
  source: 'api' | 'cache'
}

interface Api {
  validateToken: () => Promise<{ valid: boolean; error?: string }>
  searchAnime: (query: string) => Promise<{ data: AnimeSearchResult[] }>
  getAnime: (id: number) => Promise<ApiResponse<AnimeDetail>>
  getEpisode: (id: number, animeId?: number) => Promise<ApiResponse<EpisodeDetail>>
  probeEmbedQuality: (translationId: number, animeId?: number) => Promise<number | null>
  getCachedPoster: (animeId: number) => Promise<string | null>
  probeFullScanNeeded: (animeId: number, episodeCount: number) => Promise<boolean>
  probeFullScanDone: (animeId: number, episodeCount: number) => Promise<void>
  reportQualityMismatch: (data: { translationId: number; author: string; type: string; reported: number; actual: number }) => Promise<void>
  getQualityMismatchCount: () => Promise<number>
  dumpQualityMismatches: () => Promise<{ count: number; path: string }>
  libraryGet: () => Promise<AnimeSearchResult[]>
  libraryToggle: (anime: AnimeSearchResult) => Promise<boolean>
  libraryHas: (id: number) => Promise<boolean>
  libraryGetStatus: (ids: number[]) => Promise<Record<number, { starred: boolean; downloaded: boolean }>>
  libraryIsDownloaded: (id: number) => Promise<boolean>
  downloadedAnimeAdd: (anime: AnimeSearchResult) => Promise<void>
  downloadedAnimeDelete: (animeId: number, animeName: string) => Promise<void>
  getSetting: (key: string) => Promise<unknown>
  setSetting: (key: string, value: unknown) => Promise<void>

  homeGetContinueWatching: () => Promise<ContinueWatchingEntry[]>

  // Watch progress
  watchProgressSave: (animeId: number, episodeInt: string, position: number, duration: number, watched?: boolean) => Promise<void>
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
  onFixMetadataProgress: (callback: (data: { current: number; total: number; file: string }) => void) => void
  offFixMetadataProgress: () => void
  ffmpegCheck: () => Promise<{ available: boolean; version: string; path: string; encoders: string[] }>
  ffmpegDelete: () => Promise<void>
  downloadPickDir: () => Promise<string | null>
  // Storage
  storagePickHotDir: () => Promise<string | null>
  storagePickColdDir: () => Promise<string | null>
  storageMoveToCold: () => Promise<{ moved: number; failed: string[] }>
  onStorageMoveToColdProgress: (callback: (data: { current: number; total: number; file: string }) => void) => void
  offStorageMoveToColdProgress: () => void
  storageGetUsage: () => Promise<StorageUsage>
  storageRunCleanup: (opts?: { force?: boolean }) => Promise<CleanupResult>
  onStorageUsageProgress: (callback: (data: { scanned: number; total: number }) => void) => void
  offStorageUsageProgress: () => void
  onStorageCleanupPending: (callback: (data: { candidates: CleanupCandidate[] }) => void) => void
  offStorageCleanupPending: () => void
  onStorageCleanupFinished: (callback: (data: CleanupResult) => void) => void
  offStorageCleanupFinished: () => void
  // File management
  fileCheckEpisodes: (animeName: string, episodeInts: string[]) =>
    Promise<Record<string, { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]>>
  fileOpen: (filePath: string) => Promise<string>
  fileShowInFolder: (filePath: string) => Promise<void>
  fileDeleteEpisode: (animeName: string, episodeInt: string, animeId?: number, translationId?: number) => Promise<void>
  onFileEpisodesChanged: (callback: (animeName: string, data: Record<string, { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]>) => void) => void
  offFileEpisodesChanged: () => void

  onDownloadProgress: (callback: (data: EpisodeGroup[]) => void) => void
  offDownloadProgress: () => void
  onScanMergeProgress: (callback: (data: ScanMergeProgress) => void) => void
  offScanMergeProgress: () => void
  onFfmpegDownloadProgress: (callback: (data: { status: string; progress?: number }) => void) => void
  offFfmpegDownloadProgress: () => void
  onFpcalcDownloadProgress: (callback: (data: { status: string; progress?: number }) => void) => void
  offFpcalcDownloadProgress: () => void

  // Skip detection (Chromaprint)
  skipDetectorAnalyzeShow: (
    animeId: number,
    episodes: { episodeInt: string; episodeLabel: string; filePath: string }[]
  ) => Promise<ShowSkipDetections>
  skipDetectorGetDetections: (animeId: number) => Promise<ShowSkipDetections | null>
  skipDetectorGetStatus: () => Promise<{ animeId: number; lastProgress: SkipDetectorProgress | null } | null>
  skipDetectorCancel: () => Promise<void>
  skipDetectorCacheStats: () => Promise<{ fingerprintCount: number }>
  skipDetectorBackfillAll: () => Promise<{ queued: number; alreadyAnalyzed: number; skippedFewEpisodes: number; total: number }>
  skipDetectorQueueStatus: () => Promise<{ currentAnimeId: number | null; queueLength: number }>
  onSkipDetectorProgress: (callback: (data: SkipDetectorProgress) => void) => void
  offSkipDetectorProgress: () => void
  onSkipDetectorSignatureUpdated: (callback: (data: { animeId: number; perEpisode: Record<string, EpisodeSkipDetection> }) => void) => void
  offSkipDetectorSignatureUpdated: () => void

  shellOpenExternal: (url: string) => Promise<boolean>
  shellOpenExternalFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>

  // Player
  playerGetStreamUrl: (translationId: number, maxHeight: number) => Promise<{ streamUrl: string; subtitleContent: string | null; availableStreams: { height: number; url: string }[] } | null>
  playerGetLocalSubtitles: (filePath: string) => Promise<string | null>
  playerFindLocalFile: (animeName: string, episodeInt: string, translationId: number) => Promise<{ filePath: string; subtitleContent: string | null } | null>
  playerRemuxMkv: (mkvPath: string) => Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }>
  playerRemuxMkvStream: (mkvPath: string, initialSeek?: number) => Promise<
    | { sessionId: string; generation: number; duration: number; mimeType: string; hasSubtitlesPending: boolean; initialSeek: number }
    | { error: string }
  >
  playerRemuxMkvStreamTranscode: (mkvPath: string, initialSeek?: number) => Promise<
    | { sessionId: string; generation: number; duration: number; mimeType: string; hasSubtitlesPending: boolean; initialSeek: number }
    | { error: string }
  >
  playerStreamStart: (sessionId: string) => Promise<void>
  playerStreamAck: (sessionId: string, bytes: number) => Promise<void>
  playerStreamSeek: (sessionId: string, seekSeconds: number) => Promise<{ ok: true; generation: number } | { error: string }>
  playerCleanupRemux: () => Promise<void>
  onPlayerStreamSubtitles: (callback: (data: { sessionId: string; content: string }) => void) => void
  offPlayerStreamSubtitles: () => void
  onPlayerStreamChunk: (callback: (data: { sessionId: string; gen: number; data: Uint8Array }) => void) => void
  offPlayerStreamChunk: () => void
  onPlayerStreamEnd: (callback: (data: { sessionId: string }) => void) => void
  offPlayerStreamEnd: () => void
  onPlayerStreamError: (callback: (data: { sessionId: string; error: string }) => void) => void
  offPlayerStreamError: () => void
  onPlayerStreamProgress: (callback: (data: { sessionId: string; gen: number; speed: number | null; time: number | null }) => void) => void
  offPlayerStreamProgress: () => void

  // Shikimori
  shikimoriGetAuthUrl: () => Promise<string>
  shikimoriExchangeCode: (code: string) => Promise<ShikiUser>
  shikimoriLogout: () => Promise<void>
  shikimoriGetUser: () => Promise<ShikiUser | null>
  shikimoriGetRate: (malId: number) => Promise<ShikiUserRate | null>
  shikimoriUpdateRate: (malId: number, episodes: number, status: ShikiUserRateStatus, score: number) => Promise<ShikiUserRate>
  shikimoriGetFriendsRates: (malId: number) => Promise<ShikiFriendRate[]>
  shikimoriGetAnimeRates: (status?: string) => Promise<ShikiAnimeRateEntry[]>
  shikimoriGetFriendsActivity: () => Promise<ShikiFriendActivityEntry[]>
  shikimoriGetCalendar: (force?: boolean) => Promise<CalendarEntry[]>
  shikimoriGetRelated: (malId: number) => Promise<ShikiRelatedEntry[]>
  onShikimoriRateUpdated: (callback: (entry: ShikiAnimeRateEntry) => void) => void
  offShikimoriRateUpdated: () => void
  onShikimoriRatesRefreshed: (callback: (entries: ShikiAnimeRateEntry[]) => void) => void
  offShikimoriRatesRefreshed: () => void
  shikimoriGetOfflineQueueLength: () => Promise<number>
  onShikimoriOfflineQueueChanged: (callback: (data: { length: number }) => void) => void
  offShikimoriOfflineQueueChanged: () => void
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
  ) => void
  offShikimoriSyncStatus: () => void
  shikimoriGetAnimeDetails: (malId: number) => Promise<ShikiAnimeDetails | null>
  shikimoriTriggerDetailPrefetch: () => Promise<void>
  onShikimoriAnimeDetailsUpdated: (
    callback: (data: { malId: number; details: ShikiAnimeDetails }) => void
  ) => void
  offShikimoriAnimeDetailsUpdated: () => void

  // Syncplay (Watch Together)
  syncplayConnect: (cfg: SyncplayConnectConfig) => Promise<void>
  syncplayDisconnect: () => Promise<void>
  syncplaySetFile: (file: SyncplayFilePayload) => Promise<void>
  syncplaySendLocalState: (payload: { paused: boolean; position: number; cause: 'play' | 'pause' | 'seek' }) => Promise<void>
  syncplaySendLocalSnapshot: (snap: { position: number; paused: boolean }) => Promise<void>
  syncplaySetReady: (isReady: boolean) => Promise<void>
  syncplayGetStatus: () => Promise<SyncplayStatus>
  onSyncplayConnectionStatus: (callback: (status: SyncplayStatus) => void) => void
  offSyncplayConnectionStatus: (callback: (status: SyncplayStatus) => void) => void
  onSyncplayRemoteState: (callback: (state: SyncplayRemoteState) => void) => void
  offSyncplayRemoteState: (callback: (state: SyncplayRemoteState) => void) => void
  onSyncplayRoomUsers: (callback: (users: SyncplayRoomUser[]) => void) => void
  offSyncplayRoomUsers: (callback: (users: SyncplayRoomUser[]) => void) => void
  onSyncplayRoomEvent: (callback: (ev: SyncplayRoomEvent) => void) => void
  offSyncplayRoomEvent: (callback: (ev: SyncplayRoomEvent) => void) => void
  onSyncplayRemoteEpisodeChange: (callback: (ep: SyncplayRemoteEpisode) => void) => void
  offSyncplayRemoteEpisodeChange: (callback: (ep: SyncplayRemoteEpisode) => void) => void
  onSyncplayTrace: (callback: (entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => void) => void
  offSyncplayTrace: (callback: (entry: { dir: 'in' | 'out'; keys: string; msg: unknown }) => void) => void

  // Updates
  appVersion: () => Promise<string>
  updateCheck: () => Promise<void>
  updateDownload: () => Promise<void>
  updateInstall: () => void
  onUpdateStatus: (callback: (data: UpdateStatus) => void) => void
  offUpdateStatus: () => void
}

interface SyncplayConnectConfig {
  host: string
  port: number
  room: string
  username: string
  password?: string
  autoReconnect: boolean
}

interface SyncplayFilePayload {
  animeId: number
  malId: number | null
  episodeInt: string
  translationId: number | null
  canonicalName: string
  duration: number
}

interface SyncplayStatus {
  state:
    | 'idle'
    | 'connecting'
    | 'tls-probing'
    | 'tls-handshake'
    | 'hello-sent'
    | 'ready'
    | 'reconnecting'
    | 'disconnected'
  host?: string
  port?: number
  room?: string
  username?: string
  tls?: boolean
  error?: string
}

interface SyncplayRemoteState {
  paused: boolean
  position: number
  setBy: string | null
  doSeek: boolean
}

interface SyncplayRoomUser {
  username: string
  file: { name: string; duration: number; size?: number } | null
  isReady?: boolean
  animeDlAppMeta?: {
    animeId: number
    malId: number | null
    episodeInt: string
    translationId: number | null
  }
}

interface SyncplayRoomEvent {
  level: 'info' | 'warn' | 'error' | 'chat'
  text: string
}

interface SyncplayRemoteEpisode {
  animeId: number
  malId: number | null
  episodeInt: string
  translationId: number | null
  canonicalName: string
  fromUser: string
}

interface AnimeSearchResult {
  id: number
  title: string
  titles: { ru?: string; romaji?: string; ja?: string }
  posterUrlSmall: string
  numberOfEpisodes: number
  type: string
  typeTitle: string
  year: number
  season: string
}

interface AnimeDetail extends AnimeSearchResult {
  posterUrl: string
  descriptions: { source: string; value: string }[]
  episodes: EpisodeSummary[]
  genres: { id: number; title: string }[]
  myAnimeListId?: number
}

interface EpisodeSummary {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  isActive: number
}

interface EpisodeDetail {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  translations: Translation[]
}

interface Translation {
  id: number
  type: string
  typeKind: string
  typeLang: string
  authorsSummary: string
  isActive: number
  width: number
  height: number
  duration: string
}

interface WatchProgressEntry {
  position: number
  duration: number
  updatedAt: number
  watched?: boolean
  watchedAt?: number
}

interface StorageEpisodeUsage {
  episodeInt: string
  files: { mkv?: { path: string; size: number }; mp4?: { path: string; size: number }; ass?: { path: string; size: number } }
  totalBytes: number
  watched: boolean
  watchedAt?: number
}

interface StorageAnimeUsage {
  animeId: number
  animeName: string
  posterUrlSmall: string
  bytes: number
  bytesHot: number
  bytesCold: number
  fileCount: number
  episodes: StorageEpisodeUsage[]
}

interface StorageUsage {
  totalBytes: number
  bytesHot: number
  bytesCold: number
  fileCount: number
  perAnime: StorageAnimeUsage[]
}

interface CleanupCandidate {
  animeId: number
  animeName: string
  episodeInt: string
  bytes: number
  watchedAt: number
}

interface CleanupResult {
  ranAt: number
  deletedCount: number
  freedBytes: number
  items: CleanupCandidate[]
}

interface CleanupLogEntry {
  ranAt: number
  animeId: number
  animeName: string
  episodeInt: string
  bytes: number
}

interface ContinueWatchingEntry {
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

interface EpisodeMeta {
  translationType: string
  author: string
  quality: number
  translationId: number
}

interface DownloadRequest {
  translationId: number
  height: number
  animeName: string
  episodeLabel: string
  episodeInt: string
  animeId: number
  translationType: string
  author: string
}

interface DownloadProgressItem {
  id: string
  translationId: number
  kind: 'video' | 'subtitle'
  url: string
  filename: string
  animeName: string
  episodeLabel: string
  quality: number
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
  bytesReceived: number
  totalBytes: number
  speed: number
  error?: string
}

interface EpisodeGroup {
  translationId: number
  animeName: string
  episodeLabel: string
  quality: number
  video: DownloadProgressItem | null
  subtitle: DownloadProgressItem | null
  mergeStatus: 'pending' | 'merging' | 'completed' | 'failed'
  mergePercent?: number
  mergeError?: string
}

interface ScanMergeProgress {
  current: number
  total: number
  file: string
  percent: number
}

interface UpdateStatus {
  status: 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
}

interface SkipRange {
  startSec: number
  endSec: number
  pairCount: number
}

interface EpisodeSkipDetection {
  episodeInt: string
  episodeLabel: string
  filePath: string
  durationSec: number
  hashesPerSec: number
  op: SkipRange | null
  ed: SkipRange | null
}

interface ShowSkipDetections {
  animeId: number
  perEpisode: Record<string, EpisodeSkipDetection>
  analyzedAt: number
  episodeCount: number
  algorithm: {
    sampleRate: number
    matchBitThreshold: number
    minRunSec: number
    windowSec: number
    refineBitThreshold: number
    refineSustainHashes: number
  }
}

interface SkipDetectorProgress {
  animeId: number
  phase: 'fingerprinting' | 'comparing' | 'done'
  current: number
  total: number
  episodeLabel?: string
}

interface ShikiUser {
  id: number
  nickname: string
  avatar: string
}

type ShikiUserRateStatus = 'planned' | 'watching' | 'rewatching' | 'completed' | 'on_hold' | 'dropped'

interface ShikiUserRate {
  id: number
  score: number
  status: ShikiUserRateStatus
  episodes: number
  target_id: number
  target_type: string
}

interface ShikiAnimeInfo {
  id: number
  name: string
  russian: string
  image: { original: string; preview: string; x96: string; x48: string }
  episodes: number
  episodes_aired: number
  kind: string
  score: string
  status: string
}

interface ShikiAnimeRateEntry {
  rate: {
    id: number
    score: number
    status: ShikiUserRateStatus
    episodes: number
    updated_at: string
    target_id: number
  }
  shikiAnime: ShikiAnimeInfo
  smotretAnime: AnimeSearchResult | null
}

interface ShikiAnimeGenre {
  id: number
  name: string
  russian: string
  kind: string
}

interface ShikiAnimeStudio {
  id: number
  name: string
  filtered_name: string
  real: boolean
  image: string | null
}

interface ShikiAnimeDetails {
  id: number
  name: string
  russian: string
  kind: string
  description: string | null
  description_html: string | null
  rating: string
  duration: number
  aired_on: string | null
  released_on: string | null
  genres: ShikiAnimeGenre[]
  studios: ShikiAnimeStudio[]
  score: string
  status: string
  episodes: number
  episodes_aired: number
}

interface ShikiFriendRate {
  nickname: string
  avatar: string
  status: ShikiUserRateStatus
  score: number
  episodes: number
}

interface ShikiFriendActivityEntry {
  friendId: number
  friendNickname: string
  friendAvatar: string
  malId: number
  animeName: string
  animeImage: string
  description: string
  createdAt: string
  smotretAnime: AnimeSearchResult | null
}

interface CalendarEntry {
  malId: number
  animeId: number | null
  name: string
  posterUrl: string
  kind: string
  episodeInt: string
  nextEpisodeAt: string
  userStatus: ShikiUserRateStatus
}

interface ShikiRelatedAnimeInfo {
  id: number
  name: string
  image_url: string
  url: string
  year: number | null
  kind: string | null
  date: number | null
}

interface ShikiRelatedEntry {
  relation: string | null
  shikiAnime: ShikiRelatedAnimeInfo
  smotretAnime: AnimeSearchResult | null
  isCurrent: boolean
  watchStatus: ShikiUserRateStatus | null
}

interface Window {
  api: Api
}
