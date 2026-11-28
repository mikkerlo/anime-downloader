// The Chronology panel's shared step (#710): one franchise graph in, the
// panel's `ShikiRelatedEntry[]` out. Shikimori's franchise, AniList's walk
// (`anilist/related.ts`) and MyAnimeList's (`mal/related.ts`) each build a
// `ChronologyGraph`, with relations already in the canonical vocabulary;
// `buildChronology` does the rest, reading no store: the kind rule, the
// status map and the list lookup come in as deps. `docs/trackers.md`
// § Chronology describes the rules.
//
// - A BFS from `current` over `CANONICAL_RELATIONS` edges, both directions.
// - Then nodes with no MAL id are dropped (walked through, never returned),
//   then nodes sharing a MAL id are deduped: current, else the one on the
//   list, else the lowest key (#703's rule).
// - `isCurrent` and the `relation` labels compare `key`s; `shikiAnime.id` is
//   the MAL id. For Shikimori the two are the same.
// - Sorted by `date` (unix seconds, null last), joined to smotret and the
//   status map, with promos, CMs and music videos dropped (never current).

import type { AnimeSearchResult } from '../smotret-api'
import { pickMedia } from './anilist/id-map'

/** The relations the BFS walks; every other edge is ignored (the Isekai Quartet `other` edges). */
export const CANONICAL_RELATIONS: ReadonlySet<string> = new Set([
  'sequel',
  'prequel',
  'side_story',
  'parent_story',
  'alternative_version',
  'summary',
  'full_story',
  'spin_off',
  'alternative_setting'
])

/** Kinds the panel never lists, unless it is the current title. */
export const EXCLUDED_KINDS: ReadonlySet<string> = new Set(['pv', 'cm', 'music'])

export interface ChronologyNode {
  /** The source's own id: AniList's media id, else the MAL id. */
  key: number
  malId: number | null
  title: string
  imageUrl: string
  url: string
  kind: string | null
  /** Unix seconds, or null. */
  date: number | null
  year: number | null
}

export interface ChronologyEdge {
  from: number
  to: number
  /** Canonical snake_case. */
  relation: string
}

export interface ChronologyGraph {
  current: number
  nodes: ChronologyNode[]
  edges: ChronologyEdge[]
}

export interface ChronologyDeps {
  lookupByMalIds: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  /** The node's kind, given smotret's type for its MAL id. */
  kindOf: (node: ChronologyNode, smotretType: string | undefined) => string | null
  /** The node's year; defaults to `node.year`. */
  yearOf?: (node: ChronologyNode, smotret: AnimeSearchResult | null) => number | null
  /** The canonical status per MAL id, built by the caller. */
  statusByMalId: ReadonlyMap<number, ShikiUserRateStatus>
  /** Whether a node's `key` is on the user's list, for the MAL-id dedupe (AniList only). */
  isOnList?: (key: number) => boolean
}

/** The kind rule for a non-Shikimori source: the adapter's kind, then smotret's type, then null. */
export function adapterKindOf(
  node: ChronologyNode,
  smotretType: string | undefined
): string | null {
  if (node.kind) return node.kind
  return smotretType ? smotretType.toLowerCase() : null
}

/**
 * Unix seconds for a (possibly partial) date, in UTC: a missing month or day
 * is the 1st of its period, and no year is null.
 */
export function unixSeconds(
  year: number | null | undefined,
  month?: number | null,
  day?: number | null
): number | null {
  if (typeof year !== 'number' || !Number.isFinite(year)) return null
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 1000
}

function reachableKeys(graph: ChronologyGraph): Set<number> {
  const adjacency = new Map<number, number[]>()
  const add = (a: number, b: number): void => {
    const list = adjacency.get(a)
    if (list) list.push(b)
    else adjacency.set(a, [b])
  }
  for (const edge of graph.edges) {
    if (!CANONICAL_RELATIONS.has(edge.relation)) continue
    add(edge.from, edge.to)
    add(edge.to, edge.from)
  }
  const reachable = new Set<number>([graph.current])
  const queue = [graph.current]
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]) ?? []) {
      if (reachable.has(next)) continue
      reachable.add(next)
      queue.push(next)
    }
  }
  return reachable
}

type MappedNode = ChronologyNode & { malId: number }

/** One node per MAL id: the current node, else #703's rule over `isOnList`. */
function dedupeByMalId(
  nodes: readonly MappedNode[],
  current: number,
  isOnList: (key: number) => boolean
): MappedNode[] {
  const byMal = new Map<number, number[]>()
  for (const n of nodes) byMal.set(n.malId, [...(byMal.get(n.malId) ?? []), n.key])
  const kept = new Set<number>()
  for (const keys of byMal.values()) {
    if (keys.length === 1) kept.add(keys[0])
    else if (keys.includes(current)) kept.add(current)
    else kept.add(pickMedia(keys, new Set(keys.filter((k) => isOnList(k)))))
  }
  const seen = new Set<number>()
  return nodes.filter((n) => {
    if (!kept.has(n.key) || seen.has(n.key)) return false
    seen.add(n.key)
    return true
  })
}

export async function buildChronology(
  graph: ChronologyGraph,
  deps: ChronologyDeps
): Promise<ShikiRelatedEntry[]> {
  const reachable = reachableKeys(graph)
  const walked = graph.nodes.filter((n) => reachable.has(n.key))
  const mapped = walked.filter((n): n is MappedNode => n.malId !== null)
  const nodes = dedupeByMalId(mapped, graph.current, deps.isOnList ?? (() => false))

  const malIds = Array.from(new Set(nodes.map((n) => n.malId)))
  const malMap = await deps.lookupByMalIds(malIds)

  const relationByKey = new Map<number, string>()
  for (const edge of graph.edges) {
    if (edge.from === graph.current) relationByKey.set(edge.to, edge.relation)
  }

  const sorted = [...nodes].sort((a, b) => {
    if (a.date == null && b.date == null) return 0
    if (a.date == null) return 1
    if (b.date == null) return -1
    return a.date - b.date
  })

  return sorted
    .map((n): ShikiRelatedEntry => {
      const smotret = malMap[n.malId] ?? null
      return {
        relation: relationByKey.get(n.key) ?? null,
        shikiAnime: {
          id: n.malId,
          name: n.title,
          image_url: n.imageUrl,
          url: n.url,
          year: deps.yearOf ? deps.yearOf(n, smotret) : n.year,
          kind: deps.kindOf(n, smotret?.type),
          date: n.date
        },
        smotretAnime: smotret,
        isCurrent: n.key === graph.current,
        watchStatus: deps.statusByMalId.get(n.malId) ?? null
      }
    })
    .filter((e) => e.isCurrent || !(e.shikiAnime.kind && EXCLUDED_KINDS.has(e.shikiAnime.kind)))
}
