import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import { advanceClock, watchSyncOf } from '../lib/sync-state/clock'
import { localClock } from '../store/sync-meta'
import type { AppDeps } from './index'

// The smallest position move a `'playback'` save counts as a real change.
const POSITION_CHANGE_SEC = 5

export function register({ store }: AppDeps): void {
  ipcMain.handle(
    CHANNELS.WATCH_PROGRESS_SAVE,
    (
      _event,
      animeId: number,
      episodeInt: string,
      position: number,
      duration: number,
      watched: boolean | undefined,
      translationId: number | undefined,
      source?: WatchProgressSaveSource
    ) => {
      const all = store.get('watchProgress') as Record<string, WatchProgressEntry>
      const key = `${animeId}:${episodeInt}`
      const prev = all[key]
      const clock = localClock(store)
      const nowWatched = watched || prev?.watched || false
      const justWatched = nowWatched && !prev?.watched
      const nextTranslationId = translationId !== undefined ? translationId : prev?.translationId
      const sync: WatchProgressSync = prev ? { ...watchSyncOf(prev) } : {}
      if (source === 'playback') {
        const realChange =
          !sync.position ||
          Math.abs(position - prev!.position) >= POSITION_CHANGE_SEC ||
          nextTranslationId !== prev!.translationId
        if (realChange) sync.position = advanceClock(clock, sync.position)
      }
      // A `'playback'` save reports `watched: true` only on the one save that
      // completes an open (PlayerView's one-shot `completionPending`); every
      // later save of that open sends `false`. On a row that is already
      // watched, it is a re-watch completion.
      const completed = source === 'playback' && watched === true
      if (source !== undefined && (justWatched || completed)) {
        sync.watched = advanceClock(clock, sync.watched)
      }
      all[key] = {
        position,
        duration,
        updatedAt: clock.at,
        watched: nowWatched,
        watchedAt: justWatched ? clock.at : prev?.watchedAt,
        translationId: nextTranslationId,
        sync
      }
      store.set('watchProgress', all)
    }
  )

  // The one path that can clear `watched`. Local only: it never touches the
  // Shikimori rate, which merges independently of `watched`.
  ipcMain.handle(
    CHANNELS.WATCH_PROGRESS_SET_WATCHED,
    (_event, animeId: number, episodeInt: string, watched: boolean): WatchProgressEntry | null => {
      const all = store.get('watchProgress') as Record<string, WatchProgressEntry>
      const key = `${animeId}:${episodeInt}`
      const prev = all[key]
      if (!!prev?.watched === watched) return prev ?? null
      const clock = localClock(store)
      const sync: WatchProgressSync = prev ? { ...watchSyncOf(prev) } : {}
      const next: WatchProgressEntry = {
        // Zeroed like every other watched write, so the next `'playback'` save
        // on open does not read as a move.
        position: watched ? 0 : (prev?.position ?? 0),
        duration: prev?.duration ?? 0,
        updatedAt: clock.at,
        watched,
        watchedAt: watched ? clock.at : undefined,
        translationId: prev?.translationId,
        sync: { ...sync, watched: advanceClock(clock, sync.watched) }
      }
      all[key] = next
      store.set('watchProgress', all)
      return next
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
