// #631 — an MSE run settles once, on the process's `close`, whatever order its
// `exit` and its stdout `end` come in.
//
// Node doesn't order a child's `exit` against its stdout `end`. Before #631 the
// outcome of an unclassified non-zero exit depended on which came first (an
// error when `exit` won, a silent end when stdout won), the error message was
// built at `exit` from whatever stderr had arrived by then, and the session's
// `stderrTail` still held the previous run's lines. Real ffmpeg can't be made to
// pick an order, so only the process is faked here, and each case runs in both
// orders against the real streaming service.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PassThrough } from 'stream'
import { createStreamingService, type MseSession } from '../../src/main/streaming'

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

type Order = 'exit-first' | 'end-first'
const ORDERS: Order[] = ['exit-first', 'end-first']

const tick = (): Promise<void> => new Promise((res) => setImmediate(res))

async function endPipe(pipe: PassThrough): Promise<void> {
  const ended = new Promise((res) => pipe.once('end', res))
  pipe.end()
  await ended
}

async function say(run: FakeRun, line: string | undefined): Promise<void> {
  if (!line) return
  run.stderr.write(line)
  await tick()
}

/**
 * Finishes a run in a forced order, then emits `close`, which Node always emits
 * last: after `exit` and after both pipes have ended.
 *
 * - `exit-first`: `exit`, then `stderr` and `stderrAfterExit`, then stdout ends.
 * - `end-first`: `stderr`, then stdout ends, then `exit`, then `stderrAfterExit`.
 * - `stderrAfterStdoutEnd` is written after both `exit` and stdout's end, in
 *   either order, and stderr ends after it.
 * - `spawnError` stands in for a failed spawn: Node emits `error` where `exit`
 *   would be, and no `exit`.
 */
async function finishRun(
  run: FakeRun,
  order: Order,
  opts: {
    code?: number | null
    signal?: NodeJS.Signals | null
    stderr?: string
    stderrAfterExit?: string
    stderrAfterStdoutEnd?: string
    spawnError?: Error
  } = {}
): Promise<void> {
  const code = opts.code === undefined ? 0 : opts.code
  const signal = opts.signal ?? null
  const exit = async (): Promise<void> => {
    run.exitCode = code
    run.signalCode = signal
    if (opts.spawnError) run.emit('error', opts.spawnError)
    else run.emit('exit', code, signal)
    await tick()
  }
  if (order === 'exit-first') {
    await exit()
    await say(run, opts.stderr)
    await say(run, opts.stderrAfterExit)
    await endPipe(run.stdout)
  } else {
    await say(run, opts.stderr)
    await endPipe(run.stdout)
    await exit()
    await say(run, opts.stderrAfterExit)
  }
  await say(run, opts.stderrAfterStdoutEnd)
  await endPipe(run.stderr)
  run.emit('close', code, signal)
  // The classify continuation.
  await tick()
  await tick()
}

/** What ffmpeg 6.1 logs when a read of its open input fails, before it exits 0. */
const DEMUX_EIO = '[in#0/matroska,webm @ 0x1] Error during demuxing: Input/output error\n'
/** The previous run's last stderr lines, as quoted in the CI failure. */
const STALE =
  "  Stream #0:0: Video: h264 (Constrained Baseline), yuv420p, 160x90, 25 fps\nOutput #0, mp4, to 'pipe:1':\n"
/** What the app's copy args log against a file that isn't Matroska (exit 183). */
const INVALID =
  '[in#0 @ 0x1] Error opening input: Invalid data found when processing input\nError opening input files: Invalid data found when processing input\n'

type Classify = (input: string, hint: { readError: boolean }) => Promise<PlayerFailureReason | null>

const channels = { streamChunk: 'sc', streamEnd: 'se', streamError: 'sx', streamProgress: 'sp' }

function mkSession(over: Partial<MseSession> = {}): MseSession {
  return {
    proc: {} as MseSession['proc'],
    pendingBytes: 0,
    stderrTail: [],
    done: false,
    error: null,
    senderId: 1,
    ready: true,
    prelude: [],
    endPending: false,
    mkvPath: '\\\\?\\X',
    inputPath: '/drive/show.mkv',
    generation: 1,
    videoCodec: 'h264',
    transcode: false,
    audioStrategy: 'copy',
    h264Encoder: null,
    ...over
  }
}

function start(
  classifyExit?: Classify,
  over: Partial<MseSession> = {}
): {
  run: FakeRun
  session: MseSession
  sent: [string, Record<string, unknown>][]
  hints: { readError: boolean }[]
} {
  const sent: [string, Record<string, unknown>][] = []
  const hints: { readError: boolean }[] = []
  const event = {
    sender: {
      isDestroyed: (): boolean => false,
      send: (ch: string, payload: Record<string, unknown>): void => void sent.push([ch, payload])
    }
  }
  const svc = createStreamingService({
    getFfmpegPath: () => '/bin/ffmpeg',
    getFfprobePath: () => '/bin/ffprobe',
    channels,
    ...(classifyExit
      ? {
          classifyExit: (input: string, hint: { readError: boolean }) => {
            hints.push(hint)
            return classifyExit(input, hint)
          }
        }
      : {})
  })
  const session = mkSession(over)
  svc.spawnFfmpegForSession(session, event, 'sid', 0)
  return { run: runs[runs.length - 1], session, sent, hints }
}

const disconnected: Classify = async () => 'drive-disconnected'
const unclassified: Classify = async () => null
const CLASSIFIERS: [string, Classify | undefined][] = [
  ['classifyExit → null', unclassified],
  ['no classifyExit', undefined]
]

const notChunks = (sent: [string, unknown][]): [string, unknown][] =>
  sent.filter(([ch]) => ch !== 'sc')
