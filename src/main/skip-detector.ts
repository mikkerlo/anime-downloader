import * as fs from 'fs/promises'
import { fingerprintFile, popcount32, type Fingerprint } from './fingerprint'

export interface EpisodeInput {
  episodeInt: string
  episodeLabel: string
  filePath: string
}

export interface SkipRange {
  startSec: number
  endSec: number
  pairCount: number
}

export interface EpisodeSkipDetection {
  episodeInt: string
  episodeLabel: string
  filePath: string
  durationSec: number
  hashesPerSec: number
  op: SkipRange | null
  ed: SkipRange | null
}

export interface ShowSkipDetections {
  animeId: number
  perEpisode: Record<string, EpisodeSkipDetection>
  analyzedAt: number
  episodeCount: number
  algorithm: {
    sampleRate: number
    matchBitThreshold: number
    minRunSec: number
    windowSec: number
    refineBitThreshold: number
    refineSustainHashes: number
  }
}

export interface CachedFingerprint {
  hashes: number[]
  durationSec: number
  hashesPerSec: number
  fileSize: number
  fileMtimeMs: number
  cachedAt: number
}

export interface AnalyzeProgress {
  phase: 'fingerprinting' | 'comparing' | 'done'
  current: number
  total: number
  episodeLabel?: string
}

export interface AnalyzeOptions {
  fpcalcPath: string
  signal?: AbortSignal
  onProgress?: (p: AnalyzeProgress) => void
  loadCachedFingerprint: (key: string) => CachedFingerprint | undefined
  saveCachedFingerprint: (key: string, value: CachedFingerprint) => void
}

const MATCH_BIT_THRESHOLD = 6
const MIN_RUN_SECONDS = 18
const WINDOW_SECONDS = 6
// Strict per-hash threshold used to tighten edges INWARD after the coarse
// window match. Chromaprint distances for the same audio are typically 0–3;
// 4 catches true matches while rejecting coincidental window-average matches.
const REFINE_BIT_THRESHOLD = 4
// Number of consecutive strict-match hashes required to anchor a refined edge.
// Prevents single noisy hashes from defining the boundary.
const REFINE_SUSTAIN_HASHES = 5

export function fingerprintCacheKey(animeId: number, episodeInt: string, fileSize: number, fileMtimeMs: number): string {
  return `${animeId}:${episodeInt}:${fileSize}:${Math.floor(fileMtimeMs)}`
}

interface LoadedEpisode extends EpisodeInput {
  fingerprint: Fingerprint
}

async function getFingerprint(
  animeId: number,
  ep: EpisodeInput,
  opts: AnalyzeOptions
): Promise<Fingerprint> {
  const stat = await fs.stat(ep.filePath)
  const cacheKey = fingerprintCacheKey(animeId, ep.episodeInt, stat.size, stat.mtimeMs)
  const cached = opts.loadCachedFingerprint(cacheKey)
  if (cached) {
    return {
      hashes: Uint32Array.from(cached.hashes),
      durationSec: cached.durationSec,
      hashesPerSec: cached.hashesPerSec
    }
  }
  const fp = await fingerprintFile(opts.fpcalcPath, ep.filePath, { signal: opts.signal })
  opts.saveCachedFingerprint(cacheKey, {
    hashes: Array.from(fp.hashes),
    durationSec: fp.durationSec,
    hashesPerSec: fp.hashesPerSec,
    fileSize: stat.size,
    fileMtimeMs: stat.mtimeMs,
    cachedAt: Date.now()
  })
  return fp
}

interface MatchRun {
  startA: number  // hash index into A's slice
  startB: number  // hash index into B's slice
  length: number  // hash count
}

