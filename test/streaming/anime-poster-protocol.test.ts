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
  parsePosterId,
  parseSharedPoster
} from '../../src/main/streaming/anime-poster-protocol'
import {
  createAttachedLibraryService,
  POSTER_MAX_BYTES,
  type AttachedLibraryService
} from '../../src/main/services/attached-library'
import {
  createSnapshotCache,
  type SnapshotCache
} from '../../src/main/services/attached-library/snapshot-cache'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { cleanup } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'

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

  it('a small poster allocates about its own size, not the cap', async () => {
    const alloc = vi.spyOn(Buffer, 'alloc')
    const res = await serve(swappedAfterCheck(1000))
    expect(res.status).toBe(200)
    const sizes = alloc.mock.calls.map((c) => Number(c[0]))
    alloc.mockRestore()
    expect(sizes).toContain(1001)
    expect(Math.max(...sizes)).toBeLessThan(MAX)
  })

  it('a huge file never allocates past the cap + 1', async () => {
    const alloc = vi.spyOn(Buffer, 'alloc')
    const res = await serve(swappedAfterCheck(3 * MAX))
    const sizes = alloc.mock.calls.map((c) => Number(c[0]))
    alloc.mockRestore()
    expect(res.status).toBe(404)
    expect(Math.max(...sizes)).toBe(MAX + 1)
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
    expect(parsePosterId(`anime-poster://shared/${FIXTURE_LIBRARY_ID}/7`)).toBeNull()
  })
})

