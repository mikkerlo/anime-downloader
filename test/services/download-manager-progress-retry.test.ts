// #597: a throttled transfer from a server with a short keep-alive is cut off
// with `TypeError: terminated` while it is still making progress. An attempt
// that grew the `.part` by at least 256 KiB retries at the same rung after
// 250 ms instead of spending a rung of the 1/2/4 s ladder; every attempt counts
// toward a limit of 20. The catch closes the write stream before it stats the
// `.part`, so the next `Range` starts where the file really ends.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import fsModule from 'fs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  PROGRESS_RETRY_DELAY_MS,
  PROGRESS_RETRY_MIN_BYTES,
  RETRY_ATTEMPT_LIMIT,
  type DownloadItem
} from '../../src/main/download-manager'

const URL_V = 'http://example.invalid/v.mp4'
const CHUNK = 64 * 1024
const KIB = 1024
// Literals, not the exports, so the behaviour cases fail on what they observe
// rather than on an undefined import when run against a tree without #597.
const MIN_PROGRESS = 256 * KIB
const FAST_RETRY_MS = 250
const ATTEMPT_LIMIT = 20

function makeItem(): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: URL_V,
    filename: path.join('Anime', 'Anime - 01 [Author].mp4'),
    animeName: 'Anime',
    episodeLabel: 'ep1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'Author',
    status: 'queued',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0
  }
}

type Internals = {
  queue: DownloadItem[]
  activeCount: number
  abortControllers: Map<string, AbortController>
  startDownload: (item: DownloadItem, retryCount?: number, attemptCount?: number) => Promise<void>
  waitForPartClose: (stream: fs.WriteStream) => Promise<void>
}

/** Bytes that differ at every offset a duplicated or dropped range could land on. */
function source(size: number): Buffer {
  const buf = Buffer.alloc(size)
  let x = 0x12345678
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    buf[i] = x >>> 24
  }
  return buf
}

function partSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return -1
  }
}

/** Real I/O still runs under fake setTimeout; spin on setImmediate until `cond`. */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setImmediate(r))
  expect(cond()).toBe(true)
}

async function spinUntil(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setImmediate(r))
}

/**
 * A disk whose writes can be held in flight: while `holding`, `fs.write` and
 * `fs.writev` (which `fs.WriteStream` calls through the `fs` module object) are
 * parked until `release()`.
 */
function slowDisk(): { holding: boolean; held: (() => void)[]; release: () => void } {
  const disk = {
    holding: false,
    held: [] as (() => void)[],
    release(): void {
      disk.holding = false
      for (const op of disk.held.splice(0)) op()
    }
  }
  for (const name of ['write', 'writev'] as const) {
    const original = fsModule[name] as (...a: unknown[]) => void
    vi.spyOn(fsModule, name).mockImplementation(((...args: unknown[]) => {
      if (disk.holding) disk.held.push(() => original(...args))
      else original(...args)
    }) as never)
  }
  return disk
}

type Cut = number | 'full' | 'stall'

interface Server {
  fetch: Mock
  /** The `Range` start each request asked for (0 when it sent none). */
  starts: number[]
}

/**
 * A server over `src`. Request N gets `plan[N]` bytes from where its `Range`
 * starts and then `TypeError('terminated')`, or the rest of the file for
 * `'full'`, or one chunk and then nothing, ever, for `'stall'` (an attempt that
 * stays in flight until it is aborted). The error is raised only once every
 * delivered byte is on disk —
 * unless `disk` is given, in which case the last chunk's write is held in flight
 * when it is raised, which is the window #597's close-before-stat closes.
 */
