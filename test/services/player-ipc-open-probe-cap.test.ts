// #560 review: an open at T = 0 now probes for the B-frame delay instead of
// replying 0 at once. The probe runs real (fake-binary) ffmpeg/ffprobe
// processes, and the file-head probe alone has a 10 s timeout, so a probe that
// hangs on an odd file must not hold the open's reply that long. The open
// waits at most OPEN_AT_ZERO_PROBE_CAP_MS and then replies 0, the old value.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { register, OPEN_AT_ZERO_PROBE_CAP_MS } from '../../src/main/ipc/player.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { createStreamingService, type MkvProbeResult } from '../../src/main/streaming'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const mkEvent = (): unknown => ({
  sender: { id: 1, isDestroyed: (): boolean => false, send: (): void => {} }
})

const PROBE: MkvProbeResult = {
  duration: 1420,
  videoCodec: 'h264',
  audioCodecName: 'aac',
  audioStrategy: 'copy',
  streamCopyMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  audioCodecString: 'mp4a.40.2'
}

// The first GOP of a B-frame source as the fake ffprobe reports it: the NUT
// probe reads the keyframe at 0 as 0.083, the fMP4 replica emits it at 0.083,
// and the file's own first packets are a keyframe at 0 and audio at 0.062.
const MEASURING_FFPROBE =
  '#!/bin/sh\ncase "$*" in\n' +
  '  *" nut "*"a:0"*) echo 0.145 ;;\n  *" nut "*) echo 0.083 ;;\n' +
  '  *" mp4 "*) echo 0.083 ;;\n' +
  '  *"v:0 -read_intervals %+2 "*) printf "0.000000,K__\\n4.000000,K__\\n" ;;\n' +
  '  *"a:0 -read_intervals %+#1 "*) echo 0.062000 ;;\nesac\n'

// Prints nothing for longer than the cap: every probe process just waits.
const HANGING_FFPROBE = '#!/bin/sh\nsleep 3\n'

describe('player.ipc — the open at T = 0 waits a capped time for its offset probe (#560)', () => {
  let dir: string
  let ffprobe: string
  let handlers: Map<string, Handler>
  let mkvPath: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-open-cap-'))
    mkvPath = path.join(dir, 'show.mkv')
    fs.writeFileSync(mkvPath, 'not a real mkv')
    const ffmpeg = path.join(dir, 'ffmpeg')
    ffprobe = path.join(dir, 'ffprobe')
    fs.writeFileSync(ffmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const real = createStreamingService({
      getFfmpegPath: () => ffmpeg,
      getFfprobePath: () => ffprobe,
      channels: { streamChunk: 'sc', streamEnd: 'se', streamError: 'sx', streamProgress: 'sp' }
    })
    const streamingService = {
      tmpDir: path.join(dir, 'remux'),
      probeMkvForMse: vi.fn().mockResolvedValue(PROBE),
      // The real probes, run against the fake binaries above.
      probeCopyTimestampOffset: real.probeCopyTimestampOffset,
      probeSeekAnchor: vi.fn().mockResolvedValue(0),
      pickH264Encoder: vi.fn().mockResolvedValue({ name: 'libx264' }),
      registerSession: vi.fn(),
      cleanupSession: vi.fn(),
      spawnFfmpegForSession: vi.fn().mockReturnValue({ kill: vi.fn() })
    }
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register({
      store: new InMemoryStorage({ hevcTranscodeOnPlay: 'ask' }),
      streamingService,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      getFfmpegPath: () => ffmpeg,
      // Empty skips the handler's own subtitle ffprobe.
      getFfprobePath: () => '',
      attachedLibraryService: { spawnPathFor: (p: string) => p }
    } as unknown as AppDeps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function openCopyAtZero(): Promise<{ res: Record<string, unknown>; ms: number }> {
    const t0 = Date.now()
    const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(
      mkEvent(),
      mkvPath,
      0
    )) as Record<string, unknown>
    return { res, ms: Date.now() - t0 }
  }

  it('replies with the measured negative offset when the probe answers', async () => {
    fs.writeFileSync(ffprobe, MEASURING_FFPROBE, { mode: 0o755 })
    const { res, ms } = await openCopyAtZero()
    expect(res.contentStart).toBeCloseTo(-0.083, 3)
    expect(ms).toBeLessThan(OPEN_AT_ZERO_PROBE_CAP_MS)
    expect(warn).not.toHaveBeenCalled()
  })

  it('replies 0 at the cap when the probe hangs', async () => {
    fs.writeFileSync(ffprobe, HANGING_FFPROBE, { mode: 0o755 })
    const { res, ms } = await openCopyAtZero()
    // Without the cap this waits for the fake's 3 s sleep (and up to the
    // file-head probe's 10 s timeout on a real hang).
    expect(res.contentStart).toBe(0)
    expect(ms).toBeGreaterThanOrEqual(OPEN_AT_ZERO_PROBE_CAP_MS - 50)
    expect(ms).toBeLessThan(OPEN_AT_ZERO_PROBE_CAP_MS + 1000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offset probe at 0 took over'))
  }, 10_000)
})
