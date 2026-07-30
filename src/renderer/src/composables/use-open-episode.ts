// Standalone "open the player at (animeId, episodeInt, translationId?)"
// path (#213). Unlike use-episode-downloads, which assembles PlayerPayload
// from AnimeDetailView's already-loaded state, this composable fetches
// everything itself — anime details, the episode-detail window around the
// target (same PAGE_SIZE granularity the detail view paginates by, so
// PlayerView's prev/next resolution behaves identically), downloaded-episode
// metadata, and a CDN stream — then calls playerStore.openPlayer().
//
// Used by WatchTogetherView's "Join & watch"; also the natural seam for
// future deep links and the remote-episode-change mismatch case.

import { PAGE_SIZE, filterEpisodes } from './use-episode-list'
import { usePlayerStore, type PlayerTranslation } from '../stores/player'
import { getAnimeName } from '../utils'

export type OpenEpisodeTarget = {
  animeId: number
  episodeInt: string
  translationId?: number | null
}

export type OpenEpisodeResult = { ok: true } | { ok: false; error: string }

function toPlayerTranslations(detail: EpisodeDetail | undefined): PlayerTranslation[] {
  if (!detail) return []
  return detail.translations
    .filter((t) => t.isActive === 1)
    .map((t) => ({ id: t.id, label: t.authorsSummary, type: t.type, height: t.height }))
}

export function useOpenEpisode(): {
  openEpisode: (target: OpenEpisodeTarget) => Promise<OpenEpisodeResult>
} {
  const playerStore = usePlayerStore()

  async function openEpisode(target: OpenEpisodeTarget): Promise<OpenEpisodeResult> {
    let anime: AnimeDetail
    try {
      anime = (await window.api.getAnime(target.animeId)).data
    } catch (err) {
      return { ok: false, error: `Failed to load anime ${target.animeId}: ${String(err)}` }
    }

    const eps = filterEpisodes(anime)
    const episodeIndex = eps.findIndex((ep) => ep.episodeInt === target.episodeInt)
    if (episodeIndex < 0) {
      return { ok: false, error: `Episode ${target.episodeInt} not found` }
    }

    const pageStart = Math.floor(episodeIndex / PAGE_SIZE) * PAGE_SIZE
    const windowIds = eps.slice(pageStart, pageStart + PAGE_SIZE).map((ep) => ep.id)
    let details = new Map<number, EpisodeDetail>()
    let episodeMeta: Record<string, EpisodeMeta[]> = {}
    try {
      const [batch, meta] = await Promise.all([
        window.api.getEpisodesBatchCached(windowIds, target.animeId),
        window.api.downloadedEpisodesGet(target.animeId)
      ])
      details = new Map(batch.data.map((d) => [d.id, d]))
      episodeMeta = meta
    } catch (err) {
      return { ok: false, error: `Failed to load episode details: ${String(err)}` }
    }

    const allEpisodes = eps.map((ep) => ({
      episodeInt: ep.episodeInt,
      episodeFull: ep.episodeFull,
      translations: toPlayerTranslations(details.get(ep.id)),
      downloadedTrIds: (episodeMeta[ep.episodeInt] || []).map((m) => m.translationId)
    }))

    const targetEp = allEpisodes[episodeIndex]
    if (targetEp.translations.length === 0) {
      return { ok: false, error: `No translations available for episode ${target.episodeInt}` }
    }

    // Requested translation first, then the rest by quality — the first one
    // that yields a stream wins, so an unavailable host translation degrades
    // to the best available instead of failing the join.
    const requested = targetEp.translations.find((t) => t.id === target.translationId)
    const fallbacks = targetEp.translations
      .filter((t) => t.id !== target.translationId)
      .sort((a, b) => b.height - a.height)
    const candidates = requested ? [requested, ...fallbacks] : fallbacks

    for (const tr of candidates) {
      let result: Awaited<ReturnType<typeof window.api.playerGetStreamUrl>>
      try {
        result = await window.api.playerGetStreamUrl(tr.id, tr.height)
      } catch {
        continue
      }
      if (!result) continue
      playerStore.openPlayer({
        filePath: '',
        streamUrl: result.streamUrl,
        subtitleContent: result.subtitleContent || '',
        animeName: getAnimeName(anime),
        episodeLabel: target.episodeInt,
        availableStreams: result.availableStreams,
        translationId: tr.id,
        translations: targetEp.translations,
        downloadedTrIds: [...targetEp.downloadedTrIds],
        allEpisodes,
        episodeIndex,
        animeId: target.animeId,
        malId: anime.myAnimeListId ?? 0
      })
      return { ok: true }
    }
    return { ok: false, error: `No playable stream for episode ${target.episodeInt}` }
  }

  return { openEpisode }
}
