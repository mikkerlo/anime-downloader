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

// Assembled Shikimori profile dashboard payload (shikimori:get-profile, #178).
// `lists` + `scores` come straight from the Shikimori `/api/users/:id` stats
// block; the rest is derived in the main process from the cached rate list +
// pre-fetched anime details (genres). Presentation (status labels/colors) is
// owned by the renderer.
interface ShikimoriProfileList {
  status: string
  n: number
}

interface ShikimoriProfileGenre {
  name: string
  n: number
}

interface ShikimoriProfile {
  id: number
  nickname: string
  avatar: string
  friendsCount: number
  lists: ShikimoriProfileList[]
  scores: number[]
  genres: ShikimoriProfileGenre[]
  stats: {
    titles: number
    episodes: number
    mean: number
    daysWatched: number
  }
}

interface ShikiFriendRate {
  nickname: string
  avatar: string
  status: ShikiUserRateStatus
  score: number
  episodes: number
}

// Friends page (shikimori:get-friends, #179): per-friend presence + a compact
// stat block + their current/last watch. `mutual` = shared rated titles with
// the signed-in user (approximate). Assembled in the main process.
interface ShikiFriendWatching {
  malId: number
  animeId: number | null
  title: string
  image: string
  episode: number
  total: number
  status: ShikiUserRateStatus
}

interface ShikiFriendCard {
  id: number
  nickname: string
  avatar: string
  lastOnlineAt: string | null
  online: boolean
  titles: number
  mean: number
  mutual: number
  watching: ShikiFriendWatching | null
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

// One entry in the "Recommendations" feed (shikimori:get-recommendations, #193).
// Assembled in the main process: ranked locally from the user's taste, then
// resolved to a smotret-anime id via `lookupByMalIds` (null when not on
// smotret-anime, so the card renders non-clickable like Calendar/Chronology).
interface RecommendationEntry {
  malId: number
  animeId: number | null
  title: string
  posterUrl: string
  kind: string | null
  /** Shikimori community score (0–10) shown as a badge. */
  communityScore: number
  /** Why it was recommended, e.g. «Because you liked X». */
  reason: string
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
