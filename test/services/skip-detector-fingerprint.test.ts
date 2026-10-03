import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock child_process.spawn so we can simulate fpcalc/ffmpeg without binaries.
// Both fingerprint.ts and skip-detector.ts import spawn from 'child_process'.
const spawnMock = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

import { analyzeShow, computeSearchWindows, type EpisodeInput } from '../../src/main/skip-detector'
import { popcount32 } from '../../src/main/fingerprint'

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

// Emit a canned exit asynchronously, mirroring how a real child reports results.
function emit(proc: FakeProc, opts: { stdout?: string; stderr?: string; code: number }): void {
  setImmediate(() => {
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout))
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr))
    proc.emit('exit', opts.code, null)
  })
}

const VALID_FPCALC_STDOUT = `DURATION=100\nFINGERPRINT=${Array.from({ length: 12 }, (_, i) => i + 1).join(',')}\n`

let tmpRoot: string
let ffmpegCalls: string[][]

function makeEpisode(name: string): EpisodeInput {
  const filePath = path.join(tmpRoot, name)
  fs.writeFileSync(filePath, 'x')
  return { episodeInt: name.replace(/\D/g, ''), episodeLabel: `Episode ${name}`, filePath }
}

const baseOpts = {
  fpcalcPath: '/fake/fpcalc',
  loadCachedFingerprint: () => undefined,
  saveCachedFingerprint: () => {}
}

describe('analyzeShow fingerprinting resilience', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-fp-test-'))
    ffmpegCalls = []
    // Default behavior:
    // - fpcalc fails (exit 3, decode error) on any `.mkv` whose basename starts
    //   with "bad" or "corrupt"; succeeds elsewhere (good mkvs, decoded .wav).
    // - ffmpeg decode fails (exit 1) when its input basename starts with
    //   "corrupt", simulating a file even the full FFmpeg can't decode.
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const proc = new FakeProc()
      const target = args[args.length - 1] ?? ''
      if (command.includes('ffmpeg')) {
        ffmpegCalls.push(args)
        const inputPath = args[args.indexOf('-i') + 1] ?? ''
        if (path.basename(inputPath).startsWith('corrupt')) {
          emit(proc, { stderr: 'Invalid data found when processing input', code: 1 })
        } else {
          emit(proc, { code: 0 })
        }
      } else if (target.endsWith('.mkv') && /^(bad|corrupt)/.test(path.basename(target))) {
        emit(proc, {
          stderr: 'ERROR: Error decoding audio frame (Invalid data found when processing input)',
          code: 3
        })
      } else {
        emit(proc, { stdout: VALID_FPCALC_STDOUT, code: 0 })
      }
      return proc
    })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('falls back to FFmpeg WAV decode when fpcalc rejects a file, producing a fingerprint', async () => {
    const episodes = [makeEpisode('good1.mkv'), makeEpisode('bad03.mkv')]
    const result = await analyzeShow(1, episodes, {
      ...baseOpts,
      ffmpegPath: '/fake/ffmpeg'
    })
    // Both episodes fingerprinted — the bad one via the FFmpeg fallback.
    expect(Object.keys(result.perEpisode).sort()).toEqual(['03', '1'])
    expect(result.perEpisode['03'].durationSec).toBe(100)
    // FFmpeg was invoked exactly once (only for the failing episode).
    expect(ffmpegCalls.length).toBe(1)
    expect(ffmpegCalls[0]).toContain('-vn')
  })

  it('skips an undecodable episode instead of failing the whole show when no ffmpeg fallback exists', async () => {
    const episodes = [makeEpisode('good1.mkv'), makeEpisode('good2.mkv'), makeEpisode('bad3.mkv')]
    const result = await analyzeShow(1, episodes, baseOpts) // no ffmpegPath
    expect(Object.keys(result.perEpisode).sort()).toEqual(['1', '2'])
    expect(ffmpegCalls.length).toBe(0)
  })

  it('throws a descriptive error when fewer than 2 episodes can be fingerprinted', async () => {
    const episodes = [makeEpisode('bad1.mkv'), makeEpisode('bad2.mkv')]
    await expect(analyzeShow(1, episodes, baseOpts)).rejects.toThrow(
      /Could not fingerprint enough episodes \(0 of 2 succeeded\)/
    )
  })

  it('skips an episode when the FFmpeg fallback is attempted but also fails to decode', async () => {
    const episodes = [
      makeEpisode('good1.mkv'),
      makeEpisode('good2.mkv'),
      makeEpisode('corrupt3.mkv')
    ]
    const result = await analyzeShow(1, episodes, { ...baseOpts, ffmpegPath: '/fake/ffmpeg' })
    // The corrupt episode is dropped; the rest of the show still analyzes.
    expect(Object.keys(result.perEpisode).sort()).toEqual(['1', '2'])
    // The fallback was actually attempted for the corrupt episode.
    expect(ffmpegCalls.length).toBe(1)
  })

  it('throws when the FFmpeg fallback also fails on too many episodes', async () => {
    const episodes = [makeEpisode('corrupt1.mkv'), makeEpisode('corrupt2.mkv')]
    await expect(
      analyzeShow(1, episodes, { ...baseOpts, ffmpegPath: '/fake/ffmpeg' })
    ).rejects.toThrow(/Could not fingerprint enough episodes \(0 of 2 succeeded\)/)
  })
})

