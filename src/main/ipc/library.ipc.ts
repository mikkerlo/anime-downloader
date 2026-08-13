import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'
import type { AnimeSearchResult } from '../smotret-api'

export function register({ store, animeCacheService }: AppDeps): void {
  const readLib = (): Record<string, AnimeSearchResult> =>
    store.get('library') as Record<string, AnimeSearchResult>
  const readDownloaded = (): Record<string, AnimeSearchResult> =>
    store.get('downloadedAnime') as Record<string, AnimeSearchResult>
  const readPriority = (): string[] => (store.get('priorityAnimeIds') as string[]) ?? []

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
      // Priority stores ids only and renders from the `library` snapshot, so an
      // un-starred entry must leave the priority list too — otherwise the id
      // dangles with nothing left to render from.
      const priority = readPriority()
      if (priority.includes(key)) {
        store.set(
          'priorityAnimeIds',
          priority.filter((id) => id !== key)
        )
      }
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

  // Locally prioritized titles, in promote order. Priority persists ids only —
  // the metadata home stays `library` / `downloadedAnime` — so ids that no
  // longer resolve there are pruned from the *response* without writing back:
  // a read handler that repaired the store would destroy data if `library` were
  // ever transiently empty.
  ipcMain.handle(CHANNELS.LIBRARY_GET_PRIORITY, () => {
    const lib = readLib()
    const downloaded = readDownloaded()
    return readPriority().filter((key) => !!lib[key] || !!downloaded[key])
  })

  // Promote/demote in one round-trip, returning the resulting ordered list so
  // the caller refreshes membership *and* ordering without a second call.
  // Promoting also stars the title if it is not already starred — the priority
  // ⊆ library invariant, enforced main-side so the two writes cannot interleave.
  ipcMain.handle(
    CHANNELS.LIBRARY_SET_PRIORITY,
    (_event, anime: AnimeSearchResult, priority: boolean) => {
      const key = String(anime.id)
      const current = readPriority()
      if (priority) {
        const lib = readLib()
        if (!lib[key]) {
          lib[key] = anime
          store.set('library', lib)
        }
        if (current.includes(key)) return current
        const next = [...current, key]
        store.set('priorityAnimeIds', next)
        return next
      }
      if (!current.includes(key)) return current
      const next = current.filter((id) => id !== key)
      store.set('priorityAnimeIds', next)
      return next
    }
  )
}
