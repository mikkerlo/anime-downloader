// Each tracker's display name (#688), for main's strings and the renderer's
// copy alike. `src/main/trackers/types.ts` re-exports it as `TRACKER_LABELS`.

export const TRACKER_LABELS: Readonly<Record<TrackerId, string>> = {
  shikimori: 'Shikimori',
  anilist: 'AniList',
  mal: 'MyAnimeList'
}
