// The one writer of `downloadedAnime` entries (#577). The renderer reaches it
// through `DOWNLOADED_ANIME_ADD` before it enqueues a title's episodes; the
// export's pre-fetch calls it directly, so episodes it downloads land under a
// title that Downloads and the cleanup paths know about.

/** The slice of `StorageService` this helper touches. */
export interface DownloadedAnimeStore {
  get(key: 'downloadedAnime'): unknown
  set(key: 'downloadedAnime', value: Record<string, AnimeSearchResult>): void
}

export function addDownloadedAnime(store: DownloadedAnimeStore, anime: AnimeSearchResult): void {
  const downloaded = (store.get('downloadedAnime') as Record<string, AnimeSearchResult>) ?? {}
  downloaded[String(anime.id)] = anime
  store.set('downloadedAnime', downloaded)
}
