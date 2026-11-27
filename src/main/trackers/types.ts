// The tracker seam (#689, epic #688): what the sync service, the IPC routers,
// the Shared Library merge and Prepare for offline program against, so a
// second tracker plugs in beside Shikimori. `docs/trackers.md` describes it.
//
// `TrackerId`, `TrackerUser` and `TrackerErrorClass` are ambient globals
// (`src/shared/types/trackers.d.ts`), defined there only. A same-name
// re-export of an ambient global doesn't compile (TS2661), so this module uses
// the global names.

import type { RateValues } from '../lib/shikimori-rate'
import type { AnimeSearchResult } from '../smotret-api'

/** A rate field, as `changedFields` names it. */
export type TrackerRateField = keyof RateValues

/** Shikimori's session: the token and the account it was refreshed for. */
export interface ShikimoriSession {
  token: string
  userId: number
}

/**
 * One title on a tracker: its MAL id, and the tracker's own id for the user's
 * entry (Shikimori's rate id), null when the user has no entry yet.
 */
export interface TrackerRef {
  malId: number
  remoteId: number | null
}

/** A single entry as `getEntry` and `upsertEntry` return it, with the provider's own rate. */
export interface TrackerEntry<TRate> {
  trackerId: TrackerId
  malId: number
  remoteId: number | null
  values: RateValues
  /** The provider's rate, untouched. */
  native: TRate
}

/**
 * A listed entry, normalized for reading. Lossy by design: whatever must be
 * written back exactly (Shikimori's rate cache) is built from `native`.
 */
export interface TrackerRateEntry<TNative> {
  trackerId: TrackerId
  malId: number
  remoteId: number | null
  values: RateValues
  /** The row's last update in ms; null when it has none or it doesn't parse. Never NaN. */
  updatedAt: number | null
  anime: {
    title: string
    poster: string | null
    kind: string | null
    episodes: number | null
    episodesAired: number | null
    status: string | null
  }
  /** The smotret catalog entry for `malId` (`lookupByMalIds`), null when it has none. */
  smotretAnime: AnimeSearchResult | null
  /** The provider's own list row, untouched. */
  native: TNative
}

/**
 * A listed entry as the `tracker:*` IPC carries it (the ambient
 * `TrackerRateEntry`, #694): every normalized field, without `native`.
 */
export type TrackerRateEntryPayload = Omit<TrackerRateEntry<unknown>, 'native'>

export interface TrackerListOptions {
  status?: RateValues['status']
}

/**
 * The optional capability members. Each is implemented, and its signature
 * finished, by the slice that consumes it (T11a–d, T12). Reads that need the
 * user's auth or list take the session first; public reads by id take none.
 */
export const TRACKER_CAPABILITIES = [
  'getAiringInfo',
  'getCalendar',
  'getRelated',
  'getRecommendations',
  'getDetails',
  'getFriends',
  'getFriendsActivity',
  'getFriendsRates'
] as const

export type TrackerCapability = (typeof TRACKER_CAPABILITIES)[number]

/** Which capability members a provider implements. */
export type TrackerCapabilities = Readonly<Record<TrackerCapability, boolean>>

/** How old a tracker's cached data may be and still answer `getAiringInfo` (#706). */
export const AIRING_FRESHNESS_MS = 6 * 60 * 60 * 1000

/**
 * A title's aired count and total, as the auto-download tick and
 * `setSubscription` read it from the `airing` source (#706). `episodes` null
 * means "no cap", as 0 does.
 *
 * `getAiringInfo` is cache-first for every provider. The tick checks every
 * subscription every 15 min, so a provider that fetched on every call would
 * spend one request per subscription per tick:
 * - it answers from the tracker's own cached data (its list cache, then its
 *   details cache) when that data is no older than `AIRING_FRESHNESS_MS`;
 * - it makes a network call only when the title has no cached entry that
 *   fresh, e.g. a subscription to a title that isn't on the user's list;
 * - AniList (#703) answers an on-list title from `anilistUserRates`, whose list
 *   read carries `nextAiringEpisode`, `episodes` and `status`, with no request.
 *
 * Null when the tracker has no data for the title (AniList: no mapping); the
 * tick reports that as `no-episodes-aired`.
 */
export interface AiringInfo {
  episodesAired: number
  episodes: number | null
}

/**
 * One sign-in attempt's parameters (#695), held in memory by
 * `trackers/auth-session.ts` and never stored. `state` is what a loopback
 * callback or a pasted redirect URL must carry back; `verifier` is the PKCE
 * verifier a code exchange needs (MAL, #702).
 */
export interface TrackerAuthAttempt {
  authorizeUrl: string
  state?: string
  verifier?: string
}

/**
 * How a tracker signs in (#695): the flow `trackers/auth-session.ts` runs.
 * Separate from `auth`, which is the session getter every drain tick calls.
 */
export interface TrackerAuthFlow {
  /**
   * What a pasted completion is: the full redirect URL, whose `state` must
   * match the held attempt (MAL); a token (AniList); or a code (Shikimori).
   * A `'url'` flow can't complete without a held attempt.
   */
  readonly paste: 'url' | 'token' | 'code'
  /** True when the flow can't start yet (MAL with no client ID saved). */
  needsSetup?(): boolean
  /** A new attempt: its authorize URL and, for a `'url'` flow, its `state`. */
  begin(): TrackerAuthAttempt
  /**
   * The loopback to bind on `127.0.0.1` and `::1` before the browser opens
   * (MAL); null for a paste-only attempt.
   */
  loopback?(): { port: number; path: string } | null
  /**
   * The exchange and the user read. Resolves only once the account is known
   * and writes nothing. `input` is the code (a `'url'` flow's, taken from the
   * callback or the pasted URL after the `state` check) or the pasted token;
   * `attempt` is null for a completion with no attempt held.
   */
  exchange(
    input: string,
    attempt: TrackerAuthAttempt | null
  ): Promise<{ credentials: unknown; user: TrackerUser }>
}

