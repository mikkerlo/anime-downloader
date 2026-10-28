// anime-poster:// (#570): serves `poster-cache/<animeId>.jpg` so cards keep
// their poster offline. The id is the whole input and must be a positive
// integer, so no request can reach a path outside the poster dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createAnimePosterHandler,
  parsePosterId
} from '../../src/main/streaming/anime-poster-protocol'

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

describe('parsePosterId', () => {
  it('parses a positive integer and nothing else', () => {
    expect(parsePosterId('anime-poster://7')).toBe(7)
    expect(parsePosterId('anime-poster://7/')).toBe(7)
    expect(parsePosterId('anime-poster://7?x=1')).toBeNull()
    expect(parsePosterId('anime-poster://-7')).toBeNull()
    expect(parsePosterId('anime-poster://../7')).toBeNull()
  })
})
