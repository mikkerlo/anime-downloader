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

// Parameterised for #291's ownership guard: `player:close-stream-session`
// compares `session.senderId` against `event.sender.id`, so refusing a
// cross-`webContents` close needs two distinct ids.
const mkEvent = (id = 1): unknown => ({
  sender: { id, isDestroyed: (): boolean => false, send: (): void => {} }
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
  // The content-start probe is a SECOND suspension point, below the pre-spawn
  // generation check and above the reply. Gating it separately is what lets a
  // cleanup land in the window the pre-spawn check does not cover.
  let offsetGate: Promise<void> = Promise.resolve()
  return {
    handle: {
      tmpDir,
      probeMkvForMse: vi.fn(async () => {
        await probeGate
        return mkProbe()
      }),
      probeCopyTimestampOffset: vi.fn(async () => {
        await offsetGate
        return 0
      }),
      probeSeekAnchor: vi.fn(async () => {
        await offsetGate
        return 0
      }),
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
    },
    gateOffset(p: Promise<void>): void {
      offsetGate = p
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
    // unmount condition had to be widened with `mkvPreparesInFlight`.
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

  it('never replies describing a session a cleanup swept BELOW the pre-spawn check', async () => {
    // The window the pre-spawn self-reap does not cover. Between it and the
    // reply there are two more suspension points — the `Ffmpeg.ffprobe`
    // subtitle probe and `await offsetPromise`. A cleanup landing in either one
    // DOES find the session and sweeps it, but before the reply-time re-read
    // the handler kept going and returned a full success payload naming a dead,
    // deregistered `sessionId`; a renderer acting on it would sit on a
    // `MediaSource` that never receives a byte.
    //
    // Fails without the re-read: the payload comes back with a `sessionId` and
    // no `error`, while `svc.sessions.size` is already 0.
    let releaseOffset: () => void = () => {}
    svc.gateOffset(new Promise<void>((res) => (releaseOffset = res)))

    // `initialSeek > 0` is what routes through `probeCopyTimestampOffset`
    // rather than the `Promise.resolve(0)` short-circuit.
    const open = handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath, 42)
    await new Promise((r) => setTimeout(r, 5))
    // The session is registered and spawned by now — the sweep reaches it.
    expect(svc.spawned).toHaveLength(1)
    await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())
    expect(svc.killed).toHaveLength(1)
    releaseOffset()

    expect(await open).toEqual({ error: 'cancelled' })
    expect(svc.sessions.size).toBe(0)
  })

  it('does the same at the transcode handler reply', async () => {
    let releaseOffset: () => void = () => {}
    svc.gateOffset(new Promise<void>((res) => (releaseOffset = res)))

    const open = handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE)!(mkEvent(), mkvPath, 42)
    await new Promise((r) => setTimeout(r, 5))
    expect(svc.spawned).toHaveLength(1)
    await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())
    releaseOffset()

    expect(await open).toEqual({ error: 'cancelled' })
    expect(svc.sessions.size).toBe(0)
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

  it('characterizes: main registers two sessions on an overlapping open (renderer-side fix)', async () => {
    // #291's reproduction. Open A parks in `probeMkvForMse` — which sits ABOVE
    // `registerSession`, so main's map is still empty and there is nothing for a
    // sweep to find. The renderer is live (the MSE open is behind no blocking
    // overlay), so the user picks another translation: open B runs to completion
    // and wins `startMseSession`. A then resumes, registers and spawns behind it,
    // and the renderer no longer holds its id — an orphan ffmpeg until the next
    // blanket `player:cleanup-remux`.
    //
    // Neither open bumps `cleanupGeneration` (only `player:cleanup-remux` does),
    // so neither self-reap fires and both replies are full successes.
    //
    // TWO before the fix and TWO after it, deliberately: the fix is entirely
    // renderer-side (a `prepareEpoch` supersede that closes the loser's session
    // by id), so main registering both here is correct behavior, not the bug.
    // What changes is that the renderer now names A and closes it — see the
    // `player:close-stream-session` cases below.
    let releaseProbe: () => void = () => {}
    svc.gate(new Promise<void>((res) => (releaseProbe = res)))

    const openA = handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath) as Promise<{
      sessionId: string
    }>
    // The user's second pick. Ungate first so B does not park behind A.
    svc.gate(Promise.resolve())
    const b = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath)) as {
      sessionId: string
    }
    expect(b.sessionId).toBeTruthy()
    expect(svc.sessions.size).toBe(1)

    releaseProbe()
    const a = await openA

    expect(a.sessionId).toBeTruthy()
    expect(a.sessionId).not.toBe(b.sessionId)
    // Both registered, both spawned, neither reaped.
    expect(svc.sessions.size).toBe(2)
    expect(svc.spawned).toHaveLength(2)
    expect(svc.killed).toEqual([])
  })

  it('closes exactly the named session and leaves the concurrent winner alive (#291)', async () => {
    // The behavior difference. The renderer's superseded prepare names the id
    // ITS open returned; the blanket `player:cleanup-remux` would take out the
    // winner's session too and unlink the shared tmpDir.
    let releaseProbe: () => void = () => {}
    svc.gate(new Promise<void>((res) => (releaseProbe = res)))
    const openA = handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath) as Promise<{
      sessionId: string
    }>
    svc.gate(Promise.resolve())
    const b = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath)) as {
      sessionId: string
    }
    releaseProbe()
    const a = await openA
    expect(svc.sessions.size).toBe(2)

    const res = await handlers.get(CHANNELS.PLAYER_CLOSE_STREAM_SESSION)!(mkEvent(), a.sessionId)

    expect(res).toEqual({ closed: true })
    // No SIGKILL assertion here: this file runs a fake service whose
    // `cleanupSession` only records the id, and whose `spawnFfmpegForSession`
    // returns a `{ kill: vi.fn() }` nothing ever calls. The real kill (and the
    // `.ass` unlink) is covered in `test/streaming/streaming-service.test.ts`,
    // the only file that executes the real `cleanupSession`.
    expect(svc.killed).toEqual([a.sessionId])
    expect(svc.sessions.size).toBe(1)
    expect([...svc.sessions.keys()]).toEqual([b.sessionId])
  })

  it('refuses a close from a webContents that does not own the session (#291)', async () => {
    // A close is a SIGKILL of somebody's live playback. Without the ownership
    // guard any renderer could reap any other's session by id. A no-op, not a
    // throw: the caller issues this fire-and-forget, so a raise would surface
    // only as an unhandled rejection.
    const a = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(1), mkvPath)) as {
      sessionId: string
    }
    const b = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(1), mkvPath)) as {
      sessionId: string
    }
    expect(svc.sessions.size).toBe(2)

    const res = await handlers.get(CHANNELS.PLAYER_CLOSE_STREAM_SESSION)!(mkEvent(2), a.sessionId)

    expect(res).toEqual({ closed: false })
    expect(svc.killed).toEqual([])
    expect(svc.sessions.size).toBe(2)
    expect([...svc.sessions.keys()].sort()).toEqual([a.sessionId, b.sessionId].sort())
  })

  it('answers { closed: false } for an unknown session id (#291)', async () => {
    const res = await handlers.get(CHANNELS.PLAYER_CLOSE_STREAM_SESSION)!(mkEvent(), 'nope')
    expect(res).toEqual({ closed: false })
    expect(svc.killed).toEqual([])
  })

  it('does NOT bump the generation, so a concurrent parked open still replies (#291)', async () => {
    // Why the targeted close cannot join the set of things that deregister a
    // session while its own open handler is parked: the renderer only learns a
    // `sessionId` from an open's REPLY, so by the time it can name one, that
    // handler has already returned. Bumping `cleanupGeneration` here would only
    // cancel *unrelated* opens — exactly the `{ error: 'cancelled' }` an
    // overlapping translation switch must not produce.
    const a = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath)) as {
      sessionId: string
    }
    let releaseProbe: () => void = () => {}
    svc.gate(new Promise<void>((res) => (releaseProbe = res)))
    const openB = handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), mkvPath) as Promise<{
      sessionId?: string
      error?: string
    }>

    await handlers.get(CHANNELS.PLAYER_CLOSE_STREAM_SESSION)!(mkEvent(), a.sessionId)
    releaseProbe()

    const b = await openB
    expect(b.error).toBeUndefined()
    expect(b.sessionId).toBeTruthy()
    expect(svc.sessions.size).toBe(1)
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