// Slide a single fixed-length window over diagonal `d = a - b` to find the
// longest contiguous run where the average per-hash Hamming distance is below
// `threshold`. Returns the longest qualifying run (or null) within slices
// `a[aOffset .. aOffset+aLen)` and `b[bOffset .. bOffset+bLen)`.
function findBestMatch(
  a: Uint32Array, aOffset: number, aLen: number,
  b: Uint32Array, bOffset: number, bLen: number,
  windowHashes: number,
  minRunHashes: number,
  threshold: number
): MatchRun | null {
  if (aLen < windowHashes || bLen < windowHashes) return null

  let best: MatchRun | null = null
  const minD = -(bLen - windowHashes)
  const maxD = aLen - windowHashes

  for (let d = minD; d <= maxD; d++) {
    const startI = Math.max(0, d)
    const endI = Math.min(aLen, bLen + d)
    if (endI - startI < windowHashes) continue

    // Build initial window sum
    let sum = 0
    for (let k = 0; k < windowHashes; k++) {
      sum += popcount32(a[aOffset + startI + k] ^ b[bOffset + (startI + k - d)])
    }
    const allowedTotal = threshold * windowHashes

    let runStart = -1
    const tryExtend = (i: number, isMatch: boolean): void => {
      if (isMatch) {
        if (runStart < 0) runStart = i
      } else if (runStart >= 0) {
        const length = (i - runStart) + windowHashes - 1
        if (length >= minRunHashes && (!best || length > best.length)) {
          best = { startA: aOffset + runStart, startB: bOffset + runStart - d, length }
        }
        runStart = -1
      }
    }

    tryExtend(startI, sum <= allowedTotal)

    for (let i = startI + 1; i + windowHashes <= endI; i++) {
      // Slide window by 1
      sum -= popcount32(a[aOffset + i - 1] ^ b[bOffset + (i - 1 - d)])
      sum += popcount32(a[aOffset + i + windowHashes - 1] ^ b[bOffset + (i + windowHashes - 1 - d)])
      tryExtend(i, sum <= allowedTotal)
    }

    // Close trailing run
    if (runStart >= 0) {
      const length = (endI - windowHashes - runStart) + windowHashes
      if (length >= minRunHashes && (!best || length > best.length)) {
        best = { startA: aOffset + runStart, startB: bOffset + runStart - d, length }
      }
    }
  }

  return best
}

