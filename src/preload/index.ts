import { contextBridge, ipcRenderer } from 'electron'

const api = {
  searchAnime: (query: string) => ipcRenderer.invoke('search-anime', query),
  getAnime: (id: number) => ipcRenderer.invoke('get-anime', id),
  getEpisode: (id: number) => ipcRenderer.invoke('get-episode', id),
  libraryGet: () => ipcRenderer.invoke('library-get'),
  libraryToggle: (anime: unknown) => ipcRenderer.invoke('library-toggle', anime),
  libraryHas: (id: number) => ipcRenderer.invoke('library-has', id),
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
  downloadCancel: (id: string) => ipcRenderer.invoke('download:cancel', id),
  downloadGetQueue: () => ipcRenderer.invoke('download:get-queue'),
  downloadCancelByEpisode: (animeName: string, episodeLabel?: string) =>
    ipcRenderer.invoke('download:cancel-by-episode', animeName, episodeLabel),
  downloadedEpisodesGet: (animeId: number) => ipcRenderer.invoke('downloaded-episodes-get', animeId),
  downloadClearCompleted: () => ipcRenderer.invoke('download:clear-completed'),
  downloadMerge: () => ipcRenderer.invoke('download:merge'),
  ffmpegCheck: () => ipcRenderer.invoke('ffmpeg:check'),
  downloadPickDir: () => ipcRenderer.invoke('download:pick-dir'),
  // File management
  fileCheckEpisodes: (animeName: string, episodeInts: string[]) =>
    ipcRenderer.invoke('file:check-episodes', animeName, episodeInts),
  fileOpen: (filePath: string) => ipcRenderer.invoke('file:open', filePath),
  fileShowInFolder: (filePath: string) => ipcRenderer.invoke('file:show-in-folder', filePath),
  fileDeleteEpisode: (animeName: string, episodeInt: string, animeId?: number) =>
    ipcRenderer.invoke('file:delete-episode', animeName, episodeInt, animeId),

  downloadScanMerge: () => ipcRenderer.invoke('download:scan-merge'),

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
