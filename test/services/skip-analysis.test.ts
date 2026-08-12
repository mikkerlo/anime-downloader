import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSkipAnalysisService,
  type SkipAnalysisService,
  type SkipAnalysisServiceDeps,
  type SkipAnalysisFileCheckResult
} from '../../src/main/services/skip-analysis'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { ShowSkipDetections, EpisodeSkipDetection } from '../../src/main/skip-detector'

function mkDetections(per: Record<string, unknown>, source?: 'local'): ShowSkipDetections {
  return {
    perEpisode: per,
    algorithm: source ? { source } : undefined
  } as unknown as ShowSkipDetections
}

describe('SkipAnalysisService', () => {
  let store: InMemoryStorage
  let broadcasts: { channel: string; args: unknown[] }[]
  let scanResult: SkipAnalysisFileCheckResult
  let svc: SkipAnalysisService

  beforeEach(() => {
    store = new InMemoryStorage({
      skipFingerprintCache: {},
      skipDetections: {},
      downloadedAnime: {}
    })
    broadcasts = []
    scanResult = {}
    svc = createSkipAnalysisService({
      store,
      scanEpisodeFiles: () => scanResult,
      sanitizeFilename: (s) => s,
      broadcast: (channel, ...args) => broadcasts.push({ channel, args }),
      signatureUpdatedChannel: 'sig-updated',
      analyzeProgressChannel: 'analyze-progress',
      getFpcalcPath: () => '',
      getFfmpegPath: () => '',
      getFfprobePath: () => ''
    })
  })

  describe('normalizeDetections', () => {
    it('returns null untouched', () => {
      expect(svc.normalizeDetections(null)).toBeNull()
    })
    it('passes through when algorithm.source is already local', () => {
      const d = mkDetections({}, 'local')
      expect(svc.normalizeDetections(d)).toBe(d)
    })
    it('coerces legacy detections to a `local` algorithm block with defaults', () => {
      const out = svc.normalizeDetections(mkDetections({}))!
      expect(out.algorithm).toEqual({
        source: 'local',
        sampleRate: 11025,
        matchBitThreshold: 6,
        minRunSec: 18,
        windowSec: 6,
        refineBitThreshold: 4,
        refineSustainHashes: 5
      })
    })
  })

  describe('pruneCacheForEpisode', () => {
    it('drops only matching prefix and writes when something changed', () => {
      store.set('skipFingerprintCache', {
        '1:5:1000:1700000000000': { fileSize: 1, fileMtimeMs: 1 },
        '1:5:2000:1700000000000': { fileSize: 1, fileMtimeMs: 1 },
        '1:6:3000:1700000000000': { fileSize: 1, fileMtimeMs: 1 },
        '2:5:4000:1700000000000': { fileSize: 1, fileMtimeMs: 1 }
      })
      expect(svc.pruneCacheForEpisode(1, '5')).toBe(2)
      const after = store.get<Record<string, unknown>>('skipFingerprintCache')!
      expect(Object.keys(after).sort()).toEqual([
        '1:6:3000:1700000000000',
        '2:5:4000:1700000000000'
      ])
    })
    it('returns 0 and is a no-op for invalid input', () => {
      expect(svc.pruneCacheForEpisode(0, '5')).toBe(0)
      expect(svc.pruneCacheForEpisode(1, '')).toBe(0)
    })
  })

  describe('pruneCacheForAnime', () => {
    it('drops everything keyed under the anime prefix', () => {
      store.set('skipFingerprintCache', {
        '1:5:x:y': { fileSize: 1, fileMtimeMs: 1 },
        '1:6:x:y': { fileSize: 1, fileMtimeMs: 1 },
        '2:5:x:y': { fileSize: 1, fileMtimeMs: 1 }
      })
      expect(svc.pruneCacheForAnime(1)).toBe(2)
      expect(Object.keys(store.get<Record<string, unknown>>('skipFingerprintCache')!)).toEqual([
        '2:5:x:y'
      ])
    })
  })

  describe('dropDetectionsForAnime', () => {
    it('removes the row and broadcasts a clear event', () => {
      store.set('skipDetections', { '1': mkDetections({ '1': {} }, 'local') })
      expect(svc.dropDetectionsForAnime(1)).toBe(true)
      expect(store.get<Record<string, unknown>>('skipDetections')).toEqual({})
      expect(broadcasts).toEqual([
        { channel: 'sig-updated', args: [{ animeId: 1, perEpisode: {} }] }
      ])
    })
    it('returns false without broadcasting when nothing matched', () => {
      expect(svc.dropDetectionsForAnime(42)).toBe(false)
      expect(broadcasts).toEqual([])
    })
  })

  describe('dropDetectionsForEpisode', () => {
    it('removes one episode but keeps the show row when others remain', () => {
      store.set('skipDetections', {
        '1': mkDetections({ '1': { a: 1 }, '2': { a: 2 } }, 'local')
      })
      expect(svc.dropDetectionsForEpisode(1, '1')).toBe(true)
      const remaining = store.get<Record<string, ShowSkipDetections>>('skipDetections')!['1']
      expect(Object.keys(remaining.perEpisode)).toEqual(['2'])
      expect(broadcasts[0].args[0]).toMatchObject({ animeId: 1, perEpisode: { '2': { a: 2 } } })
    })
    it('removes the show row when the last episode is dropped', () => {
      store.set('skipDetections', { '1': mkDetections({ '1': { a: 1 } }, 'local') })
      expect(svc.dropDetectionsForEpisode(1, '1')).toBe(true)
      expect(store.get<Record<string, unknown>>('skipDetections')).toEqual({})
    })
    it('returns false without broadcasting when the episode is unknown', () => {
      expect(svc.dropDetectionsForEpisode(1, '9')).toBe(false)
      expect(broadcasts).toEqual([])
    })
  })

  describe('buildAutoSkipEpisodes', () => {
    it('prefers mkv over mp4, deduplicates by episodeInt, sorts numerically', () => {
      scanResult = {
        'show - 10': [{ type: 'mp4', filePath: '/x/show - 10.mp4' }],
        'show - 02': [
          { type: 'mp4', filePath: '/x/show - 02.mp4' },
          { type: 'mkv', filePath: '/x/show - 02.mkv' }
        ],
        'show - 1': [{ type: 'mp4', filePath: '/x/show - 1.mp4' }]
      }
      const ep = svc.buildAutoSkipEpisodes('show')
      expect(ep.map((e) => e.episodeInt)).toEqual(['1', '2', '10'])
      expect(ep[1].filePath).toBe('/x/show - 02.mkv') // mkv preferred
    })
    it('skips entries whose folder name does not match', () => {
      scanResult = { 'other - 01': [{ type: 'mp4', filePath: '/x/other - 01.mp4' }] }
      expect(svc.buildAutoSkipEpisodes('show')).toEqual([])
    })
  })

  // #222 leak backstop. The shared `beforeEach` builds the service with empty
  // binary paths, which makes `runStreamSkipDetection` reject before any
  // deadline can arm — so this nests its own service with non-empty paths and
  // an injected `detectStream` that only settles when its signal aborts.
  describe('runStreamSkipDetection deadline', () => {
    const DEADLINE_MS = 120_000

    function makeService(
      detectStream: (
        animeId: number,
        episodeInt: string,
        streamUrl: string,
        detections: ShowSkipDetections,
        opts: { signal?: AbortSignal }
      ) => Promise<EpisodeSkipDetection | null>
    ): SkipAnalysisService {
      return createSkipAnalysisService({
        store,
        scanEpisodeFiles: () => scanResult,
        sanitizeFilename: (s) => s,
        broadcast: (channel, ...args) => broadcasts.push({ channel, args }),
        signatureUpdatedChannel: 'sig-updated',
        analyzeProgressChannel: 'analyze-progress',
        getFpcalcPath: () => '/fake/fpcalc',
        getFfmpegPath: () => '/fake/ffmpeg',
        getFfprobePath: () => '/fake/ffprobe',
        detectStream: detectStream as unknown as SkipAnalysisServiceDeps['detectStream']
      })
    }

    /** Resolves `null` the moment its signal aborts — how the real `detectStream` behaves. */
    function abortAware(seen: {
      signal?: AbortSignal
    }): (
      ...args: [number, string, string, ShowSkipDetections, { signal?: AbortSignal }]
    ) => Promise<EpisodeSkipDetection | null> {
      return (_a, _e, _u, _d, opts) => {
        seen.signal = opts.signal
        return new Promise<EpisodeSkipDetection | null>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(null), { once: true })
        })
      }
    }

    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('aborts a run that outlives the deadline', async () => {
      // Muted because the deadline genuinely fires here; the spy doubles as the
      // assertion that it logged rather than aborting silently.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const seen: { signal?: AbortSignal } = {}
      const svc2 = makeService(abortAware(seen))
      const run = svc2.runStreamSkipDetection(
        1,
        42,
        '1',
        'https://cdn/x.mp4',
        mkDetections({}, 'local')
      )

      expect(seen.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1)
      expect(seen.signal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(seen.signal?.aborted).toBe(true)
      await expect(run).resolves.toBeNull()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stream detection deadline hit'))
      warn.mockRestore()
    })

    // `controller.abort()` is captured by reference, so a timer left armed past
    // a normal resolution would kill whichever run is live 120 s later.
    it('clears the deadline timer on normal resolution so it cannot abort a later run', async () => {
      const seen: { signal?: AbortSignal } = {}
      const svc2 = makeService((_a, _e, _u, _d, opts) => {
        seen.signal = opts.signal
        return Promise.resolve(null)
      })
      await svc2.runStreamSkipDetection(1, 42, '1', 'https://cdn/x.mp4', mkDetections({}, 'local'))
      // Let the `.finally` cleanup run before checking what is still armed.
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(DEADLINE_MS * 2)
      expect(seen.signal?.aborted).toBe(false)
    })
  })
})