// --- #477: OP/ED search-window geometry ---------------------------------------
//
// Short episodes used to hand both passes the same slice, so `findBestMatch`
// returned the same (longest) run to both slots and `op` was reported at the
// ending's offsets. These drive the real `analyzeShow` against synthetic hash
// arrays — no audio, no real fpcalc — plus the window arithmetic directly.

// `MATCH_BIT_THRESHOLD` in src/main/skip-detector.ts. Not exported; mirrored
// here only so the fixture can assert its own filler is far clear of it.
const MATCH_BIT_THRESHOLD = 6
// Pinning the hash rate makes every offset below exact: `src/main/fingerprint.ts`
// derives `hashesPerSec` as `hashes.length / durationSec`, so a DURATION of 300
// with 2400 hashes is exactly 8.0.
const HASHES_PER_SEC = 8

// mulberry32. Deliberately NOT a plain LCG: a cheap LCG's low bits are
// correlated enough that two "distinct" filler streams drift inside
// MATCH_BIT_THRESHOLD and the detector reports a spurious multi-minute match —
// a fixture artefact that looks exactly like a detector bug.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}

interface PlantedSegment {
  startSec: number
  endSec: number
  // Shared across episodes when the seed matches: that is what makes a segment
  // "the same OP" rather than "two different openings".
  seed: number
}

function synthEpisodeHashes(
  durationSec: number,
  fillerSeed: number,
  planted: PlantedSegment[]
): Uint32Array {
  const hashCount = durationSec * HASHES_PER_SEC
  const hashes = new Uint32Array(hashCount)
  const filler = mulberry32(fillerSeed)
  for (let i = 0; i < hashCount; i++) hashes[i] = filler()
  for (const seg of planted) {
    const start = Math.round(seg.startSec * HASHES_PER_SEC)
    const end = Math.min(hashCount, Math.round(seg.endSec * HASHES_PER_SEC))
    const shared = mulberry32(seg.seed)
    for (let i = start; i < end; i++) hashes[i] = shared()
  }
  return hashes
}

function fpcalcStdout(durationSec: number, hashes: Uint32Array): string {
  return `DURATION=${durationSec}\nFINGERPRINT=${Array.from(hashes).join(',')}\n`
}

function meanBitDistance(a: Uint32Array, b: Uint32Array, from: number, to: number): number {
  let total = 0
  for (let i = from; i < to; i++) total += popcount32(a[i] ^ b[i])
  return total / (to - from)
}

