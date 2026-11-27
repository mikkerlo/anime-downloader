// Build flags for the trackers epic (#688). Each is a function of
// `app.isPackaged`, called once by `index.ts` and passed through `AppDeps`, so
// a test flips it by building deps instead of re-mocking `electron`.

/**
 * The AniList (#703) and MyAnimeList (#702) cards: on in an unpackaged build,
 * off in a packaged one until #698 (T4b), #699 (T4c) and #704 (T8a) have
 * landed and a one-line follow-up flips it. While it is off, main refuses
 * `tracker:begin-auth` and `tracker:complete-auth` for both.
 */
export function newTrackerCardsEnabled(isPackaged: boolean): boolean {
  return !isPackaged
}
