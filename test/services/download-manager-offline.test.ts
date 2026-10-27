// #567: the downloader goes through `fetchWithTimeout` with a 60 s body idle
// timeout. Before it, a transfer whose server stopped sending sat in
// 'downloading' forever; now the stall rejects with `TimeoutError`, which is not
// `AbortError`, so it takes the existing retry ladder and the `.part` stays for
// the `Range` resume. The failure also reaches the network observer.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DOWNLOAD_CONNECT_MS,
  DOWNLOAD_IDLE_MS,
  DownloadManager,
  type DownloadItem
} from '../../src/main/download-manager'
import { TimeoutError, setNetworkObserver } from '../../src/main/lib/net'

const URL_V = 'http://example.invalid/v.mp4'
const HEAD = 'head'

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
  startDownload: (item: DownloadItem, retryCount?: number) => Promise<void>
}

/** A response that sends HEAD and then nothing, ever. */
function stalledResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(HEAD))
      }
    }),
    { status: 200, headers: { 'content-length': '1000' } }
  )
}

/** Real I/O (the `.part` write) still runs under fake setTimeout; spin until `cond`. */
async function until(cond: () => boolean): Promise<void> {
  // Bounded by wall time, not by spins: a loaded CI runner can take far more
  // than a few hundred event-loop turns to finish the file write and rename.
  // Kept under Vitest's 5 s test timeout so a miss reports here.
  const deadline = Date.now() + 4_000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setImmediate(r))
  expect(cond()).toBe(true)
}

describe('DownloadManager — stalled transfer (#567)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-stall-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-stall-dl-'))
    dm = new DownloadManager(downloadDir, { getSubtitlesUrl: () => 's' } as never, userDataDir)
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    dm.destroy()
    globalThis.fetch = realFetch
    setNetworkObserver(null)
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  it('a body that stops sending takes the retry path, keeps the .part and reports to the observer', async () => {
    const observer = { onFailure: vi.fn(), onSuccess: vi.fn() }
    setNetworkObserver(observer)
    const fetchStub: Mock = vi.fn(async () => stalledResponse())
    globalThis.fetch = fetchStub as unknown as typeof fetch

    const item = makeItem()
    const internals = dm as unknown as Internals
    internals.queue = [item]
    const partPath = path.join(downloadDir, item.filename) + '.part'

    void internals.startDownload(item)
    await until(() => fs.existsSync(partPath) && fs.statSync(partPath).size === HEAD.length)
    expect(item.status).toBe('downloading')

    await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_MS - 1)
    expect(item.status).toBe('downloading')
    await vi.advanceTimersByTimeAsync(1)
    await until(() => item.status !== 'downloading')

    expect(item.status).toBe('queued')
    expect(item.error).toBeUndefined()
    expect(internals.activeCount).toBe(0)
    expect(fs.statSync(partPath).size).toBe(HEAD.length)
    expect(observer.onFailure).toHaveBeenCalledTimes(1)
    expect(observer.onFailure.mock.calls[0][0]).toBeInstanceOf(TimeoutError)
    expect(observer.onFailure.mock.calls[0][1]).toBe(URL_V)

    // First rung of the ladder: 1 s later the retry resumes from the .part.
    expect(fetchStub).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchStub).toHaveBeenCalledTimes(2)
    const retryInit = fetchStub.mock.calls[1][1] as RequestInit
    expect(retryInit.headers).toMatchObject({ Range: `bytes=${HEAD.length}-` })
  })

  it('uses a 60 s idle timeout and a 60 s connect deadline', () => {
    expect(DOWNLOAD_IDLE_MS).toBe(60_000)
    expect(DOWNLOAD_CONNECT_MS).toBe(60_000)
  })

  // The default 15 s connect deadline would send a CDN that is slow to answer
  // (redirects included) down the retry ladder; a download waits as long for
  // headers as it does for bytes.
  it('waits up to 60 s for the first response before retrying', async () => {
    const ok = 'video'
    const fetchStub: Mock = vi.fn(
      (_url: unknown, init: unknown) =>
        new Promise<Response>((resolve) => {
          const { signal } = init as { signal: AbortSignal }
          const t = setTimeout(
            () => resolve(new Response(ok, { headers: { 'content-length': '5' } })),
            DOWNLOAD_CONNECT_MS - 1000
          )
          signal.addEventListener('abort', () => clearTimeout(t))
        })
    )
    globalThis.fetch = fetchStub as unknown as typeof fetch

    const item = makeItem()
    const internals = dm as unknown as Internals
    internals.queue = [item]
    void internals.startDownload(item)

    await vi.advanceTimersByTimeAsync(DOWNLOAD_CONNECT_MS - 1000)
    await until(() => item.status !== 'downloading')
    expect(item.status).toBe('completed')
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('retries when the first response takes longer than 60 s', async () => {
    const observer = { onFailure: vi.fn(), onSuccess: vi.fn() }
    setNetworkObserver(observer)
    const fetchStub: Mock = vi.fn(() => new Promise<Response>(() => {}))
    globalThis.fetch = fetchStub as unknown as typeof fetch

    const item = makeItem()
    const internals = dm as unknown as Internals
    internals.queue = [item]
    void internals.startDownload(item)

    await vi.advanceTimersByTimeAsync(DOWNLOAD_CONNECT_MS - 1)
    expect(item.status).toBe('downloading')
    await vi.advanceTimersByTimeAsync(1)
    await until(() => item.status !== 'downloading')
    expect(item.status).toBe('queued')
    expect(observer.onFailure.mock.calls[0][0]).toBeInstanceOf(TimeoutError)
  })
})

