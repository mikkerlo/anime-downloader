// The memoized 90-day watch index behind the anime-cache scope (#570).
// `isCachableAnime` runs on every cache write, so the index must not re-read
// (and so re-clone) `watchProgress` per lookup.
import { describe, it, expect, vi } from 'vitest'
import {
  createRecentWatchIndex,
  RECENT_WATCH_TTL_MS,
  RECENT_WATCH_WINDOW_MS
} from '../../src/main/lib/recent-watch'

const T0 = new Date('2026-10-28T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

function setup(progress: Record<string, { updatedAt: number }>): {
  index: ReturnType<typeof createRecentWatchIndex>
  reads: ReturnType<typeof vi.fn>
  clock: { now: number }
} {
  const clock = { now: T0 }
  const reads = vi.fn(() => progress)
  const index = createRecentWatchIndex({ readWatchProgress: reads, now: () => clock.now })
  return { index, reads, clock }
}

describe('createRecentWatchIndex', () => {
  it('1000 lookups read watchProgress once', () => {
    const { index, reads } = setup({ '5:1': { updatedAt: T0 - DAY } })
    for (let i = 0; i < 1000; i++) index.has(i % 7)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(index.has(5)).toBe(true)
  })

  it('takes the anime id from `<animeId>:<episodeInt>` keys', () => {
    const { index } = setup({
      '5:1': { updatedAt: T0 },
      '5:2': { updatedAt: T0 },
      '12:10.5': { updatedAt: T0 },
      garbage: { updatedAt: T0 },
      ':3': { updatedAt: T0 }
    })
    expect(index.has(5)).toBe(true)
    expect(index.has(12)).toBe(true)
    expect(index.has(3)).toBe(false)
  })

  it('excludes an entry older than 90 days', () => {
    const { index } = setup({
      '1:1': { updatedAt: T0 - RECENT_WATCH_WINDOW_MS - 1 },
      '2:1': { updatedAt: T0 - 89 * DAY }
    })
    expect(RECENT_WATCH_WINDOW_MS).toBe(90 * DAY)
    expect(index.has(1)).toBe(false)
    expect(index.has(2)).toBe(true)
  })

  it('touch makes a new id visible without a re-read', () => {
    const { index, reads } = setup({})
    expect(index.has(77)).toBe(false)
    index.touch(77)
    expect(index.has(77)).toBe(true)
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('touch before any lookup builds the index first, so it is not lost', () => {
    const { index, reads } = setup({ '1:1': { updatedAt: T0 } })
    index.touch(77)
    expect(index.has(77)).toBe(true)
    expect(index.has(1)).toBe(true)
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('rebuilds once after ttlMs, which ages entries out of the window', () => {
    const { index, reads, clock } = setup({ '1:1': { updatedAt: T0 - 90 * DAY + 60_000 } })
    expect(index.has(1)).toBe(true)
    clock.now = T0 + RECENT_WATCH_TTL_MS - 1
    expect(index.has(1)).toBe(true)
    expect(reads).toHaveBeenCalledTimes(1)

    clock.now = T0 + RECENT_WATCH_TTL_MS
    expect(index.has(1)).toBe(false)
    for (let i = 0; i < 100; i++) index.has(i)
    expect(reads).toHaveBeenCalledTimes(2)
    expect(RECENT_WATCH_TTL_MS).toBe(10 * 60 * 1000)
  })
})
