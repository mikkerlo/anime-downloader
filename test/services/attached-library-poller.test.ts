// The availability poller (#581): known roots by `libraryId`, mount candidates
// one level deep, the found-on-a-drive event once per mount, the async budget
// with its in-flight set and 2-call cap, network mounts dropped, and no sync fs.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  createAvailabilityPoller,
  MAX_OUTSTANDING,
  volumeLabel,
  type AvailabilityPollerDeps,
  type PollerTarget
} from '../../src/main/services/attached-library/poller'
import {
  createAttachedLibraryService,
  type AttachedLibraryServiceDeps
} from '../../src/main/services/attached-library'
import {
  createClassifyMounts,
  createMountCandidates
} from '../../src/main/lib/shared-library/mount-candidates'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { cleanup, tempRoot } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'

const L = 'aaaaaaaa-0000-4000-8000-000000000001'
const U = 'bbbbbbbb-0000-4000-8000-000000000002'
const U2 = 'cccccccc-0000-4000-8000-000000000003'

const never = <T>(): Promise<T> => new Promise<T>(() => {})

/**
 * A fake drive world: `drive` maps a library root to the `libraryId` in its
 * manifest. `statManifest`, `discover` and `identify` read it, as the real
 * ones read the disk; `target` is a minimal attached-library service.
 */
function world(known: Record<string, { root: string; available: boolean }>) {
  const drive = new Map<string, string>()
  const state = structuredClone(known)
  const dismissed = new Set<string>()
  const cand = (root: string): SharedLibraryCandidate => ({
    root,
    libraryId: drive.get(root)!,
    name: `Lib ${drive.get(root)!.slice(0, 4)}`,
    ownerNickname: 'nick',
    mode: 'metadata',
    titleCount: 1,
    identity: 'choose'
  })
  const target: PollerTarget = {
    known: () => Object.entries(state).map(([libraryId, s]) => ({ libraryId, ...s })),
    reopenAt: vi.fn(async (id: string, root: string) => {
      if (drive.get(root) !== id || !state[id]) return false
      state[id] = { root, available: true }
      return true
    }),
    markUnavailable: vi.fn((id: string, root: string) => {
      if (state[id]?.root === root) state[id].available = false
    }),
    markSeen: vi.fn(),
    identify: vi.fn(async (root: string) => (drive.has(root) ? cand(root) : null)),
    isDismissed: (id) => dismissed.has(id)
  }
  const sep = (dir: string): string => (/[\\/]$/.test(dir) ? dir : `${dir}/`)
  const deps = {
    statManifest: vi.fn(async (root: string) =>
      drive.has(root) ? `sig:${drive.get(root)}` : null
    ),
    discover: vi.fn(async (dir: string) =>
      [...drive.keys()].filter(
        (r) => r === dir || (r.startsWith(sep(dir)) && !r.slice(sep(dir).length).includes('/'))
      )
    )
  }
  return { drive, state, dismissed, target, deps }
}

function poller(
  w: ReturnType<typeof world>,
  mounts: () => string[],
  over: Partial<AvailabilityPollerDeps> = {}
) {
  const onFound = vi.fn()
  const p = createAvailabilityPoller({
    target: w.target,
    candidates: async () => mounts(),
    onFound,
    ...w.deps,
    log: { warn: vi.fn() },
    ...over
  })
  return { p, onFound }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  cleanup()
})