describe('analyzeShow OP/ED search windows (#477)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-windows-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  // Wire two synthetic episodes into the shared spawn mock and run the detector.
  async function runPair(durationSec: number, planted: PlantedSegment[]) {
    const hashesA = synthEpisodeHashes(durationSec, 0x11111111, planted)
    const hashesB = synthEpisodeHashes(durationSec, 0x77777777, planted)

    const stdoutByBasename = new Map<string, string>([
      ['ep1.mkv', fpcalcStdout(durationSec, hashesA)],
      ['ep2.mkv', fpcalcStdout(durationSec, hashesB)]
    ])
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const proc = new FakeProc()
      const target = args[args.length - 1] ?? ''
      emit(proc, { stdout: stdoutByBasename.get(path.basename(target)) ?? '', code: 0 })
      return proc
    })

    const episodes: EpisodeInput[] = ['ep1.mkv', 'ep2.mkv'].map((name) => {
      const filePath = path.join(tmpDir, name)
      fs.writeFileSync(filePath, 'x')
      return { episodeInt: name.replace(/\D/g, ''), episodeLabel: `Episode ${name}`, filePath }
    })

    const result = await analyzeShow(1, episodes, {
      fpcalcPath: '/fake/fpcalc',
      loadCachedFingerprint: () => undefined,
      saveCachedFingerprint: () => {}
    })

    // Fixture self-check: the un-planted filler of the two episodes must be far
    // clear of MATCH_BIT_THRESHOLD, so a failure below is the detector's and not
    // the generator's. Measured over the stretch between the planted segments;
    // contiguous segments leave no filler to measure, so the check is skipped
    // rather than dividing by a zero-width gap and reporting `NaN`.
    const gapFrom = Math.round(planted[0].endSec * HASHES_PER_SEC)
    const gapTo = Math.round(planted[planted.length - 1].startSec * HASHES_PER_SEC)
    const fillerMeanBits =
      gapTo > gapFrom ? meanBitDistance(hashesA, hashesB, gapFrom, gapTo) : Number.POSITIVE_INFINITY

    return {
      op: result.perEpisode['1'].op,
      ed: result.perEpisode['1'].ed,
      fillerMeanBits
    }
  }

  // The ED is deliberately LONGER than the OP. `findBestMatch` keeps the first
  // run on ties (`length > best.length`), and an OP and an ED planted at
  // identical offsets in both episodes sit on the same diagonal, so an
  // equal-length fixture would pass on the pre-fix code by luck and prove
  // nothing. Making the ED the longer run is what forces the pre-fix
  // single-slice search to hand the ending to the `op` slot.
  it('reports the opening in the op slot on a 300 s episode whose ED is longer than its OP', async () => {
    const { op, ed, fillerMeanBits } = await runPair(300, [
      { startSec: 0, endSec: 30, seed: 0xa5a5a5a5 },
      { startSec: 255, endSec: 300, seed: 0x5a5a5a5a }
    ])

    expect(fillerMeanBits).toBeGreaterThan(MATCH_BIT_THRESHOLD * 2)

    // Pre-fix: op === ed === ~[255, 300] — the planted opening is reported
    // nowhere and "Skip OP" jumps into the credits.
    expect(op).not.toBeNull()
    expect(ed).not.toBeNull()
    expect(op!.startSec).toBeCloseTo(0, 0)
    expect(op!.endSec).toBeGreaterThan(20)
    expect(op!.endSec).toBeLessThan(150)
    expect(ed!.startSec).toBeCloseTo(255, 0)
    expect(ed!.endSec).toBeCloseTo(300, 0)
    // The single clearest statement of the defect.
    expect(op!.startSec).not.toBeCloseTo(ed!.startSec, 0)
  }, 30_000)

  // The other direction, and the one the original "who is affected" condition
  // missed: at 540 s the windows merely overlap rather than coincide, and the
  // head of the ED that falls inside [0, 480) is longer than the 20 s OP, so
  // the `op` slot took it. Pre-fix this reports op [450, 480].
  it('reports the opening in the op slot on a 540 s episode whose ED head reaches into the OP window', async () => {
    const { op, ed, fillerMeanBits } = await runPair(540, [
      { startSec: 0, endSec: 20, seed: 0xc3c3c3c3 },
      { startSec: 450, endSec: 540, seed: 0x3c3c3c3c }
    ])

    expect(fillerMeanBits).toBeGreaterThan(MATCH_BIT_THRESHOLD * 2)

    expect(op).not.toBeNull()
    expect(ed).not.toBeNull()
    expect(op!.startSec).toBeCloseTo(0, 0)
    expect(op!.endSec).toBeLessThan(270)
    expect(ed!.startSec).toBeCloseTo(450, 0)
    expect(ed!.endSec).toBeCloseTo(540, 0)
    expect(op!.startSec).not.toBeCloseTo(ed!.startSec, 0)
  }, 30_000)

  // Non-regression: the arithmetic is shared by every duration, so a 1080 s
  // pair (already healthy before the fix) must come out unchanged.
  it('leaves a healthy 1080 s episode unchanged', async () => {
    const { op, ed } = await runPair(1080, [
      { startSec: 0, endSec: 90, seed: 0xdeadbeef },
      { startSec: 990, endSec: 1080, seed: 0xfeedface }
    ])

    expect(op!.startSec).toBeCloseTo(0, 0)
    expect(op!.endSec).toBeCloseTo(90, 0)
    expect(ed!.startSec).toBeCloseTo(990, 0)
    expect(ed!.endSec).toBeCloseTo(1080, 0)
  }, 60_000)

  // An episode too short to hold two MIN_RUN_SECONDS runs in disjoint halves
  // reports nothing rather than a window-edge range. No guard code backs this:
  // a slice shorter than `minRunHashes` cannot produce a qualifying run, and
  // one shorter than `windowHashes` is rejected by `findBestMatch` outright.
  it('reports null for both slots on a sub-36 s episode with shared content in both halves', async () => {
    const { op, ed } = await runPair(30, [
      { startSec: 0, endSec: 15, seed: 0x01020304 },
      { startSec: 15, endSec: 30, seed: 0x04030201 }
    ])
    expect(op).toBeNull()
    expect(ed).toBeNull()
  })
})

