import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, computed } from 'vue'
import { useSkipDetection } from '../../../src/renderer/src/composables/use-skip-detection'

type FileEntry = {
  type: 'mkv' | 'mp4'
  filePath: string
  translationId?: number
  author?: string
}

type Api = {
  skipDetectorGetDetections: (animeId: number) => Promise<ShowSkipDetections | null>
  skipDetectorGetStatus: () => Promise<{
    animeId: number
    lastProgress: SkipDetectorProgress
  } | null>
  skipDetectorAnalyzeShow: (animeId: number, inputs: unknown[]) => Promise<ShowSkipDetections>
  skipDetectorCancel: () => Promise<void>
  injectChapters: (
    animeId: number,
    inputs: unknown[]
  ) => Promise<{ written: number; skipped: number; failed: number; total: number }>
  onSkipDetectorProgress: (cb: (data: SkipDetectorProgress) => void) => Unsubscribe
  onSkipDetectorSignatureUpdated: (cb: (data: { animeId: number }) => void) => Unsubscribe
  onChapterInjectProgress: (cb: (data: ChapterInjectProgress) => void) => Unsubscribe
}

function setApi(api: Partial<Api>): void {
  const w = (globalThis as { window?: { api?: Partial<Api> } }).window
  const prev = w?.api ?? {}
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...prev, ...api } }
}

beforeEach(() => {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: {} }
})

function mkEpisode(id: number, episodeInt: string): EpisodeSummary {
  return {
    id,
    episodeInt,
    episodeFull: `Episode ${episodeInt}`,
    episodeType: 'tv',
    isActive: 1
  } as unknown as EpisodeSummary
}

function makeDeps(
  opts: {
    animeId?: number
    episodes?: EpisodeSummary[]
    fileStatus?: Record<string, FileEntry[]>
  } = {}
) {
  return {
    getAnimeId: () => opts.animeId ?? 1,
    filteredEpisodes: computed(() => opts.episodes ?? []),
    fileStatus: ref<Record<string, FileEntry[]>>(opts.fileStatus ?? {})
  }
}

describe('useSkipDetection — skipEpisodeInputs projection', () => {
  it('returns [] when no episodes have files', () => {
    const s = useSkipDetection(makeDeps({ episodes: [mkEpisode(1, '1'), mkEpisode(2, '2')] }))
    expect(s.skipEpisodeInputs.value).toEqual([])
  })

  it('prefers .mkv over .mp4 per episode', () => {
    const s = useSkipDetection(
      makeDeps({
        episodes: [mkEpisode(1, '1')],
        fileStatus: {
          '1': [
            { type: 'mp4', filePath: '/x.mp4' },
            { type: 'mkv', filePath: '/x.mkv' }
          ]
        }
      })
    )
    expect(s.skipEpisodeInputs.value).toEqual([
      { episodeInt: '1', episodeLabel: 'Episode 1', filePath: '/x.mkv' }
    ])
  })

  it('falls back to first file when no .mkv exists', () => {
    const s = useSkipDetection(
      makeDeps({
        episodes: [mkEpisode(1, '1')],
        fileStatus: { '1': [{ type: 'mp4', filePath: '/x.mp4' }] }
      })
    )
    expect(s.skipEpisodeInputs.value[0].filePath).toBe('/x.mp4')
  })

  it('skipMkvEpisodeCount counts only .mkv inputs', () => {
    const s = useSkipDetection(
      makeDeps({
        episodes: [mkEpisode(1, '1'), mkEpisode(2, '2'), mkEpisode(3, '3')],
        fileStatus: {
          '1': [{ type: 'mkv', filePath: '/a.mkv' }],
          '2': [{ type: 'mp4', filePath: '/b.mp4' }],
          '3': [{ type: 'mkv', filePath: '/c.mkv' }]
        }
      })
    )
    expect(s.skipMkvEpisodeCount.value).toBe(2)
  })
})

