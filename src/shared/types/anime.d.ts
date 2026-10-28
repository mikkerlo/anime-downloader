// Shared domain types — anime catalog, episodes, translations.
//
// Declared as ambient globals (no import/export) so existing call sites keep
// referencing them by bare name. Part of the structure refactor epic (#84),
// Phase 1 slice 1a: pure type relocation, behavior-identical.

interface ApiResponse<T> {
  data: T
  source: 'api' | 'cache'
}

/**
 * `get-anime-cache`. An entry past the 24 h TTL is returned with `stale: true`
 * offline (#568), and online for a cachable title (#570); online, any other
 * title's expired entry reads as null.
 */
interface AnimeCacheResult {
  data: AnimeDetail
  cachedAt: number
  stale: boolean
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

/** Why a title is on this PC (#571). Consumers switch on `kind`. */
type LocalSource = { kind: 'starred' } | { kind: 'downloaded' } | { kind: 'watching' }

/**
 * A `search:local` hit: a title this PC has. `genres` (titles) feeds the
 * view's genre chips; `listStatus` is the joined Shikimori list status;
 * `airingStatus` is Shikimori's (`anons` / `ongoing` / `released`) where cached.
 */
type LocalSearchResult = AnimeSearchResult & {
  localSources: LocalSource[]
  listStatus?: ShikiUserRateStatus
  genres: string[]
  airingStatus?: string
}

interface LocalSearchFilters {
  genre?: string
  status?: ShikiUserRateStatus
}

/** `search:local`. `corpusSize` 0 means this PC has no titles at all. */
interface LocalSearchResponse {
  results: LocalSearchResult[]
  corpusSize: number
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
