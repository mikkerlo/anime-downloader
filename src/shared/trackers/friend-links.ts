// A person's pages on a friends source (#712): the Friends page's "Message"
// (the profile) and "Compare" (the anime list), and the activity feed's
// friend link. The production sites, as `title-links.ts`'s are.
import { SHIKIMORI_ORIGIN } from '../shikimori'

export function friendProfileUrl(source: TrackerId, nickname: string): string {
  switch (source) {
    case 'shikimori':
      return `${SHIKIMORI_ORIGIN}/@${nickname}`
    case 'anilist':
      return `https://anilist.co/user/${nickname}`
    case 'mal':
      return `https://myanimelist.net/profile/${nickname}`
  }
}

export function friendListUrl(source: TrackerId, nickname: string): string {
  switch (source) {
    case 'shikimori':
      return `${SHIKIMORI_ORIGIN}/@${nickname}/list/anime`
    case 'anilist':
      return `https://anilist.co/user/${nickname}/animelist`
    case 'mal':
      return `https://myanimelist.net/animelist/${nickname}`
  }
}
