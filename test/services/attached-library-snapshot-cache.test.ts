// The snapshot cache of attached Shared Libraries (#582): an unplugged library
// still lists after a restart, the poster cap and its eviction, and Forget.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  createAttachedLibraryService,
  type AttachedLibraryServiceDeps
} from '../../src/main/services/attached-library'
import {
  createSnapshotCache,
  SNAPSHOT_POSTER_MAX_BYTES,
  SNAPSHOT_POSTERS_TOTAL_MAX_BYTES,
  type SnapshotCache
} from '../../src/main/services/attached-library/snapshot-cache'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { cleanup, tempRoot } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'

const OWNER = { id: 4242, nickname: 'owner', avatar: '' }
const MB = 1024 * 1024

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

function make(
  store: InMemoryStorage,
  cache: SnapshotCache,
  over: Partial<AttachedLibraryServiceDeps> = {}
): ReturnType<typeof createAttachedLibraryService> {
  let t = 1_000
  return createAttachedLibraryService({
    store,
    checkFfmpeg: async () => ({ available: true }),
    snapshotCache: cache,
    log: { log: () => {}, warn: () => {}, error: () => {} },
    now: () => (t += 1_000),
    ...over
  })
}

function newStore(): InMemoryStorage {
  return new InMemoryStorage({
    shikimoriUser: OWNER,
    shikimoriCredentials: null,
    downloadedAnime: {},
    attachedLibraries: {}
  })
}

/** The fixture library under another id and name, with a poster of `posterBytes`. */
function libraryWith(id: string, name: string, posterBytes?: number): string {
  const root = copyFixtureLibrary()
  const file = path.join(root, '.anime-dl', 'manifest.json')
  const m = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...m, libraryId: id, name }, null, 2) + '\n')
  if (posterBytes !== undefined) {
    fs.writeFileSync(
      path.join(root, '.anime-dl', 'posters', '101.jpg'),
      Buffer.alloc(posterBytes, 7)
    )
  }
  return root
}

async function attach(
  svc: ReturnType<typeof createAttachedLibraryService>,
  root: string
): Promise<string> {
  const [c] = await svc.discover(root)
  const res = await svc.attach(c.libraryId!)
  if (!res.ok) throw new Error(res.error)
  return c.libraryId!
}

describe('an unplugged library after a restart', () => {
  it('still lists its titles with metadata and posters, unavailable', async () => {
    const userData = tempRoot()
    const dir = path.join(userData, 'shared-library-cache')
    const store = newStore()
    const cache = createSnapshotCache({ dir })
    const svc = make(store, cache)
    const root = copyFixtureLibrary()
    await attach(svc, root)
    await cache.idle()
    expect(fs.existsSync(path.join(dir, FIXTURE_LIBRARY_ID, 'snapshot.json'))).toBe(true)

    // Unplug, then restart: a new service and cache over the same userData.
    fs.renameSync(root, `${root}-away`)
    const cache2 = createSnapshotCache({ dir })
    const svc2 = make(store, cache2)
    await svc2.init()
    const [lib] = svc2.list()
    expect(lib.available).toBe(false)
    expect(lib.titles.map((t) => [t.name, t.anime.titles.romaji ?? null])).toEqual([
      ['Frieren', 'Sousou no Frieren'],
      ['Dungeon Meshi', null]
    ])
    const detail = await svc2.getTitle(FIXTURE_LIBRARY_ID, 101)
    expect(detail?.meta?.malId).toBeTruthy()
    expect(detail?.episodes.map((e) => e.episodeInt)).toEqual(['1'])
    // The poster is served from the cache, not the (gone) drive.
    const poster = await svc2.posterFor(101)
    expect(poster).toBe(path.join(dir, FIXTURE_LIBRARY_ID, 'posters', '101.jpg'))
    expect(fs.readFileSync(poster!)).toEqual(
      fs.readFileSync(path.join(`${root}-away`, '.anime-dl', 'posters', '101.jpg'))
    )
    // Nothing on the gone drive resolves.
    expect(await svc2.resolveItem(101, '1', 9001)).toBeNull()
  })

  it('without the cache, the same restart lists no titles (the behaviour difference)', async () => {
    const store = newStore()
    const svc = createAttachedLibraryService({
      store,
      checkFfmpeg: async () => ({ available: true }),
      log: { log: () => {}, warn: () => {}, error: () => {} }
    })
    const root = copyFixtureLibrary()
    await attach(svc, root)
    fs.renameSync(root, `${root}-away`)
    const svc2 = createAttachedLibraryService({
      store,
      checkFfmpeg: async () => ({ available: true }),
      log: { log: () => {}, warn: () => {}, error: () => {} }
    })
    await svc2.init()
    expect(svc2.list()[0].titles).toEqual([])
  })

  it('an unchanged generation is not rewritten; a new one is', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const save = vi.spyOn(fs.promises, 'writeFile')
    const store = newStore()
    const svc = make(store, cache)
    const root = copyFixtureLibrary()
    await attach(svc, root)
    await cache.idle()
    const snapshot = path.join(dir, FIXTURE_LIBRARY_ID, 'snapshot.json.tmp')
    const writesOf = (): number => save.mock.calls.filter((c) => c[0] === snapshot).length
    expect(writesOf()).toBe(1)
    await svc.refresh(FIXTURE_LIBRARY_ID, root)
    await cache.idle()
    expect(writesOf()).toBe(1)
    const file = path.join(root, '.anime-dl', 'manifest.json')
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1 }))
    await svc.refresh(FIXTURE_LIBRARY_ID, root)
    await cache.idle()
    expect(writesOf()).toBe(2)
  })
})

