interface Api {
  searchAnime: (query: string) => Promise<{ data: AnimeSearchResult[] }>
  getAnime: (id: number) => Promise<{ data: AnimeDetail }>
  getEpisode: (id: number) => Promise<{ data: EpisodeDetail }>
  libraryGet: () => Promise<AnimeSearchResult[]>
  libraryToggle: (anime: AnimeSearchResult) => Promise<boolean>
  libraryHas: (id: number) => Promise<boolean>
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
  downloadCancel: (id: string) => Promise<void>
  downloadGetQueue: () => Promise<EpisodeGroup[]>
  downloadCancelByEpisode: (animeName: string, episodeLabel?: string) => Promise<void>
  downloadedEpisodesGet: (animeId: number) => Promise<Record<string, EpisodeMeta>>
  downloadClearCompleted: () => Promise<void>
  downloadCancelMerge: () => Promise<void>
  downloadMerge: () => Promise<void>
  downloadScanMerge: () => Promise<{ merged: number; failed: string[] }>
  ffmpegCheck: () => Promise<{ available: boolean; version: string; path: string; encoders: string[] }>
  downloadPickDir: () => Promise<string | null>
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

declare global {
  interface Window {
    api: Api
  }
}
