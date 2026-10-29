// #607 — a run's `player:stream-end` waits for `player:stream-start`, like its
// chunks do.
//
// After an unbuffered seek, the new run of a short tail can finish before the
// anchor probe does, so before the fix its end reached the renderer ahead of
// the `player:stream-seek` reply. The reply clears the renderer's `streamEnded`
// (`handleUnbufferedSeek`), nothing re-armed it, and `endOfStream()` never ran.
// Main now records the end on the session while it is not ready and sends it
// from the handshake, right after the prelude chunks, on the same sender.
//
// This drives the real `player.ipc.ts` router against the real streaming
// service; only the ffmpeg process is faked, so each run's stdout can be
// written and ended exactly when a case needs it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { PassThrough } from 'stream'
import { register } from '../../src/main/ipc/player.ipc'
import { createStreamingService, type MkvProbeResult } from '../../src/main/streaming'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'

interface FakeRun {
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  killed: string[]
  emit: (event: string, ...args: unknown[]) => boolean
}

const runs = vi.hoisted(() => [] as FakeRun[])

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const { EventEmitter } = await import('events')
  const { PassThrough } = await import('stream')
  return {
    ...actual,
    spawn: () => {
      const killed: string[] = []
      const run = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed,
        kill: (sig: string): boolean => {
          killed.push(sig)
          return true
        }
      })
      runs.push(run)
      return run
    }
  }
})

type Handler = (event: unknown, ...args: unknown[]) => unknown

const STREAM_CHANNELS = new Set<string>([
  EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
  EVENT_CHANNELS.PLAYER_STREAM_END,
  EVENT_CHANNELS.PLAYER_STREAM_ERROR
])

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

function mkSender() {
  const sent: [string, Record<string, unknown>][] = []
  let destroyed = false
  return {
    event: {
      sender: {
        id: 1,
        isDestroyed: (): boolean => destroyed,
        send: (ch: string, payload: Record<string, unknown>): void => {
          if (STREAM_CHANNELS.has(ch)) sent.push([ch, payload])
        }
      }
    },
    sent,
    destroy(): void {
      destroyed = true
    }
  }
}

// One batch flushes at 256 KB, so a run of this much plus a tail leaves two
// prelude entries — enough to check the end follows every chunk, not just one.
const BIG = Buffer.alloc(256 * 1024, 1)

async function write(run: FakeRun, ...chunks: Buffer[]): Promise<void> {
  for (const c of chunks) run.stdout.write(c)
  await new Promise((res) => setImmediate(res))
}

// A clean exit, in the order Node guarantees: `close` comes last. The run
// settles in the service's `close` listener (#631), synchronously here because
// no classifier is wired.
async function finish(run: FakeRun): Promise<void> {
  const ended = new Promise((res) => run.stdout.once('end', res))
  run.stdout.end()
  await ended
  run.exitCode = 0
  run.emit('exit', 0, null)
  run.emit('close', 0, null)
}

const channelsOf = (sent: [string, unknown][]): string[] => sent.map(([ch]) => ch)

