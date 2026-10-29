// The rollback check (#584 §2, library leg step 2). A drive whose
// `state.generation` is lower than the base's `stateGeneration` is an older
// replica (a hand-copied one, say). Each replica field is compared with the
// base's clock for that same field: a value whose `at` is not newer predates
// the base and counts as the base's value (unchanged), so an old copy's lower
// values are not a lowering everywhere; a newer `at` (an edit on the replica
// after the copy) is still a change. `dismissed` has no clock and takes the
// base's value whenever the generation is lower. Pure.

import { RATE_FIELDS } from '../sync-state/project'

export function isRollback(stateGeneration: number | null, baseGeneration: number | null): boolean {
  return stateGeneration !== null && baseGeneration !== null && stateGeneration < baseGeneration
}

function older<T>(
  replica: SyncField<T> | undefined,
  base: SyncField<T> | undefined
): SyncField<T> | undefined {
  if (!replica || !base) return replica
  return replica.at <= base.at ? base : replica
}

function olderStone(
  replica: SyncTombstone | undefined,
  base: SyncTombstone | undefined
): SyncTombstone | undefined {
  if (!replica || !base) return replica
  return replica.at <= base.at ? base : replica
}

/** `replica` with every field that predates the base's clock for it replaced by the base's. */
export function rollbackAdjust(
  replica: SyncDoc,
  base: SyncDoc
): { doc: SyncDoc; replaced: string[] } {
  const doc = structuredClone(replica)
  const replaced: string[] = []
  const note = <T>(path: string, before: T, after: T): T => {
    if (before !== after) replaced.push(path)
    return after
  }
  for (const [id, title] of Object.entries(doc.titles)) {
    const b = base.titles[id]
    if (!b) continue
    for (const [ep, entry] of Object.entries(title.watch ?? {})) {
      const be = b.watch?.[ep]
      if (!be) continue
      entry.position = note(
        `titles.${id}.watch.${ep}.position`,
        entry.position,
        older(entry.position, be.position)!
      )
      const watched = older(entry.watched, be.watched)!
      if (watched !== entry.watched) {
        entry.watched = note(`titles.${id}.watch.${ep}.watched`, entry.watched, watched)
        entry.watchedAt = be.watchedAt
      }
    }
    for (const f of ['starred', 'priority'] as const) {
      if (title[f] && b[f]) title[f] = note(`titles.${id}.${f}`, title[f], older(title[f], b[f]))
    }
    if (title.rate && b.rate) {
      for (const f of RATE_FIELDS) {
        const next = older(title.rate[f] as SyncField<unknown>, b.rate[f] as SyncField<unknown>)
        ;(title.rate as unknown as Record<string, unknown>)[f] = note(
          `titles.${id}.rate.${f}`,
          title.rate[f],
          next
        )
      }
    }
    if (b.dismissed !== undefined || title.dismissed !== undefined) {
      const next = b.dismissed
      if (JSON.stringify(next ?? []) !== JSON.stringify(title.dismissed ?? [])) {
        replaced.push(`titles.${id}.dismissed`)
      }
      if (next) title.dismissed = [...next]
      else delete title.dismissed
    }
  }
  for (const [id, stones] of Object.entries(doc.tombstones)) {
    const b = base.tombstones[id]
    if (!b) continue
    for (const f of ['starred', 'priority'] as const) {
      if (stones[f] && b[f])
        stones[f] = note(`tombstones.${id}.${f}`, stones[f], olderStone(stones[f], b[f]))
    }
  }
  if (Number.isFinite(base.priorityOrder.at)) {
    doc.priorityOrder = note(
      'priorityOrder',
      doc.priorityOrder,
      older(doc.priorityOrder, base.priorityOrder)!
    )
  }
  return { doc, replaced }
}
