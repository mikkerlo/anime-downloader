// anime-poster:// (#570): serves `poster-cache/<animeId>.jpg` so cards keep
// their poster offline. The id is the whole input and must be a positive
// integer, so no request can reach a path outside the poster dir.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ATTACHED_POSTER_MAX_BYTES,
  createAnimePosterHandler,
  parsePosterId
} from '../../src/main/streaming/anime-poster-protocol'
import { POSTER_MAX_BYTES } from '../../src/main/services/attached-library'

let root: string
let posterDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-poster-proto-'))
  posterDir = path.join(root, 'poster-cache')
  fs.mkdirSync(posterDir)
  fs.writeFileSync(path.join(posterDir, '42.jpg'), 'jpeg-bytes')
  // Outside the poster dir: what a traversal would try to reach.
  fs.writeFileSync(path.join(root, 'secret.jpg'), 'secret')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function get(url: string): Promise<Response> {
  return createAnimePosterHandler({ posterDir })({ url } as Request)
}

describe('anime-poster:// handler', () => {
  it('serves <id>.jpg as image/jpeg', async () => {
    const res = await get('anime-poster://42')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('jpeg-bytes')
  })

  it('accepts a trailing slash', async () => {
    expect((await get('anime-poster://42/')).status).toBe(200)
  })

  it('answers 404 for an id with no cached poster', async () => {
    expect((await get('anime-poster://43')).status).toBe(404)
  })

  it.each([
    'anime-poster://../secret',
    'anime-poster://..%2Fsecret',
    'anime-poster://42/../../secret',
    'anime-poster://abc',
    'anime-poster://-42',
    'anime-poster://0',
    'anime-poster://042',
    'anime-poster://4.2',
    'anime-poster://42.jpg',
    'anime-poster://',
    'anime-poster://99999999999999999999',
    'anime-video://42'
  ])('rejects %s with 400 and reads nothing', async (url) => {
    const res = await get(url)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('secret')
  })
})

describe('an attached library poster (#578)', () => {
  const MAX = ATTACHED_POSTER_MAX_BYTES

  /** `attachedPoster` the way `posterFor` behaves: size-checked, then the drive swaps the file. */
  function swappedAfterCheck(finalSize: number): (id: number) => Promise<string | null> {
    return async () => {
      const file = path.join(root, 'drive-poster.jpg')
      fs.writeFileSync(file, 'small')
      if (fs.statSync(file).size > MAX) return null
      fs.truncateSync(file, finalSize)
      return file
    }
  }

  const serve = (attachedPoster: (id: number) => Promise<string | null>): Promise<Response> =>
    createAnimePosterHandler({ posterDir, attachedPoster })({ url: 'anime-poster://7' } as Request)

  it('falls back to the attached poster on a cache miss', async () => {
    const res = await serve(swappedAfterCheck(1000))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('1000')
  })

  it('a file swapped past the cap between the check and the read is not served', async () => {
    const res = await serve(swappedAfterCheck(MAX + 1))
    expect(res.status).toBe(404)
  })

  it('exactly the cap is served in full', async () => {
    const res = await serve(swappedAfterCheck(MAX))
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBe(MAX)
  })

  it('reads through one handle, never the whole file', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile')
    await serve(swappedAfterCheck(MAX + 1))
    expect(readFile.mock.calls.map((c) => path.basename(String(c[0])))).toEqual(['7.jpg'])
    readFile.mockRestore()
  })

  it('is the cap the service enforces', () => {
    expect(MAX).toBe(POSTER_MAX_BYTES)
  })
})

describe('parsePosterId', () => {
  it('parses a positive integer and nothing else', () => {
    expect(parsePosterId('anime-poster://7')).toBe(7)
    expect(parsePosterId('anime-poster://7/')).toBe(7)
    expect(parsePosterId('anime-poster://7?x=1')).toBeNull()
    expect(parsePosterId('anime-poster://-7')).toBeNull()
    expect(parsePosterId('anime-poster://../7')).toBeNull()
  })
})
