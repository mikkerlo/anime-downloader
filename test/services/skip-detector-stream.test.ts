import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

// `fingerprintStreamClip` and `probeDurationSec` are module-private; the only
// exported entry into that path is `detectStream`. Same seam as
// `skip-detector-fingerprint.test.ts` — mock `child_process` and drive the real
// exported function — but in its own file, because that one's default
// `spawnMock` behavior is tuned for `analyzeShow`.
const spawnMock = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

import {
  detectStream,
  type ShowSkipDetections,
  type EpisodeSkipDetection
} from '../../src/main/skip-detector'

// A production `activeStreamUrl` is `embed.stream[].urls[0]`, which
// `docs/smotret-api.md` documents as a direct CDN file (and which
// `download-manager.ts` fetches with a plain `fetch` piped to disk — only valid
// for a progressive file). Not the `.m3u8` placeholder the renderer tests use.
const STREAM_URL = 'https://cdn.smotret-anime.example/videos/42/1/1080.mp4'

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const VALID_FPCALC_STDOUT = `DURATION=480\nFINGERPRINT=${Array.from(
  { length: 12 },
  (_, i) => i + 1
).join(',')}\n`

let ffmpegCalls: string[][]
let ffprobeCalls: string[][]

function ep(episodeInt: string): EpisodeSkipDetection {
  return {
    episodeInt,
    episodeLabel: `Episode ${episodeInt}`,
    filePath: `/fake/ep${episodeInt}.mkv`,
    durationSec: 1440,
    hashesPerSec: 8,
    op: { startSec: 60, endSec: 150, pairCount: 3 },
    ed: { startSec: 1290, endSec: 1380, pairCount: 3 }
  }
}

function detections(): ShowSkipDetections {
  return {
    animeId: 42,
    perEpisode: { '1': ep('1'), '2': ep('2') },
    analyzedAt: 1,
    episodeCount: 2,
    algorithm: {
      source: 'local',
      sampleRate: 11025,
      matchBitThreshold: 6,
      minRunSec: 18,
      windowSec: 6,
      refineBitThreshold: 4,
      refineSustainHashes: 5
    }
  } as unknown as ShowSkipDetections
}

const baseOpts = {
  fpcalcPath: '/fake/fpcalc',
  ffmpegPath: '/fake/ffmpeg',
  ffprobePath: '/fake/ffprobe',
  loadCachedFingerprint: () => undefined,
  saveCachedFingerprint: (): void => {}
}

describe('detectStream remote read timeout (#222)', () => {
  beforeEach(() => {
    ffmpegCalls = []
    ffprobeCalls = []
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const proc = new FakeProc()
      if (command.includes('ffprobe')) {
        ffprobeCalls.push(args)
        // A parseable duration is a precondition, not decoration: without it
        // `streamDurationSec` is null and the ED ffmpeg vector never runs.
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.from('1440.5\n'))
          proc.emit('exit', 0, null)
        })
      } else if (command.includes('ffmpeg')) {
        ffmpegCalls.push(args)
        setImmediate(() => proc.emit('exit', 0, null))
      } else {
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.from(VALID_FPCALC_STDOUT))
          proc.emit('exit', 0, null)
        })
      }
      return proc
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // Asserted on the recorded argv, never on the return value: `detectStream`
  // swallows everything downstream of the clip passes.
  it('passes -rw_timeout before -i on the remote ffmpeg clip vectors', async () => {
    await detectStream(42, '1', STREAM_URL, detections(), baseOpts)

    // Both the OP (`start`) and ED (`-sseof`) clips.
    expect(ffmpegCalls.length).toBe(2)
    for (const args of ffmpegCalls) {
      const optIdx = args.indexOf('-rw_timeout')
      expect(optIdx).toBeGreaterThanOrEqual(0)
      expect(args[optIdx + 1]).toBe('20000000')
      // Input option: misplaced after `-i`, ffmpeg reads it as an output
      // option and it silently does nothing.
      expect(optIdx).toBeLessThan(args.indexOf('-i'))
    }
    expect(ffmpegCalls.some((a) => a.includes('-sseof'))).toBe(true)
  })

  it('passes -rw_timeout before the trailing positional URL in the ffprobe vector', async () => {
    await detectStream(42, '1', STREAM_URL, detections(), baseOpts)

    expect(ffprobeCalls.length).toBe(1)
    const args = ffprobeCalls[0]
    // ffprobe takes no `-i` — the source is the last argument, so the shape of
    // the assertion differs from the ffmpeg one on purpose.
    expect(args[args.length - 1]).toBe(STREAM_URL)
    expect(args[args.length - 3]).toBe('-rw_timeout')
    expect(args[args.length - 2]).toBe('20000000')
  })

  it('omits -rw_timeout for a non-remote source', async () => {
    await detectStream(42, '1', '/local/path/episode.mp4', detections(), baseOpts)

    expect(ffprobeCalls.length).toBe(1)
    expect(ffprobeCalls[0]).not.toContain('-rw_timeout')
    expect(ffmpegCalls.length).toBeGreaterThan(0)
    for (const args of ffmpegCalls) {
      expect(args).not.toContain('-rw_timeout')
    }
  })
})