/**
 * A tracker. `auth()` returns the provider's session; a caller takes one
 * session per run and passes it to every data member, so an account switch
 * mid-run never mixes one account's item with another's token (#588). An
 * adapter never re-reads its credentials or user inside a data member.
 *
 * `TRate` is the provider's single-entry rate (`getEntry` / `upsertEntry`);
 * it defaults to `unknown` for code that only lists.
 */
export interface TrackerProvider<TSession, TNative, TRate = unknown> {
  readonly id: TrackerId
  readonly capabilities: TrackerCapabilities

  /** The session for this run. Throws what the provider's token refresh throws. */
  auth(): Promise<TSession>
  /** How the tracker signs in (#695). Absent until its provider ships one. */
  authFlow?: TrackerAuthFlow
  /** The account a token belongs to; this is what produces a session's user id (sign-in). */
  getUser(token: string): Promise<TrackerUser>
  /** Pure: what an error from this provider means (`docs/trackers.md`). */
  classifyError(err: unknown): TrackerErrorClass

  listEntries(session: TSession, opts?: TrackerListOptions): Promise<TrackerRateEntry<TNative>[]>
  getEntry(session: TSession, ref: TrackerRef): Promise<TrackerEntry<TRate> | null>
  /**
   * Creates the entry when `ref.remoteId` is null, otherwise updates it.
   * `changedFields` names what the user changed; a provider may still send
   * every field (Shikimori does).
   */
  upsertEntry(
    session: TSession,
    ref: TrackerRef,
    values: RateValues,
    changedFields: readonly TrackerRateField[]
  ): Promise<TrackerEntry<TRate>>
  /** Only reconcile's "remove" (T10) deletes; nothing in the app does today. */
  deleteEntry?(session: TSession, ref: TrackerRef): Promise<void>
  /**
   * False when the title isn't on this tracker, so #692's fan-out queues
   * nothing for it there (T7: "not on AniList"). Absent means every title is.
   */
  hasTitle?(malId: number): boolean

  // Capabilities. Session-first: they read the user's auth or list.
  getFriends?(session: TSession): Promise<unknown>
  getFriendsActivity?(session: TSession): Promise<unknown>
  getFriendsRates?(session: TSession, malId: number): Promise<unknown>
  // Public reads by id: no session (#702, #703, #706, #710 define them so).
  /** Cache-first: see `AiringInfo`. */
  getAiringInfo?(malId: number): Promise<AiringInfo | null>
  getCalendar?(): Promise<unknown>
  getRelated?(ref: TrackerRef): Promise<unknown>
  getRecommendations?(seedMalIds: readonly number[]): Promise<unknown>
  getDetails?(malId: number): Promise<unknown>
  /**
   * The tracker's own details cache entry for `malId`, normalized (#706):
   * what `tracker:get-details` returns. Never the network; null on a miss.
   * Each provider keeps its cache in its own shape and normalizes it here.
   */
  cachedDetails?(malId: number): TrackerDetails | null
}

/** Each tracker's name in the sync service's strings (`Shikimori rate limit — will retry`). */
export { TRACKER_LABELS } from '@shared/trackers/labels'

/**
 * How a tracker's rate cache (its `userRates` key) is written (#691). Rows are
 * built from each listed entry's `native`, never from the lossy normalized
 * fields, so Shikimori's `shikimoriUserRates` keeps its bytes.
 */
export interface TrackerRateCacheCodec<TNative, TRow> {
  /** The cache rows for a listed page, from each entry's `native` and `smotretAnime`. */
  fromEntries(entries: readonly TrackerRateEntry<TNative>[]): TRow[]
  /** A row's MAL id, as a refresh with `keepQueued` matches it. */
  malIdOf(row: TRow): number | undefined
  /** The index of the row a patch for `malId` writes, or -1. */
  indexOf(rows: readonly TRow[], malId: number): number
  /** A row's id and values, as #692's projection and the queue's `rateId` read them. */
  read(row: TRow): { remoteId: number | null; values: RateValues }
  /**
   * `row` with `values` laid over it and its local update time moved to now.
   * `remoteId`, when given, becomes the row's id; otherwise the id is left alone.
   */
  patch(row: TRow, values: RateValues, remoteId?: number): TRow
  /**
   * A cached row as the read side normalizes it (#694): what `tracker:*`
   * replies and broadcasts carry. It reads the row and writes nothing.
   */
  entryOf(row: TRow): TrackerRateEntryPayload
}

/**
 * What `createTrackerSyncService` (#691) needs from a tracker beyond the seam:
 * its rate-cache codec and the token step's "the session is gone" predicate.
 * A session carries the account it was refreshed for, as `userId`.
 */
export interface TrackerSyncProvider<
  TSession extends { userId: number },
  TNative,
  TRate,
  TRow
> extends TrackerProvider<TSession, TNative, TRate> {
  readonly rateCache: TrackerRateCacheCodec<TNative, TRow>
  /**
   * True when an `auth()` failure means the stored credentials are gone, so the
   * timer stops. Narrower than the `auth` class: Shikimori's is
   * `instanceof ShikiAuthError`, and a `ShikiApiError(403)` from the refresh
   * endpoint leaves the timer running.
   */
  isSessionGone(err: unknown): boolean
}
