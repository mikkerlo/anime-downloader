// Regression test for the `hevcTranscodeOnPlay === 'always'` short-circuit:
// `player:remux-mkv-stream` must return `{ requiresTranscode: true }` BEFORE
// registering a session or spawning ffmpeg. The old flow spawned the full
// stream-copy session (probe, ffmpeg, subtitle extraction) and the renderer
// then SIGKILLed it all to start the transcode — wasted double startup on
// exactly the configuration that always transcodes.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { register } from '../../src/main/ipc/player.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'
import type { MkvProbeResult } from '../../src/main/streaming'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const mkEvent = (): unknown => ({
  sender: { id: 1, isDestroyed: (): boolean => false, send: (): void => {} }
})

function mkProbe(videoCodec: 'h264' | 'hevc'): MkvProbeResult {
  return {
    duration: 1420,
    videoCodec,
    audioCodecName: 'aac',
    audioStrategy: 'copy',
    streamCopyMimeType: `video/mp4; codecs="${videoCodec === 'hevc' ? 'hvc1.2.4.L120.90' : 'avc1.640028'}, mp4a.40.2"`,
    audioCodecString: 'mp4a.40.2'
  }
}

describe('player.ipc — hevcTranscodeOnPlay=always short-circuit', () => {
  let handlers: Map<string, Handler>
  let registerSession: ReturnType<typeof vi.fn>
  let spawnFfmpegForSession: ReturnType<typeof vi.fn>
  let mkvPath: string

  function setup(videoCodec: 'h264' | 'hevc', hevcPref: string): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-test-'))
    mkvPath = path.join(dir, 'show.mkv')
    fs.writeFileSync(mkvPath, 'not a real mkv')
    registerSession = vi.fn()
    spawnFfmpegForSession = vi.fn().mockReturnValue({ kill: vi.fn() })
    const streamingService = {
      tmpDir: path.join(dir, 'remux'),
      probeMkvForMse: vi.fn().mockResolvedValue(mkProbe(videoCodec)),
      probeCopyTimestampOffset: vi.fn().mockResolvedValue(0),
      registerSession,
      spawnFfmpegForSession
    }
    const deps = {
      store: new InMemoryStorage({ hevcTranscodeOnPlay: hevcPref }),
      streamingService,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      // Empty ffprobe path skips the fluent-ffmpeg subtitle probe, keeping the
      // test hermetic; ffmpeg must be non-empty to pass the availability gate.
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => ''
    } as unknown as AppDeps
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register(deps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
  }

  beforeEach(() => {
    setup('hevc', 'always')
  })

  it('returns requiresTranscode for HEVC + always, without spawning or registering a session', async () => {
    const res = await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath)
    expect(res).toEqual({ requiresTranscode: true })
    expect(registerSession).not.toHaveBeenCalled()
    expect(spawnFfmpegForSession).not.toHaveBeenCalled()
  })

  it('opens a normal copy session for HEVC when the preference is ask', async () => {
    setup('hevc', 'ask')
    const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(
      mkEvent(),
      mkvPath
    )) as Record<string, unknown>
    expect(res.requiresTranscode).toBeUndefined()
    expect(res.sessionId).toBeTruthy()
    expect(spawnFfmpegForSession).toHaveBeenCalledTimes(1)
  })

  it('opens a normal copy session for H.264 even when the preference is always', async () => {
    setup('h264', 'always')
    const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(
      mkEvent(),
      mkvPath
    )) as Record<string, unknown>
    expect(res.requiresTranscode).toBeUndefined()
    expect(res.sessionId).toBeTruthy()
    expect(spawnFfmpegForSession).toHaveBeenCalledTimes(1)
  })
})
