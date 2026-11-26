// Each tracker's display name (epic #688). A value module, since the ambient
// `src/shared/types/trackers.d.ts` can't export a const; the renderer reads it
// now and main can later.
export const TRACKER_LABELS: Readonly<Record<TrackerId, string>> = {
  shikimori: 'Shikimori',
  anilist: 'AniList',
  mal: 'MyAnimeList'
}
