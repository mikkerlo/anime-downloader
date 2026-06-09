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

import { analyzeShow, type EpisodeInput } from '../../src/main/skip-detector'

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
