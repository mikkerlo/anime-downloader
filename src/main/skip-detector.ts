import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
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
    source: 'local'
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
  /**
   * Full FFmpeg build path. When set, a file that fpcalc's own (slimmer) bundled
   * FFmpeg can't decode is retried by decoding the audio to a temp WAV first.
   */
  ffmpegPath?: string
  signal?: AbortSignal
  onProgress?: (p: AnalyzeProgress) => void
  loadCachedFingerprint: (key: string) => CachedFingerprint | undefined
  saveCachedFingerprint: (key: string, value: CachedFingerprint) => void
}

export interface DetectStreamOptions {
  fpcalcPath: string
  ffmpegPath: string
  ffprobePath?: string
  userAgent?: string
  signal?: AbortSignal
  loadCachedFingerprint: (key: string) => CachedFingerprint | undefined
  saveCachedFingerprint: (key: string, value: CachedFingerprint) => void
}

const MATCH_BIT_THRESHOLD = 6
const MIN_RUN_SECONDS = 18
const WINDOW_SECONDS = 6
const SEARCH_REGION_SECONDS = 8 * 60
// Streamed playback should only surface ranges when multiple locally-derived
// episodes agree on the match; a single episode is too noisy to trust.
const MIN_STREAM_MATCHES = 2
// Strict per-hash threshold used to tighten edges INWARD after the coarse
// window match. Chromaprint distances for the same audio are typically 0–3;
// 4 catches true matches while rejecting coincidental window-average matches.
const REFINE_BIT_THRESHOLD = 4
// Number of consecutive strict-match hashes required to anchor a refined edge.
// Prevents single noisy hashes from defining the boundary.
const REFINE_SUSTAIN_HASHES = 5

export function fingerprintCacheKey(
  animeId: number,
  episodeInt: string,
  fileSize: number,
  fileMtimeMs: number
): string {
  return `${animeId}:${episodeInt}:${fileSize}:${Math.floor(fileMtimeMs)}`
}

const MIN_CHAPTER_SECONDS = 2

function escapeFfmetadata(value: string): string {
  return value.replace(/[=;#\\\n]/g, (m) => (m === '\n' ? '\\n' : `\\${m}`))
}

interface ChapterSegment {
  startMs: number
  endMs: number
  title: string
}

// Build an FFMETADATA1 string defining Intro/OP/Episode/ED/Outro chapters for a
// single episode. Returns null when there's nothing useful to write (no OP/ED,
// or every candidate segment collapses below MIN_CHAPTER_SECONDS).
//
// Inverted ranges (op.endSec > ed.startSec) drop ED entirely rather than
// emitting overlapping chapters that some external players parse incorrectly.
export function formatChaptersMetadata(
  durationSec: number,
  op: SkipRange | null,
  ed: SkipRange | null
): string | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null

  let opRange = op && op.endSec > op.startSec ? { startSec: op.startSec, endSec: op.endSec } : null
  let edRange = ed && ed.endSec > ed.startSec ? { startSec: ed.startSec, endSec: ed.endSec } : null

  if (opRange && edRange && opRange.endSec > edRange.startSec) {
    edRange = null
  }
  if (edRange) {
    edRange.startSec = Math.max(0, Math.min(edRange.startSec, durationSec))
    edRange.endSec = Math.max(edRange.startSec, Math.min(edRange.endSec, durationSec))
    if (edRange.endSec - edRange.startSec < MIN_CHAPTER_SECONDS) edRange = null
  }
  if (opRange) {
    opRange.startSec = Math.max(0, Math.min(opRange.startSec, durationSec))
    opRange.endSec = Math.max(opRange.startSec, Math.min(opRange.endSec, durationSec))
    if (opRange.endSec - opRange.startSec < MIN_CHAPTER_SECONDS) opRange = null
  }

  if (!opRange && !edRange) return null

  const segments: ChapterSegment[] = []
  const push = (startSec: number, endSec: number, title: string): void => {
    if (endSec - startSec < MIN_CHAPTER_SECONDS) return
    segments.push({
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000),
      title
    })
  }

  const opStart = opRange?.startSec ?? null
  const opEnd = opRange?.endSec ?? null
  const edStart = edRange?.startSec ?? null
  const edEnd = edRange?.endSec ?? null

  if (opStart !== null) push(0, opStart, 'Intro')
  if (opStart !== null && opEnd !== null) push(opStart, opEnd, 'OP')

  const epStart = opEnd ?? 0
  const epEnd = edStart ?? durationSec
  push(epStart, epEnd, 'Episode')

  if (edStart !== null && edEnd !== null) push(edStart, edEnd, 'ED')
  if (edEnd !== null) push(edEnd, durationSec, 'Outro')

  if (segments.length === 0) return null

  // Ensure adjacent chapters touch (no gaps from rounding).
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startMs < segments[i - 1].endMs) {
      segments[i].startMs = segments[i - 1].endMs
    }
  }

  const lines: string[] = [';FFMETADATA1']
  for (const seg of segments) {
    lines.push('[CHAPTER]')
    lines.push('TIMEBASE=1/1000')
    lines.push(`START=${seg.startMs}`)
    lines.push(`END=${seg.endMs}`)
    lines.push(`title=${escapeFfmetadata(seg.title)}`)
  }
  return lines.join('\n') + '\n'
}

