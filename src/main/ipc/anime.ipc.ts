import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({ smotretApi, animeCacheService, rememberAnimeMeta }: AppDeps): void {
  ipcMain.handle(CHANNELS.VALIDATE_TOKEN, () => smotretApi.validateToken())

  ipcMain.handle(CHANNELS.SEARCH_ANIME, async (_event, query: string) => {
    return smotretApi.searchAnime(query)
  })

  ipcMain.handle(CHANNELS.GET_ANIME, async (_event, id: number) => {
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
}
