import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import type { DownloadStatus } from '../download-manager'

export interface ActiveDownloadInfo {
  bytesReceived: number
  totalBytes: number
  status: DownloadStatus
}

export interface AnimeVideoHandlerDeps {
  /** Resolve an absolute file path (usually a `.part`) to its in-flight download, if any. */
  getActiveDownload: (filePath: string) => ActiveDownloadInfo | null
  /** Poll interval while waiting for a growing `.part` to gain bytes. */
  pollIntervalMs?: number
}

const PART_SUFFIX = '.part'
const DEFAULT_POLL_MS = 200
const TAIL_CHUNK_SIZE = 256 * 1024

function mimeTypeFor(filePath: string): string {
  const base = filePath.endsWith(PART_SUFFIX) ? filePath.slice(0, -PART_SUFFIX.length) : filePath
  const ext = path.extname(base).toLowerCase()
  return ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'application/octet-stream'
}

/**
 * Streams bytes [start, end] of a file that may still be growing on disk.
 * Reads what is available, then polls for growth until the promised range is
 * fully delivered — so the declared Content-Length is eventually honored.
 * Errors the stream when the backing download dies (failed / cancelled /
 * vanished, or completed without ever reaching the promised size).
 */
function createTailStream(
  filePath: string,
  start: number,
  end: number,
  deps: AnimeVideoHandlerDeps
): ReadableStream<Uint8Array> {
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS
  let offset = start
  let handle: fs.promises.FileHandle | null = null

  const close = async (): Promise<void> => {
    const h = handle
    handle = null
    if (h) await h.close().catch(() => {})
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        if (!handle) handle = await fs.promises.open(filePath, 'r')
        while (offset <= end) {
          const size = (await handle.stat()).size
          const available = Math.min(end + 1, size) - offset
          if (available > 0) {
            const buf = Buffer.alloc(Math.min(available, TAIL_CHUNK_SIZE))
            const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
            if (bytesRead > 0) {
              offset += bytesRead
              controller.enqueue(new Uint8Array(buf.subarray(0, bytesRead)))
              return
            }
          }
          // Nothing readable yet — decide whether more bytes can still arrive.
          const download = deps.getActiveDownload(filePath)
          const canGrow =
            download &&
            (download.status === 'downloading' ||
              download.status === 'queued' ||
              download.status === 'paused')
          if (!canGrow) {
            // failed / cancelled / vanished, or completed short of the
            // promised range: the remaining bytes will never arrive.
            throw new Error(`download ended before byte ${end} was available`)
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs))
        }
        controller.close()
        await close()
      } catch (err) {
        await close()
        controller.error(err)
      }
    },
    cancel(): Promise<void> {
      return close()
    }
  })
}

/**
 * `anime-video://{encodeURIComponent(absolute-path)}` — serves local video to
 * the renderer's <video> element with Range support. Completed files stream
 * via plain fs read streams (unchanged legacy behavior). Growing `.part`
 * files are served with the download's expected total size in the
 * Content-Range denominator (so the element gets the real duration up front)
 * while the response body *tails* the file as it grows; the response's own
 * Content-Length always matches the bytes actually delivered.
 */
export function createAnimeVideoHandler(
  deps: AnimeVideoHandlerDeps
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const raw = request.url.replace('anime-video://', '')
    let filePath = decodeURIComponent(raw)

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      // Post-finalize edge: the .part was renamed to the final file between
      // the player resolving the path and this range request.
      if (filePath.endsWith(PART_SUFFIX)) {
        const finalPath = filePath.slice(0, -PART_SUFFIX.length)
        try {
          stat = fs.statSync(finalPath)
          filePath = finalPath
        } catch {
          return new Response('File not found', { status: 404 })
        }
      } else {
        return new Response('File not found', { status: 404 })
      }
    }

    const mimeType = mimeTypeFor(filePath)
    const download = filePath.endsWith(PART_SUFFIX) ? deps.getActiveDownload(filePath) : null
    const growing = download !== null && download.totalBytes > 0
    // For a growing .part the on-disk size lags the final size; advertise the
    // download's expected total so duration/seek-range are correct up front.
    const totalSize = growing ? Math.max(download.totalBytes, stat.size) : stat.size

    const rangeHeader = request.headers.get('Range')
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1
        const chunkSize = end - start + 1
        const headers = {
          'Content-Type': mimeType,
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes'
        }

        if (growing && end >= stat.size) {
          return new Response(createTailStream(filePath, start, end, deps), {
            status: 206,
            headers
          })
        }

        const nodeStream = fs.createReadStream(filePath, { start, end })
        const webStream = Readable.toWeb(nodeStream) as ReadableStream
        return new Response(webStream, { status: 206, headers })
      }
    }

    const headers = {
      'Content-Type': mimeType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes'
    }
    if (growing) {
      return new Response(createTailStream(filePath, 0, totalSize - 1, deps), {
        status: 200,
        headers
      })
    }
    const nodeStream = fs.createReadStream(filePath)
    const webStream = Readable.toWeb(nodeStream) as ReadableStream
    return new Response(webStream, { status: 200, headers })
  }
}