describe('player.ipc — a run end is held until stream-start has flushed the prelude (#607)', () => {
  let handlers: Map<string, Handler>
  let svc: ReturnType<typeof createStreamingService>
  let mkvPath: string
  let dir: string
  let anchorGate: Promise<number>

  beforeEach(() => {
    runs.length = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-end-held-'))
    mkvPath = path.join(dir, 'show.mkv')
    fs.writeFileSync(mkvPath, 'not a real mkv')
    svc = createStreamingService({
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => '',
      channels: {
        streamChunk: EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
        streamEnd: EVENT_CHANNELS.PLAYER_STREAM_END,
        streamError: EVENT_CHANNELS.PLAYER_STREAM_ERROR,
        streamProgress: EVENT_CHANNELS.PLAYER_STREAM_PROGRESS
      }
    })
    anchorGate = Promise.resolve(95)
    const deps = {
      store: new InMemoryStorage({ hevcTranscodeOnPlay: 'ask' }),
      streamingService: {
        ...svc,
        tmpDir: path.join(dir, 'remux'),
        probeMkvForMse: vi.fn(async () => mkProbe()),
        probeCopyTimestampOffset: vi.fn(async () => 0),
        probeSeekAnchor: vi.fn(() => anchorGate)
      },
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      playerLockService: { open: (): void => {}, close: (): void => {} },
      // Empty ffprobe path skips the fluent-ffmpeg subtitle probe.
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => '',
      attachedLibraryService: { spawnPathFor: (p: string) => p }
    } as unknown as AppDeps
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register(deps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function open(sender: ReturnType<typeof mkSender>): Promise<string> {
    const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(sender.event, mkvPath)) as {
      sessionId: string
    }
    expect(res.sessionId).toBeTruthy()
    return res.sessionId
  }

  const start = (sender: ReturnType<typeof mkSender>, sessionId: string): unknown =>
    handlers.get(CHANNELS.PLAYER_STREAM_START)!(sender.event, sessionId)

  const seek = (
    sender: ReturnType<typeof mkSender>,
    sessionId: string,
    at: number
  ): Promise<{ generation: number }> =>
    handlers.get(CHANNELS.PLAYER_STREAM_SEEK)!(sender.event, sessionId, at) as Promise<{
      generation: number
    }>

  it('initial open: a run that ends before the handshake sends its end after the prelude', async () => {
    const sender = mkSender()
    const sessionId = await open(sender)
    const session = svc.getSession(sessionId)!

    await write(runs[0], BIG, Buffer.from('tail'))
    await finish(runs[0])

    // Before the fix the end went out here, ahead of every chunk.
    expect(sender.sent).toEqual([])
    expect(session.endPending).toBe(true)
    expect(session.prelude).toHaveLength(2)

    start(sender, sessionId)

    expect(channelsOf(sender.sent)).toEqual([
      EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
      EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
      EVENT_CHANNELS.PLAYER_STREAM_END
    ])
    expect(sender.sent[0][1].gen).toBe(0)
    expect((sender.sent[1][1].data as Buffer).toString()).toBe('tail')
    expect(sender.sent[2][1]).toEqual({ sessionId })
    expect(session.endPending).toBe(false)
    expect(session.prelude).toEqual([])
  })

  it('seek: a new run that ends before the reply sends its end only after stream-start', async () => {
    const sender = mkSender()
    const sessionId = await open(sender)
    start(sender, sessionId)

    let releaseAnchor: (v: number) => void = () => {}
    anchorGate = new Promise<number>((res) => (releaseAnchor = res))
    const reply = seek(sender, sessionId, 1400)
    expect(runs).toHaveLength(2)

    // The tail run finishes while the anchor probe is still running — the #607
    // red order: stream-end ahead of the seek reply.
    await write(runs[1], Buffer.from('tail-of-file'))
    await finish(runs[1])
    expect(sender.sent).toEqual([])

    releaseAnchor(1395)
    expect((await reply).generation).toBe(1)
    expect(sender.sent).toEqual([])

    start(sender, sessionId)

    expect(channelsOf(sender.sent)).toEqual([
      EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
      EVENT_CHANNELS.PLAYER_STREAM_END
    ])
    expect(sender.sent[0][1].gen).toBe(1)
    expect((sender.sent[0][1].data as Buffer).toString()).toBe('tail-of-file')
  })

  it('a run that ends after stream-start sends its end straight away, with no second handshake', async () => {
    const sender = mkSender()
    const sessionId = await open(sender)
    start(sender, sessionId)

    await write(runs[0], Buffer.from('whole-file'))
    await finish(runs[0])

    expect(channelsOf(sender.sent)).toEqual([
      EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
      EVENT_CHANNELS.PLAYER_STREAM_END
    ])
    expect(sender.sent[1][1]).toEqual({ sessionId })
  })

  it('a seek that lands with an end pending does not carry it over to the new run', async () => {
    const sender = mkSender()
    const sessionId = await open(sender)
    start(sender, sessionId)
    const session = svc.getSession(sessionId)!

    // Seek 1: its run ends before the renderer has handshaken again.
    await seek(sender, sessionId, 1400)
    await write(runs[1], Buffer.from('first-tail'))
    await finish(runs[1])
    expect(session.endPending).toBe(true)

    // Seek 2 lands on top. The reset runs synchronously, before the spawn and
    // before the reply's await.
    let releaseAnchor: (v: number) => void = () => {}
    anchorGate = new Promise<number>((res) => (releaseAnchor = res))
    const reply = seek(sender, sessionId, 1300)
    expect(session.generation).toBe(2)
    expect(session.endPending).toBe(false)
    expect(session.prelude).toEqual([])

    releaseAnchor(1295)
    expect((await reply).generation).toBe(2)
    start(sender, sessionId)

    // Seek 1's end would have gone out here, ahead of the new run's data.
    expect(sender.sent).toEqual([])

    await write(runs[2], Buffer.from('second-tail'))
    await finish(runs[2])

    expect(channelsOf(sender.sent)).toEqual([
      EVENT_CHANNELS.PLAYER_STREAM_CHUNK,
      EVENT_CHANNELS.PLAYER_STREAM_END
    ])
    expect(sender.sent[0][1].gen).toBe(2)
    expect((sender.sent[0][1].data as Buffer).toString()).toBe('second-tail')
  })

  it('stream-start to a destroyed sender sends nothing and still clears the pending end', async () => {
    const sender = mkSender()
    const sessionId = await open(sender)
    const session = svc.getSession(sessionId)!

    await finish(runs[0])
    expect(session.endPending).toBe(true)

    sender.destroy()
    start(sender, sessionId)

    expect(sender.sent).toEqual([])
    expect(session.endPending).toBe(false)
  })
})
