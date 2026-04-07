import { contextBridge, ipcRenderer } from 'electron'

const api = {
  validateToken: () => ipcRenderer.invoke('validate-token'),
  searchAnime: (query: string) => ipcRenderer.invoke('search-anime', query),
  getAnime: (id: number) => ipcRenderer.invoke('get-anime', id),
  getEpisode: (id: number, animeId?: number) => ipcRenderer.invoke('get-episode', id, animeId),
  probeEmbedQuality: (translationId: number, animeId?: number) => ipcRenderer.invoke('probe-embed-quality', translationId, animeId) as Promise<number | null>,
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
  fileDeleteEpisode: (animeName: string, episodeInt: string, animeId?: number) =>
    ipcRenderer.invoke('file:delete-episode', animeName, episodeInt, animeId),

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

  shellOpenExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<boolean>,

  // Player
  playerGetStreamUrl: (translationId: number, maxHeight: number) =>
    ipcRenderer.invoke('player:get-stream-url', translationId, maxHeight),
  playerGetLocalSubtitles: (filePath: string) =>
    ipcRenderer.invoke('player:get-local-subtitles', filePath) as Promise<string | null>,

  // Shikimori
  shikimoriGetAuthUrl: () => ipcRenderer.invoke('shikimori:get-auth-url') as Promise<string>,
  shikimoriExchangeCode: (code: string) => ipcRenderer.invoke('shikimori:exchange-code', code),
  shikimoriLogout: () => ipcRenderer.invoke('shikimori:logout'),
  shikimoriGetUser: () => ipcRenderer.invoke('shikimori:get-user'),
  shikimoriGetRate: (malId: number) => ipcRenderer.invoke('shikimori:get-rate', malId),
  shikimoriUpdateRate: (malId: number, episodes: number, status: string, score: number) =>
    ipcRenderer.invoke('shikimori:update-rate', malId, episodes, status, score),
  shikimoriGetAnimeRates: (status?: string) =>
    ipcRenderer.invoke('shikimori:get-anime-rates', status) as Promise<ShikiAnimeRateEntry[]>,

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