// Offline gates (#567): the pump starts nothing, the retry timer re-checks the
// pump's gates, a failure that arrives while offline spends no rung, and
// entering offline suspends active transfers back to 'queued'.
describe('DownloadManager — offline (#567)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let realFetch: typeof globalThis.fetch
  let offline: boolean

  type OfflineInternals = Internals & { processQueue: () => void }
  const internals = (): OfflineInternals => dm as unknown as OfflineInternals

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-off-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-off-dl-'))
    dm = new DownloadManager(downloadDir, { getSubtitlesUrl: () => 's' } as never, userDataDir)
    offline = false
    dm.setOfflineCheck(() => offline)
    realFetch = globalThis.fetch
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    dm.destroy()
    globalThis.fetch = realFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  function stubFetch(impl: () => Promise<Response>): Mock {
    const stub = vi.fn(impl)
    globalThis.fetch = stub as unknown as typeof fetch
    return stub
  }

  it('while offline the pump starts nothing and items stay queued', () => {
    const fetchStub = stubFetch(async () => stalledResponse())
    const item = makeItem()
    internals().queue = [item]
    offline = true
    internals().processQueue()
    expect(item.status).toBe('queued')
    expect(internals().activeCount).toBe(0)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('going online starts the queue', async () => {
    const fetchStub = stubFetch(async () => stalledResponse())
    const item = makeItem()
    internals().queue = [item]
    offline = true
    internals().processQueue()
    offline = false
    dm.resumeAfterOffline()
    expect(item.status).toBe('downloading')
    await until(() => fetchStub.mock.calls.length === 1)
  })

  it('a retry timer that fires while offline does not call fetch and leaves the item queued', async () => {
    const fetchStub = stubFetch(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    })
    const item = makeItem()
    internals().queue = [item]
    void internals().startDownload(item)
    await until(() => item.status === 'queued')
    expect(fetchStub).toHaveBeenCalledTimes(1)
    offline = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(item.status).toBe('queued')
    expect(internals().activeCount).toBe(0)
  })

  it('a retry timer does not double-start an item the pump already started', async () => {
    let calls = 0
    const fetchStub = stubFetch(async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return stalledResponse()
    })
    const item = makeItem()
    internals().queue = [item]
    void internals().startDownload(item)
    await until(() => item.status === 'queued')
    internals().processQueue()
    expect(item.status).toBe('downloading')
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(internals().activeCount).toBe(1)
  })

  it('a failure that arrives while offline goes back to queued without spending a retry', async () => {
    let reject!: (err: unknown) => void
    const fetchStub = stubFetch(() => new Promise<Response>((_r, j) => (reject = j)))
    const item = makeItem()
    internals().queue = [item]
    void internals().startDownload(item)
    await until(() => fetchStub.mock.calls.length === 1)
    offline = true
    reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENETUNREACH' } }))
    await until(() => item.status === 'queued')
    expect(internals().activeCount).toBe(0)
    expect(item.error).toBeUndefined()
    // No rung was scheduled: online, nothing restarts it but the pump.
    offline = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('suspendForOffline() returns an active item to queued, activeCount to 0, and the next start sends Range', async () => {
    const fetchStub = stubFetch(async () => stalledResponse())
    const item = makeItem()
    internals().queue = [item]
    const partPath = path.join(downloadDir, item.filename) + '.part'
    const inFlight = internals().startDownload(item)
    await until(() => fs.existsSync(partPath) && fs.statSync(partPath).size === HEAD.length)
    expect(internals().activeCount).toBe(1)

    offline = true
    dm.suspendForOffline()
    expect(item.status).toBe('queued')
    await inFlight
    expect(item.status).toBe('queued')
    expect(internals().activeCount).toBe(0)
    expect(fs.statSync(partPath).size).toBe(HEAD.length)

    offline = false
    dm.resumeAfterOffline()
    await until(() => fetchStub.mock.calls.length === 2)
    const init = fetchStub.mock.calls[1] as unknown as [string, RequestInit]
    expect(init[1].headers).toMatchObject({ Range: `bytes=${HEAD.length}-` })
    expect(internals().activeCount).toBe(1)
  })

  it('a pause after a suspend-and-resume still settles activeCount exactly once', async () => {
    stubFetch(async () => stalledResponse())
    const item = makeItem()
    internals().queue = [item]
    const first = internals().startDownload(item)
    await until(() => internals().activeCount === 1 && item.status === 'downloading')
    offline = true
    dm.suspendForOffline()
    await first
    offline = false
    dm.resumeAfterOffline()
    expect(internals().activeCount).toBe(1)
    dm.pause(item.id)
    await until(() => internals().activeCount === 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(internals().activeCount).toBe(0)
    expect(item.status).toBe('paused')
  })
})
