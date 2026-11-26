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
  /**
   * Written only by #692's fan-out writer (`services/trackers/fan-out.ts`): a
   * mirror of a change made on another tracker, a reconcile winner (T10), or
   * a "Copy from primary" write. Never on a Shikimori-only queue's entries.
   */
  via?: QueueVia
}

export type QueueVia = 'mirror' | 'reconcile' | 'copy'

/**
 * Any tracker's queue entry (#691): the same shape, in that tracker's own
 * queue key, so an entry carries no tracker id.
 */
export type QueuedTrackerUpdate = QueuedShikimoriUpdate

export const SERVER_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000
export const SERVER_ERROR_GAP_MS = 60 * 60 * 1000

export interface ConsolidatedWorkItem extends QueuedShikimoriUpdate {
  consumedQueuedAts: number[]
}

const union = (a: SyncRateField[], b: SyncRateField[]): SyncRateField[] => [
  ...new Set([...a, ...b])
]

export const RATE_FIELDS: readonly SyncRateField[] = ['episodes', 'status', 'score', 'rewatches']

/**
 * The fields an entry or work item means to change: a scoped one's `fields`
 * and `resolvedFields`, otherwise every rate field. The drain reads an item's
 * through this, and #692's projection and revert read an entry's.
 */
export function intendedFields(
  entry: Pick<QueuedShikimoriUpdate, 'fields' | 'resolvedFields'>
): SyncRateField[] {
  if (!entry.fields) return [...RATE_FIELDS]
  return RATE_FIELDS.filter((f) => entry.fields!.includes(f) || entry.resolvedFields?.includes(f))
}

/**
 * One work item per MAL id and `via` value, placed at its first entry: a `via`
 * entry (#692) never consolidates with a non-`via` entry or with another `via`
 * value. The first entry's `before` is kept (a user's own sequence of offline
 * edits drifts against the rate it started from); `after` is the last.
 * `resolvedFields` is the union; `fields` is the union while every entry is
 * scoped, and unscoped (today's whole-rate policy) once any one isn't.
 * Provenance is kept per field, the last writer winning: on a via-free item a
 * later entry that changes a field's value without provenance for it clears
 * that field's provenance (#692 § 4).
 */
