// The MAL → smotret join every tracker's list read goes through (#744), moved
// out of `index.ts` so a test can drive it: `malIdMap` hits are served from
// the cache, and only the uncached ids go to smotret. A smotret failure
// degrades instead of rejecting: the uncached ids are left out of the result
// (each caller's miss is `smotretAnime: null`) and nothing is cached for them,
// so the next successful lookup fills them in. Cache hits keep their join.

import type { AnimeDetail, AnimeSearchResult, SmotretApi } from '../smotret-api'
import type { StorageService } from '../store/types'

export interface MalIdLookupDeps {
  store: StorageService
  smotretApi: Pick<SmotretApi, 'lookupByMalIds' | 'getAnime'>
  /** `index.ts`'s `rememberAnimeMeta`: caches a fetched detail in `recentAnimeMeta`. */
  rememberAnimeMeta: (detail: AnimeDetail) => void
  log?: Pick<Console, 'warn'>
}

export type MalIdLookup = (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>

export function createMalIdLookup(deps: MalIdLookupDeps): MalIdLookup {
  const { store, smotretApi, rememberAnimeMeta } = deps
  const log = deps.log ?? console

  // Smotret's bulk `series/?myAnimeListId[]=…` endpoint occasionally returns
  // entries with an empty `posterUrlSmall`. The single-anime detail endpoint
  // (`/series/:id`) usually has one. Enrich any poster-less entries by hitting
  // the detail endpoint, with a small concurrency limit and a per-call timeout.
  // Caches the resolved poster in `recentAnimeMeta` so future lookups skip the
  // fetch entirely.
  async function enrichMissingPosters(
    entries: AnimeSearchResult[],
    recent: Record<string, AnimeSearchResult>
  ): Promise<void> {
    const idsToFetch: number[] = []
    for (const e of entries) {
      if (e.posterUrlSmall || !e.id) continue
      const cachedRecent = recent[String(e.id)]
      if (cachedRecent?.posterUrlSmall) {
        e.posterUrlSmall = cachedRecent.posterUrlSmall
        continue
      }
      idsToFetch.push(e.id)
    }
    if (idsToFetch.length === 0) return

    // Cap to avoid runaway fan-out on first sync of a large list. Anything past
    // the cap will be enriched lazily on next interaction.
    const MAX_ENRICH = 20
    const ids = idsToFetch.slice(0, MAX_ENRICH)
    const concurrency = 4
    let cursor = 0
    async function worker(): Promise<void> {
      while (cursor < ids.length) {
        const id = ids[cursor++]
        try {
          const result = await Promise.race([
            smotretApi.getAnime(id),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
          ])
          const detail = (result as { data: AnimeDetail }).data
          if (!detail) continue
          rememberAnimeMeta(detail)
          const poster = detail.posterUrlSmall || detail.posterUrl || ''
          if (!poster) continue
          for (const e of entries) {
            if (e.id === id && !e.posterUrlSmall) e.posterUrlSmall = poster
          }
        } catch {
          // best-effort; leave empty so renderer fallback can decide
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
  }

  return async function lookupByMalIds(
    malIds: number[]
  ): Promise<Record<number, AnimeSearchResult>> {
    const cached = store.get('malIdMap') as Record<string, AnimeSearchResult>
    const recent = store.get('recentAnimeMeta') as Record<string, AnimeSearchResult>
    const result: Record<number, AnimeSearchResult> = {}
    const uncachedIds: number[] = []

    for (const id of malIds) {
      if (cached[String(id)]) {
        let entry = cached[String(id)]
        // If the cached MAL→smotret entry has no poster, try the freshest
        // smotret meta we have (populated on every get-anime call). This
        // heals stale entries that were cached before we enriched.
        if (!entry.posterUrlSmall && recent[String(entry.id)]?.posterUrlSmall) {
          entry = { ...entry, posterUrlSmall: recent[String(entry.id)].posterUrlSmall }
          cached[String(id)] = entry
        }
        result[id] = entry
      } else {
        uncachedIds.push(id)
      }
    }

    if (uncachedIds.length > 0) {
      let fetched: Awaited<ReturnType<typeof smotretApi.lookupByMalIds>> | null = null
      try {
        fetched = await smotretApi.lookupByMalIds(uncachedIds)
      } catch (err) {
        log.warn(`[smotret] the MAL id lookup failed for ${uncachedIds.length} uncached ids:`, err)
      }
      if (fetched) {
        await enrichMissingPosters(fetched, recent)
        for (const anime of fetched) {
          if (anime.myAnimeListId) {
            result[anime.myAnimeListId] = anime
            cached[String(anime.myAnimeListId)] = anime
          }
        }
      }
    }
    store.set('malIdMap', cached)
    return result
  }
}
