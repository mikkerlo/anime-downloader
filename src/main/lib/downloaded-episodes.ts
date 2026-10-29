/**
 * The single writer of `downloadedEpisodes` entries (#412).
 *
 * Extracted out of `index.ts` so it has two callers instead of one: the
 * per-video hook that fires as soon as the video item lands, and the
 * group-complete hook that still runs afterwards as a repair path for queues
 * persisted before that hook existed. Both write the same keyed entry from the
 * same video item, so running both is idempotent by construction — which is
 * the property the callers rely on rather than a happy accident.
 *
 * The store arrives by injection, not through the `electron-store` singleton:
 * `electron-store` is externalised from the Vitest bundle, so a test cannot
 * reach this write by mocking `electron`. It can only pass a fake store.
 */

export interface DownloadedEpisodeEntry {
  translationType: string
  author: string
  quality: number
  translationId: number
  /**
   * When a copy from a Shared Library arrived on this PC (#579), in ms. Watched
   * cleanup counts an episode's age from it; ordinary downloads have none.
   */
  arrivedAt?: number
}

export type DownloadedEpisodesMap = Record<string, DownloadedEpisodeEntry>

/** The `DownloadItem` / `EpisodeCompleteInfo` fields an entry is built from. */
export interface DownloadedEpisodeSource {
  animeId: number
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  quality: number
  /** Set by the import (#579); without it, the entry's existing `arrivedAt` is kept. */
  arrivedAt?: number
}

/** The slice of `StorageService` this helper touches. */
export interface DownloadedEpisodesStore {
  get(key: 'downloadedEpisodes'): DownloadedEpisodesMap
  set(key: 'downloadedEpisodes', value: DownloadedEpisodesMap): void
}

/**
 * Records `animeId:episodeInt:translationId` for a video that is on disk,
 * dropping the pre-translation-id key for the same episode on the way.
 *
 * @returns whether an entry was written — false for an item with no anime id or
 * no episode number, which cannot be keyed and so can never be read back.
 */
export function persistDownloadedEpisode(
  store: DownloadedEpisodesStore,
  source: DownloadedEpisodeSource
): boolean {
  const { animeId, episodeInt, translationId, translationType, author, quality } = source
  if (!(animeId > 0) || !episodeInt) return false

  const episodes = store.get('downloadedEpisodes')
  const key = `${animeId}:${episodeInt}:${translationId}`
  // A later write to the same key (the subtitle-retry tail, a re-download)
  // carries the arrival over, so cleanup keeps aging from the first arrival.
  const arrivedAt = source.arrivedAt ?? episodes[key]?.arrivedAt
  delete episodes[`${animeId}:${episodeInt}`]
  episodes[key] = {
    translationType,
    author,
    quality,
    translationId,
    ...(arrivedAt !== undefined ? { arrivedAt } : {})
  }
  store.set('downloadedEpisodes', episodes)
  return true
}