function server(
  src: Buffer,
  plan: Cut[],
  partPath: string,
  opts: { disk?: ReturnType<typeof slowDisk>; contentLengthOn200?: boolean } = {}
): Server {
  const starts: number[] = []
  const fetch = vi.fn(async (_url: unknown, init: unknown) => {
    const range = ((init as RequestInit).headers as Record<string, string>).Range
    const start = range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0
    const cut = plan[starts.length] ?? 'full'
    starts.push(start)
    const end =
      cut === 'full' ? src.length : Math.min(src.length, start + (cut === 'stall' ? CHUNK : cut))
    const data = src.subarray(start, end)
    const disk = opts.disk
    let off = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (off < data.length) {
          const n = Math.min(CHUNK, data.length - off)
          if (disk && cut !== 'full' && off + n === data.length) {
            await spinUntil(() => partSize(partPath) === end - n)
            disk.holding = true
          }
          c.enqueue(new Uint8Array(data.subarray(off, off + n)))
          off += n
          return
        }
        if (cut === 'full') {
          c.close()
          return
        }
        if (cut === 'stall') return new Promise<void>(() => {})
        if (disk && data.length > 0) await spinUntil(() => disk.held.length > 0)
        else await spinUntil(() => partSize(partPath) === end)
        c.error(new TypeError('terminated'))
      }
    })
    const headers: Record<string, string> = {}
    if (start > 0) {
      headers['content-range'] = `bytes ${start}-${src.length - 1}/${src.length}`
      headers['content-length'] = String(src.length - start)
    } else if (opts.contentLengthOn200 !== false) {
      headers['content-length'] = String(src.length)
    }
    return new Response(body, { status: start > 0 ? 206 : 200, headers })
  })
  return { fetch, starts }
}

