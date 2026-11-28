// AniList's chronology walk (#710): `tracker:get-related`'s AniList branch.
// `docs/trackers.md` § Chronology.
//
// - Level 0 goes through the id map (`resolveRef`, with #703's duplicate-`idMal`
//   rule). No mapping is `null`, and the handler falls back to the public
//   Shikimori franchise; a failed lookup throws.
// - Each level is one `getRelatedBatch` request (`Page.media(id_in)`, chunked
//   by 50, ANIME edges only) at `interactive`, on AniList media ids. Only
//   canonical edges are walked; the graph stops growing at 40 nodes.
// - Nodes with no `idMal` stay in the graph, so a special between two seasons
//   doesn't cut the second one off; `buildChronology` drops them after its BFS.
// - A failed level throws: no partial graph. Walks aren't cached.

import type { StorageService } from '../../store/types'
import {
  CANONICAL_RELATIONS,
  unixSeconds,
  type ChronologyGraph,
  type ChronologyNode
} from '../chronology'
import type { AniListPriority } from './limiter'
import {
  titleOf,
  type AniListCachedRow,
  type AniListMedia,
  type AniListRelatedMedia
} from './provider'

/**
 * AniList's `MediaRelation` values onto the canonical relations. The last four
 * aren't walked. `A → B: COMPILATION` reads "B is a compilation of A", so B is
 * A's `summary`; `CONTAINS`, its inverse, makes B the `full_story`.
 * `SAME_UNIVERSE` (schema v3) is what Shikimori and MAL call
 * `alternative_setting`. The 14 values are a live introspection's (2026-11-28).
 */
export const ANILIST_RELATION_MAP: Readonly<Record<string, string>> = {
  SEQUEL: 'sequel',
  PREQUEL: 'prequel',
  SIDE_STORY: 'side_story',
  PARENT: 'parent_story',
  ALTERNATIVE: 'alternative_version',
  SUMMARY: 'summary',
  SPIN_OFF: 'spin_off',
  COMPILATION: 'summary',
  CONTAINS: 'full_story',
  SAME_UNIVERSE: 'alternative_setting',
  CHARACTER: 'character',
  OTHER: 'other',
  ADAPTATION: 'adaptation',
  SOURCE: 'source'
}

/** The most nodes a walk collects. */
export const ANILIST_WALK_CAP = 40

/** AniList's `format` onto the panel's kinds (`TV_SHORT` is TV); unknown is null. */
export function anilistKind(format: string | null | undefined): string | null {
  if (!format) return null
  if (format === 'TV_SHORT') return 'tv'
  return format.toLowerCase()
}

type RelationNode = Pick<AniListMedia, 'id' | 'idMal' | 'title' | 'coverImage' | 'format'> & {
  type?: string | null
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  siteUrl?: string | null
}

export function anilistChronologyNode(m: RelationNode): ChronologyNode {
  const start = m.startDate ?? null
  return {
    key: m.id,
    malId: typeof m.idMal === 'number' ? m.idMal : null,
    title: titleOf(m as AniListMedia),
    imageUrl: m.coverImage?.large ?? '',
    url: m.siteUrl ?? `https://anilist.co/anime/${m.id}`,
    kind: anilistKind(m.format),
    date: unixSeconds(start?.year, start?.month, start?.day),
    year: typeof start?.year === 'number' ? start.year : null
  }
}

export interface AniListRelatedDeps {
  resolveRef: (
    malId: number,
    opts?: { priority?: AniListPriority }
  ) => Promise<{ mediaId: number } | null>
  getRelatedBatch: (
    anilistIds: readonly number[],
    opts?: { priority?: AniListPriority }
  ) => Promise<Map<number, AniListRelatedMedia>>
  store: Pick<StorageService, 'get'>
  cap?: number
}

export interface AniListRelated {
  /** The walked graph, or null when AniList doesn't map the MAL id. */
  walk(malId: number): Promise<ChronologyGraph | null>
  /** Whether an AniList media id is on the user's list (`anilistUserRates`). */
  isOnList(mediaId: number): boolean
}

export function createAniListRelated(deps: AniListRelatedDeps): AniListRelated {
  const cap = deps.cap ?? ANILIST_WALK_CAP

  async function walk(malId: number): Promise<ChronologyGraph | null> {
    const ref = await deps.resolveRef(malId, { priority: 'interactive' })
    if (!ref) return null
    const current = ref.mediaId
    const nodes = new Map<number, ChronologyNode>()
    const edges: ChronologyGraph['edges'] = []
    let frontier = [current]
    const fetched = new Set<number>()
    while (frontier.length > 0) {
      const batch = await deps.getRelatedBatch(frontier, { priority: 'interactive' })
      const next: number[] = []
      for (const id of frontier) {
        fetched.add(id)
        const media = batch.get(id)
        if (!media) continue
        // A fetched media's own fields win over what an edge carried.
        nodes.set(id, anilistChronologyNode(media as unknown as RelationNode))
        for (const edge of media.relations?.edges ?? []) {
          const target = edge?.node as RelationNode | undefined
          if (!target || target.type !== 'ANIME') continue
          const relation =
            ANILIST_RELATION_MAP[edge.relationType] ?? String(edge.relationType).toLowerCase()
          edges.push({ from: id, to: target.id, relation })
          if (!CANONICAL_RELATIONS.has(relation) || nodes.has(target.id)) continue
          if (nodes.size >= cap) continue
          nodes.set(target.id, anilistChronologyNode(target))
          if (!fetched.has(target.id)) next.push(target.id)
        }
      }
      // At the cap a node's edges can add nothing: its own fields came with its edge.
      frontier = nodes.size >= cap ? [] : next
    }
    return { current, nodes: [...nodes.values()], edges }
  }

  function isOnList(mediaId: number): boolean {
    const rows = (deps.store.get('anilistUserRates') as AniListCachedRow[] | undefined) ?? []
    return rows.some((r) => (r?.entry?.mediaId ?? r?.entry?.media?.id) === mediaId)
  }

  return { walk, isOnList }
}
