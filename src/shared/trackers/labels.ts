// Each tracker's display name (#700, epic #688): the one place UI copy that
// names a tracker takes it from. A value module, so main can read it too; the
// ambient `types/trackers.d.ts` can't export a const.
export const TRACKER_LABELS: Record<TrackerId, string> = {
  shikimori: 'Shikimori',
  anilist: 'AniList',
  mal: 'MyAnimeList'
}
