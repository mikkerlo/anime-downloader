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