export function consolidateQueue(queue: QueuedShikimoriUpdate[]): ConsolidatedWorkItem[] {
  const map = new Map<string, ConsolidatedWorkItem>()
  for (const entry of queue) {
    const key = `${entry.malId}|${entry.via ?? ''}`
    const existing = map.get(key)
    if (existing) {
      if (!existing.via && existing.origin) {
        const provenance = { ...existing.origin.provenance }
        for (const f of Object.keys(provenance) as SyncRateField[]) {
          if (entry.after[f] !== existing.after[f] && !entry.origin?.provenance[f]) {
            delete provenance[f]
          }
        }
        if (Object.keys(provenance).length > 0) existing.origin = { kind: 'sync-merge', provenance }
        else delete existing.origin
      }
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
      map.set(key, {
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
  return stripSurvivors(stripProvenanceSlots(entries, libraryId))
}

/**
 * One queue entry through a strip: `entry` as queued, `next` what is left of
 * it (null when it was removed, `entry` itself when untouched), and the
 * fields the strip took from it. #692's revert/rebase helper reads these.
 */
export interface StripSlot {
  entry: QueuedShikimoriUpdate
  next: QueuedShikimoriUpdate | null
  stripped: SyncRateField[]
}

export function stripSurvivors(slots: readonly StripSlot[]): QueuedShikimoriUpdate[] {
  return slots.flatMap((s) => (s.next ? [s.next] : []))
}

/** `stripProvenance`, entry by entry, in queue order. */
export function stripProvenanceSlots(
  entries: QueuedShikimoriUpdate[],
  libraryId: string
): StripSlot[] {
  const out: StripSlot[] = []
  for (const entry of entries) {
    const prov = entry.origin?.provenance
    if (!prov) {
      out.push({ entry, next: entry, stripped: [] })
      continue
    }
    const stripped = (Object.keys(prov) as SyncRateField[]).filter((f) =>
      provenanceNames(prov[f], libraryId)
    )
    if (stripped.length === 0) {
      out.push({ entry, next: entry, stripped: [] })
      continue
    }
    const gone = new Set(stripped)
    const keep = (fs?: SyncRateField[]): SyncRateField[] | undefined =>
      fs?.filter((f) => !gone.has(f))
    const fields = keep(entry.fields)
    const resolvedFields = keep(entry.resolvedFields)
    if ((fields?.length ?? 0) + (resolvedFields?.length ?? 0) === 0) {
      out.push({ entry, next: null, stripped })
      continue
    }
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
    out.push({ entry, next, stripped })
  }
  return out
}

type RateRecord = Record<SyncRateField, number | string>

const valueOf = (v: QueuedShikimoriUpdate['before'], f: SyncRateField): number | string =>
  f === 'rewatches' ? (v.rewatches ?? 0) : v[f]

export interface RevertAndRebaseResult {
  /** The queue after the strip, every later `via` survivor rebased. */
  queue: QueuedShikimoriUpdate[]
  /** Per MAL id, the cache fields to write back: only those that differ from the cache. */
  reverts: Map<number, Partial<RateRecord>>
}

/**
 * #692 § 7's shared revert/rebase helper (`discardQueue`, and #716 § 5's
 * Forget mirror-cache step). `slots` is one queue through a strip, in queue
 * order; a slot with `stripped` fields is an (entry, stripped fields) pair,
 * and the survivors are the `next` entries. Pure.
 *
 * - **The cache revert**, for the pairs `revertCache` accepts and only with a
 *   `cache` reader. Per MAL id with a cached row, for each stripped field `f`,
 *   with `L` the last such pair that has `f`: (1) a survivor queued after `L`
 *   that has `f` leaves it alone; (2) so does a cache that no longer shows
 *   `L.after[f]`; (3) otherwise the target is the `after[f]` of the last
 *   survivor queued before `L` that has `f`, else the earliest such pair's
 *   `before[f]`. A survivor's fields are its `intendedFields`.
 * - **The rebase**, for every pair: for each stripped `f`, every surviving `via`
 *   entry queued after the earliest pair that has `f` gets `before[f]` set to
 *   the `after[f]` of the nearest survivor before it that has `f`, else that
 *   earliest pair's `before[f]`; one that doesn't have `f` gets `after[f]` too.
 *   A queue with no `via` entry is returned as it came.
 */
export function revertAndRebase(
  slots: readonly StripSlot[],
  opts: {
    cache?: (malId: number) => RateRecord | null
    revertCache?: (slot: StripSlot) => boolean
  } = {}
): RevertAndRebaseResult {
  const next = slots.map((s) => s.next)
  const reverts = new Map<number, Partial<RateRecord>>()
  const malIds = [...new Set(slots.filter((s) => s.stripped.length > 0).map((s) => s.entry.malId))]
  const has = (q: QueuedShikimoriUpdate | null, f: SyncRateField): boolean =>
    !!q && intendedFields(q).includes(f)

  for (const malId of malIds) {
    const idx = slots.flatMap((s, i) => (s.entry.malId === malId ? [i] : []))
    const strippedAt = (f: SyncRateField, filter: (s: StripSlot) => boolean = () => true) =>
      idx.filter((i) => slots[i].stripped.includes(f) && filter(slots[i]))

    const cached = opts.cache?.(malId) ?? null
    if (cached && opts.revertCache) {
      const out: Partial<RateRecord> = {}
      const fields = new Set(
        idx.flatMap((i) => (opts.revertCache!(slots[i]) ? slots[i].stripped : []))
      )
      for (const f of RATE_FIELDS.filter((g) => fields.has(g))) {
        const pairs = strippedAt(f, opts.revertCache)
        const L = pairs[pairs.length - 1]
        if (idx.some((i) => i > L && has(slots[i].next, f))) continue
        if (cached[f] !== valueOf(slots[L].entry.after, f)) continue
        const prior = idx.filter((i) => i < L && has(slots[i].next, f)).pop()
        const target =
          prior !== undefined
            ? valueOf(slots[prior].next!.after, f)
            : valueOf(slots[pairs[0]].entry.before, f)
        if (cached[f] !== target) out[f] = target
      }
      if (Object.keys(out).length > 0) reverts.set(malId, out)
    }

    const fields = new Set(idx.flatMap((i) => slots[i].stripped))
    for (const f of RATE_FIELDS.filter((g) => fields.has(g))) {
      const earliest = strippedAt(f)[0]
      for (const i of idx) {
        const q = next[i]
        if (i <= earliest || !q?.via) continue
        const prior = idx.filter((j) => j < i && has(next[j], f)).pop()
        const target =
          prior !== undefined
            ? valueOf(next[prior]!.after, f)
            : valueOf(slots[earliest].entry.before, f)
        const keepsAfter = has(q, f)
        if (valueOf(q.before, f) === target && (keepsAfter || valueOf(q.after, f) === target))
          continue
        const set = (v: QueuedShikimoriUpdate['before']) =>
          ({ ...v, [f]: target }) as QueuedShikimoriUpdate['before']
        next[i] = { ...q, before: set(q.before), after: keepsAfter ? q.after : set(q.after) }
      }
    }
  }
  return { queue: next.filter((q): q is QueuedShikimoriUpdate => q !== null), reverts }
}

/**
 * `${malId}:${field}` for every field a stripped non-`via` entry lost that a
 * surviving `via` entry queued after it carries (#692 § 6): Forget's owner
 * revert keeps those, because that entry's patch is the cache's newer value.
 */
export function keptByLaterVia(slots: readonly StripSlot[]): Set<string> {
  const out = new Set<string>()
  slots.forEach((s, i) => {
    if (s.entry.via) return
    for (const f of s.stripped) {
      const later = slots
        .slice(i + 1)
        .some(
          (t) =>
            t.entry.malId === s.entry.malId && !!t.next?.via && intendedFields(t.next).includes(f)
        )
      if (later) out.add(`${s.entry.malId}:${f}`)
    }
  })
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
  return stripSurvivors(stripFieldSlots(entries, malId, field))
}

/** `stripField`, entry by entry, in queue order (#692 review: Keep theirs rebases too). */
export function stripFieldSlots(
  entries: QueuedShikimoriUpdate[],
  malId: number,
  field: SyncRateField
): StripSlot[] {
  const out: StripSlot[] = []
  for (const entry of entries) {
    const scoped = !!entry.fields?.includes(field) || !!entry.resolvedFields?.includes(field)
    if (entry.malId !== malId || !entry.origin || !scoped) {
      out.push({ entry, next: entry, stripped: [] })
      continue
    }
    const keep = (fs?: SyncRateField[]): SyncRateField[] | undefined =>
      fs?.filter((f) => f !== field)
    const fields = keep(entry.fields)
    const resolvedFields = keep(entry.resolvedFields)
    if ((fields?.length ?? 0) + (resolvedFields?.length ?? 0) === 0) {
      out.push({ entry, next: null, stripped: [field] })
      continue
    }
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
    out.push({ entry, next, stripped: [field] })
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

/**
 * Whether `q` is one of the entries a work item consumed: its `malId`, one of
 * its `queuedAt`s, and its `via` (#692 § 4), so two items for one title that
 * share a `queuedAt` across `via` values never consume each other's entries.
 */
export function isConsumedEntry(
  q: QueuedShikimoriUpdate,
  malId: number,
  consumed: ReadonlySet<number>,
  via: QueueVia | undefined
): boolean {
  return q.malId === malId && consumed.has(q.queuedAt) && q.via === via
}

export function dropFromParked(
  parked: ParkedQueues,
  ownerId: string,
  malId: number,
  consumedQueuedAts: number[],
  via?: QueueVia
): ParkedQueues {
  const bucket = parked[ownerId]
  if (!bucket) return parked
  const consumed = new Set(consumedQueuedAts)
  const entries = bucket.entries.filter((q) => !isConsumedEntry(q, malId, consumed, via))
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
  now: number,
  via?: QueueVia
): { entries: QueuedShikimoriUpdate[]; expired: boolean } {
  const consumed = new Set(consumedQueuedAts)
  let newest = -1
  entries.forEach((q, i) => {
    if (!isConsumedEntry(q, malId, consumed, via)) return
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
  now: number,
  via?: QueueVia
): { parked: ParkedQueues; expired: boolean } {
  const bucket = parked[ownerId]
  if (!bucket) return { parked, expired: false }
  const { entries, expired } = recordServerError(bucket.entries, malId, consumedQueuedAts, now, via)
  if (entries === bucket.entries) return { parked, expired }
  return { parked: { ...parked, [ownerId]: { ...bucket, entries } }, expired }
}