describe('useSkipDetection — labels & helpers', () => {
  it('formatSkipTime formats mm:ss with zero-pad', () => {
    const s = useSkipDetection(makeDeps())
    expect(s.formatSkipTime(125)).toBe('2:05')
    expect(s.formatSkipTime(0)).toBe('0:00')
    expect(s.formatSkipTime(-1)).toBe('—')
    expect(s.formatSkipTime(NaN)).toBe('—')
  })

  it('skipProgressLabel formats fingerprinting phase with episode label', () => {
    const s = useSkipDetection(makeDeps())
    s.skipProgress.value = {
      animeId: 1,
      phase: 'fingerprinting',
      current: 3,
      total: 12,
      episodeLabel: 'Episode 3'
    } as unknown as SkipDetectorProgress
    expect(s.skipProgressLabel.value).toBe('Fingerprinting 3/12 — Episode 3')
  })

  it('skipProgressLabel formats comparing phase', () => {
    const s = useSkipDetection(makeDeps())
    s.skipProgress.value = {
      animeId: 1,
      phase: 'comparing',
      current: 4,
      total: 10
    } as unknown as SkipDetectorProgress
    expect(s.skipProgressLabel.value).toBe('Comparing pairs 4/10')
  })

  it('chapterInjectProgressLabel for analyzing and writing phases', () => {
    const s = useSkipDetection(makeDeps())
    s.chapterInjectProgress.value = { phase: 'analyzing' } as unknown as ChapterInjectProgress
    expect(s.chapterInjectProgressLabel.value).toBe('Analyzing fingerprints…')
    s.chapterInjectProgress.value = {
      phase: 'writing',
      current: 2,
      total: 5,
      episodeLabel: 'Episode 3'
    } as unknown as ChapterInjectProgress
    expect(s.chapterInjectProgressLabel.value).toBe('Writing chapters 3/5 — Episode 3')
  })
})

describe('useSkipDetection — runSkipAnalysis', () => {
  it('refuses with fewer than 2 downloaded episodes', async () => {
    const analyze = vi.fn()
    setApi({ skipDetectorAnalyzeShow: analyze })
    const s = useSkipDetection(
      makeDeps({
        episodes: [mkEpisode(1, '1')],
        fileStatus: { '1': [{ type: 'mkv', filePath: '/a.mkv' }] }
      })
    )
    await s.runSkipAnalysis()
    expect(analyze).not.toHaveBeenCalled()
    expect(s.skipError.value).toMatch(/at least 2/i)
  })

  it('analyzes and stores result; transient flags toggle correctly', async () => {
    const result = { perEpisode: {} } as unknown as ShowSkipDetections
    const analyze = vi.fn().mockResolvedValue(result)
    setApi({ skipDetectorAnalyzeShow: analyze })
    const s = useSkipDetection(
      makeDeps({
        animeId: 42,
        episodes: [mkEpisode(1, '1'), mkEpisode(2, '2')],
        fileStatus: {
          '1': [{ type: 'mkv', filePath: '/a.mkv' }],
          '2': [{ type: 'mkv', filePath: '/b.mkv' }]
        }
      })
    )
    await s.runSkipAnalysis()
    expect(analyze).toHaveBeenCalledWith(
      42,
      expect.arrayContaining([expect.objectContaining({ episodeInt: '1', filePath: '/a.mkv' })])
    )
    expect(s.skipDetections.value).toStrictEqual(result)
    expect(s.skipAnalyzing.value).toBe(false)
    expect(s.skipProgress.value).toBeNull()
  })

  it('captures error on analyze failure', async () => {
    setApi({ skipDetectorAnalyzeShow: vi.fn().mockRejectedValue(new Error('boom')) })
    const s = useSkipDetection(
      makeDeps({
        episodes: [mkEpisode(1, '1'), mkEpisode(2, '2')],
        fileStatus: {
          '1': [{ type: 'mkv', filePath: '/a.mkv' }],
          '2': [{ type: 'mkv', filePath: '/b.mkv' }]
        }
      })
    )
    await s.runSkipAnalysis()
    expect(s.skipError.value).toMatch(/boom/)
    expect(s.skipAnalyzing.value).toBe(false)
  })

  it('does not double-fire when already analyzing', async () => {
    const analyze = vi.fn().mockResolvedValue({ perEpisode: {} } as ShowSkipDetections)
    setApi({ skipDetectorAnalyzeShow: analyze })
    const s = useSkipDetection(
      makeDeps({
        episodes: [mkEpisode(1, '1'), mkEpisode(2, '2')],
        fileStatus: {
          '1': [{ type: 'mkv', filePath: '/a.mkv' }],
          '2': [{ type: 'mkv', filePath: '/b.mkv' }]
        }
      })
    )
    s.skipAnalyzing.value = true
    await s.runSkipAnalysis()
    expect(analyze).not.toHaveBeenCalled()
  })
})