describe('the poster cap', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const C = '33333333-3333-4333-8333-333333333333'

  it('defaults: 2 MB per poster, 100 MB in all', () => {
    expect(SNAPSHOT_POSTER_MAX_BYTES).toBe(2 * MB)
    expect(SNAPSHOT_POSTERS_TOTAL_MAX_BYTES).toBe(100 * MB)
  })

  it('a 3 MB poster is not cached, and its metadata still is', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const svc = make(newStore(), cache)
    const id = await attach(svc, libraryWith(A, 'Big poster', 3 * MB))
    await cache.idle()
    expect(cache.posterFile(id, 101)).toBeNull()
    expect(fs.existsSync(path.join(dir, id, 'posters', '101.jpg'))).toBe(false)
    expect((await cache.load(id))?.metas.has(101)).toBe(true)
  })

  it('the cap holds on the bytes copied: a poster swapped for a 3 MB file after the open is not cached', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const root = libraryWith(A, 'Swapped', 1_000)
    const poster = path.join(root, '.anime-dl', 'posters', '101.jpg')
    const svc = make(newStore(), cache, {
      // The drive changes the file between the open's size check and the copy.
      checkFfmpeg: async () => {
        fs.writeFileSync(poster, Buffer.alloc(3 * MB, 1))
        return { available: true }
      }
    })
    const id = await attach(svc, root)
    await cache.idle()
    expect(fs.statSync(poster).size).toBe(3 * MB)
    expect(cache.posterFile(id, 101)).toBeNull()
    expect(fs.existsSync(path.join(dir, id, 'posters', '101.jpg'))).toBe(false)
  })

  it('above the total, the oldest-seen unavailable library is evicted, never an available one', async () => {
    // Sizes scaled down with the cap: three 40 KB posters against a 100 KB cap.
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir, totalMaxBytes: 100_000 })
    const store = newStore()
    const svc = make(store, cache)
    const roots = {
      [A]: libraryWith(A, 'Seen first', 40_000),
      [B]: libraryWith(B, 'Seen second', 40_000),
      [C]: libraryWith(C, 'Still plugged', 40_000)
    }
    // A and B attach (seen at t = 2000, 3000), then are unplugged; C stays.
    await attach(svc, roots[A])
    await attach(svc, roots[B])
    await cache.idle()
    svc.markUnavailable(A, roots[A])
    svc.markUnavailable(B, roots[B])
    await attach(svc, roots[C])
    await cache.idle()

    // 120 KB > 100 KB: A, the oldest-seen unavailable library, loses its posters.
    expect(cache.posterFile(A, 101)).toBeNull()
    expect(fs.existsSync(path.join(dir, A, 'posters'))).toBe(false)
    expect(cache.posterFile(B, 101)).not.toBeNull()
    expect(cache.posterFile(C, 101)).not.toBeNull()
    // Metadata is kept for all three.
    for (const id of [A, B, C]) expect((await cache.load(id))?.metas.has(101)).toBe(true)
    // A's card shows the placeholder: no poster is served for it.
    expect(await svc.posterFor(101)).not.toBe(path.join(dir, A, 'posters', '101.jpg'))
  })

  it('available libraries are never evicted, even over the cap', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir, totalMaxBytes: 50_000 })
    const svc = make(newStore(), cache)
    await attach(svc, libraryWith(A, 'One', 40_000))
    await attach(svc, libraryWith(B, 'Two', 40_000))
    await cache.idle()
    expect(cache.posterFile(A, 101)).not.toBeNull()
    expect(cache.posterFile(B, 101)).not.toBeNull()
  })

  it('an evicted library is cached again when it is seen again', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir, totalMaxBytes: 50_000 })
    const svc = make(newStore(), cache)
    const a = libraryWith(A, 'One', 40_000)
    await attach(svc, a)
    await cache.idle()
    svc.markUnavailable(A, a)
    await attach(svc, libraryWith(B, 'Two', 40_000))
    await cache.idle()
    expect(cache.posterFile(A, 101)).toBeNull()
    svc.markUnavailable(B, svc.get(B)!.root)
    expect(await svc.reopenAt(A, a)).toBe(true)
    await cache.idle()
    expect(cache.posterFile(A, 101)).not.toBeNull()
  })
})

