import * as fs from 'fs'
import * as path from 'path'

export interface AnimePosterHandlerDeps {
  /** `<userData>/poster-cache`, where the anime cache writes `<animeId>.jpg`. */
  posterDir: string
  /** An attached Shared Library's `posters/<animeId>.jpg` (#578), checked under its root. */
  attachedPoster?: (animeId: number) => Promise<string | null>
  /** The most an attached poster may hold; the drive can swap the file after the check. */
  attachedPosterMaxBytes?: number
}

/**
 * Reads `file` through one handle, at most `max` bytes. Throws when there is
 * more, so a file swapped after `attachedPoster`'s size check is never read in
 * full.
 */
async function readCapped(file: string, max: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(max + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > max) throw new Error(`poster over ${max} bytes`)
    return buf.subarray(0, total)
  } finally {
    await fh.close()
  }
}

const SCHEME_PREFIX = 'anime-poster://'

/** A drive's poster is untrusted input; the card never needs more (#578). */
export const ATTACHED_POSTER_MAX_BYTES = 2 * 1024 * 1024

/** The id in `anime-poster://<id>` when it is a positive integer, else null. */
export function parsePosterId(url: string): number | null {
  if (!url.startsWith(SCHEME_PREFIX)) return null
  const raw = url.slice(SCHEME_PREFIX.length).replace(/\/$/, '')
  if (!/^[1-9]\d*$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}

/**
 * Serves `anime-poster://<animeId>` from the poster disk cache (#570), so cards
 * keep their poster offline. The id is the only input and must parse as a
 * positive integer, so a request can never name a path. A miss falls back to
 * an attached Shared Library's snapshot poster (#578).
 */
export function createAnimePosterHandler(
  deps: AnimePosterHandlerDeps
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const id = parsePosterId(request.url)
    if (id === null) return new Response('Bad poster id', { status: 400 })
    let data: Buffer
    try {
      data = await fs.promises.readFile(path.join(deps.posterDir, `${id}.jpg`))
    } catch {
      const attached = await deps.attachedPoster?.(id).catch(() => null)
      try {
        if (!attached) throw new Error('no attached poster')
        data = await readCapped(attached, deps.attachedPosterMaxBytes ?? ATTACHED_POSTER_MAX_BYTES)
      } catch {
        return new Response('Poster not cached', { status: 404 })
      }
    }
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(data.length) }
    })
  }
}
