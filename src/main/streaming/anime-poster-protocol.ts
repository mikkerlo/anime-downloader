import * as fs from 'fs'
import * as path from 'path'

export interface AnimePosterHandlerDeps {
  /** `<userData>/poster-cache`, where the anime cache writes `<animeId>.jpg`. */
  posterDir: string
  /** An attached Shared Library's `posters/<animeId>.jpg` (#578), checked under its root. */
  attachedPoster?: (animeId: number) => Promise<string | null>
  /** `shared/<libraryId>/<animeId>` (#583): that library's poster, null unless it is available. */
  libraryPoster?: (libraryId: string, animeId: number) => Promise<string | null>
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
    // Sized from this handle: a file that grows after the `stat` is cut at
    // `size + 1`, and no read ever goes past `max + 1`.
    const { size } = await fh.stat()
    const buf = Buffer.alloc(Math.min(size, max) + 1)
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

const POSITIVE_ID = /^[1-9]\d*$/
const SHARED_FORM =
  /^shared\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d+)$/i

function toId(raw: string): number | null {
  if (!POSITIVE_ID.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}

/** The id in `anime-poster://<id>` when it is a positive integer, else null. */
export function parsePosterId(url: string): number | null {
  if (!url.startsWith(SCHEME_PREFIX)) return null
  return toId(url.slice(SCHEME_PREFIX.length).replace(/\/$/, ''))
}

/** `anime-poster://shared/<libraryId>/<animeId>` (#583): a uuid and a positive id, else null. */
export function parseSharedPoster(url: string): { libraryId: string; animeId: number } | null {
  if (!url.startsWith(SCHEME_PREFIX)) return null
  const m = SHARED_FORM.exec(url.slice(SCHEME_PREFIX.length).replace(/\/$/, ''))
  const animeId = m ? toId(m[2]) : null
  return m && animeId !== null ? { libraryId: m[1], animeId } : null
}

const notFound = (): Response => new Response('Poster not cached', { status: 404 })

function jpeg(data: Buffer): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(data.length) }
  })
}

/**
 * Serves `anime-poster://<animeId>` from the poster disk cache (#570), so cards
 * keep their poster offline. The id is the only input and must parse as a
 * positive integer, so a request can never name a path. A miss falls back to
 * an attached Shared Library's snapshot poster (#578).
 *
 * `anime-poster://shared/<libraryId>/<animeId>` (#583) serves only that
 * library's drive poster, through `libraryPoster`: the URL holds a uuid and an
 * id, never a path, and an unknown or unavailable library is a 404.
 */
export function createAnimePosterHandler(
  deps: AnimePosterHandlerDeps
): (request: Request) => Promise<Response> {
  const max = deps.attachedPosterMaxBytes ?? ATTACHED_POSTER_MAX_BYTES

  async function readAttached(file: Promise<string | null> | undefined): Promise<Response> {
    const found = await file?.catch(() => null)
    if (!found) return notFound()
    try {
      return jpeg(await readCapped(found, max))
    } catch {
      return notFound()
    }
  }

  return async (request: Request): Promise<Response> => {
    const shared = parseSharedPoster(request.url)
    if (shared) return readAttached(deps.libraryPoster?.(shared.libraryId, shared.animeId))
    const id = parsePosterId(request.url)
    if (id === null) return new Response('Bad poster id', { status: 400 })
    try {
      return jpeg(await fs.promises.readFile(path.join(deps.posterDir, `${id}.jpg`)))
    } catch {
      return readAttached(deps.attachedPoster?.(id))
    }
  }
}
