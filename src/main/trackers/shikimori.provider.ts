// The Shikimori tracker adapter (#689). It wraps `shikimori.ts` and adds no
// behaviour: every member calls the same function with the same positional
// arguments as today's call sites, taken from the session it is given. It
// calls through the module namespace, so a `vi.mock` of `../shikimori`
// intercepts every call.

import * as shikimori from '../shikimori'
import { rateValues } from '../lib/shikimori-rate'
import { buildRateCacheEntries, type CachedRateEntry } from '../lib/shikimori-rate-cache'
import type { AnimeSearchResult } from '../smotret-api'
import type { StorageService } from '../store/types'
import { classifyShikimoriError } from './shikimori.errors'
import { TRACKER_CAPABILITIES, type TrackerCapabilities, type TrackerEntry } from './types'
import type {
  ShikimoriSession,
  TrackerRateCacheCodec,
  TrackerRateEntry,
  TrackerSyncProvider
} from './types'

export interface ShikimoriProviderDeps {
  store: StorageService
  /** The smotret join for listed rows, as the rate refresh does it. */
  lookupByMalIds?: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
}

export type ShikimoriProvider = TrackerSyncProvider<
  ShikimoriSession,
  shikimori.ShikiAnimeRateEntry,
  shikimori.ShikiUserRate,
  CachedRateEntry
>

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
  }
}

/** The refresh cleared the stored credentials: only a new sign-in brings them back. */
export function isShikimoriSessionGone(err: unknown): boolean {
  return err instanceof shikimori.ShikiAuthError
}

const NO_CAPABILITIES = Object.fromEntries(
  TRACKER_CAPABILITIES.map((c) => [c, false])
) as unknown as TrackerCapabilities

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

function toRateEntry(
  row: shikimori.ShikiAnimeRateEntry,
  smotretAnime: AnimeSearchResult | null
): TrackerRateEntry<shikimori.ShikiAnimeRateEntry> {
  const anime = row.anime
  return {
    trackerId: 'shikimori',
    // As the rate cache derives `target_id` (`lib/shikimori-rate-cache.ts`).
    malId: row.target_id ?? anime.id,
    remoteId: row.id,
    values: rateValues(row),
    updatedAt: parseUpdatedAt(row.updated_at),
    anime: {
      // The app's display rule: the Russian title, else the romaji name.
      title: anime.russian || anime.name,
      poster: anime.image?.original ?? null,
      kind: anime.kind ?? null,
      episodes: anime.episodes ?? null,
      episodesAired: anime.episodes_aired ?? null,
      status: anime.status ?? null
    },
    smotretAnime,
    native: row
  }
}

export function createShikimoriProvider(deps: ShikimoriProviderDeps): ShikimoriProvider {
  const { store } = deps
  return {
    id: 'shikimori',
    capabilities: NO_CAPABILITIES,

    // The drain's order: the user first, then the token, so `userId` is the
    // account the token was refreshed for.
    async auth() {
      const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
      const token = await shikimori.ensureFreshToken(store)
      if (!user) throw new Error('Not logged in to Shikimori')
      return { token, userId: user.id }
    },

    getUser: (token) => shikimori.getUser(token),

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
    }
  }
}
