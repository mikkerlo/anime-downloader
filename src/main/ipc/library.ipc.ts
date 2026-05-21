import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'
import type { AnimeSearchResult } from '../smotret-api'

export function register({ store, animeCacheService }: AppDeps): void {
  const readLib = (): Record<string, AnimeSearchResult> =>
    store.get('library') as Record<string, AnimeSearchResult>
  const readDownloaded = (): Record<string, AnimeSearchResult> =>
    store.get('downloadedAnime') as Record<string, AnimeSearchResult>

  ipcMain.handle(CHANNELS.LIBRARY_GET, () => {
    const lib = readLib()
    const downloaded = readDownloaded()
    const merged = new Map<string, AnimeSearchResult>()
    for (const [k, v] of Object.entries(lib)) merged.set(k, v)
    for (const [k, v] of Object.entries(downloaded)) {
      if (!merged.has(k)) merged.set(k, v)
    }
    return [...merged.values()]
  })

  ipcMain.handle(CHANNELS.LIBRARY_IS_DOWNLOADED, (_event, id: number) => {
    return !!readDownloaded()[String(id)]
  })

  ipcMain.handle(CHANNELS.LIBRARY_TOGGLE, (_event, anime: AnimeSearchResult) => {
    const lib = readLib()
    const key = String(anime.id)
    if (lib[key]) {
      delete lib[key]
      store.set('library', lib)
      if (!readDownloaded()[String(anime.id)]) animeCacheService.deleteEntry(anime.id)
      return false
    } else {
      lib[key] = anime
      store.set('library', lib)
      return true
    }
  })

  ipcMain.handle(CHANNELS.LIBRARY_HAS, (_event, id: number) => {
    return !!readLib()[String(id)]
  })

  ipcMain.handle(CHANNELS.LIBRARY_GET_STATUS, (_event, ids: number[]) => {
    const lib = readLib()
    const downloaded = readDownloaded()
    const result: Record<number, { starred: boolean; downloaded: boolean }> = {}
    for (const id of ids) {
      const key = String(id)
      result[id] = { starred: !!lib[key], downloaded: !!downloaded[key] }
    }
    return result
  })
}
