// The Shikimori tracker adapter (#689). It wraps `shikimori.ts` and adds no
// behaviour: every member calls the same function with the same positional
// arguments as today's call sites, taken from the session it is given. It
// calls through the module namespace, so a `vi.mock` of `../shikimori`
// intercepts every call.

import * as shikimori from '../shikimori'
import { SHIKIMORI_ORIGIN } from '../../shared/shikimori'
import { rateValues } from '../lib/shikimori-rate'
import { buildRateCacheEntries, type CachedRateEntry } from '../lib/shikimori-rate-cache'
import type { AnimeSearchResult } from '../smotret-api'
import type { StorageService } from '../store/types'
import { classifyShikimoriError } from './shikimori.errors'
import {
  AIRING_FRESHNESS_MS,
  TRACKER_CAPABILITIES,
  type TrackerCapabilities,
  type TrackerEntry
} from './types'
import type {
  ShikimoriSession,
  TrackerAuthFlow,
  TrackerRateCacheCodec,
  TrackerRateEntry,
  TrackerRateEntryPayload,
  TrackerSyncProvider
} from './types'

export interface ShikimoriProviderDeps {
  store: StorageService
  /** The smotret join for listed rows, as the rate refresh does it. */
  lookupByMalIds?: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  /**
   * `refreshShikimoriDetailsForMalId`: what `getAiringInfo` calls for a missing
   * or stale details entry. Without it the read is cache-only.
   */
  refreshDetails?: (malId: number) => Promise<shikimori.ShikiAnimeDetails | null>
}

export interface ShikimoriProvider extends TrackerSyncProvider<
  ShikimoriSession,
  shikimori.ShikiAnimeRateEntry,
  shikimori.ShikiUserRate,
  CachedRateEntry
> {
  /** `getFriendsWithStats`, `mutual` counted against the cached own list (#712). */
  getFriends(session: ShikimoriSession): Promise<shikimori.ShikiFriendCard[]>
  getFriendsActivity(session: ShikimoriSession): Promise<shikimori.ShikiFriendActivity[]>
  getFriendsRates(session: ShikimoriSession, malId: number): Promise<shikimori.ShikiFriendRate[]>
}

/**
 * `shikimoriUserRates` (#691): `buildRateCacheEntries` over the `native`
 * rows, with the smotret join each entry already carries, and the settle patch
 * that `reconcileCacheFromRate` made. Both match a row by `rate.target_id`
 * alone; a refresh's `keepQueued` falls back to `shikiAnime.id`.
 */
export const shikimoriRateCache: TrackerRateCacheCodec<
  shikimori.ShikiAnimeRateEntry,
  CachedRateEntry
> = {
  fromEntries(entries) {
    const malMap: Record<number, AnimeSearchResult> = {}
    for (const e of entries) if (e.smotretAnime) malMap[e.native.anime.id] = e.smotretAnime
    return buildRateCacheEntries(
      entries.map((e) => e.native),
      malMap
    )
  },
  malIdOf: (row) => row.rate.target_id ?? row.shikiAnime?.id,
  indexOf: (rows, malId) => rows.findIndex((e) => e.rate.target_id === malId),
  // The router's `cachedBasis`: a row with no numeric id has no rate yet.
  read: (row) => ({
    remoteId: typeof row.rate.id === 'number' ? row.rate.id : null,
    values: rateValues(row.rate)
  }),
  patch(row, values, remoteId) {
    return {
      ...row,
      rate: {
        ...row.rate,
        ...(remoteId !== undefined ? { id: remoteId } : {}),
        episodes: values.episodes,
        status: values.status,
        score: values.score,
        rewatches: values.rewatches,
        updated_at: new Date().toISOString()
      }
    }
  },
  // `malIdOf`'s match, so a row from before `target_id` was cached still reads.
  entryOf(row) {
    return {
      trackerId: 'shikimori',
      malId: (row.rate.target_id ?? row.shikiAnime?.id) as number,
      remoteId: typeof row.rate.id === 'number' ? row.rate.id : null,
      values: rateValues(row.rate),
      updatedAt: parseUpdatedAt(row.rate.updated_at),
      anime: animeOf(row.shikiAnime),
      smotretAnime: row.smotretAnime ?? null
    } satisfies TrackerRateEntryPayload
  }
}

/**
 * Shikimori's sign-in (#695): today's out-of-band code paste. `begin` is
 * `getAuthUrl()`, and `exchange` is `SHIKIMORI_EXCHANGE_CODE`'s two calls in
 * its order: the code exchange, then `getUser` with the new access token.
 */
export const shikimoriAuthFlow: TrackerAuthFlow = {
  paste: 'code',
  begin: () => ({ authorizeUrl: shikimori.getAuthUrl() }),
  async exchange(code) {
    const credentials = await shikimori.exchangeCode(code)
    const user = await shikimori.getUser(credentials.access_token)
    return { credentials, user }
  }
}

/** The refresh cleared the stored credentials: only a new sign-in brings them back. */
export function isShikimoriSessionGone(err: unknown): boolean {
  return err instanceof shikimori.ShikiAuthError
}

// The members this adapter implements; the rest land with their slices.
const IMPLEMENTED = new Set<string>([
  'getAiringInfo',
  'getFriends',
  'getFriendsActivity',
  'getFriendsRates'
])
const SHIKIMORI_CAPABILITIES = Object.fromEntries(
  TRACKER_CAPABILITIES.map((c) => [c, IMPLEMENTED.has(c)])
) as unknown as TrackerCapabilities

