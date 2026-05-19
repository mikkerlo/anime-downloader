import { describe, it, expect } from 'vitest'
import { consolidateQueue, type QueuedShikimoriUpdate } from '../../src/main/lib/shikimori-queue'

function mk(
  malId: number,
  queuedAt: number,
  episodes: number,
  rateId: number | null = null
): QueuedShikimoriUpdate {
  return {
    malId,
    rateId,
    before: { episodes: episodes - 1, status: 'watching', score: 0, rewatches: 0 },
    after: { episodes, status: 'watching', score: 0, rewatches: 0 },
    queuedAt
  }
}

describe('consolidateQueue', () => {
  it('returns one work item per malId, keeping the latest `after`', () => {
    const out = consolidateQueue([mk(1, 100, 3), mk(1, 200, 5), mk(2, 150, 1)])
    expect(out).toHaveLength(2)
    const a = out.find((w) => w.malId === 1)!
    expect(a.after.episodes).toBe(5)
    expect(a.consumedQueuedAts).toEqual([100, 200])
    const b = out.find((w) => w.malId === 2)!
    expect(b.after.episodes).toBe(1)
    expect(b.consumedQueuedAts).toEqual([150])
  })

  it('keeps an existing rateId when a later entry has none, and adopts one when it appears', () => {
    const withId = consolidateQueue([mk(1, 100, 3, 42), mk(1, 200, 5, null)])
    expect(withId[0].rateId).toBe(42)

    const adopt = consolidateQueue([mk(1, 100, 3, null), mk(1, 200, 5, 99)])
    expect(adopt[0].rateId).toBe(99)
  })

  it('preserves first-seen order of malIds', () => {
    const out = consolidateQueue([mk(7, 10, 1), mk(3, 20, 1), mk(7, 30, 2)])
    expect(out.map((w) => w.malId)).toEqual([7, 3])
  })

  it('returns an empty array for an empty queue', () => {
    expect(consolidateQueue([])).toEqual([])
  })
})
