// MyAnimeList's chronology walk (#710): `tracker:get-related`'s MAL branch.
// `docs/trackers.md` § Chronology.
//
// - One `getRelated` read (`GET /anime/{id}?fields=…related_anime`) per node,
//   one at a time: each is awaited before the next is queued on the client's
//   limiter, so a MAL write waits behind at most one walk request.
// - Only canonical edges are walked, and at most 15 nodes are fetched. A node
//   seen only inside a `related_anime` list carries its id, title and picture:
//   no kind, year or date (smotret's type and year stand in; it sorts last).
// - A failed read throws: no partial graph, nothing cached. A walked graph is
//   kept in memory per requested MAL id for an hour, before the status join.

import {
  CANONICAL_RELATIONS,
  unixSeconds,
  type ChronologyGraph,
  type ChronologyNode
} from '../chronology'
import type { TrackerRef } from '../types'
import type { MalRelatedRead } from './provider'

/** The most `GET /anime/{id}` reads a walk makes. */
export const MAL_WALK_CAP = 15
/** How long a walked graph is served from memory. */
export const MAL_RELATED_TTL_MS = 60 * 60 * 1000

const START_DATE_RE = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/

/** `start_date` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) as unix seconds and the year, else nulls. */
export function malStartDate(value: string | null | undefined): {
  date: number | null
  year: number | null
} {
  const m = START_DATE_RE.exec(value ?? '')
  if (!m) return { date: null, year: null }
  const year = Number(m[1])
  const month = m[2] ? Number(m[2]) : null
  const day = m[3] ? Number(m[3]) : null
  return { date: unixSeconds(year, month, day), year }
}

/** `media_type`, with `unknown` (or none) as null. */
export function malKind(mediaType: string | null | undefined): string | null {
  if (!mediaType || mediaType === 'unknown') return null
  return mediaType.toLowerCase()
}

type Picture = { medium?: string; large?: string } | null | undefined

const pictureOf = (p: Picture): string => p?.large ?? p?.medium ?? ''
const urlOf = (id: number): string => `https://myanimelist.net/anime/${id}`

/** A fetched title: its own kind and date. */
export function malChronologyNode(read: MalRelatedRead): ChronologyNode {
  const { date, year } = malStartDate(read.start_date)
  return {
    key: read.id,
    malId: read.id,
    title: read.title ?? '',
    imageUrl: pictureOf(read.main_picture),
    url: urlOf(read.id),
    kind: malKind(read.media_type),
    date,
    year
  }
}

function discoveredNode(node: {
  id: number
  title?: string
  main_picture?: Picture
}): ChronologyNode {
  return {
    key: node.id,
    malId: node.id,
    title: node.title ?? '',
    imageUrl: pictureOf(node.main_picture),
    url: urlOf(node.id),
    kind: null,
    date: null,
    year: null
  }
}

export interface MalRelatedDeps {
  /** The provider's `getRelated`: one public read on the client's limiter. */
  getRelated: (ref: TrackerRef) => Promise<unknown>
  cap?: number
  ttlMs?: number
  now?: () => number
}

export interface MalRelated {
  /** The walked graph, from memory within the TTL. */
  walk(malId: number): Promise<ChronologyGraph>
}

export function createMalRelated(deps: MalRelatedDeps): MalRelated {
  const cap = deps.cap ?? MAL_WALK_CAP
  const ttl = deps.ttlMs ?? MAL_RELATED_TTL_MS
  const now = deps.now ?? Date.now
  const cache = new Map<number, { graph: ChronologyGraph; at: number }>()

  async function fetchWalk(malId: number): Promise<ChronologyGraph> {
    const nodes = new Map<number, ChronologyNode>()
    const edges: ChronologyGraph['edges'] = []
    const queue = [malId]
    const queued = new Set(queue)
    let fetched = 0
    while (queue.length > 0 && fetched < cap) {
      const id = queue.shift()!
      const read = (await deps.getRelated({ malId: id, remoteId: null })) as MalRelatedRead
      fetched++
      nodes.set(id, malChronologyNode({ ...read, id }))
      for (const rel of read.related_anime ?? []) {
        const target = rel?.node
        if (typeof target?.id !== 'number') continue
        const relation = String(rel.relation_type ?? '').toLowerCase()
        edges.push({ from: id, to: target.id, relation })
        if (!CANONICAL_RELATIONS.has(relation)) continue
        if (!nodes.has(target.id)) nodes.set(target.id, discoveredNode(target))
        if (!queued.has(target.id)) {
          queued.add(target.id)
          queue.push(target.id)
        }
      }
    }
    return { current: malId, nodes: [...nodes.values()], edges }
  }

  async function walk(malId: number): Promise<ChronologyGraph> {
    const hit = cache.get(malId)
    if (hit && now() - hit.at < ttl) return hit.graph
    const graph = await fetchWalk(malId)
    cache.set(malId, { graph, at: now() })
    return graph
  }

  return { walk }
}
