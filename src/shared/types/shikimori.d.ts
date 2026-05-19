// Shared domain types — Shikimori user rates, friends, calendar, chronology.
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

interface ShikiUser {
  id: number
  nickname: string
  avatar: string
}

type ShikiUserRateStatus =
  | 'planned'
  | 'watching'
  | 'rewatching'
  | 'completed'
  | 'on_hold'
  | 'dropped'

interface ShikiUserRate {
  id: number
  score: number
  status: ShikiUserRateStatus
  episodes: number
  rewatches: number
  target_id: number
  target_type: string
}

interface ShikiAnimeInfo {
  id: number
  name: string
  russian: string
  image: { original: string; preview: string; x96: string; x48: string }
  episodes: number
  episodes_aired: number
  kind: string
  score: string
  status: string
}

interface ShikiAnimeRateEntry {
  rate: {
    id: number
    score: number
    status: ShikiUserRateStatus
    episodes: number
    rewatches: number
    updated_at: string
    target_id: number
  }
  shikiAnime: ShikiAnimeInfo
  smotretAnime: AnimeSearchResult | null
}

interface ShikiAnimeGenre {
  id: number
  name: string
  russian: string
  kind: string
}

interface ShikiAnimeStudio {
  id: number
  name: string
  filtered_name: string
  real: boolean
  image: string | null
}

interface ShikiAnimeDetails {
  id: number
  name: string
  russian: string
  kind: string
  description: string | null
  description_html: string | null
  rating: string
  duration: number
  aired_on: string | null
  released_on: string | null
  genres: ShikiAnimeGenre[]
  studios: ShikiAnimeStudio[]
  score: string
  status: string
  episodes: number
  episodes_aired: number
}

interface ShikiFriendRate {
  nickname: string
  avatar: string
  status: ShikiUserRateStatus
  score: number
  episodes: number
}

interface ShikiFriendActivityEntry {
  friendId: number
  friendNickname: string
  friendAvatar: string
  malId: number
  animeName: string
  animeImage: string
  description: string
  createdAt: string
  smotretAnime: AnimeSearchResult | null
}

interface CalendarEntry {
  malId: number
  animeId: number | null
  name: string
  posterUrl: string
  kind: string
  episodeInt: string
  nextEpisodeAt: string
  userStatus: ShikiUserRateStatus
}

interface ShikiRelatedAnimeInfo {
  id: number
  name: string
  image_url: string
  url: string
  year: number | null
  kind: string | null
  date: number | null
}

interface ShikiRelatedEntry {
  relation: string | null
  shikiAnime: ShikiRelatedAnimeInfo
  smotretAnime: AnimeSearchResult | null
  isCurrent: boolean
  watchStatus: ShikiUserRateStatus | null
}
