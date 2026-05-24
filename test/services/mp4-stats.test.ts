import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'

let probeMock: ReturnType<typeof vi.fn>

vi.mock('../../src/main/mp4-faststart', () => ({
  probeMp4Faststart: (...args: unknown[]) => probeMock(...args)
}))

import { createMp4StatsService, type Mp4StatsService } from '../../src/main/services/mp4-stats'

function emptyStats(): {
  totalChecked: number
  faststartCount: number
  nonFaststartSamples: unknown[]
} {
  return { totalChecked: 0, faststartCount: 0, nonFaststartSamples: [] }
}

const CTX = {
  animeId: 1,
  animeName: 'Show',
  episodeInt: '01',
  episodeLabel: 'Episode 01'
}

describe('Mp4StatsService', () => {
  let store: InMemoryStorage
  let svc: Mp4StatsService

  beforeEach(() => {
    probeMock = vi.fn()
    store = new InMemoryStorage({ mp4StreamingStats: emptyStats() })
    svc = createMp4StatsService({ store })
  })

  it('skips probing when probeMp4Faststart returns null', async () => {
    probeMock.mockResolvedValue(null)
    await svc.recordCheck('/a.mp4', CTX)
    expect(svc.getStats()).toEqual(emptyStats())
  })

  it('counts a faststart MP4 as faststartCount + totalChecked', async () => {
    probeMock.mockResolvedValue({ faststart: true })
    await svc.recordCheck('/a.mp4', CTX)
    expect(svc.getStats()).toEqual({
      totalChecked: 1,
      faststartCount: 1,
      nonFaststartSamples: []
    })
  })

  it('records a non-faststart sample with full context', async () => {
    probeMock.mockResolvedValue({ faststart: false, firstNonFtypBox: 'mdat' })
    await svc.recordCheck('/b.mp4', CTX)
    const stats = svc.getStats()
    expect(stats.totalChecked).toBe(1)
    expect(stats.faststartCount).toBe(0)
    expect(stats.nonFaststartSamples.length).toBe(1)
    expect(stats.nonFaststartSamples[0]).toMatchObject({
      animeId: 1,
      animeName: 'Show',
      episodeLabel: 'Episode 01',
      filePath: '/b.mp4',
      firstNonFtypBox: 'mdat'
    })
  })

  it('deduplicates by filePath within a session — re-probing is a no-op', async () => {
    probeMock.mockResolvedValue({ faststart: true })
    await svc.recordCheck('/a.mp4', CTX)
    await svc.recordCheck('/a.mp4', CTX)
    await svc.recordCheck('/a.mp4', CTX)
    expect(probeMock).toHaveBeenCalledTimes(1)
    expect(svc.getStats().totalChecked).toBe(1)
  })

  it('caps nonFaststartSamples at 10 (slides the window)', async () => {
    probeMock.mockResolvedValue({ faststart: false, firstNonFtypBox: 'mdat' })
    for (let i = 0; i < 15; i++) {
      await svc.recordCheck(`/f${i}.mp4`, { ...CTX, animeId: i })
    }
    const stats = svc.getStats()
    expect(stats.totalChecked).toBe(15)
    expect(stats.nonFaststartSamples.length).toBe(10)
    expect((stats.nonFaststartSamples[0] as { animeId: number }).animeId).toBe(5)
    expect((stats.nonFaststartSamples[9] as { animeId: number }).animeId).toBe(14)
  })

  it('serializes concurrent recordCheck calls — no clobbered counters', async () => {
    probeMock.mockResolvedValue({ faststart: true })
    await Promise.all([
      svc.recordCheck('/p1.mp4', CTX),
      svc.recordCheck('/p2.mp4', CTX),
      svc.recordCheck('/p3.mp4', CTX),
      svc.recordCheck('/p4.mp4', CTX),
      svc.recordCheck('/p5.mp4', CTX)
    ])
    expect(svc.getStats()).toEqual({
      totalChecked: 5,
      faststartCount: 5,
      nonFaststartSamples: []
    })
  })

  it('resetStats clears counters and the deduped path set', async () => {
    probeMock.mockResolvedValue({ faststart: true })
    await svc.recordCheck('/a.mp4', CTX)
    svc.resetStats()
    expect(svc.getStats()).toEqual(emptyStats())
    // After reset the same path is probed again
    await svc.recordCheck('/a.mp4', CTX)
    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(svc.getStats().totalChecked).toBe(1)
  })
})