// Tighten boundaries of a coarse match INWARD only. The coarse window-average
// search may report edges up to one window earlier/later than the real OP/ED
// onset. We scan within the coarse range for the first/last position where
// `sustain` consecutive per-hash distances are all ≤ `threshold`, anchoring
// the refined start/end to genuine same-audio runs. Never extends outward.
function refineMatch(
  a: Uint32Array, b: Uint32Array,
  match: MatchRun,
  threshold: number,
  sustain: number
): MatchRun {
  const d = match.startA - match.startB
  const coarseEnd = match.startA + match.length

  const isSustainedGood = (i: number): boolean => {
    if (i + sustain > coarseEnd) return false
    if (i + sustain > a.length) return false
    if ((i - d) < 0 || (i + sustain - d) > b.length) return false
    for (let k = 0; k < sustain; k++) {
      if (popcount32(a[i + k] ^ b[i + k - d]) > threshold) return false
    }
    return true
  }

  let newStart = match.startA
  for (let i = match.startA; i + sustain <= coarseEnd; i++) {
    if (isSustainedGood(i)) { newStart = i; break }
  }

  let newEnd = coarseEnd
  for (let i = coarseEnd - sustain; i >= newStart; i--) {
    if (isSustainedGood(i)) { newEnd = i + sustain; break }
  }

  return {
    startA: newStart,
    startB: newStart - d,
    length: Math.max(0, newEnd - newStart)
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

interface PerEpisodeSamples {
  opStart: number[]
  opLength: number[]
  edStart: number[]  // counted from start (not end) for consistency
  edLength: number[]
}

export async function analyzeShow(
  animeId: number,
  episodes: EpisodeInput[],
  opts: AnalyzeOptions
): Promise<ShowSkipDetections> {
  if (episodes.length < 2) {
    throw new Error('analyzeShow: need at least 2 episodes')
  }

  // Phase 1: fingerprint each episode (use cache when available)
  const loaded: LoadedEpisode[] = []
  for (let i = 0; i < episodes.length; i++) {
    if (opts.signal?.aborted) throw new Error('analysis cancelled')
    opts.onProgress?.({ phase: 'fingerprinting', current: i, total: episodes.length, episodeLabel: episodes[i].episodeLabel })
    const fp = await getFingerprint(animeId, episodes[i], opts)
    loaded.push({ ...episodes[i], fingerprint: fp })
    opts.onProgress?.({ phase: 'fingerprinting', current: i + 1, total: episodes.length, episodeLabel: episodes[i].episodeLabel })
  }

  // Phase 2: pairwise comparison
  const samplesByEpisode = new Map<string, PerEpisodeSamples>()
  for (const ep of loaded) {
    samplesByEpisode.set(ep.episodeInt, { opStart: [], opLength: [], edStart: [], edLength: [] })
  }

  const pairs: { i: number; j: number }[] = []
  for (let i = 0; i < loaded.length; i++) {
    for (let j = i + 1; j < loaded.length; j++) {
      pairs.push({ i, j })
    }
  }

  for (let p = 0; p < pairs.length; p++) {
    if (opts.signal?.aborted) throw new Error('analysis cancelled')
    opts.onProgress?.({ phase: 'comparing', current: p, total: pairs.length })

    const a = loaded[pairs[p].i]
    const b = loaded[pairs[p].j]
    // Use the slower of the two hash rates so window-in-hashes is safely sized for both
    const minHashesPerSec = Math.min(a.fingerprint.hashesPerSec, b.fingerprint.hashesPerSec)
    const windowHashes = Math.max(8, Math.round(WINDOW_SECONDS * minHashesPerSec))
    const minRunHashes = Math.max(windowHashes + 1, Math.round(MIN_RUN_SECONDS * minHashesPerSec))

    // OP region: search the first 8 minutes of each episode
    const opRegionHashesA = Math.min(a.fingerprint.hashes.length, Math.round(a.fingerprint.hashesPerSec * 8 * 60))
    const opRegionHashesB = Math.min(b.fingerprint.hashes.length, Math.round(b.fingerprint.hashesPerSec * 8 * 60))
    const opMatch = findBestMatch(
      a.fingerprint.hashes, 0, opRegionHashesA,
      b.fingerprint.hashes, 0, opRegionHashesB,
      windowHashes, minRunHashes, MATCH_BIT_THRESHOLD
    )
    if (opMatch) {
      const refined = refineMatch(a.fingerprint.hashes, b.fingerprint.hashes, opMatch, REFINE_BIT_THRESHOLD, REFINE_SUSTAIN_HASHES)
      const sA = samplesByEpisode.get(a.episodeInt)!
      const sB = samplesByEpisode.get(b.episodeInt)!
      sA.opStart.push(refined.startA / a.fingerprint.hashesPerSec)
      sA.opLength.push(refined.length / a.fingerprint.hashesPerSec)
      sB.opStart.push(refined.startB / b.fingerprint.hashesPerSec)
      sB.opLength.push(refined.length / b.fingerprint.hashesPerSec)
    }

    // ED region: search the last 8 minutes of each episode
    const edSearchSec = 8 * 60
    const edRegionHashesA = Math.min(a.fingerprint.hashes.length, Math.round(a.fingerprint.hashesPerSec * edSearchSec))
    const edRegionHashesB = Math.min(b.fingerprint.hashes.length, Math.round(b.fingerprint.hashesPerSec * edSearchSec))
    const edStartA = a.fingerprint.hashes.length - edRegionHashesA
    const edStartB = b.fingerprint.hashes.length - edRegionHashesB
    const edMatch = findBestMatch(
      a.fingerprint.hashes, edStartA, edRegionHashesA,
      b.fingerprint.hashes, edStartB, edRegionHashesB,
      windowHashes, minRunHashes, MATCH_BIT_THRESHOLD
    )
    // Suppress duplicate detection of the OP showing through into ED region (rare with the offsets above, but possible for short shows)
    if (edMatch) {
      const refined = refineMatch(a.fingerprint.hashes, b.fingerprint.hashes, edMatch, REFINE_BIT_THRESHOLD, REFINE_SUSTAIN_HASHES)
      const sA = samplesByEpisode.get(a.episodeInt)!
      const sB = samplesByEpisode.get(b.episodeInt)!
      sA.edStart.push(refined.startA / a.fingerprint.hashesPerSec)
      sA.edLength.push(refined.length / a.fingerprint.hashesPerSec)
      sB.edStart.push(refined.startB / b.fingerprint.hashesPerSec)
      sB.edLength.push(refined.length / b.fingerprint.hashesPerSec)
    }
  }
  opts.onProgress?.({ phase: 'comparing', current: pairs.length, total: pairs.length })

  // Aggregate per-episode boundaries via median
  const perEpisode: Record<string, EpisodeSkipDetection> = {}
  for (const ep of loaded) {
    const samples = samplesByEpisode.get(ep.episodeInt)!
    const op: SkipRange | null = samples.opStart.length === 0 ? null : {
      startSec: median(samples.opStart),
      endSec: median(samples.opStart) + median(samples.opLength),
      pairCount: samples.opStart.length
    }
    const ed: SkipRange | null = samples.edStart.length === 0 ? null : {
      startSec: median(samples.edStart),
      endSec: median(samples.edStart) + median(samples.edLength),
      pairCount: samples.edStart.length
    }
    perEpisode[ep.episodeInt] = {
      episodeInt: ep.episodeInt,
      episodeLabel: ep.episodeLabel,
      filePath: ep.filePath,
      durationSec: ep.fingerprint.durationSec,
      hashesPerSec: ep.fingerprint.hashesPerSec,
      op,
      ed
    }
  }

  opts.onProgress?.({ phase: 'done', current: pairs.length, total: pairs.length })
  return {
    animeId,
    perEpisode,
    analyzedAt: Date.now(),
    episodeCount: episodes.length,
    algorithm: {
      sampleRate: 11025,
      matchBitThreshold: MATCH_BIT_THRESHOLD,
      minRunSec: MIN_RUN_SECONDS,
      windowSec: WINDOW_SECONDS,
      refineBitThreshold: REFINE_BIT_THRESHOLD,
      refineSustainHashes: REFINE_SUSTAIN_HASHES
    }
  }
}
