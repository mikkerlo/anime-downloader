// The 3-way merge engine (#584 §1). `merge3(base | null, a, b, fieldTable, opts)`
// over S4 (#572)'s `SyncDoc` v1, applying the frozen field table (rules 1–12)
// as written. Side A is this PC; side B the library or Shikimori. Pure: no
// store, no `fs`, no clock but `opts.now`.
//
// - "Changed" is a value difference from the base; clocks only break ties. A
//   re-watch's `watched` clock is the one clock-only change carried (#645).
// - Clocks more than 120 s in the future are clamped to `now` on input, and
//   each clamp is reported. An in-scope library `watched` clamp is written
//   back clamped. File mtimes are never a clock.
// - A conflict leaves the field as it was on both sides, and the base for that
//   field doesn't advance, so the conflict surfaces again until resolved.
// - Only titles in `opts.scope` take part; the result docs hold only those.
// - With no base (`null`) every rule degrades to §1's first-merge table.

import { clampSyncDoc } from '../sync-state/clock'
import {
  FIELD_TABLE,
  type Decision,
  type FieldRule,
  type SkipContext
} from '../sync-state/field-table'
import { KNOWN_DOC_FIELDS } from '../sync-state/project'
import { normalizeDoc } from './no-base'
import { mergeTitle, ruleFn, type FieldConflict, type MergeAcc, type MergeLogEntry } from './rules'

export type { FieldConflict, MergeLogEntry } from './rules'

const WATCHED_CLOCK = /^titles\.([^.]+)\.watch\..+\.watched$/

export interface Merge3Options {
  now: number
  /** The in-scope animeIds. Titles outside it are never read or returned. */
  scope: Iterable<string | number>
  /** Rule 12's context for a title; without it `skip` is left as each side has it. */
  skip?: (animeId: string) => SkipContext
  /** Merge `priorityOrder` (rule 10). Off for a single-title run. Default on. */
  order?: boolean
}

export interface Merge3Result {
  /** Side A after the merge: what this PC applies (conflicted fields keep A's value). */
  result: SyncDoc
  /** Side B after the merge: what the library is written with (conflicted fields keep B's). */
  remote: SyncDoc
  /** The next base: merged fields, and the old base's value for every conflicted field. */
  nextBase: SyncDoc
  /** Field paths whose value changes on A / on B. */
  changesA: string[]
  changesB: string[]
  conflicts: FieldConflict[]
  log: MergeLogEntry[]
  clamped: (SyncClampReport & { side: 'a' | 'b' })[]
}

export function merge3(
  baseIn: SyncDoc | null,
  aIn: SyncDoc,
  bIn: SyncDoc,
  table: readonly FieldRule[] = FIELD_TABLE,
  opts: Merge3Options
): Merge3Result {
  const ca = clampSyncDoc(normalizeDoc(aIn), opts.now)
  const cb = clampSyncDoc(normalizeDoc(bIn), opts.now)
  const a = ca.doc
  const b = cb.doc
  const base = baseIn ? normalizeDoc(baseIn) : null
  const acc: MergeAcc = { changesA: [], changesB: [], conflicts: [], log: [] }
  const ids = [...new Set([...opts.scope].map(String))].sort()

  const docOf = (src: SyncDoc, installId: string): SyncDoc => ({
    stateVersion: 1,
    stateMinor: src.stateMinor,
    installId,
    titles: {},
    priorityOrder: src.priorityOrder,
    tombstones: {}
  })
  // The library's plain unknown doc-level keys go to both sides (S5's plain-key carry).
  const unknownDoc = Object.fromEntries(Object.entries(b).filter(([k]) => !KNOWN_DOC_FIELDS.has(k)))
  const result: SyncDoc = { ...unknownDoc, ...docOf(a, a.installId) }
  const remote: SyncDoc = { ...unknownDoc, ...docOf(b, a.installId) }
  const nextBase: SyncDoc = docOf(base ?? a, a.installId)

  for (const id of ids) {
    const t = mergeTitle(table, id, { base, a, b }, opts.skip?.(id), acc)
    const put = (doc: SyncDoc, title: SyncTitleState, stones: SyncDoc['tombstones'][string]) => {
      if (Object.keys(title).length > 0) doc.titles[id] = title
      if (stones.starred || stones.priority) doc.tombstones[id] = stones
    }
    put(result, t.a, t.stones.a)
    put(remote, t.b, t.stones.b)
    put(nextBase, t.base, t.stones.base)
  }

  // A clamped drive `watched` clock is written back clamped (#645), or every
  // later merge would read the re-clamped clock as a new re-watch. In-scope
  // titles only: the runner writes the others back exactly as the drive has them.
  const inScope = new Set(ids)
  const conflicted = new Set(acc.conflicts.map((c) => `titles.${c.animeId}.${c.fieldPath}`))
  for (const c of cb.clamped) {
    const w = WATCHED_CLOCK.exec(c.path)
    if (!w || !inScope.has(w[1]) || conflicted.has(c.path) || acc.changesB.includes(c.path))
      continue
    acc.changesB.push(c.path)
  }

  if (opts.order !== false) {
    // Rule 10, over the merged priority membership of in-scope ids.
    const decideOrder = ruleFn<
      (
        base: SyncField<string[]> | undefined,
        a: SyncField<string[]>,
        b: SyncField<string[]>,
        ctx: { members: readonly string[] }
      ) => Decision<SyncField<string[]>>
    >(table, 10)
    const scoped = (o: SyncField<string[]>): SyncField<string[]> => ({
      ...o,
      value: o.value.filter((id) => inScope.has(id))
    })
    const baseOrder =
      base && Number.isFinite(base.priorityOrder.at) ? scoped(base.priorityOrder) : undefined
    const aOrder = scoped(a.priorityOrder)
    // A side with no order of its own has no view of it.
    const bOrder = Number.isFinite(b.priorityOrder.at)
      ? scoped(b.priorityOrder)
      : (baseOrder ?? aOrder)
    const members = ids.filter((id) => !!result.titles[id]?.priority)
    const d = decideOrder(baseOrder, aOrder, bOrder, { members })
    if (d.kind === 'merge' || d.kind === 'take') {
      const v = d.value
      result.priorityOrder = v
      remote.priorityOrder = v
      nextBase.priorityOrder = v
      if (JSON.stringify(v.value) !== JSON.stringify(aOrder.value))
        acc.changesA.push('priorityOrder')
      if (JSON.stringify(v.value) !== JSON.stringify(bOrder.value))
        acc.changesB.push('priorityOrder')
      acc.log.push({ path: 'priorityOrder', kind: 'merge' })
    } else {
      result.priorityOrder = aOrder
      remote.priorityOrder = Number.isFinite(b.priorityOrder.at) ? bOrder : aOrder
      nextBase.priorityOrder = baseOrder ?? aOrder
    }
  } else {
    result.priorityOrder = a.priorityOrder
    remote.priorityOrder = Number.isFinite(b.priorityOrder.at) ? b.priorityOrder : a.priorityOrder
    nextBase.priorityOrder = base?.priorityOrder ?? a.priorityOrder
  }

  return {
    result,
    remote,
    nextBase,
    changesA: acc.changesA,
    changesB: acc.changesB,
    conflicts: acc.conflicts,
    log: acc.log,
    clamped: [
      ...ca.clamped.map((c) => ({ ...c, side: 'a' as const })),
      ...cb.clamped.map((c) => ({ ...c, side: 'b' as const }))
    ]
  }
}
