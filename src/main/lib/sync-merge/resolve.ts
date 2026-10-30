// The review sheet's choices for a held conflict (#585). Pure: which choices a
// record offers, and the value each one stands for.
//
// - Keep mine is this PC's value; Keep theirs is a library's or Shikimori's.
// - Combine exists only where a combination is defined: `rate.episodes` takes
//   the max, `watched` keeps the re-watch. Never for status, score or rewatches.
// - Both sides adding one rewatch from the same base (owner decision 6) asks
//   "one rewatch or two?": One is `base + 1`, Two is `base + 2`.

export type ConflictField = SyncRateField | 'watched'

export function fieldOf(fieldPath: SyncConflictFieldPath): ConflictField {
  return fieldPath.startsWith('rate.') ? (fieldPath.slice(5) as SyncRateField) : 'watched'
}

/** `watch.<ep>.watched` → `<ep>` (an opaque string, `"12.5"` included). */
export function episodeOf(fieldPath: SyncConflictFieldPath): string | null {
  const m = /^watch\.(.+)\.watched$/.exec(fieldPath)
  return m ? m[1] : null
}

const others = (rec: SyncConflictRecord): string[] =>
  Object.keys(rec.parties).filter((p) => p !== 'local')

/** The decision-6 base, when both sides added exactly one rewatch to it; otherwise null. */
export function rewatchQuestionBase(rec: SyncConflictRecord): number | null {
  if (rec.fieldPath !== 'rate.rewatches') return null
  const [party, ...rest] = others(rec)
  if (!party || rest.length > 0) return null
  const base = rec.bases[party]
  if (typeof base !== 'number') return null
  return rec.parties.local === base + 1 && rec.parties[party] === base + 1 ? base : null
}

function combineValue(rec: SyncConflictRecord): unknown {
  const field = fieldOf(rec.fieldPath)
  if (field === 'watched') return true
  if (field !== 'episodes') return undefined
  const values = Object.values(rec.parties).filter((v): v is number => typeof v === 'number')
  return values.length > 0 ? Math.max(...values) : undefined
}

export function conflictOptions(rec: SyncConflictRecord): SyncConflictOption[] {
  const base = rewatchQuestionBase(rec)
  if (base !== null) {
    return [
      { choice: { kind: 'rewatches', count: 1 }, value: base + 1 },
      { choice: { kind: 'rewatches', count: 2 }, value: base + 2 }
    ]
  }
  const out: SyncConflictOption[] = []
  if ('local' in rec.parties) {
    out.push({ choice: { kind: 'party', party: 'local' }, value: rec.parties.local })
  }
  for (const party of others(rec)) {
    out.push({ choice: { kind: 'party', party }, value: rec.parties[party] })
  }
  const combined = combineValue(rec)
  if (combined !== undefined) out.push({ choice: { kind: 'combine' }, value: combined })
  return out
}

/** The value `choice` stands for, or undefined when the record doesn't offer it. */
export function choiceValue(rec: SyncConflictRecord, choice: SyncConflictChoice): unknown {
  if (!choice || typeof choice !== 'object') return undefined
  if (choice.kind === 'party') {
    return typeof choice.party === 'string' && choice.party in rec.parties
      ? rec.parties[choice.party]
      : undefined
  }
  if (choice.kind === 'combine') return combineValue(rec)
  if (choice.kind === 'rewatches') {
    const base = rewatchQuestionBase(rec)
    return base !== null && (choice.count === 1 || choice.count === 2)
      ? base + choice.count
      : undefined
  }
  return undefined
}

/** A short name for a choice, for the log: `local`, `library:<id>`, `shikimori`, `combine`, `one`, `two`. */
export function choiceName(choice: SyncConflictChoice): string {
  if (choice.kind === 'party') return choice.party
  if (choice.kind === 'combine') return 'combine'
  return choice.count === 1 ? 'one' : 'two'
}
