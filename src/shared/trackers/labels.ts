// Each tracker's display name (epic #688). A value module, since the ambient
// `src/shared/types/trackers.d.ts` can't export a const. The renderer reads it,
// and `src/main/trackers/types.ts` re-exports it for main's strings (#706).
export const TRACKER_LABELS: Readonly<Record<TrackerId, string>> = {
  shikimori: 'Shikimori',
  anilist: 'AniList',
  mal: 'MyAnimeList'
}
