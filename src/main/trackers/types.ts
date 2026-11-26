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

  // Capabilities. Session-first: they read the user's auth or list.
  getFriends?(session: TSession): Promise<unknown>
  getFriendsActivity?(session: TSession): Promise<unknown>
  getFriendsRates?(session: TSession, malId: number): Promise<unknown>
  // Public reads by id: no session (#702, #703, #706, #710 define them so).
  getAiringInfo?(malId: number): Promise<unknown>
  getCalendar?(): Promise<unknown>
  getRelated?(ref: TrackerRef): Promise<unknown>
  getRecommendations?(seedMalIds: readonly number[]): Promise<unknown>
  getDetails?(malId: number): Promise<unknown>
}
