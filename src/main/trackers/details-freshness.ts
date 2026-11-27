// How long a tracker's cached details entry stays fresh (#744): AniList's
// prefetch walk and MyAnimeList's `detailsStale` read the same window.

/** A details entry older than this is fetched again. */
export const DETAILS_STALE_MS = 7 * 24 * 60 * 60 * 1000
