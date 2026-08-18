// #280 — session reaping across a player close.
//
// `player:cleanup-remux` is the ONLY reaper in the app: `player:closed` just
// releases the download lock, `cleanupAllSessions` has no production caller,
// and there is no idle sweep. That makes the ordering between a cleanup and a
// registration load-bearing, and this file drives the real `player.ipc.ts`
// router against a fake `ipcMain` + a stubbed streaming service to pin it.
//
// Two of the four cases are characterization tests that must keep passing after
// the fix: they are the executable form of "the renderer-side `unmounted`
// ladder is not optional", because the main-side generation self-reap provably
// cannot reach either.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'
import type { MkvProbeResult, MseSession } from '../../src/main/streaming'

// The legacy full-file remux drives fluent-ffmpeg directly. The fake writes the
// output file straight away and finishes on a timer, which is what lets a
// cleanup sweep land in the middle of a "copy".
const ffmpegRuns: { output: string; done: Promise<void> }[] = []
vi.mock('fluent-ffmpeg', () => {
  const Ffmpeg = (): Record<string, unknown> => {
    let output = ''
    let onEnd: (() => void) | undefined
    const builder: Record<string, unknown> = {
      outputOptions: () => builder,
      output: (p: string) => {
        output = p
        return builder
      },
      on: (evt: string, cb: () => void) => {
        if (evt === 'end') onEnd = cb
        return builder
      },
      run: () => {
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, 'remuxed bytes')
        ffmpegRuns.push({
          output,
          done: new Promise<void>((res) => setTimeout(() => (onEnd?.(), res()), 30))
        })
      }
    }
    return builder
  }
  Ffmpeg.setFfmpegPath = (): void => {}
  Ffmpeg.setFfprobePath = (): void => {}
  Ffmpeg.ffprobe = (_p: string, cb: (e: unknown, m: unknown) => void): void => cb(null, {})
  return { default: Ffmpeg }
})

// Imported after the mock so the router picks up the fake.
const { register } = await import('../../src/main/ipc/player.ipc')

type Handler = (event: unknown, ...args: unknown[]) => unknown

const mkEvent = (): unknown => ({
  sender: { id: 1, isDestroyed: (): boolean => false, send: (): void => {} }
})

function mkProbe(): MkvProbeResult {
  return {
    duration: 1420,
    videoCodec: 'h264',
    audioCodecName: 'aac',
    audioStrategy: 'copy',
    streamCopyMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    audioCodecString: 'mp4a.40.2'
  }
}

/** A streaming service with a REAL session map, so kills and leaks are countable. */
function mkStreamingService(tmpDir: string) {
  const sessions = new Map<string, MseSession>()
  const killed: string[] = []
  const spawned: string[] = []
  let probeGate: Promise<void> = Promise.resolve()
  return {
    handle: {
      tmpDir,
      probeMkvForMse: vi.fn(async () => {
        await probeGate
        return mkProbe()
      }),
      probeCopyTimestampOffset: vi.fn().mockResolvedValue(0),
      probeSeekAnchor: vi.fn().mockResolvedValue(0),
      pickH264Encoder: vi.fn().mockResolvedValue({ name: 'libx264' }),
      registerSession: vi.fn((id: string, s: MseSession) => sessions.set(id, s)),
      getSession: (id: string): MseSession | undefined => sessions.get(id),
      allSessionIds: (): string[] => [...sessions.keys()],
      cleanupSession: vi.fn((id: string) => {
        killed.push(id)
        sessions.delete(id)
      }),
      spawnFfmpegForSession: vi.fn((_s, _e, id: string) => {
        spawned.push(id)
        return { kill: vi.fn(), stdout: { isPaused: (): boolean => false } }
      })
    },
    sessions,
    killed,
    spawned,
    gate(p: Promise<void>): void {
      probeGate = p
    }
  }
}