interface LoadedEpisode extends EpisodeInput {
  fingerprint: Fingerprint
}

// Decode a file's audio to a temp mono 11025 Hz WAV with the app's full FFmpeg,
// then fingerprint that. fpcalc downsamples to mono/11025 internally, so the
// resulting fingerprint is identical to decoding the source directly — this is
// purely a more capable decoder front-end for files fpcalc's bundled (slimmer,
// platform-specific) FFmpeg rejects with "Error decoding audio frame".
async function fingerprintViaWavDecode(
  sourcePath: string,
  ffmpegPath: string,
  fpcalcPath: string,
  signal?: AbortSignal
): Promise<Fingerprint> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-dl-skip-decode-'))
  const outputPath = path.join(tmpDir, 'audio.wav')
  try {
    await runChild(
      ffmpegPath,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        sourcePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '11025',
        '-c:a',
        'pcm_s16le',
        outputPath
      ],
      { signal }
    )
    return await fingerprintFile(fpcalcPath, outputPath, { signal })
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

async function fingerprintLocalFile(filePath: string, opts: AnalyzeOptions): Promise<Fingerprint> {
  try {
    return await fingerprintFile(opts.fpcalcPath, filePath, { signal: opts.signal })
  } catch (err) {
    if (!opts.ffmpegPath || opts.signal?.aborted) throw err
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[skip-detector] fpcalc failed to decode ${path.basename(filePath)} (${msg}); retrying via FFmpeg WAV decode`
    )
    return await fingerprintViaWavDecode(filePath, opts.ffmpegPath, opts.fpcalcPath, opts.signal)
  }
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
  const fp = await fingerprintLocalFile(ep.filePath, opts)
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
  startA: number // hash index into A's slice
  startB: number // hash index into B's slice
  length: number // hash count
}

interface FingerprintRegion {
  fingerprint: Fingerprint
  offsetHashes: number
  lengthHashes: number
  sourceOffsetSec: number
}

interface RegionMatch {
  startSecA: number
  startSecB: number
  lengthSecA: number
  lengthSecB: number
}

// Slide a single fixed-length window over diagonal `d = a - b` to find the
// longest contiguous run where the average per-hash Hamming distance is below
// `threshold`. Returns the longest qualifying run (or null) within slices
// `a[aOffset .. aOffset+aLen)` and `b[bOffset .. bOffset+bLen)`.
function findBestMatch(
  a: Uint32Array,
  aOffset: number,
  aLen: number,
  b: Uint32Array,
  bOffset: number,
  bLen: number,
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
        const length = i - runStart + windowHashes - 1
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
      const length = endI - windowHashes - runStart + windowHashes
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
  a: Uint32Array,
  b: Uint32Array,
  match: MatchRun,
  threshold: number,
  sustain: number
): MatchRun {
  const d = match.startA - match.startB
  const coarseEnd = match.startA + match.length

  const isSustainedGood = (i: number): boolean => {
    if (i + sustain > coarseEnd) return false
    if (i + sustain > a.length) return false
    if (i - d < 0 || i + sustain - d > b.length) return false
    for (let k = 0; k < sustain; k++) {
      if (popcount32(a[i + k] ^ b[i + k - d]) > threshold) return false
    }
    return true
  }

  let newStart = match.startA
  for (let i = match.startA; i + sustain <= coarseEnd; i++) {
    if (isSustainedGood(i)) {
      newStart = i
      break
    }
  }

  let newEnd = coarseEnd
  for (let i = coarseEnd - sustain; i >= newStart; i--) {
    if (isSustainedGood(i)) {
      newEnd = i + sustain
      break
    }
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

function matchFingerprintRegions(a: FingerprintRegion, b: FingerprintRegion): RegionMatch | null {
  if (a.lengthHashes <= 0 || b.lengthHashes <= 0) return null
  const minHashesPerSec = Math.min(a.fingerprint.hashesPerSec, b.fingerprint.hashesPerSec)
  const windowHashes = Math.max(8, Math.round(WINDOW_SECONDS * minHashesPerSec))
  const minRunHashes = Math.max(windowHashes + 1, Math.round(MIN_RUN_SECONDS * minHashesPerSec))
  const coarse = findBestMatch(
    a.fingerprint.hashes,
    a.offsetHashes,
    a.lengthHashes,
    b.fingerprint.hashes,
    b.offsetHashes,
    b.lengthHashes,
    windowHashes,
    minRunHashes,
    MATCH_BIT_THRESHOLD
  )
  if (!coarse) return null
  const refined = refineMatch(
    a.fingerprint.hashes,
    b.fingerprint.hashes,
    coarse,
    REFINE_BIT_THRESHOLD,
    REFINE_SUSTAIN_HASHES
  )
  return {
    startSecA: a.sourceOffsetSec + (refined.startA - a.offsetHashes) / a.fingerprint.hashesPerSec,
    startSecB: b.sourceOffsetSec + (refined.startB - b.offsetHashes) / b.fingerprint.hashesPerSec,
    lengthSecA: refined.length / a.fingerprint.hashesPerSec,
    lengthSecB: refined.length / b.fingerprint.hashesPerSec
  }
}

interface PerEpisodeSamples {
  opStart: number[]
  opLength: number[]
  edStart: number[] // counted from start (not end) for consistency
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

  // Phase 1: fingerprint each episode (use cache when available). A single
  // episode that can't be decoded (even after the FFmpeg WAV fallback) is
  // skipped rather than aborting the whole show — pairwise matching only needs
  // two good episodes to find the OP/ED.
  const loaded: LoadedEpisode[] = []
  const failures: { episodeLabel: string; message: string }[] = []
  for (let i = 0; i < episodes.length; i++) {
    if (opts.signal?.aborted) throw new Error('analysis cancelled')
    opts.onProgress?.({
      phase: 'fingerprinting',
      current: i,
      total: episodes.length,
      episodeLabel: episodes[i].episodeLabel
    })
    try {
      const fp = await getFingerprint(animeId, episodes[i], opts)
      loaded.push({ ...episodes[i], fingerprint: fp })
    } catch (err) {
      if (opts.signal?.aborted) throw new Error('analysis cancelled')
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ episodeLabel: episodes[i].episodeLabel, message })
      console.warn(
        `[skip-detector] skipping ${episodes[i].episodeLabel}: fingerprinting failed (${message})`
      )
    }
    opts.onProgress?.({
      phase: 'fingerprinting',
      current: i + 1,
      total: episodes.length,
      episodeLabel: episodes[i].episodeLabel
    })
  }

  if (loaded.length < 2) {
    const detail = failures.map((f) => `${f.episodeLabel}: ${f.message}`).join('; ')
    throw new Error(
      `Could not fingerprint enough episodes (${loaded.length} of ${episodes.length} succeeded)` +
        (detail ? ` — ${detail}` : '')
    )
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
    // OP region: search the first 8 minutes of each episode
    const opRegionHashesA = Math.min(
      a.fingerprint.hashes.length,
      Math.round(a.fingerprint.hashesPerSec * SEARCH_REGION_SECONDS)
    )
    const opRegionHashesB = Math.min(
      b.fingerprint.hashes.length,
      Math.round(b.fingerprint.hashesPerSec * SEARCH_REGION_SECONDS)
    )
    const opMatch = matchFingerprintRegions(
      {
        fingerprint: a.fingerprint,
        offsetHashes: 0,
        lengthHashes: opRegionHashesA,
        sourceOffsetSec: 0
      },
      {
        fingerprint: b.fingerprint,
        offsetHashes: 0,
        lengthHashes: opRegionHashesB,
        sourceOffsetSec: 0
      }
    )
    if (opMatch) {
      const sA = samplesByEpisode.get(a.episodeInt)!
      const sB = samplesByEpisode.get(b.episodeInt)!
      sA.opStart.push(opMatch.startSecA)
      sA.opLength.push(opMatch.lengthSecA)
      sB.opStart.push(opMatch.startSecB)
      sB.opLength.push(opMatch.lengthSecB)
    }

    // ED region: search the last 8 minutes of each episode
    const edRegionHashesA = Math.min(
      a.fingerprint.hashes.length,
      Math.round(a.fingerprint.hashesPerSec * SEARCH_REGION_SECONDS)
    )
    const edRegionHashesB = Math.min(
      b.fingerprint.hashes.length,
      Math.round(b.fingerprint.hashesPerSec * SEARCH_REGION_SECONDS)
    )
    const edStartA = a.fingerprint.hashes.length - edRegionHashesA
    const edStartB = b.fingerprint.hashes.length - edRegionHashesB
    const edMatch = matchFingerprintRegions(
      {
        fingerprint: a.fingerprint,
        offsetHashes: edStartA,
        lengthHashes: edRegionHashesA,
        sourceOffsetSec: edStartA / a.fingerprint.hashesPerSec
      },
      {
        fingerprint: b.fingerprint,
        offsetHashes: edStartB,
        lengthHashes: edRegionHashesB,
        sourceOffsetSec: edStartB / b.fingerprint.hashesPerSec
      }
    )
    // Suppress duplicate detection of the OP showing through into ED region (rare with the offsets above, but possible for short shows)
    if (edMatch) {
      const sA = samplesByEpisode.get(a.episodeInt)!
      const sB = samplesByEpisode.get(b.episodeInt)!
      sA.edStart.push(edMatch.startSecA)
      sA.edLength.push(edMatch.lengthSecA)
      sB.edStart.push(edMatch.startSecB)
      sB.edLength.push(edMatch.lengthSecB)
    }
  }
  opts.onProgress?.({ phase: 'comparing', current: pairs.length, total: pairs.length })

  // Aggregate per-episode boundaries via median
  const perEpisode: Record<string, EpisodeSkipDetection> = {}
  for (const ep of loaded) {
    const samples = samplesByEpisode.get(ep.episodeInt)!
    const op: SkipRange | null =
      samples.opStart.length === 0
        ? null
        : {
            startSec: median(samples.opStart),
            endSec: median(samples.opStart) + median(samples.opLength),
            pairCount: samples.opStart.length
          }
    const ed: SkipRange | null =
      samples.edStart.length === 0
        ? null
        : {
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
      source: 'local',
      sampleRate: 11025,
      matchBitThreshold: MATCH_BIT_THRESHOLD,
      minRunSec: MIN_RUN_SECONDS,
      windowSec: WINDOW_SECONDS,
      refineBitThreshold: REFINE_BIT_THRESHOLD,
      refineSustainHashes: REFINE_SUSTAIN_HASHES
    }
  }
}

function killChild(proc: ChildProcess | null): void {
  if (!proc || proc.killed) return
  try {
    proc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}

async function runChild(
  command: string,
  args: string[],
  opts?: { signal?: AbortSignal }
): Promise<void> {
  let proc: ChildProcess | null = null
  if (opts?.signal?.aborted) throw new Error('operation cancelled')
  const onAbort = (): void => killChild(proc)
  opts?.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      proc.on('error', reject)
      proc.on('exit', (code, signal) => {
        if (signal === 'SIGKILL') {
          reject(new Error('operation cancelled'))
          return
        }
        if (code !== 0) {
          reject(
            new Error(`${path.basename(command)} exited ${code}: ${stderr.trim() || 'no stderr'}`)
          )
          return
        }
        resolve()
      })
    })
  } finally {
    opts?.signal?.removeEventListener('abort', onAbort)
    killChild(proc)
  }
}

async function probeDurationSec(
  sourcePath: string,
  ffprobePath: string,
  signal?: AbortSignal
): Promise<number | null> {
  let proc: ChildProcess | null = null
  if (signal?.aborted) throw new Error('operation cancelled')
  const onAbort = (): void => killChild(proc)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await new Promise<number | null>((resolve, reject) => {
      proc = spawn(
        ffprobePath,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          sourcePath
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      proc.on('error', reject)
      proc.on('exit', (code, exitSignal) => {
        if (exitSignal === 'SIGKILL') {
          reject(new Error('operation cancelled'))
          return
        }
        if (code !== 0) {
          reject(new Error(`ffprobe exited ${code}: ${stderr.trim() || 'no stderr'}`))
          return
        }
        const value = Number(stdout.trim())
        resolve(Number.isFinite(value) && value > 0 ? value : null)
      })
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    killChild(proc)
  }
}

async function fingerprintStreamClip(
  streamUrl: string,
  ffmpegPath: string,
  fpcalcPath: string,
  mode: 'start' | 'end',
  clipLengthSec: number,
  streamDurationSec: number | null,
  signal?: AbortSignal,
  userAgent?: string
): Promise<{ fingerprint: Fingerprint; offsetSec: number }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-dl-skip-stream-'))
  const outputPath = path.join(tmpDir, `${mode}.wav`)
  try {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin']
    if (userAgent) {
      args.push('-user_agent', userAgent)
    }
    if (mode === 'end') {
      if (!streamDurationSec) throw new Error('stream duration required for end-clip detection')
      // NOTE: -sseof requires the server to expose Content-Length / seekable range.
      // This works for direct MP4 CDN URLs but would fail silently for HLS/m3u8 sources.
      args.push('-sseof', `-${clipLengthSec}`)
    }
    args.push(
      '-i',
      streamUrl,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '11025',
      '-c:a',
      'pcm_s16le',
      '-t',
      String(clipLengthSec),
      outputPath
    )
    await runChild(ffmpegPath, args, { signal })
    const fingerprint = await fingerprintFile(fpcalcPath, outputPath, { signal })
    const offsetSec =
      mode === 'end' && streamDurationSec
        ? Math.max(0, streamDurationSec - fingerprint.durationSec)
        : 0
    return { fingerprint, offsetSec }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

async function loadEpisodeFingerprint(
  animeId: number,
  ep: EpisodeSkipDetection,
  opts: DetectStreamOptions
): Promise<Fingerprint | null> {
  if (!ep.filePath) return null
  try {
    return await getFingerprint(
      animeId,
      {
        episodeInt: ep.episodeInt,
        episodeLabel: ep.episodeLabel,
        filePath: ep.filePath
      },
      opts
    )
  } catch {
    return null
  }
}

async function detectStreamRange(
  animeId: number,
  kind: 'op' | 'ed',
  clip: { fingerprint: Fingerprint; offsetSec: number },
  detections: ShowSkipDetections,
  opts: DetectStreamOptions
): Promise<SkipRange | null> {
  const starts: number[] = []
  const lengths: number[] = []
  for (const ep of Object.values(detections.perEpisode)) {
    const range = kind === 'op' ? ep.op : ep.ed
    if (!range) continue
    const localFingerprint = await loadEpisodeFingerprint(animeId, ep, opts)
    if (!localFingerprint) continue
    const startHash = Math.max(0, Math.round(range.startSec * localFingerprint.hashesPerSec))
    const endHash = Math.min(
      localFingerprint.hashes.length,
      Math.round(range.endSec * localFingerprint.hashesPerSec)
    )
    const match = matchFingerprintRegions(
      {
        fingerprint: clip.fingerprint,
        offsetHashes: 0,
        lengthHashes: clip.fingerprint.hashes.length,
        sourceOffsetSec: clip.offsetSec
      },
      {
        fingerprint: localFingerprint,
        offsetHashes: startHash,
        lengthHashes: Math.max(0, endHash - startHash),
        sourceOffsetSec: range.startSec
      }
    )
    if (!match) continue
    starts.push(match.startSecA)
    lengths.push(match.lengthSecA)
  }
  if (starts.length < MIN_STREAM_MATCHES) return null
  const startSec = median(starts)
  return {
    startSec,
    endSec: startSec + median(lengths),
    pairCount: starts.length
  }
}

export async function detectStream(
  animeId: number,
  episodeInt: string,
  streamUrl: string,
  detections: ShowSkipDetections,
  opts: DetectStreamOptions
): Promise<EpisodeSkipDetection | null> {
  const streamDurationSec = opts.ffprobePath
    ? await probeDurationSec(streamUrl, opts.ffprobePath, opts.signal).catch(() => null)
    : null
  const opCandidates = Object.values(detections.perEpisode).some((ep) => !!ep.op)
  const edCandidates = Object.values(detections.perEpisode).some((ep) => !!ep.ed)

  let op: SkipRange | null = null
  let ed: SkipRange | null = null
  let opFingerprint: Fingerprint | null = null
  let edFingerprint: Fingerprint | null = null

  if (opCandidates) {
    try {
      const clip = await fingerprintStreamClip(
        streamUrl,
        opts.ffmpegPath,
        opts.fpcalcPath,
        'start',
        SEARCH_REGION_SECONDS,
        streamDurationSec,
        opts.signal,
        opts.userAgent
      )
      opFingerprint = clip.fingerprint
      op = await detectStreamRange(animeId, 'op', clip, detections, opts)
    } catch {
      op = null
    }
  }

  if (edCandidates && streamDurationSec) {
    try {
      const clip = await fingerprintStreamClip(
        streamUrl,
        opts.ffmpegPath,
        opts.fpcalcPath,
        'end',
        SEARCH_REGION_SECONDS,
        streamDurationSec,
        opts.signal,
        opts.userAgent
      )
      edFingerprint = clip.fingerprint
      ed = await detectStreamRange(animeId, 'ed', clip, detections, opts)
    } catch {
      ed = null
    }
  } else if (edCandidates && !streamDurationSec) {
    console.warn(
      '[skip-detector] ED detection skipped: stream duration unavailable (ffprobe missing or probe failed)'
    )
  }

  if (!op && !ed) return null
  return {
    episodeInt,
    episodeLabel: `Episode ${episodeInt}`,
    filePath: '',
    durationSec: streamDurationSec ?? 0,
    hashesPerSec: opFingerprint?.hashesPerSec ?? edFingerprint?.hashesPerSec ?? 0,
    op,
    ed
  }
}
