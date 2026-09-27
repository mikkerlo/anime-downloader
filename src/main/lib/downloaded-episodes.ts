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
  delete episodes[`${animeId}:${episodeInt}`]
  episodes[`${animeId}:${episodeInt}:${translationId}`] = {
    translationType,
    author,
    quality,
    translationId
  }
  store.set('downloadedEpisodes', episodes)
  return true
}
