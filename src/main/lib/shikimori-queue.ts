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
}

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