describe('known libraries, matched by libraryId', () => {
  it('a library moving from E:\\ to F:\\ is found by libraryId and its root updates', async () => {
    const w = world({ [L]: { root: 'E:\\Anime', available: true } })
    w.drive.set('E:\\Anime', L)
    let mounts = ['E:\\']
    const { p } = poller(w, () => mounts)
    await p.tick()
    expect(w.state[L]).toEqual({ root: 'E:\\Anime', available: true })

    // Unplugged, re-plugged as F:.
    w.drive.delete('E:\\Anime')
    w.drive.set('F:\\Anime', L)
    mounts = ['F:\\']
    await p.tick()
    expect(w.target.markUnavailable).toHaveBeenCalledWith(L, 'E:\\Anime')
    expect(w.target.reopenAt).toHaveBeenCalledWith(L, 'F:\\Anime')
    expect(w.state[L]).toEqual({ root: 'F:\\Anime', available: true })
  })

  it('moved to another folder on a drive already scanned: searched while unavailable, and found', async () => {
    const w = world({ [L]: { root: '/media/u/STICK/Anime', available: true } })
    w.drive.set('/media/u/STICK/Anime', L)
    const { p } = poller(w, () => ['/media/u/STICK'])
    await p.tick()
    await p.tick()
    expect(w.deps.discover).toHaveBeenCalledTimes(1)
    w.drive.delete('/media/u/STICK/Anime')
    w.drive.set('/media/u/STICK/Renamed', L)
    await p.tick()
    expect(w.state[L]).toEqual({ root: '/media/u/STICK/Renamed', available: true })
  })

  it('an unchanged known root is not re-read; the first tick takes the startup read as current', async () => {
    const w = world({ [L]: { root: '/media/u/STICK', available: true } })
    w.drive.set('/media/u/STICK', L)
    const { p } = poller(w, () => ['/media/u/STICK'])
    await p.tick()
    await p.tick()
    expect(w.target.reopenAt).not.toHaveBeenCalled()
    expect(w.target.markSeen).toHaveBeenCalledTimes(2)
  })

  it('back at the same root after an unplug: re-read and available', async () => {
    const w = world({ [L]: { root: '/mnt/usb/Anime', available: true } })
    const { p } = poller(w, () => [])
    await p.tick()
    expect(w.state[L].available).toBe(false)
    w.drive.set('/mnt/usb/Anime', L)
    await p.tick()
    expect(w.target.reopenAt).toHaveBeenCalledWith(L, '/mnt/usb/Anime')
    expect(w.state[L]).toEqual({ root: '/mnt/usb/Anime', available: true })
  })

  it('a different library at the old root is read once, not on every tick', async () => {
    const w = world({ [L]: { root: '/mnt/usb/Anime', available: false } })
    w.drive.set('/mnt/usb/Anime', U)
    w.dismissed.add(U)
    const { p } = poller(w, () => [])
    await p.tick()
    await p.tick()
    await p.tick()
    expect(w.target.reopenAt).toHaveBeenCalledTimes(1)
    expect(w.state[L].available).toBe(false)
  })
})

describe('unknown libraries on a newly mounted drive', () => {
  it('emit SHARED_LIBRARY_FOUND once per mount, one event listing every library on it', async () => {
    const w = world({})
    w.drive.set('/media/u/STICK/A', U)
    w.drive.set('/media/u/STICK/B', U2)
    let mounts = ['/media/u/STICK']
    const { p, onFound } = poller(w, () => mounts)
    await p.tick()
    await p.tick()
    await p.tick()
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(onFound.mock.calls[0][0]).toMatchObject({
      volume: 'STICK',
      dir: '/media/u/STICK',
      candidates: [{ libraryId: U }, { libraryId: U2 }]
    })
    // Unmounted, mounted again: offered again.
    mounts = []
    await p.tick()
    mounts = ['/media/u/STICK']
    await p.tick()
    expect(onFound).toHaveBeenCalledTimes(2)
  })

  it('once per mount even while an unplugged library keeps every mount scanned', async () => {
    const w = world({ [L]: { root: '/mnt/gone/Anime', available: false } })
    w.drive.set('/media/u/STICK', U)
    const { p, onFound } = poller(w, () => ['/media/u/STICK'])
    await p.tick()
    await p.tick()
    await p.tick()
    expect(w.deps.discover).toHaveBeenCalledTimes(3)
    expect(onFound).toHaveBeenCalledTimes(1)
  })

  it('a dismissed libraryId emits nothing', async () => {
    const w = world({})
    w.drive.set('/media/u/STICK', U)
    w.dismissed.add(U)
    const { p, onFound } = poller(w, () => ['/media/u/STICK'])
    await p.tick()
    expect(onFound).not.toHaveBeenCalled()
  })

  it('an attached library on a new mount is not offered', async () => {
    const w = world({ [L]: { root: '/media/u/STICK', available: true } })
    w.drive.set('/media/u/STICK', L)
    const { p, onFound } = poller(w, () => ['/media/u/STICK'])
    await p.tick()
    expect(onFound).not.toHaveBeenCalled()
  })

  it('with every library available, a mount already offered is not scanned again', async () => {
    const w = world({})
    w.drive.set('/media/u/STICK', U)
    const { p } = poller(w, () => ['/media/u/STICK'])
    await p.tick()
    await p.tick()
    await p.tick()
    expect(w.deps.discover).toHaveBeenCalledTimes(1)
  })

  it('volume labels: a drive letter, or the mount folder', () => {
    expect(volumeLabel('f:\\')).toBe('F:')
    expect(volumeLabel('/run/media/u/KINGSTON')).toBe('KINGSTON')
  })
})

