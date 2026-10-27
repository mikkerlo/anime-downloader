import { describe, it, expect } from 'vitest'
import {
  consolidateQueue,
  dropFromParked,
  mergeQueues,
  parkEntries,
  takeParked,
  type ParkedQueues,
  type QueuedShikimoriUpdate
} from '../../src/main/lib/shikimori-queue'

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

describe('parked queues (#588)', () => {
  const A = { id: '7', nickname: 'alice' }

  it('mergeQueues keeps queuedAt order, so consolidateQueue takes the latest `after` across a merge', () => {
    const live = [mk(1, 300, 9)]
    const parked = [mk(1, 100, 3), mk(1, 200, 5)]
    const merged = mergeQueues(live, parked)
    expect(merged.map((e) => e.queuedAt)).toEqual([100, 200, 300])
    expect(consolidateQueue(merged)[0].after.episodes).toBe(9)
  })

  it('parkEntries appends to an existing bucket and refreshes the nickname', () => {
    const first = parkEntries({}, A, [mk(1, 100, 3)], 1000)
    const second = parkEntries(first, { id: '7', nickname: 'alice2' }, [mk(2, 50, 1)], 2000)
    expect(second['7']).toEqual({
      nickname: 'alice2',
      entries: [mk(2, 50, 1), mk(1, 100, 3)],
      parkedAt: 2000
    })
  })

  it('parkEntries creates no bucket for empty input', () => {
    const parked: ParkedQueues = {}
    expect(parkEntries(parked, A, [], 1000)).toBe(parked)
    expect(parkEntries(parked, A, [], 1000)).toEqual({})
  })

  it('round-trips fields this slice does not know about through park, take and merge', () => {
    const entry = {
      ...mk(1, 100, 3),
      fields: ['episodes'],
      resolvedFields: { episodes: 3 },
      origin: 'library',
      somethingElse: { nested: true }
    } as unknown as QueuedShikimoriUpdate
    const original = structuredClone(entry)
    const parked = parkEntries({}, A, [entry], 1000)
    const taken = takeParked(parked, '7')
    const merged = mergeQueues([], taken.entries)
    expect(merged).toEqual([original])
  })

  it('takeParked returns the bucket and leaves the other owners alone', () => {
    const parked = parkEntries(
      parkEntries({}, A, [mk(1, 100, 3)], 1000),
      { id: '8', nickname: 'bob' },
      [mk(2, 200, 1)],
      1000
    )
    const { entries, parked: rest } = takeParked(parked, '7')
    expect(entries).toEqual([mk(1, 100, 3)])
    expect(Object.keys(rest)).toEqual(['8'])
    expect(rest['8'].entries).toEqual([mk(2, 200, 1)])
    expect(takeParked(rest, '7')).toEqual({ entries: [], parked: rest })
  })

  it('dropFromParked removes consumed entries and deletes the bucket when it empties', () => {
    const parked = parkEntries({}, A, [mk(1, 100, 3), mk(1, 200, 4), mk(2, 150, 1)], 1000)
    const afterOne = dropFromParked(parked, '7', 1, [100, 200])
    expect(afterOne['7'].entries).toEqual([mk(2, 150, 1)])
    expect(dropFromParked(afterOne, '7', 2, [150])).toEqual({})
  })

  it('dropFromParked creates no bucket for a missing owner', () => {
    const parked = parkEntries({}, A, [mk(1, 100, 3)], 1000)
    expect(dropFromParked(parked, '8', 1, [100])).toBe(parked)
    expect(dropFromParked({}, '8', 1, [100])).toEqual({})
  })
})
