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
