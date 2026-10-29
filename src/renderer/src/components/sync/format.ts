// Value and choice wording for the review sheet (#585), matching the Shikimori
// panel: episodes "5 / 12", score stars, status labels.

const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  watching: 'Watching',
  rewatching: 'Rewatching',
  completed: 'Completed',
  on_hold: 'On Hold',
  dropped: 'Dropped'
}

export function fieldName(fieldPath: SyncConflictFieldPath): string {
  const w = /^watch\.(.+)\.watched$/.exec(fieldPath)
  if (w) return `Episode ${w[1]} watched`
  if (fieldPath === 'rate.episodes') return 'Episodes'
  if (fieldPath === 'rate.status') return 'Status'
  if (fieldPath === 'rate.score') return 'Score'
  return 'Rewatches'
}

export function conflictValue(
  fieldPath: SyncConflictFieldPath,
  value: unknown,
  totalEpisodes: number | null = null
): string {
  if (value === undefined || value === null) return '—'
  if (fieldPath.startsWith('watch.')) return value ? 'Watched' : 'Not watched'
  if (fieldPath === 'rate.episodes')
    return totalEpisodes ? `${value} / ${totalEpisodes}` : `${value}`
  if (fieldPath === 'rate.score') return Number(value) > 0 ? `★ ${value}` : 'No score'
  if (fieldPath === 'rate.status') return STATUS_LABEL[String(value)] ?? String(value)
  return String(value)
}

export function partyLabel(party: string, item: Pick<SyncConflictItem, 'libraries'>): string {
  if (party === 'local') return 'This PC'
  if (party === 'shikimori') return 'Shikimori'
  const id = party.startsWith('library:') ? party.slice(8) : party
  return item.libraries.find((l) => l.libraryId === id)?.name ?? 'Shared Library'
}

export function choiceKey(choice: SyncConflictChoice): string {
  if (choice.kind === 'party') return `party:${choice.party}`
  if (choice.kind === 'combine') return 'combine'
  return `rewatches:${choice.count}`
}

export function choiceLabel(choice: SyncConflictChoice, item: SyncConflictItem): string {
  if (choice.kind === 'party') {
    return choice.party === 'local'
      ? 'Keep mine'
      : `Keep theirs (${partyLabel(choice.party, item)})`
  }
  if (choice.kind === 'combine') return 'Combine'
  return choice.count === 1 ? 'One' : 'Two'
}

/** The suggestion's option (the newest `at`), if the row has one. */
export function suggestedChoice(item: SyncConflictItem): SyncConflictChoice | null {
  if (!item.suggestion || item.rewatchQuestion) return null
  const o = item.options.find(
    (x) => x.choice.kind === 'party' && x.choice.party === item.suggestion
  )
  return o ? o.choice : null
}
