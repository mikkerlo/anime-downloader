import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

interface WatchProgressEntry {
  position: number
  duration: number
  updatedAt: number
  watched?: boolean
  watchedAt?: number
  translationId?: number
}

export function register({ store }: AppDeps): void {
  ipcMain.handle(
    CHANNELS.WATCH_PROGRESS_SAVE,
    (
      _event,
      animeId: number,
      episodeInt: string,
      position: number,
      duration: number,
      watched?: boolean,
      translationId?: number
    ) => {
      const all = store.get('watchProgress') as Record<string, WatchProgressEntry>
      const key = `${animeId}:${episodeInt}`
      const prev = all[key]
      const nowWatched = watched || prev?.watched || false
      const justWatched = nowWatched && !prev?.watched
      all[key] = {
        position,
        duration,
        updatedAt: Date.now(),
        watched: nowWatched,
        watchedAt: justWatched ? Date.now() : prev?.watchedAt,
        translationId: translationId !== undefined ? translationId : prev?.translationId
      }
      store.set('watchProgress', all)
    }
  )

  ipcMain.handle(CHANNELS.WATCH_PROGRESS_GET, (_event, animeId: number, episodeInt: string) => {
    const all = store.get('watchProgress') as Record<string, WatchProgressEntry>
    return all[`${animeId}:${episodeInt}`] || null
  })

  ipcMain.handle(CHANNELS.WATCH_PROGRESS_GET_ALL, (_event, animeId: number) => {
    const all = store.get('watchProgress') as Record<string, WatchProgressEntry>
    const prefix = `${animeId}:`
    const out: Record<string, WatchProgressEntry> = {}
    for (const [key, val] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        out[key.slice(prefix.length)] = val
      }
    }
    return out
  })
}