describe('DownloadManager — progress-aware retry rung (#597)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let internals: Internals
  let item: DownloadItem
  let partPath: string
  let finalPath: string
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-prog-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-prog-dl-'))
    dm = new DownloadManager(downloadDir, { getSubtitlesUrl: () => 's' } as never, userDataDir)
    internals = dm as unknown as Internals
    item = makeItem()
    internals.queue = [item]
    finalPath = path.join(downloadDir, item.filename)
    partPath = finalPath + '.part'
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    dm.destroy()
    globalThis.fetch = realFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  function serve(s: Server): Server {
    globalThis.fetch = s.fetch as unknown as typeof fetch
    return s
  }

  /** Waits for the catch to re-queue (or fail) the attempt that is in flight. */
  async function settled(): Promise<void> {
    await until(() => item.status !== 'downloading')
  }

  /** Holds every `waitForPartClose` open until `open()`, then runs the real one. */
  function holdPartClose(): { closeSpy: Mock; open: () => void } {
    const original = internals.waitForPartClose
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const closeSpy = vi.spyOn(internals, 'waitForPartClose').mockImplementation(async function (
      this: unknown,
      stream: fs.WriteStream
    ) {
      await gate
      return original.call(this, stream)
    })
    return { closeSpy: closeSpy as unknown as Mock, open }
  }

  /** The next request fires exactly `ms` after the re-queue, not a tick before. */
  async function expectRetryAfter(s: Server, ms: number): Promise<void> {
    const before = s.fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(s.fetch).toHaveBeenCalledTimes(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.fetch).toHaveBeenCalledTimes(before + 1)
  }

  it('pins the three numbers', () => {
    expect(PROGRESS_RETRY_MIN_BYTES).toBe(MIN_PROGRESS)
    expect(PROGRESS_RETRY_DELAY_MS).toBe(FAST_RETRY_MS)
    expect(RETRY_ATTEMPT_LIMIT).toBe(ATTEMPT_LIMIT)
  })

  it('an attempt that grew the .part keeps its rung, and each Range starts where the closed .part ends', async () => {
    // Five cut-off attempts — one more than RETRY_LIMIT + 1, so main fails the
    // item on the fourth — then one that finishes. Each attempt's last write is
    // still in flight when the body errors.
    const per = 384 * KIB
    const src = source(5 * per + 200 * KIB)
    const disk = slowDisk()
    const s = serve(server(src, [per, per, per, per, per, 'full'], partPath, { disk }))

    void internals.startDownload(item)
    for (let attempt = 1; attempt <= 5; attempt++) {
      const end = attempt * per
      await until(() => disk.held.length > 0)
      // Nothing may be scheduled off a `.part` whose last write has not landed.
      await vi.advanceTimersByTimeAsync(FAST_RETRY_MS)
      expect(s.fetch).toHaveBeenCalledTimes(attempt)
      disk.release()
      await settled()
      expect(item.status).toBe('queued')
      const closedSize = partSize(partPath)
      expect(closedSize).toBe(end)

      await expectRetryAfter(s, FAST_RETRY_MS)
      expect(s.starts[attempt]).toBe(closedSize)
    }

    await until(() => item.status === 'completed')
    expect(s.fetch).toHaveBeenCalledTimes(6)
    expect(fs.existsSync(partPath)).toBe(false)
    expect(fs.readFileSync(finalPath).equals(src)).toBe(true)
  })

  it('an attempt that wrote nothing spends a rung', async () => {
    const src = source(512 * KIB)
    const s = serve(server(src, [0, 0, 0, 0], partPath))

    void internals.startDownload(item)
    for (const ms of [1000, 2000, 4000]) {
      await settled()
      expect(item.status).toBe('queued')
      await expectRetryAfter(s, ms)
    }
    await settled()
    expect(item.status).toBe('failed')
    expect(item.error).toBe('terminated')
    expect(s.fetch).toHaveBeenCalledTimes(4)
  })

  it('an attempt one byte short of 256 KiB spends a rung', async () => {
    const per = MIN_PROGRESS - 1
    const src = source(4 * per + 100 * KIB)
    const s = serve(server(src, [per, per, per, per], partPath))

    void internals.startDownload(item)
    for (const ms of [1000, 2000, 4000]) {
      await settled()
      expect(item.status).toBe('queued')
      await expectRetryAfter(s, ms)
    }
    await settled()
    expect(item.status).toBe('failed')
    expect(item.error).toBe('terminated')
    expect(s.fetch).toHaveBeenCalledTimes(4)
    expect(s.starts).toEqual([0, per, 2 * per, 3 * per])
    expect(partSize(partPath)).toBe(4 * per)
  })

  it('a server that drops every attempt after 256 KiB gets exactly 20 attempts', async () => {
    const per = MIN_PROGRESS
    const src = source(ATTEMPT_LIMIT * per + 100 * KIB)
    const s = serve(server(src, Array(ATTEMPT_LIMIT + 5).fill(per), partPath))

    void internals.startDownload(item)
    for (let attempt = 1; attempt < ATTEMPT_LIMIT; attempt++) {
      await settled()
      expect(item.status).toBe('queued')
      await expectRetryAfter(s, FAST_RETRY_MS)
    }
    await settled()
    expect(item.status).toBe('failed')
    expect(item.error).toBe('terminated')
    expect(internals.activeCount).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.fetch).toHaveBeenCalledTimes(ATTEMPT_LIMIT)
    expect(partSize(partPath)).toBe(ATTEMPT_LIMIT * per)
  })

  it('resumes with Range and takes the total from Content-Range, not the 206 Content-Length', async () => {
    const first = 384 * KIB
    const src = source(first + 300 * KIB)
    // No Content-Length on the 200, so the only total the item can learn is
    // the one in the 206's Content-Range.
    const s = serve(server(src, [first, 'full'], partPath, { contentLengthOn200: false }))

    void internals.startDownload(item)
    await settled()
    expect(item.totalBytes).toBe(0)
    await expectRetryAfter(s, FAST_RETRY_MS)
    expect((s.fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Range: `bytes=${first}-`
    })
    const resumed = (await s.fetch.mock.results[1].value) as Response
    expect(resumed.status).toBe(206)
    expect(resumed.headers.get('content-length')).toBe(String(src.length - first))

    await until(() => item.status === 'completed')
    expect(item.totalBytes).toBe(src.length)
    expect(fs.readFileSync(finalPath).equals(src)).toBe(true)
  })

  it('a body cut off one byte short is retried, never finalized', async () => {
    const src = source(512 * KIB)
    const s = serve(server(src, [src.length - 1, 'full'], partPath))

    void internals.startDownload(item)
    await settled()
    expect(item.status).toBe('queued')
    expect(item.totalBytes).toBe(src.length)
    expect(fs.existsSync(finalPath)).toBe(false)
    expect(partSize(partPath)).toBe(src.length - 1)

    await expectRetryAfter(s, FAST_RETRY_MS)
    expect(s.starts[1]).toBe(src.length - 1)
    await until(() => item.status === 'completed')
    expect(fs.readFileSync(finalPath).equals(src)).toBe(true)
  })

  // Ordering pin, independent of the runtime: Node 22+ already holds the
  // `pipeline()` rejection until the write stream closes, so the slow-disk test
  // above cannot tell whether the catch waits. This one holds the close itself.
  it('schedules nothing until the .part write stream has closed', async () => {
    const per = 384 * KIB
    const src = source(per + 100 * KIB)
    const s = serve(server(src, [per, 'full'], partPath))
    const { closeSpy, open } = holdPartClose()

    void internals.startDownload(item)
    await until(() => closeSpy.mock.calls.length === 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(item.status).toBe('downloading')

    open()
    await settled()
    expect(item.status).toBe('queued')
    await expectRetryAfter(s, FAST_RETRY_MS)
    expect(s.starts[1]).toBe(per)
    await until(() => item.status === 'completed')
    expect(fs.readFileSync(finalPath).equals(src)).toBe(true)
  })

  it('a pause while the .part is closing is not overridden by the retry', async () => {
    const per = 384 * KIB
    const src = source(per + 100 * KIB)
    const s = serve(server(src, [per, 'full'], partPath))
    const { closeSpy, open } = holdPartClose()

    void internals.startDownload(item)
    await until(() => closeSpy.mock.calls.length === 1)
    dm.pause(item.id)
    expect(item.status).toBe('paused')

    open()
    await until(() => internals.activeCount === 0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(item.status).toBe('paused')
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(partSize(partPath)).toBe(per)
  })

  // #597 review: a resume while the failed attempt's stream is still closing
  // starts a new attempt for the same item. The old catch must neither
  // schedule a second retry nor delete the new attempt's controller.
  it('a pause and resume while the .part is closing leaves the new attempt the only owner', async () => {
    const per = 384 * KIB
    const src = source(per + 100 * KIB)
    const s = serve(server(src, [per, 'stall'], partPath))
    const { closeSpy, open } = holdPartClose()

    void internals.startDownload(item)
    await until(() => closeSpy.mock.calls.length === 1)
    dm.pause(item.id)
    dm.resume(item.id)
    expect(item.status).toBe('downloading')
    await until(() => s.fetch.mock.calls.length === 2)
    expect(s.starts[1]).toBe(per)
    expect(internals.activeCount).toBe(2)

    open()
    await until(() => internals.activeCount === 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.fetch).toHaveBeenCalledTimes(2)
    expect(item.status).toBe('downloading')
    expect(internals.abortControllers.has(item.id)).toBe(true)

    // The new attempt is still the one a pause reaches.
    dm.pause(item.id)
    const resumedSignal = (s.fetch.mock.calls[1][1] as RequestInit).signal!
    expect(resumedSignal.aborted).toBe(true)
    await until(() => internals.activeCount === 0)
    expect(item.status).toBe('paused')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.fetch).toHaveBeenCalledTimes(2)
  })

  // The same ownership in `finally`: a pause and resume in one tick start the
  // new attempt before the aborted one's catch runs, and that catch's cleanup
  // must not delete the controller the new attempt installed.
  it('an aborted attempt does not delete the controller of the attempt that replaced it', async () => {
    const src = source(512 * KIB)
    const s = serve(server(src, ['stall', 'stall'], partPath))

    void internals.startDownload(item)
    await until(() => partSize(partPath) === CHUNK)
    dm.pause(item.id)
    dm.resume(item.id)
    await until(() => s.fetch.mock.calls.length === 2)
    await until(() => internals.activeCount === 1)
    expect(item.status).toBe('downloading')
    expect(internals.abortControllers.has(item.id)).toBe(true)

    dm.pause(item.id)
    expect((s.fetch.mock.calls[1][1] as RequestInit).signal!.aborted).toBe(true)
    await until(() => internals.activeCount === 0)
    expect(item.status).toBe('paused')
  })
})
