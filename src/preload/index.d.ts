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
  downloadedEpisodesGet: (animeId: number) => Promise<Record<string, EpisodeMeta>>
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
  // File management
  fileCheckEpisodes: (animeName: string, episodeInts: string[]) =>
    Promise<Record<string, { type: 'mkv' | 'mp4'; filePath: string }>>
  fileOpen: (filePath: string) => Promise<string>
  fileShowInFolder: (filePath: string) => Promise<void>
  fileDeleteEpisode: (animeName: string, episodeInt: string, animeId?: number) => Promise<void>

  onDownloadProgress: (callback: (data: EpisodeGroup[]) => void) => void
  offDownloadProgress: () => void
  onScanMergeProgress: (callback: (data: ScanMergeProgress) => void) => void
  offScanMergeProgress: () => void
  onFfmpegDownloadProgress: (callback: (data: { status: string; progress?: number }) => void) => void
  offFfmpegDownloadProgress: () => void

  shellOpenExternal: (url: string) => Promise<boolean>

  // Player
  playerGetStreamUrl: (translationId: number, maxHeight: number) => Promise<{ streamUrl: string; subtitleContent: string | null; availableStreams: { height: number; url: string }[] } | null>
  playerGetLocalSubtitles: (filePath: string) => Promise<string | null>

  // Shikimori
  shikimoriGetAuthUrl: () => Promise<string>
  shikimoriExchangeCode: (code: string) => Promise<ShikiUser>
  shikimoriLogout: () => Promise<void>
  shikimoriGetUser: () => Promise<ShikiUser | null>
  shikimoriGetRate: (malId: number) => Promise<ShikiUserRate | null>
  shikimoriUpdateRate: (malId: number, episodes: number, status: ShikiUserRateStatus, score: number) => Promise<ShikiUserRate>
  shikimoriGetAnimeRates: (status?: string) => Promise<ShikiAnimeRateEntry[]>

  // Updates
  appVersion: () => Promise<string>
  updateCheck: () => Promise<void>
  updateDownload: () => Promise<void>
  updateInstall: () => void
  onUpdateStatus: (callback: (data: UpdateStatus) => void) => void
  offUpdateStatus: () => void
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

declare global {
  interface Window {
    api: Api
  }
}
