// The merge field table of #572 (§6), frozen there: rules 1–12 as data, each
// with its decision function. S9 (#584)'s engine applies them field by field;
// S5 (#573) serializes the fields they cover. A change to a rule follows the
// `SyncDoc` version rule (`stateMinor` / `stateVersion`). Pure.
//
// "Changed" is a value difference from the base, never a clock difference.
// Clocks only break the ties the table says "later `at` wins" (rules 1, 8, 9,
// 10), and detect a re-watch (rule 2). With no base (`base === undefined`)
// every rule degrades to S9's first-merge table: equal values are unchanged, a
// value present on one side only is taken, `position` / membership / order go
// to the later `at` (a tie to side A), `watched: true` wins, `episodes` takes
// the max, differing `status` / `score` / `rewatches` conflict, and `dismissed`
// is a union.

import { laterClock } from './clock'

export type MergeSide = 'a' | 'b'

/** What a rule decided for one field. `value` is what both sides end up with. */
export type Decision<T> =
  | { kind: 'unchanged' }
  | { kind: 'take'; from: MergeSide; value: T }
  | { kind: 'merge'; value: T }
  | { kind: 'conflict'; reason: string }

/** A membership (`starred` / `priority`) as a rule sees it: present or not, and since when. */
export interface Membership {
  present: boolean
  at: number
  origin: string
}

/** Rule 3's per-side input. */
export interface WatchedAtSide {
  watched: boolean
  watchedAt: number | null
}

export interface SkipContext {
  /** The detector's algorithm on this PC; an entry with another one is a cache miss. */
  algorithm: ShowSkipDetections['algorithm']
  /** This PC's file for an episode, or null when it has none. */
  localFile(episodeInt: string): { translationId: number; fileSize: number } | null
}

/** Value equality over JSON-shaped data: key order and `undefined` members don't count. */
export function sameValue(x: unknown, y: unknown): boolean {
  return canonical(x) === canonical(y)
}

