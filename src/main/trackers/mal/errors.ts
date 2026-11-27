// MyAnimeList's own errors (#702), beside `TrackerApiError`, which the client
// throws for every HTTP-level answer. `classify.ts` sorts all of them.

/** Where a MAL session error sends the user. */
export const MAL_SESSION_EXPIRED_MESSAGE =
  'MyAnimeList session expired — sign in again in Settings → Trackers'
export const MAL_NOT_CONNECTED_MESSAGE =
  'Not connected to MyAnimeList — connect in Settings → Trackers'
export const MAL_LOCKED_MESSAGE =
  'Can’t unlock the saved MyAnimeList sign-in — sign in again in Settings → Trackers'

/**
 * The stored session is gone: a refresh answered `invalid_grant` (the
 * credentials were cleared and `myanimelistSessionExpired` set), nothing is
 * stored, or the stored blob can't be decrypted. Only a new sign-in helps, so
 * the drain stops its timer (`isSessionGone`). Classified `auth`.
 */
export class MalSessionGoneError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MalSessionGoneError'
  }
}

/**
 * The app's MAL setup can't make a request: no client ID saved, or the saved
 * client secret can't be decrypted. Classified `config` ("Needs setup").
 */
export class MalConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalConfigError'
  }
}

/**
 * A login or logout landed while `auth()` was reading the vault, so the token
 * it read may be another session's. Nothing is wrong with the account: the
 * drain sees the owner change, or retries on its next tick. Classified
 * `network` (abort, keep the queue, no error shown).
 */
export class MalSessionChangedError extends Error {
  constructor() {
    super('The MyAnimeList account changed while its token was read')
    this.name = 'MalSessionChangedError'
  }
}