describe('computeSearchWindows (#477)', () => {
  // The invariant that replaces the runtime overlap guard: the OP and ED
  // windows never touch. `findBestMatch` searches only inside the slice it is
  // handed and `refineMatch` only moves edges inward, so disjoint windows are
  // the whole of the protection — this sweep is what stops a refactor from
  // quietly dropping it.
  it('keeps the OP and ED windows disjoint at every duration, per side', () => {
    const durations = [30, 120, 300, 480, 540, 570, 720, 960, 1080, 1440, 2880]
    // Rates differ per encode; the two sides of a pair are computed
    // independently, so the invariant is asserted per side, not per pair.
    const rates = [8, 8.0067, 11.3]
    let checked = 0
    for (const durationSec of durations) {
      for (const hashesPerSec of rates) {
        const hashCount = Math.round(durationSec * hashesPerSec)
        const w = computeSearchWindows(hashCount, hashesPerSec)
        expect(w.opOffsetHashes).toBe(0)
        expect(w.edOffsetHashes).toBeGreaterThanOrEqual(w.opOffsetHashes + w.opLengthHashes)
        expect(w.opLengthHashes + w.edLengthHashes).toBeLessThanOrEqual(hashCount)
        expect(w.edOffsetHashes + w.edLengthHashes).toBe(hashCount)
        checked++
      }
    }
    // Pin the count so a dropped loop bound cannot shrink the sweep silently.
    expect(checked).toBe(33)
  })

  it('puts the ED window off zero on a 300 s episode, where it used to start at 0', () => {
    const w = computeSearchWindows(2400, 8)
    expect(w.edOffsetHashes).toBe(1200)
    expect(w.opLengthHashes).toBe(1200)
    expect(w.edLengthHashes).toBe(1200)
  })

  it('splits a 720 s episode at the midpoint instead of overlapping at [0,480)/[240,720)', () => {
    const w = computeSearchWindows(5760, 8)
    // 360 s, not the 480 s / 240 s pair the pre-#477 arithmetic produced.
    expect(w.opLengthHashes).toBe(2880)
    expect(w.edOffsetHashes).toBe(2880)
  })

  it('leaves durations at or above 960 s exactly as they were', () => {
    // 1440 s: [0, 480) and [960, 1440).
    const long = computeSearchWindows(11520, 8)
    expect(long.opLengthHashes).toBe(3840)
    expect(long.edOffsetHashes).toBe(7680)
    expect(long.edLengthHashes).toBe(3840)
    // 960 s is the hinge: the midpoint and `duration - 480` coincide there.
    const hinge = computeSearchWindows(7680, 8)
    expect(hinge.opLengthHashes).toBe(3840)
    expect(hinge.edOffsetHashes).toBe(3840)
  })
})
