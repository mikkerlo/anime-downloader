// The tracker error taxonomy (#689): the classes, the base error the AniList
// and MyAnimeList clients throw, and what each class means to the drain.
//
// A leaf module: it imports nothing from `lib/` or from a provider.
// `lib/errors.ts` imports `TrackerApiError` from here to keep it out of
// `isNetworkError`, so importing `lib/errors.ts` back would close a cycle. The
// classifiers, which need `isNetworkError`, live beside their adapters
// (`shikimori.errors.ts`, `anilist/classify.ts`, `mal/classify.ts`).

export const TRACKER_ERROR_CLASSES = [
  'network',
  'auth',
  'config',
  'rate-limit',
  'server',
  'item'
] as const satisfies readonly TrackerErrorClass[]

/**
 * An HTTP-level answer from a tracker API: the request reached the server and
 * it said no. Never a network error, even when its `cause` carries a network
 * code (`lib/errors.ts` excludes it, as it does `ShikiApiError`).
 */
export class TrackerApiError extends Error {
  constructor(
    message: string,
    public readonly trackerId: TrackerId,
    public readonly status: number,
    /** Scrubbed + truncated response body, `''` when it could not be read. */
    public readonly body: string = '',
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'TrackerApiError'
  }
}

export interface TrackerErrorPolicy {
  /** `abort` stops the drain; `continue` moves on to the next item. */
  drain: 'abort' | 'continue'
  /**
   * What happens to the failing queue entry: `keep` it, `drop` it now, or keep
   * it until that item has seen `SERVER_ERROR_DROP_AFTER_MS` of server errors.
   */
  entry: 'keep' | 'drop' | 'drop-after-24h'
  /** The tracker shows "Needs setup". */
  needsSetup: boolean
}

/** How long a 5xx keeps an item before the drain drops it (today's Shikimori window). */
export const SERVER_ERROR_DROP_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * What each class implies, as data; `docs/trackers.md` carries the same
 * table. On an `auth()` failure there is no item, so whatever the class the
 * run aborts and the queue is untouched (see the docs for the token step).
 */
export const TRACKER_ERROR_POLICY: Readonly<Record<TrackerErrorClass, TrackerErrorPolicy>> = {
  network: { drain: 'abort', entry: 'keep', needsSetup: false },
  auth: { drain: 'abort', entry: 'keep', needsSetup: false },
  'rate-limit': { drain: 'abort', entry: 'keep', needsSetup: false },
  server: { drain: 'continue', entry: 'drop-after-24h', needsSetup: false },
  item: { drain: 'continue', entry: 'drop', needsSetup: false },
  config: { drain: 'abort', entry: 'keep', needsSetup: true }
}
