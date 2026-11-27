// AniList's GraphQL documents (#703). Each one is pinned by a fixture under
// `test/fixtures/anilist/`. Every score is read as `score(format: POINT_100)`:
// the user's `scoreFormat` only gives the scale's precision. No document
// filters by `isAdult`: mapping and list reads must see adult titles, and only
// For You, Calendar and activity filter, client-side, by `displayAdultContent`.

/** `perPage` is capped at 50: a probe with `perPage: 200` came back clamped. */
export const PAGE_SIZE = 50
/** `perChunk` maxes out at 500. */
export const LIST_CHUNK_SIZE = 500

export const VIEWER = `query Viewer {
  Viewer {
    id
    name
    avatar { medium }
    options { displayAdultContent }
    mediaListOptions { scoreFormat }
  }
}`

/** What `getEntry` reads and `SaveMediaListEntry` returns: the same selection. */
export const ENTRY_SELECTION = 'id status score(format: POINT_100) progress repeat updatedAt'

const LIST_MEDIA = `media {
          id
          idMal
          title { romaji english }
          coverImage { large }
          format
          episodes
          status
          nextAiringEpisode { episode }
        }`

export const MEDIA_LIST_COLLECTION = `query MediaListCollection($userId: Int, $chunk: Int, $perChunk: Int, $status: MediaListStatus) {
  MediaListCollection(userId: $userId, type: ANIME, forceSingleCompletedList: true, perChunk: $perChunk, chunk: $chunk, status: $status) {
    hasNextChunk
    lists {
      isCustomList
      entries {
        id
        mediaId
        status
        score(format: POINT_100)
        progress
        repeat
        updatedAt
        ${LIST_MEDIA}
      }
    }
  }
}`

export const MEDIA_LIST = `query MediaList($userId: Int, $mediaId: Int) {
  MediaList(userId: $userId, mediaId: $mediaId) { ${ENTRY_SELECTION} }
}`

export const SAVE_MEDIA_LIST_ENTRY = `mutation SaveMediaListEntry($mediaId: Int, $status: MediaListStatus, $progress: Int, $scoreRaw: Int, $repeat: Int) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw, repeat: $repeat) { ${ENTRY_SELECTION} }
}`

export const DELETE_MEDIA_LIST_ENTRY = `mutation DeleteMediaListEntry($id: Int) {
  DeleteMediaListEntry(id: $id) { deleted }
}`

/** The id map's lookup: the selection stays `{ id idMal }` (the complexity limit). */
export const ID_MAP_LOOKUP = `query IdMap($ids: [Int]) {
  Page(page: 1, perPage: ${PAGE_SIZE}) {
    media(idMal_in: $ids, type: ANIME) { id idMal }
  }
}`

export const AIRING_LOOKUP = `query Airing($ids: [Int]) {
  Page(page: 1, perPage: ${PAGE_SIZE}) {
    media(idMal_in: $ids, type: ANIME) { id idMal episodes status nextAiringEpisode { episode } }
  }
}`

export const DETAILS_LOOKUP = `query Details($ids: [Int]) {
  Page(page: 1, perPage: ${PAGE_SIZE}) {
    media(idMal_in: $ids, type: ANIME) {
      id
      idMal
      description(asHtml: false)
      genres
      format
      episodes
      status
      nextAiringEpisode { episode }
    }
  }
}`

export const CALENDAR = `query Calendar($ids: [Int]) {
  Page(perPage: ${PAGE_SIZE}) {
    media(id_in: $ids, type: ANIME) {
      id
      idMal
      isAdult
      format
      title { romaji english }
      coverImage { large }
      nextAiringEpisode { episode airingAt }
    }
  }
}`

const RELATION_NODE = `id idMal type format startDate { year month day } title { romaji english } coverImage { large } siteUrl`

export const RELATIONS = `query Relations($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    relations { edges { relationType node { ${RELATION_NODE} } } }
  }
}`

export const RELATED_BATCH = `query RelatedBatch($ids: [Int]) {
  Page(perPage: ${PAGE_SIZE}) {
    media(id_in: $ids, type: ANIME) {
      id
      idMal
      format
      startDate { year month day }
      title { romaji english }
      coverImage { large }
      siteUrl
      relations { edges { relationType node { ${RELATION_NODE} } } }
    }
  }
}`

export const RECOMMENDATIONS = `query Recommendations($ids: [Int]) {
  Page(perPage: ${PAGE_SIZE}) {
    media(id_in: $ids, type: ANIME) {
      id
      idMal
      recommendations(sort: RATING_DESC, perPage: 10) {
        nodes {
          rating
          mediaRecommendation { id idMal type isAdult format title { romaji english } coverImage { large } }
        }
      }
    }
  }
}`

export const FRIENDS_RATES = `query FriendsRates($mediaId: Int, $page: Int) {
  Page(page: $page, perPage: ${PAGE_SIZE}) {
    pageInfo { hasNextPage }
    mediaList(mediaId: $mediaId, isFollowing: true) {
      user { id name avatar { medium } }
      status
      score(format: POINT_100)
      progress
      repeat
      updatedAt
    }
  }
}`

/**
 * The following list (#712). `Page.following` takes only `userId` and `sort`.
 * `statistics.anime.meanScore` takes no `format`: it is on the 0–100 scale.
 */
export const FOLLOWING = `query Following($userId: Int, $page: Int) {
  Page(page: $page, perPage: ${PAGE_SIZE}) {
    pageInfo { hasNextPage }
    following(userId: $userId, sort: [USERNAME]) {
      id
      name
      avatar { medium }
      statistics { anime { count meanScore } }
    }
  }
}`

export const FRIENDS_ACTIVITY = `query FriendsActivity($page: Int) {
  Page(page: $page, perPage: ${PAGE_SIZE}) {
    activities(isFollowing: true, type_in: [ANIME_LIST], sort: ID_DESC) {
      ... on ListActivity {
        id
        status
        progress
        createdAt
        user { id name avatar { medium } }
        media { id idMal isAdult title { romaji english } coverImage { large } }
      }
    }
  }
}`
