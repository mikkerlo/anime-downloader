// Build flags for the multi-tracker rollout (epic #688). Functions of
// `isPackaged`, not import-time constants, so a test flips one by building
// `AppDeps` instead of re-mocking `electron`. `index.ts` calls each once with
// `app.isPackaged`.

/**
 * The MyAnimeList (#702) and AniList (#703) cards in Settings → Trackers. Off
 * in packaged builds until #698 (T4b), #699 (T4c) and #704 (T8a) have landed;
 * a one-line follow-up lifts it. Main refuses `tracker:begin-auth` for a
 * hidden card's tracker, so the gate isn't the renderer's alone.
 */
export function newTrackerCardsEnabled(isPackaged: boolean): boolean {
  return !isPackaged
}