function canonical(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}`
}

/** Whether a side changed a field: its value differs from the base's. An absent side has no view and never changed. */
export function sideChanged<T>(base: T | undefined, side: T | undefined): boolean {
  return side !== undefined && !sameValue(base, side)
}

function valueOf<T>(f: SyncField<T> | undefined): T | undefined {
  return f?.value
}

/**
 * The shared skeleton: neither changed → unchanged; one changed → take it;
 * both changed to the same value → merge (the later clock); both changed to
 * different values → `bothDiffer`.
 */
function decideClocked<T>(
  base: SyncField<T> | undefined,
  a: SyncField<T> | undefined,
  b: SyncField<T> | undefined,
  bothDiffer: (a: SyncField<T>, b: SyncField<T>) => Decision<SyncField<T>>
): Decision<SyncField<T>> {
  // With no base, equal values are unchanged on both sides, whatever the clocks say.
  if (base === undefined && sameValue(valueOf(a), valueOf(b))) return { kind: 'unchanged' }
  const changedA = sideChanged(valueOf(base), valueOf(a))
  const changedB = sideChanged(valueOf(base), valueOf(b))
  if (!changedA && !changedB) return { kind: 'unchanged' }
  if (changedA && !changedB) return { kind: 'take', from: 'a', value: a! }
  if (!changedA && changedB) return { kind: 'take', from: 'b', value: b! }
  if (sameValue(a!.value, b!.value)) return { kind: 'merge', value: laterClock(a!, b!) }
  return bothDiffer(a!, b!)
}

const laterWins = <T>(a: SyncField<T>, b: SyncField<T>): Decision<SyncField<T>> => ({
  kind: 'merge',
  value: laterClock(a, b)
})

/** Rule 1: `watch[ep].position`. */
export function decidePosition(
  base: SyncField<SyncWatchPosition> | undefined,
  a: SyncField<SyncWatchPosition> | undefined,
  b: SyncField<SyncWatchPosition> | undefined
): Decision<SyncField<SyncWatchPosition>> {
  return decideClocked(base, a, b, laterWins)
}

/** Rule 2: `watch[ep].watched`. */
export function decideWatched(
  base: SyncField<boolean> | undefined,
  a: SyncField<boolean> | undefined,
  b: SyncField<boolean> | undefined
): Decision<SyncField<boolean>> {
  // An unwatch on one side against a re-watch on the other: the re-watched
  // side kept `true`, but its clock moved past the base's.
  const rewatched = (s: SyncField<boolean> | undefined): boolean =>
    !!base && base.value && !!s && s.value && s.at > base.at
  const unwatched = (s: SyncField<boolean> | undefined): boolean =>
    !!base && base.value && !!s && !s.value
  if ((unwatched(a) && rewatched(b)) || (unwatched(b) && rewatched(a))) {
    return { kind: 'conflict', reason: 'unwatched on one side, re-watched on the other' }
  }
  // Both changed to different values is only reachable with no base.
  return decideClocked(base, a, b, (x, y) => ({ kind: 'merge', value: x.value ? x : y }))
}

/** Rule 3: `watch[ep].watchedAt`, the earliest non-null of the sides where `watched` is true. */
export function decideWatchedAt(
  _base: WatchedAtSide | undefined,
  a: WatchedAtSide | undefined,
  b: WatchedAtSide | undefined,
  ctx: { mergedWatched: boolean }
): Decision<number | null> {
  const candidates = [a, b]
    .filter((s): s is WatchedAtSide => !!s && s.watched && s.watchedAt !== null)
    .map((s) => s.watchedAt as number)
  const value = ctx.mergedWatched && candidates.length > 0 ? Math.min(...candidates) : null
  if ((a?.watchedAt ?? null) === value && (b?.watchedAt ?? null) === value) {
    return { kind: 'unchanged' }
  }
  return { kind: 'merge', value }
}

const lowest = Number.NEGATIVE_INFINITY

/** Rule 4: `rate.episodes`. */
export function decideEpisodes(
  base: SyncField<number> | undefined,
  a: SyncField<number> | undefined,
  b: SyncField<number> | undefined
): Decision<SyncField<number>> {
  return decideClocked(base, a, b, (x, y) => {
    const from = base?.value ?? lowest
    const xRose = x.value > from
    const yRose = y.value > from
    if (xRose && yRose) return { kind: 'merge', value: x.value >= y.value ? x : y }
    if (xRose !== yRose)
      return { kind: 'conflict', reason: 'lowered on one side, raised on the other' }
    return { kind: 'conflict', reason: 'lowered on both sides, to different values' }
  })
}

const differentIsConflict = <T>(): Decision<SyncField<T>> => ({
  kind: 'conflict',
  reason: 'changed on both sides, to different values'
})

/** Rule 5: `rate.status`. */
export function decideStatus(
  base: SyncField<string> | undefined,
  a: SyncField<string> | undefined,
  b: SyncField<string> | undefined
): Decision<SyncField<string>> {
  return decideClocked(base, a, b, () => differentIsConflict())
}

/** Rule 6: `rate.score`. */
export function decideScore(
  base: SyncField<number> | undefined,
  a: SyncField<number> | undefined,
  b: SyncField<number> | undefined
): Decision<SyncField<number>> {
  return decideClocked(base, a, b, () => differentIsConflict())
}

/** Rule 7: `rate.rewatches`. Both rose is a conflict even to the same value (owner decision 6). */
export function decideRewatches(
  base: SyncField<number> | undefined,
  a: SyncField<number> | undefined,
  b: SyncField<number> | undefined
): Decision<SyncField<number>> {
  if (base && a && b && a.value > base.value && b.value > base.value) {
    return { kind: 'conflict', reason: 'a rewatch added on both sides: one rewatch or two?' }
  }
  return decideClocked(base, a, b, () => differentIsConflict())
}

/** Rules 8 and 9: `starred` and `priority` membership. Tombstones carry the `at` of a removal. */
export function decideMembership(
  base: Membership | undefined,
  a: Membership,
  b: Membership
): Decision<Membership> {
  const changedA = base === undefined ? true : a.present !== base.present
  const changedB = base === undefined ? true : b.present !== base.present
  if (a.present === b.present) {
    if (base !== undefined && a.present === base.present) return { kind: 'unchanged' }
    if (base === undefined) return { kind: 'unchanged' }
    return { kind: 'merge', value: laterClock(a, b) }
  }
  if (changedA && !changedB) return { kind: 'take', from: 'a', value: a }
  if (!changedA && changedB) return { kind: 'take', from: 'b', value: b }
  const later = laterClock(a, b)
  return { kind: 'take', from: later === a ? 'a' : 'b', value: later }
}

/** Rule 9's invariant: a title that is not starred is not prioritised. */
export function enforcePriorityInvariant(starred: Membership, priority: Membership): Membership {
  if (starred.present || !priority.present) return priority
  return { present: false, at: Math.max(starred.at, priority.at), origin: starred.origin }
}

/**
 * `order` filtered to `members`, then the members it lacks in `other`'s
 * relative order, then any still missing in `members`' order.
 */
export function reconcileOrder(
  order: readonly string[],
  other: readonly string[],
  members: readonly string[]
): string[] {
  const memberSet = new Set(members)
  const out = order.filter((id) => memberSet.has(id))
  const seen = new Set(out)
  for (const id of [...other, ...members]) {
    if (memberSet.has(id) && !seen.has(id)) {
      out.push(id)
      seen.add(id)
    }
  }
  return out
}

/** Rule 10: `priorityOrder`, over in-scope ids. `members` is the merged priority membership. */
export function decidePriorityOrder(
  base: SyncField<string[]> | undefined,
  a: SyncField<string[]>,
  b: SyncField<string[]>,
  ctx: { members: readonly string[] }
): Decision<SyncField<string[]>> {
  const changedA = sideChanged(base?.value, a.value)
  const changedB = sideChanged(base?.value, b.value)
  let winner: SyncField<string[]>
  let loser: SyncField<string[]>
  if (changedA && changedB) {
    winner = laterClock(a, b)
    loser = winner === a ? b : a
  } else if (changedB) {
    winner = b
    loser = a
  } else {
    winner = a
    loser = b
  }
  const value = reconcileOrder(winner.value, loser.value, ctx.members)
  if (sameValue(value, a.value) && sameValue(value, b.value)) return { kind: 'unchanged' }
  return { kind: 'merge', value: { ...winner, value } }
}

/** Rule 11: `dismissed`, a 3-way set merge: (base ∪ addedA ∪ addedB) − removedA − removedB. */
export function decideDismissed(
  base: readonly string[] | undefined,
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): Decision<string[]> {
  const baseSet = new Set(base ?? [])
  const aSet = new Set(a ?? [])
  const bSet = new Set(b ?? [])
  const added = [...aSet, ...bSet].filter((k) => !baseSet.has(k))
  const removed = new Set([...baseSet].filter((k) => !aSet.has(k) || !bSet.has(k)))
  const value = [...new Set([...baseSet, ...added])].filter((k) => !removed.has(k)).sort()
  if (sameValue(value, [...aSet].sort()) && sameValue(value, [...bSet].sort())) {
    return { kind: 'unchanged' }
  }
  return { kind: 'merge', value }
}

/**
 * Rule 12: `skip`, a cache. Side A is this PC. Per episode: keep A's entry
 * when its algorithm is this PC's; otherwise take B's when its algorithm is
 * this PC's and its file identity matches this PC's file; otherwise none, and
 * the episode is re-analysed locally. Never a conflict.
 */
export function decideSkip(
  _base: SyncSkipState | undefined,
  a: SyncSkipState | undefined,
  b: SyncSkipState | undefined,
  ctx: SkipContext
): Decision<SyncSkipState | undefined> {
  const aOk = !!a && sameValue(a.algorithm, ctx.algorithm)
  const bOk = !!b && sameValue(b.algorithm, ctx.algorithm)
  const perEpisode: Record<string, SyncSkipEpisode> = {}
  if (aOk) Object.assign(perEpisode, a!.perEpisode)
  let tookB = false
  if (bOk) {
    for (const [ep, entry] of Object.entries(b!.perEpisode)) {
      if (perEpisode[ep]) continue
      const file = ctx.localFile(ep)
      if (file && sameValue(file, entry.file)) {
        perEpisode[ep] = entry
        tookB = true
      }
    }
  }
  // Nothing taken from B leaves this PC's cache as it is: a stale entry is
  // replaced by the next local analysis, not deleted by a merge.
  if (!tookB) return { kind: 'unchanged' }
  const show = aOk ? a! : b!
  return { kind: 'merge', value: { ...show, perEpisode } }
}

/** A side's membership in `doc`: the field, its tombstone, or neither (never a member). */
export function membershipOf(
  doc: SyncDoc,
  animeId: string,
  field: 'starred' | 'priority'
): Membership {
  const live = doc.titles[animeId]?.[field]
  if (live) return { present: true, at: live.at, origin: live.origin }
  const stone = doc.tombstones[animeId]?.[field]
  if (stone) return { present: false, at: stone.at, origin: stone.origin }
  return { present: false, at: Number.NEGATIVE_INFINITY, origin: '' }
}

export interface FieldRule {
  rule: number
  field: string
  /** Where the field lives in the local store. */
  source: string
  /** Whether a clock can change this rule's outcome. */
  clockDecides: boolean
  /** Whether this rule can hold a field for review (S10 #585). */
  canConflict: boolean
  silent: string
  conflict: string | null
  decide: (...args: never[]) => Decision<unknown>
}

/** #572 §6, rules 1–12. Frozen: S9 (#584) applies it as written. */
export const FIELD_TABLE: readonly FieldRule[] = [
  {
    rule: 1,
    field: 'watch[ep].position',
    source: 'watchProgress: position, duration, translationId',
    clockDecides: true,
    canConflict: false,
    silent:
      "A change on one side is applied. If both changed, the later position.at wins. Only 'playback' saves move it.",
    conflict: null,
    decide: decidePosition
  },
  {
    rule: 2,
    field: 'watch[ep].watched',
    source: 'watchProgress.watched',
    clockDecides: true,
    canConflict: true,
    silent: 'A change on one side is applied, including an unwatch.',
    conflict:
      'One side unwatched (true → false) while the other re-watched: still true, with a watched.at newer than the base.',
    decide: decideWatched
  },
  {
    rule: 3,
    field: 'watch[ep].watchedAt',
    source: 'watchProgress.watchedAt',
    clockDecides: false,
    canConflict: false,
    silent: 'Earliest non-null of the sides where watched is true.',
    conflict: null,
    decide: decideWatchedAt
  },
  {
    rule: 4,
    field: 'rate.episodes',
    source: 'rate cache and queued edits (S9 adds its pending overlay)',
    clockDecides: false,
    canConflict: true,
    silent:
      'A change on one side is applied. Both changed to the same value: applied. Both rose: take the max.',
    conflict: 'One side lowered while the other rose. Both lowered, to different values.',
    decide: decideEpisodes
  },
  {
    rule: 5,
    field: 'rate.status',
    source: 'rate cache and queued edits',
    clockDecides: false,
    canConflict: true,
    silent: 'A change on one side is applied. Both changed to the same value: applied.',
    conflict: 'Both changed, to different values.',
    decide: decideStatus
  },
  {
    rule: 6,
    field: 'rate.score',
    source: 'rate cache and queued edits',
    clockDecides: false,
    canConflict: true,
    silent: 'A change on one side is applied. Both changed to the same value: applied.',
    conflict: 'Both changed, to different values.',
    decide: decideScore
  },
  {
    rule: 7,
    field: 'rate.rewatches',
    source: 'rate cache and queued edits',
    clockDecides: false,
    canConflict: true,
    silent: 'A change on one side is applied. Both lowered to the same value: applied.',
    conflict:
      'Both changed to different values. Both rose, even to the same value (one rewatch or two?).',
    decide: decideRewatches
  },
  {
    rule: 8,
    field: 'starred',
    source: 'library membership',
    clockDecides: true,
    canConflict: false,
    silent:
      'A change on one side is applied. If both changed, the later at wins (tombstones included).',
    conflict: null,
    decide: decideMembership
  },
  {
    rule: 9,
    field: 'priority',
    source: 'priorityAnimeIds membership',
    clockDecides: true,
    canConflict: false,
    silent: 'Like starred. If the merged starred is false, priority becomes false.',
    conflict: null,
    decide: decideMembership
  },
  {
    rule: 10,
    field: 'priorityOrder',
    source: 'priorityAnimeIds order, filtered to in-scope ids',
    clockDecides: true,
    canConflict: false,
    silent:
      "If both changed, the order of the side with the later at; merged members missing from it are appended in the other side's relative order. Applying rewrites only the slots in-scope ids occupy.",
    conflict: null,
    decide: decidePriorityOrder
  },
  {
    rule: 11,
    field: 'dismissed',
    source: 'dismissedContinueWatching keys with an in-scope animeId: prefix',
    clockDecides: false,
    canConflict: false,
    silent: '(base ∪ addedA ∪ addedB) − removedA − removedB. A local prune is a removal.',
    conflict: null,
    decide: decideDismissed
  },
  {
    rule: 12,
    field: 'skip',
    source: 'skipDetections[animeId], without filePath',
    clockDecides: false,
    canConflict: false,
    silent:
      "A cache. Keep the local entry when its algorithm matches; otherwise the other side's when its file identity and algorithm match; otherwise none.",
    conflict: null,
    decide: decideSkip
  }
]