describe('a drive lost while the posters are copied (review r4407995047)', () => {
  const ID = '44444444-4444-4444-8444-444444444444'

  /** Three poster files on a "drive", and a cache save input over them at `generation`. */
  function drive(generation: number, gone: Set<number> = new Set(), throws = false) {
    const root = tempRoot()
    for (const id of [1, 2, 3])
      fs.writeFileSync(path.join(root, `${id}.jpg`), Buffer.alloc(100, id))
    return {
      manifest: {
        libraryId: ID,
        generation,
        titles: [],
        items: []
      } as unknown as SharedLibraryManifest,
      metas: new Map<number, SharedLibraryMeta>(),
      posters: [1, 2, 3],
      posterSource: async (animeId: number): Promise<string | null> => {
        if (gone.has(animeId)) {
          if (throws) throw Object.assign(new Error('gone'), { code: 'EIO' })
          return null
        }
        return path.join(root, `${animeId}.jpg`)
      }
    }
  }

  const indexOf = (dir: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, ID, 'index.json'), 'utf8'))

  it.each([
    ['a missing poster', false],
    ['a read that throws', true]
  ])(
    '%s mid-loop keeps the last complete cache, and a later save of that generation still runs',
    async (_l, throws) => {
      const dir = path.join(tempRoot(), 'cache')
      const cache = createSnapshotCache({ dir })
      await cache.save(ID, drive(1), () => true)
      expect(indexOf(dir)).toMatchObject({ generation: 1, posters: [1, 2, 3] })

      await cache.save(ID, drive(2, new Set([2, 3]), throws), () => true)
      // Nothing of generation 2 was committed, and the old posters are all still served.
      expect(indexOf(dir)).toMatchObject({ generation: 1, posters: [1, 2, 3] })
      expect(indexOf(dir).evicted).toBeUndefined()
      for (const id of [1, 2, 3]) {
        const p = cache.posterFile(ID, id)
        expect(p && fs.existsSync(p)).toBe(true)
      }
      expect((await cache.load(ID))?.manifest.generation).toBe(1)
      expect(fs.existsSync(path.join(dir, ID, 'posters.next'))).toBe(false)

      await cache.save(ID, drive(2), () => true)
      expect(indexOf(dir)).toMatchObject({ generation: 2, posters: [1, 2, 3] })
    }
  )

  it('with no complete cache to keep, the partial one is marked so the same generation saves again', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    await cache.save(ID, drive(1, new Set([3])), () => true)
    expect(indexOf(dir)).toMatchObject({ generation: 1, posters: [1, 2], evicted: true })
    expect((await cache.load(ID))?.manifest.generation).toBe(1)
    await cache.save(ID, drive(1), () => true)
    expect(indexOf(dir)).toMatchObject({ generation: 1, posters: [1, 2, 3] })
    expect(indexOf(dir).evicted).toBeUndefined()
  })

  it('through the service: the drive pulled right after a read keeps the cache of the read before', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const root = copyFixtureLibrary()
    let pullOnChange = false
    const svc = make(newStore(), cache, {
      // Runs right after the read is committed, before the queued save copies a poster.
      onChanged: () => {
        if (pullOnChange) fs.renameSync(root, `${root}-away`)
      }
    })
    await attach(svc, root)
    await cache.idle()
    const first = JSON.parse(
      fs.readFileSync(path.join(dir, FIXTURE_LIBRARY_ID, 'index.json'), 'utf8')
    )
    expect(first.posters).toEqual([101])

    const file = path.join(root, '.anime-dl', 'manifest.json')
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1 }))
    pullOnChange = true
    await svc.refresh(FIXTURE_LIBRARY_ID, root)
    await cache.idle()
    const kept = JSON.parse(
      fs.readFileSync(path.join(dir, FIXTURE_LIBRARY_ID, 'index.json'), 'utf8')
    )
    expect(kept).toEqual(first)
    expect(fs.existsSync(cache.posterFile(FIXTURE_LIBRARY_ID, 101)!)).toBe(true)
  })
})