describe('the async budget', () => {
  it('a candidate whose stat never settles is abandoned after 1 s; the tick completes and later ticks skip it', async () => {
    vi.useFakeTimers()
    const w = world({ [L]: { root: '/mnt/hung', available: true } })
    w.deps.statManifest.mockImplementation((root: string) =>
      root === '/mnt/hung' ? never<string | null>() : Promise.resolve(null)
    )
    const { p } = poller(w, () => [])
    let done = false
    void p.tick().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    // Abandoned, not judged: still available.
    expect(w.target.markUnavailable).not.toHaveBeenCalled()

    for (let i = 0; i < 3; i++) {
      const t = p.tick()
      await vi.advanceTimersByTimeAsync(1000)
      await t
    }
    expect(w.deps.statManifest.mock.calls.filter(([r]) => r === '/mnt/hung')).toHaveLength(1)
  })

  it('no more than 2 calls are ever outstanding, across ticks', async () => {
    vi.useFakeTimers()
    const known: Record<string, { root: string; available: boolean }> = {}
    for (let i = 0; i < 4; i++) known[`lib-${i}`] = { root: `/mnt/k${i}`, available: true }
    const w = world(known)
    let outstanding = 0
    let max = 0
    const settle: (() => void)[] = []
    const track = <T>(value: T) =>
      new Promise<T>((resolve) => {
        outstanding++
        max = Math.max(max, outstanding)
        settle.push(() => {
          outstanding--
          resolve(value)
        })
      })
    w.deps.statManifest.mockImplementation(() => track<string | null>(null))
    w.deps.discover.mockImplementation(() => track<string[]>([]))
    const { p } = poller(w, () => ['/media/u/A', '/media/u/B', '/media/u/C'])

    for (let i = 0; i < 4; i++) {
      const t = p.tick()
      await vi.advanceTimersByTimeAsync(2000)
      await t
    }
    expect(MAX_OUTSTANDING).toBe(2)
    expect(max).toBe(2)
    expect(w.deps.statManifest).toHaveBeenCalledTimes(2)
    expect(w.deps.discover).not.toHaveBeenCalled()

    // One settles: the next tick takes exactly one more call.
    settle.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    const t = p.tick()
    await vi.advanceTimersByTimeAsync(2000)
    await t
    expect(max).toBe(2)
    expect(w.deps.statManifest).toHaveBeenCalledTimes(3)
  })

  it('the interval and window focus both tick; stop ends it', async () => {
    vi.useFakeTimers()
    const w = world({ [L]: { root: '/mnt/usb', available: true } })
    w.drive.set('/mnt/usb', L)
    const { p } = poller(w, () => [], { intervalMs: 50 })
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.deps.statManifest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(w.deps.statManifest).toHaveBeenCalledTimes(2)
    p.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.deps.statManifest).toHaveBeenCalledTimes(3)
    p.stop()
    p.poke()
    await vi.advanceTimersByTimeAsync(500)
    expect(w.deps.statManifest).toHaveBeenCalledTimes(3)
  })
})

