import * as fs from 'fs'
import * as path from 'path'

export interface AnimePosterHandlerDeps {
  /** `<userData>/poster-cache`, where the anime cache writes `<animeId>.jpg`. */
  posterDir: string
}

const SCHEME_PREFIX = 'anime-poster://'

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
 * positive integer, so a request can never name a path.
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
      return new Response('Poster not cached', { status: 404 })
    }
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(data.length) }
    })
  }
}