/** The MAL ids on the cached own list: the friend cards' `mutual` (#179). */
function ownMalIds(store: StorageService): Set<number> {
  const ownRates = store.get('shikimoriUserRates') as {
    rate: { target_id?: number }
    shikiAnime?: { id: number }
  }[]
  const out = new Set<number>()
  for (const e of ownRates) {
    const malId = e.rate?.target_id ?? e.shikiAnime?.id
    if (malId) out.add(malId)
  }
  return out
}

interface DetailsCacheEntry {
  details: shikimori.ShikiAnimeDetails
  fetchedAt: number
}

/** `Date.parse` in ms, or null for a missing or unparseable timestamp. */
export function parseUpdatedAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function toEntry(
  malId: number,
  rate: shikimori.ShikiUserRate
): TrackerEntry<shikimori.ShikiUserRate> {
  return {
    trackerId: 'shikimori',
    malId,
    remoteId: rate.id,
    values: rateValues(rate),
    native: rate
  }
}

// The Home rail's pick (#698): `preview`, then `x96`, then `original`, with a
// relative path made absolute on the Shikimori origin. Null when there is none.
function posterOf(
  image: shikimori.ShikiAnimeRateEntry['anime']['image'] | undefined
): string | null {
  const img = image?.preview || image?.x96 || image?.original || ''
  return absolute(img)
}

function absolute(img: string | undefined): string | null {
  if (!img) return null
  return img.startsWith('http') ? img : `${SHIKIMORI_ORIGIN}${img}`
}

// A cached row from an older version can lack `shikiAnime`.
function animeOf(
  anime: shikimori.ShikiAnimeRateEntry['anime'] | undefined
): TrackerRateEntryPayload['anime'] {
  return {
    // The app's display rule: the Russian title, else the romaji name.
    title: anime?.russian || anime?.name || '',
    poster: posterOf(anime?.image),
    // The list page's pick (#707): `original`, as 6.0.21's ShikimoriView showed it.
    posterOriginal: absolute(anime?.image?.original),
    kind: anime?.kind ?? null,
    episodes: anime?.episodes ?? null,
    episodesAired: anime?.episodes_aired ?? null,
    status: anime?.status ?? null
  }
}

function toRateEntry(
  row: shikimori.ShikiAnimeRateEntry,
  smotretAnime: AnimeSearchResult | null
): TrackerRateEntry<shikimori.ShikiAnimeRateEntry> {
  return {
    trackerId: 'shikimori',
    // As the rate cache derives `target_id` (`lib/shikimori-rate-cache.ts`).
    malId: row.target_id ?? row.anime.id,
    remoteId: row.id,
    values: rateValues(row),
    updatedAt: parseUpdatedAt(row.updated_at),
    anime: animeOf(row.anime),
    smotretAnime,
    native: row
  }
}

export function createShikimoriProvider(deps: ShikimoriProviderDeps): ShikimoriProvider {
  const { store } = deps
  return {
    id: 'shikimori',
    capabilities: SHIKIMORI_CAPABILITIES,

    // The drain's order: the user first, then the token, so `userId` is the
    // account the token was refreshed for.
    async auth() {
      const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
      const token = await shikimori.ensureFreshToken(store)
      if (!user) throw new Error('Not logged in to Shikimori')
      return { token, userId: user.id }
    },

    getUser: (token) => shikimori.getUser(token),
    authFlow: shikimoriAuthFlow,

    classifyError: classifyShikimoriError,
    isSessionGone: isShikimoriSessionGone,
    rateCache: shikimoriRateCache,

    async listEntries(session, opts) {
      const rows = await shikimori.getUserAnimeRates(session.token, session.userId, opts?.status)
      const malMap = deps.lookupByMalIds
        ? await deps.lookupByMalIds(rows.map((r) => r.anime.id))
        : {}
      return rows.map((row) => toRateEntry(row, malMap[row.anime.id] ?? null))
    },

    async getEntry(session, ref) {
      const rate = await shikimori.getUserRate(session.token, session.userId, ref.malId)
      return rate ? toEntry(ref.malId, rate) : null
    },

    // Sends all four fields whatever `changedFields` says: today's behaviour.
    async upsertEntry(session, ref, values, _changedFields) {
      const { episodes, status, score, rewatches } = values
      const rate =
        ref.remoteId === null
          ? await shikimori.createUserRate(
              session.token,
              session.userId,
              ref.malId,
              episodes,
              status,
              score,
              rewatches
            )
          : await shikimori.updateUserRate(
              session.token,
              ref.remoteId,
              episodes,
              status,
              score,
              rewatches
            )
      return toEntry(ref.malId, rate)
    },

    // The auto-downloader's read before #706, moved here unchanged: the
    // `shikimoriAnimeDetails` entry, refreshed inline when it is missing or
    // older than 6 h; a failed refresh keeps the stale entry.
    async getAiringInfo(malId) {
      const cache = store.get('shikimoriAnimeDetails') as Record<string, DetailsCacheEntry>
      let entry: DetailsCacheEntry | undefined = cache[String(malId)]
      const age = entry ? Date.now() - entry.fetchedAt : Infinity
      if (age > AIRING_FRESHNESS_MS && deps.refreshDetails) {
        const fresh = await deps.refreshDetails(malId)
        if (fresh) entry = { details: fresh, fetchedAt: Date.now() }
      }
      if (!entry) return null
      return {
        episodesAired: entry.details?.episodes_aired ?? 0,
        episodes: entry.details?.episodes ?? 0
      }
    },

    // The Friends page and detail block (#712): today's three reads, unchanged.
    getFriends: (session) =>
      shikimori.getFriendsWithStats(session.token, session.userId, ownMalIds(store)),
    getFriendsActivity: (session) => shikimori.getFriendsActivity(session.token, session.userId),
    getFriendsRates: (session, malId) =>
      shikimori.getFriendsRatesForAnime(session.token, session.userId, malId)
  }
}