describe('network mounts are never probed', () => {
  it('cifs and nfs4 under /mnt: no discover call there; classifyMounts runs once per candidate-set change', async () => {
    const w = world({})
    w.drive.set('/mnt/usb/A', U)
    const mountinfo = [
      '22 1 8:1 / / rw - ext4 /dev/sda1 rw',
      '41 22 0:44 / /mnt/nas rw - cifs //nas/share rw',
      '42 22 0:45 / /mnt/nfs rw - nfs4 srv:/x rw',
      '44 22 8:17 / /mnt/usb rw - vfat /dev/sdb1 rw'
    ].join('\n')
    const classify = vi.fn(
      createClassifyMounts({ platform: 'linux', readMountinfo: async () => mountinfo })
    )
    let names = ['nas', 'nfs', 'usb']
    const candidates = createMountCandidates({
      platform: 'linux',
      user: 'u',
      listDirs: async (dir) => (dir === '/mnt' ? names : []),
      classifyMounts: classify
    })
    const { p, onFound } = poller(w, () => [], { candidates })
    for (let i = 0; i < 3; i++) await p.tick()
    expect(w.deps.discover.mock.calls.map(([d]) => d)).toEqual(['/mnt/usb'])
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(classify).toHaveBeenCalledTimes(1)
    names = ['nas', 'nfs', 'usb', 'usb2']
    for (let i = 0; i < 3; i++) await p.tick()
    expect(classify).toHaveBeenCalledTimes(2)
  })
})

describe('no sync fs in poller.ts', () => {
  it('uses none of existsSync, accessSync, statSync, readdirSync (or any *Sync)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/main/services/attached-library/poller.ts'),
      'utf8'
    )
    for (const name of ['existsSync', 'accessSync', 'statSync', 'readdirSync']) {
      expect(src).not.toContain(name)
    }
    expect(src).not.toMatch(/\b\w+Sync\s*\(/)
  })
})