describe('anime-poster://shared/<libraryId>/<animeId> (#583)', () => {
  const OWNER = { id: 4242, nickname: 'owner', avatar: '' }
  const OTHER_ID = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'
  const url = (libraryId: string, animeId: number | string): string =>
    `anime-poster://shared/${libraryId}/${animeId}`

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  async function attached(): Promise<{
    svc: AttachedLibraryService
    drive: string
    cache: SnapshotCache
    serve: (u: string) => Promise<Response>
  }> {
    const cache = createSnapshotCache({ dir: path.join(root, 'snapshot-cache') })
    const svc = createAttachedLibraryService({
      store: new InMemoryStorage({
        shikimoriUser: OWNER,
        shikimoriCredentials: null,
        downloadedAnime: {},
        attachedLibraries: {}
      }),
      checkFfmpeg: async () => ({ available: true }),
      log: { log: () => {}, warn: () => {}, error: () => {} },
      snapshotCache: cache
    })
    const drive = copyFixtureLibrary()
    const [candidate] = await svc.discover(drive)
    const res = await svc.attach(candidate.libraryId!)
    if (!res.ok) throw new Error(res.error)
    await cache.idle()
    // The local poster cache holds a different 101: the shared form must never serve it.
    fs.writeFileSync(path.join(posterDir, '101.jpg'), 'local-cache-bytes')
    const handler = createAnimePosterHandler({
      posterDir,
      attachedPoster: (id) => svc.posterFor(id),
      libraryPoster: (libraryId, id) => svc.libraryPosterFor(libraryId, id)
    })
    return { svc, drive, cache, serve: (u) => handler({ url: u } as Request) }
  }

  const drivePoster = (drive: string): Buffer =>
    fs.readFileSync(path.join(drive, '.anime-dl', 'posters', '101.jpg'))

  it("serves an attached, available library's poster from its drive", async () => {
    const { drive, serve } = await attached()
    for (const u of [url(FIXTURE_LIBRARY_ID, 101), `${url(FIXTURE_LIBRARY_ID, 101)}/`]) {
      const res = await serve(u)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('image/jpeg')
      expect(Buffer.from(await res.arrayBuffer()).equals(drivePoster(drive))).toBe(true)
    }
  })

  it('an unknown library, or a title with no poster in it, is a 404 and never the local cache', async () => {
    const { serve } = await attached()
    for (const u of [
      url(OTHER_ID, 101),
      url(FIXTURE_LIBRARY_ID, 202),
      url(FIXTURE_LIBRARY_ID, 42)
    ]) {
      const res = await serve(u)
      expect(res.status, u).toBe(404)
      expect(await res.text()).not.toContain('local-cache-bytes')
    }
  })

  it('unavailable it is a 404, even with the snapshot cache holding it; available again, served', async () => {
    const { svc, drive, cache, serve } = await attached()
    svc.markUnavailable(FIXTURE_LIBRARY_ID, drive)
    // S8 (#582)'s cache still serves the bare form for the Shared Libraries tab.
    expect(cache.posterFile(FIXTURE_LIBRARY_ID, 101)).toBeTruthy()
    expect(await svc.posterFor(101)).toBe(cache.posterFile(FIXTURE_LIBRARY_ID, 101))
    expect(await svc.libraryPosterFor(FIXTURE_LIBRARY_ID, 101)).toBeNull()
    expect((await serve(url(FIXTURE_LIBRARY_ID, 101))).status).toBe(404)

    expect(await svc.reopenAt(FIXTURE_LIBRARY_ID, drive)).toBe(true)
    expect((await serve(url(FIXTURE_LIBRARY_ID, 101))).status).toBe(200)
  })

  it('a forgotten library is a 404', async () => {
    const { svc, serve } = await attached()
    await svc.forget(FIXTURE_LIBRARY_ID)
    expect((await serve(url(FIXTURE_LIBRARY_ID, 101))).status).toBe(404)
  })

  it('a drive poster replaced past the cap is not served', async () => {
    const { drive, serve } = await attached()
    fs.truncateSync(path.join(drive, '.anime-dl', 'posters', '101.jpg'), POSTER_MAX_BYTES + 1)
    expect((await serve(url(FIXTURE_LIBRARY_ID, 101))).status).toBe(404)
  })

  it('a file swapped past the cap after the check is not served (one capped read)', async () => {
    const file = path.join(root, 'swapped.jpg')
    const handler = createAnimePosterHandler({
      posterDir,
      libraryPoster: async () => {
        fs.writeFileSync(file, 'small')
        fs.truncateSync(file, ATTACHED_POSTER_MAX_BYTES + 1)
        return file
      }
    })
    const res = await handler({ url: url(FIXTURE_LIBRARY_ID, 101) } as Request)
    expect(res.status).toBe(404)
  })

  it('hands the lookup a uuid and an id, never a path', async () => {
    const libraryPoster = vi.fn(async () => null)
    const handler = createAnimePosterHandler({ posterDir, libraryPoster })
    await handler({ url: url(FIXTURE_LIBRARY_ID, 101) } as Request)
    expect(libraryPoster).toHaveBeenCalledWith(FIXTURE_LIBRARY_ID, 101)
  })

  it.each([
    `anime-poster://shared/../secret`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/../../secret`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/101/../../../secret`,
    `anime-poster://shared/..%2F..%2Fsecret/101`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/..%2Fsecret`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/%2e%2e`,
    `anime-poster://shared/../${FIXTURE_LIBRARY_ID}/101`,
    `anime-poster://shared//101`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/0`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/042`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/101.jpg`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/99999999999999999999`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}/101/extra`,
    `anime-poster://shared/not-a-uuid/101`,
    `anime-poster://shared/${FIXTURE_LIBRARY_ID}x/101`,
    `anime-poster://shared//tmp/secret/101`,
    `anime-poster://shared/%2Ftmp%2Fsecret.jpg/101`,
    `anime-poster://Shared/${FIXTURE_LIBRARY_ID}/101x`,
    `anime-video://shared/${FIXTURE_LIBRARY_ID}/101`
  ])('rejects %s with 400 and looks nothing up', async (u) => {
    const libraryPoster = vi.fn(async () => path.join(root, 'secret.jpg'))
    const attachedPoster = vi.fn(async () => path.join(root, 'secret.jpg'))
    const res = await createAnimePosterHandler({ posterDir, libraryPoster, attachedPoster })({
      url: u
    } as Request)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('secret')
    expect(libraryPoster).not.toHaveBeenCalled()
    expect(attachedPoster).not.toHaveBeenCalled()
  })
})

describe('parseSharedPoster', () => {
  it('parses a uuid and a positive id and nothing else', () => {
    expect(parseSharedPoster(`anime-poster://shared/${FIXTURE_LIBRARY_ID}/7`)).toEqual({
      libraryId: FIXTURE_LIBRARY_ID,
      animeId: 7
    })
    expect(parseSharedPoster(`anime-poster://shared/${FIXTURE_LIBRARY_ID}/7/`)).toEqual({
      libraryId: FIXTURE_LIBRARY_ID,
      animeId: 7
    })
    expect(parseSharedPoster('anime-poster://7')).toBeNull()
    expect(parseSharedPoster(`anime-poster://shared/${FIXTURE_LIBRARY_ID}/7?x=1`)).toBeNull()
    expect(parseSharedPoster(`anime-poster://shared/${FIXTURE_LIBRARY_ID}/-7`)).toBeNull()
  })
})
