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
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r))
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

  it('uses a 60 s idle timeout', () => {
    expect(DOWNLOAD_IDLE_MS).toBe(60_000)
  })
})
