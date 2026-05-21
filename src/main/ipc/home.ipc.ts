import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'
import type { AnimeSearchResult, AnimeDetail } from '../smotret-api'
import type { AnimeCacheEntry } from '../services/anime-cache'
import {
  buildContinueWatchingEntries,
  finalizeContinueWatchingEntries,
  type CachedShikiRate,
  type WatchProgressEntry
} from '../lib/continue-watching'

const RESOLVE_CONCURRENCY = 4
const RESOLVE_TIMEOUT_MS = 5000

export function register({ store, smotretApi, rememberAnimeMeta }: AppDeps): void {
  ipcMain.handle(CHANNELS.HOME_GET_CONTINUE_WATCHING, async () => {
    const inputs = {
      watchProgress: store.get('watchProgress') as Record<string, WatchProgressEntry>,
      rates: store.get('shikimoriUserRates') as CachedShikiRate[],
      library: store.get('library') as Record<string, AnimeSearchResult>,
      downloaded: store.get('downloadedAnime') as Record<string, AnimeSearchResult>,
      recent: store.get('recentAnimeMeta') as Record<string, AnimeSearchResult>,
      malMap: store.get('malIdMap') as Record<string, AnimeSearchResult>,
      cache: store.get('animeCache') as Record<string, AnimeCacheEntry>
    }

    const { entries, unresolvedIds } = buildContinueWatchingEntries(inputs)

    const fetched: Record<number, AnimeDetail | null> = {}
    if (unresolvedIds.length > 0) {
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < unresolvedIds.length) {
          const id = unresolvedIds[cursor++]
          let timer: NodeJS.Timeout | undefined
          try {
            const result = await Promise.race([
              smotretApi.getAnime(id),
              new Promise<{ data: null }>((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), RESOLVE_TIMEOUT_MS)
              })
            ])
            const detail = (result as { data: AnimeDetail | null }).data
            if (detail) {
              fetched[id] = detail
              rememberAnimeMeta(detail)
            }
          } catch {
            fetched[id] = null
          } finally {
            clearTimeout(timer)
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(RESOLVE_CONCURRENCY, unresolvedIds.length) }, () => worker())
      )
    }

    return finalizeContinueWatchingEntries(entries, fetched)
  })
}
