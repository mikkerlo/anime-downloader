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

/**
 * Connecting a second tracker (#701): on in an unpackaged build, off in a
 * packaged one until #708 (T10) removes the flag. While it is off, a sign-in
 * for one tracker is refused when another tracker has a user; a reconnect of
 * the same tracker isn't a second tracker. Main checks it when an attempt
 * begins (`tracker:begin-auth`, `shikimori:get-auth-url`) and again when a
 * login commits (`trackers/lifecycle.ts`), since an attempt stays open after
 * its `BEGIN` resolves.
 */
export function secondTrackerEnabled(isPackaged: boolean): boolean {
  return !isPackaged
}

export const SECOND_TRACKER_REFUSAL = "Connecting a second tracker isn't available yet"

/** What a refused sign-in rejects with; the attempt reports it as an `auth` error. */
export class SecondTrackerRefusedError extends Error {
  constructor() {
    super(SECOND_TRACKER_REFUSAL)
    this.name = 'SecondTrackerRefusedError'
  }
}

const IDS: readonly TrackerId[] = ['shikimori', 'anilist', 'mal']

/**
 * Throws `SecondTrackerRefusedError` when the flag is off and a tracker other
 * than `trackerId` has a user (`isConnected`, the "user set" rule).
 */
export function assertMayConnect(
  enabled: boolean,
  trackerId: TrackerId,
  isConnected: (id: TrackerId) => boolean
): void {
  if (enabled) return
  if (IDS.some((other) => other !== trackerId && isConnected(other))) {
    throw new SecondTrackerRefusedError()
  }
}