describe('with the real service (the behaviour difference)', () => {
  function make(over: Partial<AttachedLibraryServiceDeps> = {}) {
    const store = new InMemoryStorage({
      shikimoriUser: null,
      downloadedAnime: {},
      attachedLibraries: {},
      sharedLibraryPromptDismissed: []
    })
    let t = 1_000
    const svc = createAttachedLibraryService({
      store,
      checkFfmpeg: async () => ({ available: true }),
      log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => t,
      ...over
    })
    return { svc, store, setNow: (n: number) => (t = n) }
  }

  async function attached() {
    const m = make()
    const root = copyFixtureLibrary()
    const [c] = await m.svc.discover(root)
    const res = await m.svc.attach(c.libraryId!, 'videos')
    if (!res.ok) throw new Error(res.error)
    return { ...m, root }
  }

  it("a library re-plugged under a new path is found again; S7a's startup re-read alone leaves it unavailable", async () => {
    const first = await attached()
    const { store, root } = first
    const mounts = path.join(tempRoot(), 'mounts')
    fs.mkdirSync(mounts)
    const moved = path.join(mounts, 'KINGSTON')
    fs.renameSync(root, moved)

    // S7a: the only re-read is the startup one, and it reads the old root.
    const svc = createAttachedLibraryService({
      store,
      checkFfmpeg: async () => ({ available: true }),
      log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    await svc.init()
    expect(svc.get(FIXTURE_LIBRARY_ID)?.available).toBe(false)
    await svc.init()
    expect(svc.get(FIXTURE_LIBRARY_ID)?.available).toBe(false)

    const p = createAvailabilityPoller({
      target: svc,
      candidates: createMountCandidates({
        parents: [mounts],
        classifyMounts: async () => new Map()
      }),
      onFound: vi.fn()
    })
    await p.tick()
    const info = svc.get(FIXTURE_LIBRARY_ID)!
    expect(info.available).toBe(true)
    expect(info.root).toBe(moved)
    expect(info.titles.length).toBeGreaterThan(0)
    expect(
      (store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>)[FIXTURE_LIBRARY_ID]
        .root
    ).toBe(moved)
  })

  it('removing the dir gives unavailable, with lastSeenAt the last time it was seen', async () => {
    const { svc, store, root, setNow } = await attached()
    const p = createAvailabilityPoller({
      target: svc,
      candidates: async () => [],
      onFound: vi.fn()
    })
    setNow(5_000)
    await p.tick()
    setNow(9_000)
    fs.renameSync(root, `${root}-away`)
    await p.tick()
    const info = svc.get(FIXTURE_LIBRARY_ID)!
    expect(info.available).toBe(false)
    expect(info.lastSeenAt).toBe(5_000)
    expect(
      (store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>)[FIXTURE_LIBRARY_ID]
        .lastSeenAt
    ).toBe(5_000)
    // Its in-memory copy stays (S8 greys it), but search drops it (S3b).
    expect(info.titles.length).toBeGreaterThan(0)
    expect(svc.availableSnapshots()).toEqual([])

    fs.renameSync(`${root}-away`, root)
    await p.tick()
    expect(svc.get(FIXTURE_LIBRARY_ID)!.available).toBe(true)
    expect(svc.get(FIXTURE_LIBRARY_ID)!.lastSeenAt).toBe(9_000)
    expect(svc.availableSnapshots()).toHaveLength(1)
  })

  it('quitting saves the time each available library was last seen', async () => {
    const { svc, store, setNow } = await attached()
    const p = createAvailabilityPoller({
      target: svc,
      candidates: async () => [],
      onFound: vi.fn()
    })
    setNow(7_000)
    await p.tick()
    // The in-memory store hands out its own object, so check what is written.
    const set = vi.spyOn(store, 'set')
    svc.saveLastSeen()
    expect(set).toHaveBeenCalledWith(
      'attachedLibraries',
      expect.objectContaining({
        [FIXTURE_LIBRARY_ID]: expect.objectContaining({ lastSeenAt: 7_000 })
      })
    )
  })

  it("a replica the poller finds on another drive doesn't redirect the Attach of a hand-opened one", async () => {
    const m = make()
    const opened = copyFixtureLibrary()
    const mounts = path.join(tempRoot(), 'mounts')
    const replica = path.join(mounts, 'STICK', 'Fixture library')
    fs.mkdirSync(path.dirname(replica), { recursive: true })
    fs.cpSync(opened, replica, { recursive: true })

    // The user opens folder A by hand; the dialog is up.
    const [candidate] = await m.svc.discover(opened)
    expect(candidate.root).toBe(opened)
    // Meanwhile the poller identifies the replica B on a newly mounted stick.
    const onFound = vi.fn()
    const p = createAvailabilityPoller({
      target: m.svc,
      candidates: createMountCandidates({
        parents: [mounts],
        classifyMounts: async () => new Map()
      }),
      onFound
    })
    await p.tick()
    expect((onFound.mock.calls[0][0] as SharedLibraryFound).candidates[0].root).toBe(replica)

    // Attach in the hand-opened dialog opens A.
    const res = await m.svc.attach(FIXTURE_LIBRARY_ID, 'videos')
    expect(res.ok && res.library.root).toBe(opened)
    // The toast's Open would have taken B.
    const viaToast = make().svc
    await createAvailabilityPoller({
      target: viaToast,
      candidates: createMountCandidates({
        parents: [mounts],
        classifyMounts: async () => new Map()
      }),
      onFound: vi.fn()
    }).tick()
    const res2 = await viaToast.attach(FIXTURE_LIBRARY_ID, 'videos', 'found')
    expect(res2.ok && res2.library.root).toBe(replica)
  })

  it('an unknown library found by the poller can be attached from the event', async () => {
    const m = make()
    const mounts = path.join(tempRoot(), 'mounts')
    fs.mkdirSync(mounts)
    const stick = path.join(mounts, 'STICK')
    fs.mkdirSync(stick)
    fs.cpSync(copyFixtureLibrary(), path.join(stick, 'Fixture library'), { recursive: true })
    const onFound = vi.fn()
    const p = createAvailabilityPoller({
      target: m.svc,
      candidates: createMountCandidates({
        parents: [mounts],
        classifyMounts: async () => new Map()
      }),
      onFound
    })
    await p.tick()
    expect(onFound).toHaveBeenCalledTimes(1)
    const found = onFound.mock.calls[0][0] as SharedLibraryFound
    expect(found.volume).toBe('STICK')
    expect(found.candidates.map((c) => c.libraryId)).toEqual([FIXTURE_LIBRARY_ID])
    const res = await m.svc.attach(FIXTURE_LIBRARY_ID, 'videos', 'found')
    expect(res.ok).toBe(true)

    m.svc.dismissPrompt([U])
    expect(m.svc.isDismissed(U)).toBe(true)
    expect(m.store.get('sharedLibraryPromptDismissed')).toEqual([U])
  })
})
