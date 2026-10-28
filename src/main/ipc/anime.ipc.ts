import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'
import type { EpisodeDetail } from '../smotret-api'
import { OfflineError } from '../lib/net'
import { buildCorpus, searchLocal, type LocalSearchSnapshot } from '../lib/local-search'

export function register({
  store,
  smotretApi,
  animeCacheService,
  rememberAnimeMeta,
  offlineService,
  recentWatch
}: AppDeps): void {
  // Shared cache read for the cache-first channel + the network-first
  // error-fallback (#196) so the two reads can't drift: id → cached episode
  // translation, undefined entries filtered out.
  function readCachedEpisodes(animeId: number, episodeIds: number[]): EpisodeDetail[] {
    const cached = animeCacheService.getEntry(animeId)
    if (!cached) return []
    return episodeIds
      .map((id) => cached.episodes[id])
      .filter((d): d is EpisodeDetail => d !== undefined)
  }

  ipcMain.handle(CHANNELS.VALIDATE_TOKEN, () => smotretApi.validateToken())

  ipcMain.handle(CHANNELS.SEARCH_ANIME, async (_event, query: string) => {
    return smotretApi.searchAnime(query)
  })

  // Local search (#571): one read of each key per call, so one clone of
  // `animeCache` per search. Fine on submit; an as-you-type search would need a
  // corpus cached in main and invalidated on writes to these keys.
  ipcMain.handle(
    CHANNELS.SEARCH_LOCAL,
    (_event, query: string, filters?: LocalSearchFilters): LocalSearchResponse => {
      const corpus = buildCorpus({
        library: store.get('library') as LocalSearchSnapshot['library'],
        downloadedAnime: store.get('downloadedAnime') as LocalSearchSnapshot['downloadedAnime'],
        animeCache: store.get('animeCache') as LocalSearchSnapshot['animeCache'],
        shikimoriUserRates: store.get(
          'shikimoriUserRates'
        ) as LocalSearchSnapshot['shikimoriUserRates'],
        shikimoriAnimeDetails: store.get(
          'shikimoriAnimeDetails'
        ) as LocalSearchSnapshot['shikimoriAnimeDetails'],
        isRecentlyWatched: (animeId) => recentWatch.has(animeId)
      })
      return { results: searchLocal(corpus, query, filters), corpusSize: corpus.length }
    }
  )

  ipcMain.handle(CHANNELS.GET_ANIME, async (_event, id: number) => {
    // Offline (#568) the cache is the answer, without a refused round trip.
    if (offlineService?.isOffline()) {
      const cached = animeCacheService.getEntry(id)
      if (cached?.animeDetail) return { data: cached.animeDetail, source: 'cache' }
      throw new OfflineError()
    }
    try {
      const result = await smotretApi.getAnime(id)
      animeCacheService.updateAnimeDetail(id, result.data)
      rememberAnimeMeta(result.data)
      return { ...result, source: 'api' }
    } catch (err) {
      const cached = animeCacheService.getEntry(id)
      if (cached?.animeDetail) {
        return { data: cached.animeDetail, source: 'cache' }
      }
      throw err
    }
  })

  ipcMain.handle(
    CHANNELS.PROBE_EMBED_QUALITY,
    async (_event, translationId: number, animeId?: number) => {
      try {
        const embed = await smotretApi.getEmbed(translationId)
        const streams = embed.stream || []
        if (streams.length === 0) return null
        const best = streams.reduce((a, b) => (a.height > b.height ? a : b))
        if (animeId) animeCacheService.updateQualityProbe(animeId, translationId, best.height)
        return best.height
      } catch {
        if (animeId) {
          const cached = animeCacheService.getEntry(animeId)
          return cached?.qualityProbes[translationId] ?? null
        }
        return null
      }
    }
  )

  ipcMain.handle(
    CHANNELS.PROBE_FULL_SCAN_NEEDED,
    (_event, animeId: number, episodeCount: number) => {
      const entry = animeCacheService.getEntry(animeId)
      if (!entry?.fullProbeAt) return true
      if (entry.fullProbeEpisodeCount !== episodeCount) return true
      const weekMs = 7 * 24 * 60 * 60 * 1000
      return Date.now() - entry.fullProbeAt > weekMs
    }
  )

  ipcMain.handle(CHANNELS.PROBE_FULL_SCAN_DONE, (_event, animeId: number, episodeCount: number) => {
    const entry = animeCacheService.getEntry(animeId)
    if (!entry) return
    entry.fullProbeAt = Date.now()
    entry.fullProbeEpisodeCount = episodeCount
    animeCacheService.setEntry(animeId, entry)
  })

  ipcMain.handle(CHANNELS.GET_EPISODE, async (_event, id: number, animeId?: number) => {
    try {
      const result = await smotretApi.getEpisode(id)
      if (animeId) animeCacheService.updateEpisode(animeId, id, result.data)
      return { ...result, source: 'api' }
    } catch (err) {
      if (animeId) {
        const cached = animeCacheService.getEntry(animeId)
        if (cached?.episodes[id]) {
          return { data: cached.episodes[id], source: 'cache' }
        }
      }
      throw err
    }
  })

  ipcMain.handle(
    CHANNELS.GET_EPISODES_BATCH,
    async (_event, episodeIds: number[], animeId?: number) => {
      try {
        const result = await smotretApi.getEpisodesBatch(episodeIds)
        // Single store write for the whole page — per-episode updates used to
        // block this reply behind ~60 full-file store operations.
        if (animeId) animeCacheService.updateEpisodes(animeId, result.data)
        return { ...result, source: 'api' }
      } catch (err) {
        if (animeId) {
          const data = readCachedEpisodes(animeId, episodeIds)
          if (data.length > 0) return { data, source: 'cache' }
        }
        throw err
      }
    }
  )

  // Cache-first read: returns whatever translations `animeCacheService` already
  // has, synchronously, with no network (#196). The renderer paints these rows
  // immediately, then background-refreshes via the network `GET_EPISODES_BATCH`
  // and patches. Always reports `source: 'cache'`; an empty `data` just means
  // nothing was cached (cold/non-library anime) and the network fetch fills it.
  ipcMain.handle(
    CHANNELS.GET_EPISODES_BATCH_CACHED,
    (_event, episodeIds: number[], animeId?: number) => {
      const data = animeId ? readCachedEpisodes(animeId, episodeIds) : []
      return { data, source: 'cache' as const }
    }
  )
}