const channelsOf = (sent: [string, unknown][]): string[] => sent.map(([ch]) => ch)

describe('StreamingService: an MSE run settles on close, in either exit/end order (#631)', () => {
  beforeEach(() => {
    runs.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe.each(ORDERS)('%s', (order) => {
    it.each(CLASSIFIERS)(
      'T1: an unclassified exit 183 is an error with no reason, never an end (%s)',
      async (_label, classify) => {
        const { run, session, sent } = start(classify)
        run.stdout.write(Buffer.from('x'))
        await finishRun(run, order, { code: 183, stderr: INVALID })

        expect(notChunks(sent)).toEqual([
          [
            'sx',
            { sessionId: 'sid', error: expect.stringContaining('ffmpeg exited with code 183') }
          ]
        ])
        expect(notChunks(sent)[0][1]).not.toHaveProperty('reason')
        expect(session.endPending).toBe(false)
      }
    )

    it("T2: the message quotes the run's own stderr, written after exit, not the previous run's", async () => {
      const { run, sent } = start(unclassified, { stderrTail: [STALE] })
      await finishRun(run, order, { code: 183, stderrAfterExit: INVALID })

      expect(channelsOf(sent)).toEqual(['sx'])
      const error = sent[0][1].error as string
      expect(error).toContain('Invalid data found')
      expect(error).not.toContain('160x90')
    })

    it("T3: a run with no stderr of its own doesn't quote the previous run's", async () => {
      const { run, session, sent } = start(unclassified, { stderrTail: [STALE] })
      await finishRun(run, order, { code: 183 })

      expect(channelsOf(sent)).toEqual(['sx'])
      expect(sent[0][1].error).not.toContain('160x90')
      expect(session.stderrTail).toEqual([])
    })

    it('T4: a demux read error logged after exit and stdout end still reaches the classifier', async () => {
      const { run, session, sent, hints } = start(async (_input, hint) =>
        hint.readError ? 'drive-disconnected' : null
      )
      run.stdout.write(Buffer.from('x'))
      await finishRun(run, order, { code: 0, stderrAfterStdoutEnd: DEMUX_EIO })

      expect(hints).toEqual([{ readError: true }])
      expect(notChunks(sent)).toEqual([
        [
          'sx',
          {
            sessionId: 'sid',
            error: expect.stringContaining('Error during demuxing'),
            reason: 'drive-disconnected'
          }
        ]
      ])
      expect(session.endPending).toBe(false)
    })

    it('T5: a failed run the classifier names is its error, with the reason, and no end', async () => {
      const { run, sent } = start(disconnected)
      run.stdout.write(Buffer.from('x'))
      await finishRun(run, order, { code: 1 })

      expect(notChunks(sent)).toEqual([
        [
          'sx',
          {
            sessionId: 'sid',
            error: expect.stringContaining('ffmpeg exited with code 1'),
            reason: 'drive-disconnected'
          }
        ]
      ])
    })

    it.each(CLASSIFIERS)('T6: a clean exit still ends (%s)', async (_label, classify) => {
      const ready = start(classify)
      ready.run.stdout.write(Buffer.from('x'))
      await finishRun(ready.run, order, { code: 0 })
      expect(channelsOf(ready.sent)).toEqual(['sc', 'se'])
      expect(ready.session.error).toBeNull()

      const held = start(classify, { ready: false })
      held.run.stdout.write(Buffer.from('x'))
      await finishRun(held.run, order, { code: 0 })
      expect(held.sent).toEqual([])
      expect(held.session.endPending).toBe(true)
      expect(Buffer.concat(held.session.prelude).toString()).toBe('x')
    })

    it('T7: an outside SIGKILL ends, unclassified and never "code null"', async () => {
      const { run, session, sent, hints } = start(unclassified)
      run.stdout.write(Buffer.from('x'))
      await finishRun(run, order, { code: null, signal: 'SIGKILL' })

      expect(channelsOf(sent)).toEqual(['sc', 'se'])
      expect(session.error).toBeNull()
      expect(hints).toEqual([])
    })

    it.each(CLASSIFIERS)(
      'T8: a run a seek has superseded reports nothing after the bump, and is not asked about (%s)',
      async (_label, classify) => {
        const { run, session, sent, hints } = start(classify)
        run.stdout.write(Buffer.alloc(256 * 1024, 1))
        await tick()
        expect(channelsOf(sent)).toEqual(['sc'])

        session.generation++
        await finishRun(run, order, { code: 183, stderr: INVALID })

        expect(channelsOf(sent)).toEqual(['sc'])
        expect(sent[0][1].gen).toBe(1)
        expect(session.error).toBeNull()
        expect(hints).toEqual([])
      }
    )

    it('T8: a seek that lands while the classifier is still running drops its verdict', async () => {
      let resolve: (v: PlayerFailureReason | null) => void = () => {}
      const slow: Classify = () => new Promise((res) => (resolve = res))
      const { run, session, sent, hints } = start(slow)
      await finishRun(run, order, { code: 183, stderr: INVALID })
      expect(hints).toHaveLength(1)

      session.generation++
      resolve(null)
      await tick()

      expect(sent).toEqual([])
      expect(session.error).toBeNull()
    })

    it('T9: a spawn error, then close, is reported once', async () => {
      const { run, sent } = start(unclassified)
      const err = Object.assign(new Error('spawn /bin/ffmpeg ENOENT'), { code: 'ENOENT' })
      await finishRun(run, order, { code: -2, spawnError: err })

      expect(sent).toEqual([['sx', { sessionId: 'sid', error: 'spawn /bin/ffmpeg ENOENT' }]])
    })
  })
})