describe('useSkipDetection — injectChaptersToMkv', () => {
  it('refuses with fewer than 3 MKV episodes', async () => {
    const inject = vi.fn()
    setApi({ injectChapters: inject })
    const s = useSkipDetection(
      makeDeps({
        episodes: [mkEpisode(1, '1'), mkEpisode(2, '2')],
        fileStatus: {
          '1': [{ type: 'mkv', filePath: '/a.mkv' }],
          '2': [{ type: 'mkv', filePath: '/b.mkv' }]
        }
      })
    )
    await s.injectChaptersToMkv()
    expect(inject).not.toHaveBeenCalled()
    expect(s.chapterInjectError.value).toMatch(/at least 3/i)
  })

  it('writes chapters and stores result', async () => {
    const res = { written: 3, skipped: 0, failed: 0, total: 3 }
    const inject = vi.fn().mockResolvedValue(res)
    setApi({ injectChapters: inject })
    const s = useSkipDetection(
      makeDeps({
        animeId: 7,
        episodes: [mkEpisode(1, '1'), mkEpisode(2, '2'), mkEpisode(3, '3')],
        fileStatus: {
          '1': [{ type: 'mkv', filePath: '/a.mkv' }],
          '2': [{ type: 'mkv', filePath: '/b.mkv' }],
          '3': [{ type: 'mkv', filePath: '/c.mkv' }]
        }
      })
    )
    await s.injectChaptersToMkv()
    expect(inject).toHaveBeenCalledWith(7, expect.any(Array))
    expect(s.chapterInjectResult.value).toEqual(res)
    expect(s.chapterInjecting.value).toBe(false)
  })
})

describe('useSkipDetection — hydrateSkipStatus', () => {
  it('resumes the analyzing flag if status matches the current anime', async () => {
    setApi({
      skipDetectorGetStatus: vi.fn().mockResolvedValue({
        animeId: 5,
        lastProgress: {
          animeId: 5,
          phase: 'fingerprinting',
          current: 2,
          total: 10
        } as unknown as SkipDetectorProgress
      })
    })
    const s = useSkipDetection(makeDeps({ animeId: 5 }))
    await s.hydrateSkipStatus()
    expect(s.skipAnalyzing.value).toBe(true)
    expect(s.skipProgress.value?.current).toBe(2)
  })

  it('ignores status for a different anime', async () => {
    setApi({
      skipDetectorGetStatus: vi.fn().mockResolvedValue({
        animeId: 999,
        lastProgress: {} as SkipDetectorProgress
      })
    })
    const s = useSkipDetection(makeDeps({ animeId: 5 }))
    await s.hydrateSkipStatus()
    expect(s.skipAnalyzing.value).toBe(false)
  })
})

describe('useSkipDetection — subscriptions filter by animeId', () => {
  it('subscribeSkipDetectorProgress ignores other anime ids', () => {
    let captured: ((data: SkipDetectorProgress) => void) | null = null
    setApi({
      onSkipDetectorProgress: (cb) => {
        captured = cb
        return () => {}
      }
    })
    const s = useSkipDetection(makeDeps({ animeId: 5 }))
    s.subscribeSkipDetectorProgress()
    captured!({
      animeId: 7,
      phase: 'fingerprinting',
      current: 1,
      total: 2
    } as unknown as SkipDetectorProgress)
    expect(s.skipProgress.value).toBeNull()
    captured!({
      animeId: 5,
      phase: 'fingerprinting',
      current: 1,
      total: 2
    } as unknown as SkipDetectorProgress)
    expect(s.skipProgress.value?.animeId).toBe(5)
    expect(s.skipAnalyzing.value).toBe(true)
  })
})
