import type * as shikimori from '../shikimori'

export interface QueuedShikimoriUpdate {
  malId: number
  rateId: number | null
  before: {
    episodes: number
    status: shikimori.ShikiUserRateStatus
    score: number
    rewatches: number
  }
  after: {
    episodes: number
    status: shikimori.ShikiUserRateStatus
    score: number
    rewatches: number
  }
  queuedAt: number
  firstServerErrorAt?: number
  lastServerErrorAt?: number
  /**
   * A field-scoped entry (the Shared Library merge, #584): the fields it means
   * to change. On drift the drain writes `after[f]` only where the server still
   * has `before[f]`, and keeps every other field at the server's value. Absent
   * on a user's own edit, which keeps the whole-rate drift policy.
   */
  fields?: SyncRateField[]
  /** S10 (#585)'s explicit resolutions: `after[f]` is written for these whatever the server has. */
  resolvedFields?: SyncRateField[]
  /** Where each field's value came from, so Forget (#584) can strip a library's fields. */
  origin?: { kind: 'sync-merge'; provenance: Partial<Record<SyncRateField, SyncProvenance>> }
}

export const SERVER_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000
export const SERVER_ERROR_GAP_MS = 60 * 60 * 1000

export interface ConsolidatedWorkItem extends QueuedShikimoriUpdate {
  consumedQueuedAts: number[]
}

const union = (a: SyncRateField[], b: SyncRateField[]): SyncRateField[] => [
  ...new Set([...a, ...b])
]

/**
 * One work item per MAL id. The first entry's `before` is kept (a user's own
 * sequence of offline edits drifts against the rate it started from); `after`
 * is the last. `resolvedFields` is the union; `fields` is the union while every
 * entry is scoped, and unscoped (today's whole-rate policy) once any one isn't.
 * Provenance is kept per field, the last writer winning.
 */
export function consolidateQueue(queue: QueuedShikimoriUpdate[]): ConsolidatedWorkItem[] {
  const map = new Map<number, ConsolidatedWorkItem>()
  for (const entry of queue) {
    const existing = map.get(entry.malId)
    if (existing) {
      existing.after = entry.after
      existing.rateId = entry.rateId ?? existing.rateId
      existing.consumedQueuedAts.push(entry.queuedAt)
      if (existing.fields && entry.fields) existing.fields = union(existing.fields, entry.fields)
      else delete existing.fields
      if (entry.resolvedFields) {
        existing.resolvedFields = union(existing.resolvedFields ?? [], entry.resolvedFields)
      }
      if (entry.origin) {
        existing.origin = {
          kind: 'sync-merge',
          provenance: { ...existing.origin?.provenance, ...entry.origin.provenance }
        }
      }
    } else {
      map.set(entry.malId, {
        ...entry,
        ...(entry.fields ? { fields: [...entry.fields] } : {}),
        ...(entry.resolvedFields ? { resolvedFields: [...entry.resolvedFields] } : {}),
        ...(entry.origin
          ? { origin: { kind: 'sync-merge', provenance: { ...entry.origin.provenance } } }
          : {}),
        consumedQueuedAts: [entry.queuedAt]
      })
    }
  }
  return Array.from(map.values())
}

/** Whether `p` names `libraryId`: its own `{ libraryId }`, or a resolution it was a party to. */
export function provenanceNames(p: SyncProvenance | undefined, libraryId: string): boolean {
  if (!p) return false
  if ('libraryId' in p) return p.libraryId === libraryId
  return p.libraryIds.includes(libraryId)
}

/**
 * `entries` without the fields whose provenance names `libraryId` (Forget,
 * #584). An entry left with no field is removed; user entries (no `origin`)
 * are never touched. A stripped field goes back to the entry's `before` and
 * leaves `fields` / `resolvedFields`, so the drain never sends it.
 */
export function stripProvenance(
  entries: QueuedShikimoriUpdate[],
  libraryId: string
): QueuedShikimoriUpdate[] {
  const out: QueuedShikimoriUpdate[] = []
  for (const entry of entries) {
    const prov = entry.origin?.provenance
    if (!prov) {
      out.push(entry)
      continue
    }
    const stripped = (Object.keys(prov) as SyncRateField[]).filter((f) =>
      provenanceNames(prov[f], libraryId)
    )
    if (stripped.length === 0) {
      out.push(entry)
      continue
    }
    const gone = new Set(stripped)
    const keep = (fs?: SyncRateField[]): SyncRateField[] | undefined =>
      fs?.filter((f) => !gone.has(f))
    const fields = keep(entry.fields)
    const resolvedFields = keep(entry.resolvedFields)
    if ((fields?.length ?? 0) + (resolvedFields?.length ?? 0) === 0) continue
    const after = { ...entry.after }
    for (const f of stripped) (after as Record<string, unknown>)[f] = entry.before[f]
    const keptProv = Object.fromEntries(
      Object.entries(prov).filter(([f]) => !gone.has(f as SyncRateField))
    )
    const next: QueuedShikimoriUpdate = { ...entry, after }
    // Kept even when empty: an emptied `fields` still scopes the entry.
    if (fields) next.fields = fields
    if (resolvedFields) next.resolvedFields = resolvedFields
    if (Object.keys(keptProv).length > 0) next.origin = { kind: 'sync-merge', provenance: keptProv }
    else delete next.origin
    out.push(next)
  }
  return out
}

