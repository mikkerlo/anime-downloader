// AniList's error classes (#703). Both extend `TrackerApiError`, so
// `isNetworkError` excludes them (`lib/errors.ts`) and `classifyAnilistError`
// reads them by status and body.

import { TrackerApiError } from '../errors'

/**
 * An answer from AniList's GraphQL endpoint that said no: an HTTP error, or a
 * 200 that still carries `errors`. `status` is the HTTP status; `errorStatus`
 * is `errors[0].status` when the body has one. `body` is the scrubbed,
 * truncated response body the classifier reads.
 */
export class AniListApiError extends TrackerApiError {
  constructor(
    message: string,
    status: number,
    body: string = '',
    public readonly errorStatus: number | null = null,
    options?: { cause?: unknown }
  ) {
    super(message, 'anilist', status, body, options)
    this.name = 'AniListApiError'
  }
}

export const ANILIST_SESSION_EXPIRED_MESSAGE =
  'AniList session expired — sign in again in Settings → Trackers'

/**
 * `auth()` found no usable token: the credential was cleared by a 401, or it
 * can't be decrypted. A 401-class error, so the drain aborts and keeps the
 * queue, and `isSessionGone` stops the timer. `getEntry` also throws it, with
 * the refusal as its `cause`, for a read the server refused as `auth` (#740).
 */
export class AniListSessionError extends AniListApiError {
  constructor(message: string = ANILIST_SESSION_EXPIRED_MESSAGE, options?: { cause?: unknown }) {
    super(message, 401, '', 401, options)
    this.name = 'AniListSessionError'
  }
}

/** A successful id-map lookup omitted the title: it isn't on AniList. `item` class (drops). */
export class AniListUnmappedError extends AniListApiError {
  constructor(public readonly malId: number) {
    super(`MAL id ${malId} is not on AniList`, 404, '', 404)
    this.name = 'AniListUnmappedError'
  }
}
