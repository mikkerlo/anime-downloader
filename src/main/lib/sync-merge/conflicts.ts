// Held conflicts (#584 §5): identity, dedupe across legs and runs, and
// convergence. Pure; `services/sync-runner/conflicts.ts` persists the list.
//
// - Identity is `(ownerScope, animeId, fieldPath)`; one record per identity.
// - A leg raising the same field merges into the record (the library leg and
//   the Shikimori leg give one record with three parties).
// - A later run updates the record in place (values, `lastSeenRunId`), keeping
//   `firstSeenRunId`.
// - A leg that no longer finds the conflict drops its party; a record left
//   with no non-local party is removed ("resolved elsewhere").

export interface LegConflict {
  animeId: string
  fieldPath: SyncConflictFieldPath
  reason: string
  local: unknown
  party: unknown
  base: unknown
  atLocal?: SyncClock
  atParty?: SyncClock
  noSuggestion?: boolean
}

export interface LegReport {
  ownerScope: number
  /** `library:<id>` or `shikimori`. */
  party: string
  /** Whether a record's title took part in this leg (out-of-scope records are left alone). */
  inScope(animeId: string): boolean
  conflicts: LegConflict[]
  runId: string
}

export const identityOf = (
  r: Pick<SyncConflictRecord, 'ownerScope' | 'animeId' | 'fieldPath'>
): string => `${r.ownerScope}|${r.animeId}|${r.fieldPath}`

/** The party with the newest `at`, or null when the newest is shared or none has one. */
export function suggestionOf(at: Record<string, SyncClock>): string | null {
  let best: string | null = null
  let bestAt = Number.NEGATIVE_INFINITY
  let tie = false
  for (const [party, clock] of Object.entries(at)) {
    if (!Number.isFinite(clock?.at)) continue
    if (clock.at > bestAt) {
      best = party
      bestAt = clock.at
      tie = false
    } else if (clock.at === bestAt) tie = true
  }
  return tie ? null : best
}

/**
 * The records after one leg: this leg's conflicts upserted, and this leg's
 * party dropped from every in-scope record it no longer conflicts on.
 * `removed` are the records that converged.
 */
export function reconcileLeg(
  records: SyncConflictRecord[],
  leg: LegReport,
  makeId: () => string
): {
  records: SyncConflictRecord[]
  removed: SyncConflictRecord[]
  upserted: SyncConflictRecord[]
} {
  const byId = new Map(records.map((r) => [identityOf(r), structuredClone(r)]))
  const seen = new Set<string>()
  const upserted: SyncConflictRecord[] = []
  for (const c of leg.conflicts) {
    const key = identityOf({
      ownerScope: leg.ownerScope,
      animeId: c.animeId,
      fieldPath: c.fieldPath
    })
    seen.add(key)
    const rec: SyncConflictRecord = byId.get(key) ?? {
      id: makeId(),
      ownerScope: leg.ownerScope,
      animeId: c.animeId,
      fieldPath: c.fieldPath,
      parties: {},
      bases: {},
      at: {},
      suggestion: null,
      reason: c.reason,
      firstSeenRunId: leg.runId,
      lastSeenRunId: leg.runId
    }
    rec.parties.local = c.local
    rec.parties[leg.party] = c.party
    rec.bases[leg.party] = c.base
    if (c.atLocal) rec.at.local = c.atLocal
    else delete rec.at.local
    if (c.atParty) rec.at[leg.party] = c.atParty
    else delete rec.at[leg.party]
    rec.reason = c.reason
    rec.lastSeenRunId = leg.runId
    rec.suggestion = c.noSuggestion ? null : suggestionOf(rec.at)
    byId.set(key, rec)
    upserted.push(rec)
  }
  const removed: SyncConflictRecord[] = []
  for (const [key, rec] of byId) {
    if (seen.has(key) || rec.ownerScope !== leg.ownerScope || !(leg.party in rec.parties)) continue
    if (!leg.inScope(rec.animeId)) continue
    delete rec.parties[leg.party]
    delete rec.bases[leg.party]
    delete rec.at[leg.party]
    if (Object.keys(rec.parties).every((p) => p === 'local')) {
      byId.delete(key)
      removed.push(rec)
    } else {
      rec.suggestion = suggestionOf(rec.at)
    }
  }
  return { records: [...byId.values()], removed, upserted }
}

/** Forget (#584 §4 step 4): records whose only non-local party is this library go; others lose it. */
export function dropLibraryParty(
  records: SyncConflictRecord[],
  libraryId: string
): SyncConflictRecord[] {
  const party = `library:${libraryId}`
  const out: SyncConflictRecord[] = []
  for (const r of records) {
    if (!(party in r.parties)) {
      out.push(r)
      continue
    }
    const next = structuredClone(r)
    delete next.parties[party]
    delete next.bases[party]
    delete next.at[party]
    if (Object.keys(next.parties).some((p) => p !== 'local')) {
      next.suggestion = suggestionOf(next.at)
      out.push(next)
    }
  }
  return out
}
