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
}

export const SERVER_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000
export const SERVER_ERROR_GAP_MS = 60 * 60 * 1000

export interface ConsolidatedWorkItem extends QueuedShikimoriUpdate {
  consumedQueuedAts: number[]
}

export function consolidateQueue(queue: QueuedShikimoriUpdate[]): ConsolidatedWorkItem[] {
  const map = new Map<number, ConsolidatedWorkItem>()
  for (const entry of queue) {
    const existing = map.get(entry.malId)
    if (existing) {
      existing.after = entry.after
      existing.rateId = entry.rateId ?? existing.rateId
      existing.consumedQueuedAts.push(entry.queuedAt)
    } else {
      map.set(entry.malId, { ...entry, consumedQueuedAts: [entry.queuedAt] })
    }
  }
  return Array.from(map.values())
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
