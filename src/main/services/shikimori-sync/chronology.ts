// Shikimori's chronology (#118, #710): the body of `shikimori:get-related`,
// shared with `tracker:get-related`'s Shikimori branch. That branch is also
// the fallback with no `chronology` source and for a title AniList doesn't
// map. Shikimori's public `GET /api/animes/:id/franchise` (no token) returns
// the whole franchise graph in one call; `buildChronology` does the rest, with
// Shikimori's kind rule (its details and rate caches first).

import * as shikimori from '../../shikimori'
import type { AnimeSearchResult } from '../../smotret-api'
import type { StorageService } from '../../store/types'
import {
  buildChronology,
  type ChronologyGraph,
  type ChronologyNode
} from '../../trackers/chronology'

type Store = Pick<StorageService, 'get'>

type CachedRate = {
  rate: { status: shikimori.ShikiUserRateStatus }
  shikiAnime: { id: number; kind?: string }
}

/** The franchise as a chronology graph: keys are MAL ids, as Shikimori's anime ids are. */
export function franchiseGraph(franchise: shikimori.ShikiFranchise): ChronologyGraph {
  return {
    current: franchise.current_id,
    nodes: franchise.nodes.map((n) => ({
      key: n.id,
      malId: n.id,
      title: n.name,
      imageUrl: n.image_url,
      url: n.url,
      kind: n.kind,
      date: n.date,
      year: n.year
    })),
    edges: franchise.links.map((l) => ({
      from: l.source_id,
      to: l.target_id,
      relation: l.relation
    }))
  }
}

/** `shikimoriUserRates`' status per MAL id: `shikimori:get-related`'s status map. */
export function shikimoriStatusByMalId(store: Store): Map<number, shikimori.ShikiUserRateStatus> {
  const out = new Map<number, shikimori.ShikiUserRateStatus>()
  for (const r of store.get('shikimoriUserRates') as CachedRate[]) {
    const id = r.shikiAnime?.id
    if (id == null) continue
    if (r.rate?.status) out.set(id, r.rate.status)
  }
  return out
}

/**
 * Shikimori's kind rule: the details cache, then the rate cache, then smotret's
 * type, then the franchise node's own (localized) kind. The caches are read on
 * the first call, after the franchise and smotret reads, as the handler did.
 */
export function shikimoriKindOf(
  store: Store
): (node: ChronologyNode, smotretType: string | undefined) => string | null {
  let caches: {
    details: Record<string, { details: shikimori.ShikiAnimeDetails; fetchedAt: number }>
    kindByMalId: Map<number, string>
  } | null = null
  const read = (): NonNullable<typeof caches> => {
    if (caches) return caches
    const kindByMalId = new Map<number, string>()
    for (const r of store.get('shikimoriUserRates') as CachedRate[]) {
      const id = r.shikiAnime?.id
      if (id == null) continue
      if (r.shikiAnime.kind) kindByMalId.set(id, r.shikiAnime.kind)
    }
    caches = {
      details: store.get('shikimoriAnimeDetails') as NonNullable<typeof caches>['details'],
      kindByMalId
    }
    return caches
  }
  return (node, smotretType) => {
    const { details, kindByMalId } = read()
    const cached = details[String(node.malId)]?.details?.kind
    if (cached) return cached
    const rated = node.malId === null ? undefined : kindByMalId.get(node.malId)
    if (rated) return rated
    if (smotretType) return smotretType.toLowerCase()
    const k = (node.kind || '').toLowerCase()
    if (k.includes('проморолик') || k === 'pv') return 'pv'
    if (k.includes('реклама') || k === 'cm') return 'cm'
    if (k.includes('клип') || k === 'music') return 'music'
    if (k.includes('тв-спешл') || k === 'tv_special') return 'tv_special'
    if (k.includes('спешл') || k === 'special') return 'special'
    if (k.includes('полнометраж') || k === 'movie') return 'movie'
    if (k.includes('ova')) return 'ova'
    if (k.includes('ona')) return 'ona'
    if (k.includes('tv')) return 'tv'
    return node.kind ?? null
  }
}

export type ShikimoriChronologyRead = (
  malId: number,
  statusByMalId?: ReadonlyMap<number, ShikiUserRateStatus>
) => Promise<ShikiRelatedEntry[]>

/**
 * The franchise read and `buildChronology`. `statusByMalId` defaults to
 * `shikimoriUserRates`' (the alias); `tracker:get-related` passes the primary's.
 */
export function createShikimoriChronology(deps: {
  store: Store
  lookupByMalIds: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
}): ShikimoriChronologyRead {
  const { store, lookupByMalIds } = deps
  return async (malId, statusByMalId) => {
    const franchise = await shikimori.getFranchise(malId)
    return buildChronology(franchiseGraph(franchise), {
      lookupByMalIds,
      kindOf: shikimoriKindOf(store),
      statusByMalId: statusByMalId ?? shikimoriStatusByMalId(store)
    })
  }
}
