// Shared domain types — anime catalog, episodes, translations.
//
// Declared as ambient globals (no import/export) so existing call sites keep
// referencing them by bare name. Part of the structure refactor epic (#84),
// Phase 1 slice 1a: pure type relocation, behavior-identical.

interface ApiResponse<T> {
  data: T
  source: 'api' | 'cache'
}

interface AnimeSearchResult {
  id: number
  title: string
  titles: { ru?: string; romaji?: string; ja?: string }
  posterUrlSmall: string
  numberOfEpisodes: number
  type: string
  typeTitle: string
  year: number
  season: string
}

interface AnimeDetail extends AnimeSearchResult {
  posterUrl: string
  descriptions: { source: string; value: string }[]
  episodes: EpisodeSummary[]
  genres: { id: number; title: string }[]
  myAnimeListId?: number
}

interface EpisodeSummary {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  isActive: number
}

interface EpisodeDetail {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  translations: Translation[]
}

interface Translation {
  id: number
  type: string
  typeKind: string
  typeLang: string
  authorsSummary: string
  isActive: number
  width: number
  height: number
  duration: string
}

interface ContinueWatchingEntry {
  kind: 'resume' | 'next'
  animeId: number
  animeName: string
  posterUrl: string
  episodeInt: string
  episodeLabel: string
  position?: number
  duration?: number
  updatedAt: number
  malId?: number
}
