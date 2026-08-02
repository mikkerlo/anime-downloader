// anime-video:// protocol handler (#63): legacy whole/range serving must be
// unchanged; growing .part files get the download's expected size in the
// Content-Range denominator, a Content-Length that matches the bytes actually
// delivered, and a body that tails the file as it grows.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createAnimeVideoHandler,
  type ActiveDownloadInfo
} from '../../src/main/streaming/anime-video-protocol'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-video-proto-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeRequest(filePath: string, range?: string): Request {
  return {
    url: 'anime-video://' + encodeURIComponent(filePath),
    headers: { get: (name: string) => (name === 'Range' ? (range ?? null) : null) }
  } as unknown as Request
}

function handler(
  download: ActiveDownloadInfo | null = null
): (request: Request) => Promise<Response> {
  return createAnimeVideoHandler({
    getActiveDownload: () => download,
    pollIntervalMs: 5
  })
}

async function bodyText(res: Response): Promise<string> {
  return Buffer.from(await res.arrayBuffer()).toString('utf-8')
}

describe('legacy behavior (complete files) is unchanged', () => {
  it('serves a whole file with 200 and its real size', async () => {
    const fp = path.join(dir, 'movie.mp4')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler()(makeRequest(fp))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('video/mp4')
    expect(res.headers.get('Content-Length')).toBe('10')
    expect(await bodyText(res)).toBe('0123456789')
  })

  it('serves a byte range with 206 and the file size as the denominator', async () => {
    const fp = path.join(dir, 'movie.mp4')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler()(makeRequest(fp, 'bytes=2-5'))

    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(res.headers.get('Content-Length')).toBe('4')
    expect(await bodyText(res)).toBe('2345')
  })

  it('404s a missing file', async () => {
    const res = await handler()(makeRequest(path.join(dir, 'gone.mp4')))
    expect(res.status).toBe(404)
  })
})

describe('unsatisfiable ranges', () => {
  it('416s a start at/past the file size', async () => {
    const fp = path.join(dir, 'movie.mp4')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler()(makeRequest(fp, 'bytes=10-'))

    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */10')
  })

  it('416s an inverted range (start > end)', async () => {
    const fp = path.join(dir, 'movie.mp4')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler()(makeRequest(fp, 'bytes=5-2'))

    expect(res.status).toBe(416)
  })

  it('416s a start past the advertised total of a growing .part (no empty tail stream)', async () => {
    const fp = path.join(dir, 'ep.mp4.part')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler({ bytesReceived: 10, totalBytes: 20, status: 'downloading' })(
      makeRequest(fp, 'bytes=20-')
    )

    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */20')
  })
})

describe('growing .part files', () => {
  it('derives the MIME from the underlying extension, not .part', async () => {
    const fp = path.join(dir, 'ep.mp4.part')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler({ bytesReceived: 10, totalBytes: 20, status: 'downloading' })(
      makeRequest(fp, 'bytes=0-4')
    )

    expect(res.headers.get('Content-Type')).toBe('video/mp4')
  })

  it('advertises the expected total in the Content-Range denominator for an in-range request', async () => {
    const fp = path.join(dir, 'ep.mp4.part')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler({ bytesReceived: 10, totalBytes: 20, status: 'downloading' })(
      makeRequest(fp, 'bytes=0-4')
    )

    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 0-4/20')
    expect(res.headers.get('Content-Length')).toBe('5')
    expect(await bodyText(res)).toBe('01234')
  })

  it('tails the file: bytes written after the request started are delivered', async () => {
    const fp = path.join(dir, 'ep.mp4.part')
    fs.writeFileSync(fp, '0123456789')
    const download: ActiveDownloadInfo = {
      bytesReceived: 10,
      totalBytes: 20,
      status: 'downloading'
    }

    const res = await handler(download)(makeRequest(fp, 'bytes=0-'))
    expect(res.headers.get('Content-Range')).toBe('bytes 0-19/20')
    expect(res.headers.get('Content-Length')).toBe('20')

    // Grow the file while the body is being read.
    setTimeout(() => {
      fs.appendFileSync(fp, 'ABCDEFGHIJ')
      download.bytesReceived = 20
      download.status = 'completed'
    }, 25)

    expect(await bodyText(res)).toBe('0123456789ABCDEFGHIJ')
  })

  it('delivers a file whose last flush lands exactly when the download completes', async () => {
    // Regression (#218 follow-up): the tail loop used to stat the file first
    // and check download liveness second. A download whose final append and
    // 'completed' flip both landed between those two calls got a stale size
    // with a dead status — and the stream errored a fully-written file. This
    // getActiveDownload mock reproduces that interleaving deterministically:
    // by the time the loop learns the download ended, the bytes are on disk.
    const fp = path.join(dir, 'ep.mp4.part')
    fs.writeFileSync(fp, '0123456789')
    // Call 1 is the handler's request-time lookup — still downloading. Every
    // later call comes from the tail loop: the download finishes (flush, then
    // status flip) right at that liveness probe.
    let calls = 0
    const h = createAnimeVideoHandler({
      getActiveDownload: () => {
        calls += 1
        if (calls === 1) return { bytesReceived: 10, totalBytes: 20, status: 'downloading' }
        if (calls === 2) fs.appendFileSync(fp, 'ABCDEFGHIJ')
        return { bytesReceived: 20, totalBytes: 20, status: 'completed' }
      },
      pollIntervalMs: 5
    })

    const res = await h(makeRequest(fp, 'bytes=0-'))
    expect(res.headers.get('Content-Range')).toBe('bytes 0-19/20')
    expect(await bodyText(res)).toBe('0123456789ABCDEFGHIJ')
  })

  it('errors the body when the download dies short of the promised range', async () => {
    const fp = path.join(dir, 'ep.mp4.part')
    fs.writeFileSync(fp, '0123456789')
    const download: ActiveDownloadInfo = {
      bytesReceived: 10,
      totalBytes: 20,
      status: 'downloading'
    }

    const res = await handler(download)(makeRequest(fp, 'bytes=0-'))
    setTimeout(() => {
      download.status = 'failed'
    }, 25)

    await expect(res.arrayBuffer()).rejects.toThrow()
  })

  it('errors the body when a completed download never reached the promised size', async () => {
    const fp = path.join(dir, 'ep.mp4.part')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler({ bytesReceived: 10, totalBytes: 20, status: 'completed' })(
      makeRequest(fp, 'bytes=0-')
    )

    await expect(res.arrayBuffer()).rejects.toThrow()
  })

  it('treats a .part with no active download as a plain file (no size spoofing)', async () => {
    const fp = path.join(dir, 'orphan.mp4.part')
    fs.writeFileSync(fp, '0123456789')

    const res = await handler(null)(makeRequest(fp))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('10')
    expect(await bodyText(res)).toBe('0123456789')
  })

  it('falls back to the final file when the .part was renamed mid-session', async () => {
    const finalPath = path.join(dir, 'done.mp4')
    fs.writeFileSync(finalPath, '0123456789')

    const res = await handler(null)(makeRequest(finalPath + '.part', 'bytes=0-3'))

    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 0-3/10')
    expect(await bodyText(res)).toBe('0123')
  })
})