/**
 * `entries` without `field` of `malId` in merge entries (S10 #585's Keep theirs
 * (Shikimori): nothing may push the pending value back). Stripped like
 * `stripProvenance`; user entries (no `origin`) are never touched.
 */
export function stripField(
  entries: QueuedShikimoriUpdate[],
  malId: number,
  field: SyncRateField
): QueuedShikimoriUpdate[] {
  const out: QueuedShikimoriUpdate[] = []
  for (const entry of entries) {
    const scoped = !!entry.fields?.includes(field) || !!entry.resolvedFields?.includes(field)
    if (entry.malId !== malId || !entry.origin || !scoped) {
      out.push(entry)
      continue
    }
    const keep = (fs?: SyncRateField[]): SyncRateField[] | undefined =>
      fs?.filter((f) => f !== field)
    const fields = keep(entry.fields)
    const resolvedFields = keep(entry.resolvedFields)
    if ((fields?.length ?? 0) + (resolvedFields?.length ?? 0) === 0) continue
    const next: QueuedShikimoriUpdate = {
      ...entry,
      after: { ...entry.after, [field]: entry.before[field] }
    }
    if (fields) next.fields = fields
    if (resolvedFields) next.resolvedFields = resolvedFields
    const prov = Object.fromEntries(
      Object.entries(entry.origin.provenance).filter(([f]) => f !== field)
    )
    if (Object.keys(prov).length > 0) next.origin = { kind: 'sync-merge', provenance: prov }
    else delete next.origin
    out.push(next)
  }
  return out
}

export interface ParkedQueue {
  nickname: string
  entries: QueuedShikimoriUpdate[]
  parkedAt: number
}

export type ParkedQueues = Record<string, ParkedQueue>

export const UNKNOWN_OWNER = 'unknown'

export function mergeQueues(
  a: QueuedShikimoriUpdate[],
  b: QueuedShikimoriUpdate[]
): QueuedShikimoriUpdate[] {
  return [...a, ...b].sort((x, y) => x.queuedAt - y.queuedAt)
}

export function parkEntries(
  parked: ParkedQueues,
  owner: { id: string; nickname: string },
  entries: QueuedShikimoriUpdate[],
  now: number
): ParkedQueues {
  if (entries.length === 0) return parked
  const existing = parked[owner.id]
  return {
    ...parked,
    [owner.id]: {
      nickname: owner.nickname,
      entries: mergeQueues(existing?.entries ?? [], entries),
      parkedAt: now
    }
  }
}

export function takeParked(
  parked: ParkedQueues,
  ownerId: string
): { entries: QueuedShikimoriUpdate[]; parked: ParkedQueues } {
  const bucket = parked[ownerId]
  if (!bucket) return { entries: [], parked }
  const rest = { ...parked }
  delete rest[ownerId]
  return { entries: bucket.entries, parked: rest }
}

export function dropFromParked(
  parked: ParkedQueues,
  ownerId: string,
  malId: number,
  consumedQueuedAts: number[]
): ParkedQueues {
  const bucket = parked[ownerId]
  if (!bucket) return parked
  const consumed = new Set(consumedQueuedAts)
  const entries = bucket.entries.filter((q) => !(q.malId === malId && consumed.has(q.queuedAt)))
  if (entries.length === 0) return takeParked(parked, ownerId).parked
  return { ...parked, [ownerId]: { ...bucket, entries } }
}

// The clock lives on the newest consumed entry, so a fresh edit gets a full
// window. A gap longer than SERVER_ERROR_GAP_MS since the last 5xx (app
// closed, offline, signed out) restarts it, so only a continuous run of failed
// attempts can expire an edit (#599).
export function recordServerError(
  entries: QueuedShikimoriUpdate[],
  malId: number,
  consumedQueuedAts: number[],
  now: number
): { entries: QueuedShikimoriUpdate[]; expired: boolean } {
  const consumed = new Set(consumedQueuedAts)
  let newest = -1
  entries.forEach((q, i) => {
    if (q.malId !== malId || !consumed.has(q.queuedAt)) return
    if (newest === -1 || q.queuedAt > entries[newest].queuedAt) newest = i
  })
  if (newest === -1) return { entries, expired: false }
  const entry = entries[newest]
  const first = entry.firstServerErrorAt
  const last = entry.lastServerErrorAt
  const continuing = first !== undefined && last !== undefined && now - last <= SERVER_ERROR_GAP_MS
  if (continuing && now - first >= SERVER_ERROR_WINDOW_MS) return { entries, expired: true }
  const stamped: QueuedShikimoriUpdate = {
    ...entry,
    firstServerErrorAt: continuing ? first : now,
    lastServerErrorAt: now
  }
  return { entries: entries.map((q, i) => (i === newest ? stamped : q)), expired: false }
}

export function recordServerErrorInParked(
  parked: ParkedQueues,
  ownerId: string,
  malId: number,
  consumedQueuedAts: number[],
  now: number
): { parked: ParkedQueues; expired: boolean } {
  const bucket = parked[ownerId]
  if (!bucket) return { parked, expired: false }
  const { entries, expired } = recordServerError(bucket.entries, malId, consumedQueuedAts, now)
  if (entries === bucket.entries) return { parked, expired }
  return { parked: { ...parked, [ownerId]: { ...bucket, entries } }, expired }
}