describe('a poster that is bad for good is skipped, not a lost drive (review r4408200616)', () => {
  const chmodded: string[] = []
  afterEach(() => {
    for (const f of chmodded.splice(0)) fs.chmodSync(f, 0o644)
  })

  const indexAt = (dir: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, FIXTURE_LIBRARY_ID, 'index.json'), 'utf8'))

  /** The fixture with a second poster, for Dungeon Meshi (202), spoiled by `spoil`. */
  async function withBadPoster(spoil: (poster: string) => void): Promise<void> {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const svc = make(newStore(), cache)
    const root = copyFixtureLibrary()
    const bad = path.join(root, '.anime-dl', 'posters', '202.jpg')
    fs.writeFileSync(bad, Buffer.alloc(500, 2))
    spoil(bad)
    await attach(svc, root)
    await cache.idle()
    // The save completed, without that poster.
    expect(indexAt(dir)).toMatchObject({ generation: 1, posters: [101] })
    expect(indexAt(dir).evicted).toBeUndefined()
    expect(cache.posterFile(FIXTURE_LIBRARY_ID, 202)).toBeNull()
    // And later generations still save.
    const file = path.join(root, '.anime-dl', 'manifest.json')
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...m, generation: 2 }))
    await svc.refresh(FIXTURE_LIBRARY_ID, root)
    await cache.idle()
    expect(indexAt(dir)).toMatchObject({ generation: 2, posters: [101] })
    expect((await cache.load(FIXTURE_LIBRARY_ID))?.manifest.generation).toBe(2)
  }

  it('a symlink that leads outside the root', async () => {
    await withBadPoster((poster) => {
      const outside = path.join(tempRoot(), 'elsewhere.jpg')
      fs.writeFileSync(outside, Buffer.alloc(500, 3))
      fs.rmSync(poster)
      fs.symlinkSync(outside, poster)
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a chmod 000 file (EACCES)',
    async () => {
      await withBadPoster((poster) => {
        fs.chmodSync(poster, 0o000)
        chmodded.push(poster)
      })
    }
  )

  it('a directory named <id>.jpg (EISDIR), swapped in after the read', async () => {
    // The read already drops a directory (`isFile()`), so the copy is handed one.
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const drive = tempRoot()
    fs.writeFileSync(path.join(drive, '1.jpg'), Buffer.alloc(100, 1))
    fs.mkdirSync(path.join(drive, '2.jpg'))
    const input = (generation: number) => ({
      manifest: {
        libraryId: FIXTURE_LIBRARY_ID,
        generation,
        titles: [],
        items: []
      } as unknown as SharedLibraryManifest,
      metas: new Map<number, SharedLibraryMeta>(),
      posters: [1, 2],
      posterSource: async (id: number): Promise<string> => path.join(drive, `${id}.jpg`)
    })
    await cache.save(FIXTURE_LIBRARY_ID, input(1), () => true)
    expect(indexAt(dir)).toMatchObject({ generation: 1, posters: [1] })
    expect(indexAt(dir).evicted).toBeUndefined()
    await cache.save(FIXTURE_LIBRARY_ID, input(2), () => true)
    expect(indexAt(dir)).toMatchObject({ generation: 2, posters: [1] })
  })
})

describe('Forget', () => {
  it("deletes the library's cache dir", async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const svc = make(newStore(), cache)
    await attach(svc, copyFixtureLibrary())
    await cache.idle()
    expect(fs.existsSync(path.join(dir, FIXTURE_LIBRARY_ID))).toBe(true)
    await svc.forget(FIXTURE_LIBRARY_ID)
    expect(fs.existsSync(path.join(dir, FIXTURE_LIBRARY_ID))).toBe(false)
    expect(await cache.load(FIXTURE_LIBRARY_ID)).toBeNull()
  })

  it('a write queued before Forget never brings the dir back', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    const svc = make(newStore(), cache)
    await attach(svc, copyFixtureLibrary())
    await svc.forget(FIXTURE_LIBRARY_ID)
    await cache.idle()
    expect(fs.existsSync(path.join(dir, FIXTURE_LIBRARY_ID))).toBe(false)
  })

  it('a libraryId that is not a plain id is never a folder name', async () => {
    const dir = path.join(tempRoot(), 'cache')
    const cache = createSnapshotCache({ dir })
    await cache.remove('../escape')
    expect(cache.posterFile('../x', 1)).toBeNull()
    expect(await cache.load('../x')).toBeNull()
    expect(fs.existsSync(path.dirname(dir) + '/escape')).toBe(false)
  })
})