describe('player.ipc — session reaping across a close (#280)', () => {
  let handlers: Map<string, Handler>
  let svc: ReturnType<typeof mkStreamingService>
  let closedFiles: string[]
  let mkvPath: string
  let tmpDir: string

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-reap-'))
    tmpDir = path.join(dir, 'remux')
    mkvPath = path.join(dir, 'show.mkv')
    fs.writeFileSync(mkvPath, 'not a real mkv')
    svc = mkStreamingService(tmpDir)
    closedFiles = []
    ffmpegRuns.length = 0
    const deps = {
      store: new InMemoryStorage({ hevcTranscodeOnPlay: 'ask' }),
      streamingService: svc.handle,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      playerLockService: {
        open: (): void => {},
        close: (f: string): void => void closedFiles.push(f)
      },
      // Empty ffprobe path skips the fluent-ffmpeg subtitle probe.
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => ''
    } as unknown as AppDeps
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register(deps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
  })

  it('leaves the session registered after player:closed — the lock service is not a reaper', async () => {
    const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath)) as {
      sessionId: string
    }
    expect(res.sessionId).toBeTruthy()
    expect(svc.spawned).toHaveLength(1)

    await handlers.get(CHANNELS.PLAYER_CLOSED)!(mkEvent(), mkvPath)

    // Characterization: `player:closed` only releases the download lock. The
    // renderer MUST issue `player:cleanup-remux` itself, which is why the
    // unmount condition had to be widened with `mkvPrepareInFlight`.
    expect(closedFiles).toEqual([mkvPath])
    expect(svc.sessions.size).toBe(1)
    expect(svc.killed).toEqual([])
  })

  it('self-reaps when a cleanup overtakes a registration still stuck in the probe', async () => {
    // The sub-window the renderer cannot close: the cleanup fires at unmount,
    // finds nothing to kill because `registerSession` has not run yet, and the
    // registration lands behind it. Before the generation check this left a
    // live session with a spawned ffmpeg (measured: 0 killed, 1 alive).
    let releaseProbe: () => void = () => {}
    svc.gate(new Promise<void>((res) => (releaseProbe = res)))

    const open = handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath)
    await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())
    expect(svc.killed).toEqual([]) // nothing was registered yet
    releaseProbe()

    expect(await open).toEqual({ error: 'cancelled' })
    expect(svc.sessions.size).toBe(0)
    // The `return` is the load-bearing half: the process never exists at all.
    expect(svc.spawned).toEqual([])
  })

  it('does the same for the transcode handler', async () => {
    let releaseProbe: () => void = () => {}
    svc.gate(new Promise<void>((res) => (releaseProbe = res)))

    const open = handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE)!(mkEvent(), mkvPath)
    await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())
    releaseProbe()

    expect(await open).toEqual({ error: 'cancelled' })
    expect(svc.sessions.size).toBe(0)
    expect(svc.spawned).toEqual([])
  })

  it('does NOT misfire on a legitimate cleanup-then-open sequence', async () => {
    // Every renderer call site awaits `playerCleanupRemux()` before opening the
    // next session, so the bump always lands before the next handler captures
    // it. The capture point has to be handler entry, not module load.
    await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())
    const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath)) as {
      sessionId?: string
    }
    expect(res.sessionId).toBeTruthy()
    expect(svc.sessions.size).toBe(1)
    expect(svc.spawned).toHaveLength(1)
  })

  it('CANNOT reach a transcode whose cleanup landed before the handler was entered', async () => {
    // Characterization — this is the unmount ordering: `onBeforeUnmount` issues
    // `playerCleanupRemux()` synchronously, and the resumed continuation only
    // then reaches `player:remux-mkv-stream-transcode`. The generation the
    // handler captures has already absorbed the bump, so it never moves and the
    // self-reap is silent. Nothing in main can fix this; the renderer's
    // `unmounted` checkpoint above `prepareHevcTranscode` is the only guard.
    await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())
    const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE)!(
      mkEvent(),
      mkvPath
    )) as Record<string, unknown>

    expect(res.error).toBeUndefined()
    expect(res.sessionId).toBeTruthy()
    expect(svc.sessions.size).toBe(1)
    expect(svc.spawned).toHaveLength(1)
    expect(svc.killed).toEqual([])
  })

  it('CANNOT reach the legacy full-file remux at all, and the sweep deletes its output', async () => {
    // Characterization — `player:remux-mkv` registers no session, so there is
    // nothing for a generation check to reap and `playerCleanupRemux` cannot
    // kill it: not at unmount, not on the next open, not ever. It runs to
    // completion writing an `.mp4` the sweep unlinks out from under it, and the
    // handler still returns that now-deleted path as success. The renderer's
    // checkpoint above `runLegacyRemuxIpc` is the only thing that can stop it.
    const legacy = handlers.get(CHANNELS.PLAYER_REMUX_MKV)!(mkEvent(), mkvPath) as Promise<{
      mp4Path: string
    }>
    // Let the "ffmpeg" start and write its output, then sweep across it.
    await new Promise((r) => setTimeout(r, 5))
    await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())

    const res = await legacy
    expect(res.mp4Path).toBeTruthy()
    expect(svc.sessions.size).toBe(0)
    expect(svc.killed).toEqual([])
    // Reported as success, gone from disk.
    expect(fs.existsSync(res.mp4Path)).toBe(false)
    expect(ffmpegRuns).toHaveLength(1)
  })
})
