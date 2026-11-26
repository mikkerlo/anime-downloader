// The detail panel's per-tracker badge and "Open ↗" target (#704). The links
// use the production sites: the `ANIME_DL_*_ORIGIN` overrides are main-only
// test seams.
import { SHIKIMORI_ORIGIN } from '../shikimori'

export const TRACKER_BADGES: Readonly<Record<TrackerId, string>> = {
  shikimori: 'Sh',
  anilist: 'AL',
  mal: 'MAL'
}

/**
 * The title's page on `trackerId`, or null when there is none to link.
 * AniList pages are keyed by its own media id, which `tracker:get-rate`
 * carries as `mediaId` only for a mapped title (#703); without it there is no
 * link.
 */
export function trackerTitleUrl(
  trackerId: TrackerId,
  malId: number,
  mediaId?: number
): string | null {
  switch (trackerId) {
    case 'shikimori':
      return `${SHIKIMORI_ORIGIN}/animes/${malId}`
    case 'mal':
      return `https://myanimelist.net/anime/${malId}`
    case 'anilist':
      return mediaId ? `https://anilist.co/anime/${mediaId}` : null
  }
}
