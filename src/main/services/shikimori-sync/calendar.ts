// Shikimori's airing calendar (#568, #709): the body of `shikimori:get-calendar`,
// shared with `tracker:get-calendar` while Shikimori is the `calendar` source.
// Shikimori's public `/api/calendar`, filtered to the signed-in user's
// watching / rewatching / planned titles in `shikimoriUserRates`, cached in the
// sync service's calendar snapshot with the shared TTL and offline rules.

import * as shikimori from '../../shikimori'
import { SHIKIMORI_ORIGIN } from '@shared/shikimori'
import type { StorageService } from '../../store/types'
import type { AnimeSearchResult } from '../../smotret-api'
import { serveCalendar } from '../../trackers/display-snapshots'
import {
  CALENDAR_CACHE_TTL_MS,
  type CachedCalendar,
  type CalendarEntry,
  type ShikimoriSyncService
} from '.'

const SHIKI_BASE = SHIKIMORI_ORIGIN

export interface ShikimoriCalendarDeps {
  store: StorageService
  sync: Pick<ShikimoriSyncService, 'getCachedCalendar' | 'setCachedCalendar' | 'fetchAndCacheRates'>
  lookupByMalIds: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  isOffline: () => boolean
}

export type ShikimoriCalendarRead = (
  force?: boolean
) => Promise<ShikiSnapshotResult<CalendarEntry[]>>

export function createShikimoriCalendar(deps: ShikimoriCalendarDeps): ShikimoriCalendarRead {
  const { store, sync, lookupByMalIds } = deps

  function currentUserId(): number | undefined {
    return (store.get('shikimoriUser') as shikimori.ShikiUser | null)?.id
  }

  async function fetchCalendar(): Promise<CachedCalendar> {
    const userId = currentUserId() ?? null

    let cachedRates = store.get('shikimoriUserRates') as {
      rate: { target_id?: number; episodes: number; status: shikimori.ShikiUserRateStatus }
      shikiAnime?: { id: number }
    }[]

    if (cachedRates.length === 0) {
      try {
        await sync.fetchAndCacheRates({ status: undefined })
        cachedRates = store.get('shikimoriUserRates') as typeof cachedRates
      } catch (err) {
        console.warn('[shikimori] calendar: rate fetch failed:', err)
      }
    }

    // Older cached entries may lack `rate.target_id`; fall back to `shikiAnime.id`
    // (also the MAL ID) — same compatibility shim used by `home:get-continue-watching`.
    function malIdOf(r: (typeof cachedRates)[number]): number | undefined {
      return r.rate.target_id ?? r.shikiAnime?.id
    }

    const tracked = new Set<number>()
    const statusByMal = new Map<number, shikimori.ShikiUserRateStatus>()
    for (const r of cachedRates) {
      const malId = malIdOf(r)
      if (!malId) continue
      statusByMal.set(malId, r.rate.status)
      if (
        r.rate.status === 'watching' ||
        r.rate.status === 'rewatching' ||
        r.rate.status === 'planned'
      ) {
        tracked.add(malId)
      }
    }

    if (tracked.size === 0) return sync.setCachedCalendar([], userId)

    const calendar = await shikimori.getCalendar()
    const filtered = calendar.filter((c) => c.next_episode_at && tracked.has(c.anime.id))

    const malIds = Array.from(new Set(filtered.map((c) => c.anime.id)))
    const malMap = await lookupByMalIds(malIds)

    function absoluteImage(url: string): string {
      return url.startsWith('http') ? url : `${SHIKI_BASE}${url}`
    }

    const entries: CalendarEntry[] = filtered.map((c) => {
      const malId = c.anime.id
      const smotret = malMap[malId] ?? null
      const posterUrl =
        smotret?.posterUrlSmall ||
        absoluteImage(c.anime.image.preview || c.anime.image.x96 || c.anime.image.original)
      return {
        malId,
        animeId: smotret?.id ?? null,
        name: c.anime.russian || c.anime.name,
        posterUrl,
        kind: c.anime.kind,
        episodeInt: String(c.next_episode ?? c.anime.episodes_aired + 1),
        nextEpisodeAt: c.next_episode_at!,
        userStatus: statusByMal.get(malId) ?? 'planned'
      }
    })

    return sync.setCachedCalendar(entries, userId)
  }

  return (force = false) =>
    serveCalendar({
      cached: () => sync.getCachedCalendar(),
      isOffline: deps.isOffline,
      fetch: fetchCalendar,
      force,
      ttlMs: CALENDAR_CACHE_TTL_MS,
      label: '[shikimori]'
    })
}
