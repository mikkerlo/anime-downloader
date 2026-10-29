// The attached-library lifecycle (#582): the writability re-check on every
// availability transition, the write-failure demotion S9 (#584) reports, the
// transitions S9 subscribes to, "never written" across transitions for every
// kind of library, the disconnect classification, and a claim PC's rates.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  createAttachedLibraryService,
  type AttachedLibraryServiceDeps
} from '../../src/main/services/attached-library'
import { checkWritable } from '../../src/main/services/attached-library/writable'
import { createSnapshotCache } from '../../src/main/services/attached-library/snapshot-cache'
import { createSyncBaseStore } from '../../src/main/lib/sync-state/bases'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { cleanup, manifest, state, tempRoot, tree, LIB } from '../helpers/shared-library'
import {
  FIXTURE_LIBRARY_ID,
  copyFixtureLibrary,
  fsWritesUnder,
  mtimeSnapshot
} from '../helpers/attached-library'

const OWNER = { id: 4242, nickname: 'owner', avatar: '' }
const STRANGER = { id: 777, nickname: 'stranger', avatar: '' }
const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

interface Made {
  svc: ReturnType<typeof createAttachedLibraryService>
  store: InMemoryStorage
  onChanged: ReturnType<typeof vi.fn>
  log: {
    log: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  transitions: AttachedLibraryTransition[]
}

function make(
  initial: Record<string, unknown> = {},
  over: Partial<AttachedLibraryServiceDeps> = {}
): Made {
  const store = new InMemoryStorage({
    shikimoriUser: OWNER,
    shikimoriCredentials: null,
    downloadedAnime: {},
    attachedLibraries: {},
    ...initial
  })
  const onChanged = vi.fn()
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let t = 1_000
  const svc = createAttachedLibraryService({
    store,
    checkFfmpeg: async () => ({ available: true }),
    onChanged,
    log,
    now: () => (t += 1_000),
    ...over
  })
  const transitions: AttachedLibraryTransition[] = []
  svc.onAvailabilityChanged((tr) => transitions.push(tr))
  return { svc, store, onChanged, log, transitions }
}

async function attachAt(
  m: Made,
  root: string,
  choice?: SharedLibraryAttachChoice
): Promise<string> {
  const [c] = await m.svc.discover(root)
  const res = await m.svc.attach(c.libraryId!, choice)
  if (!res.ok) throw new Error(res.error)
  return c.libraryId!
}

/** An unplug and a re-plug at the same root: the poller's two calls. */
async function replug(m: Made, libraryId: string): Promise<void> {
  const root = m.svc.get(libraryId)!.root
  m.svc.markUnavailable(libraryId, root)
  expect(m.svc.get(libraryId)!.available).toBe(false)
  expect(await m.svc.reopenAt(libraryId, root)).toBe(true)
}

const chmodded: string[] = []
afterEach(() => {
  for (const d of chmodded.splice(0)) fs.chmodSync(d, 0o755)
  vi.restoreAllMocks()
  cleanup()
})

const posixNonRoot = process.platform === 'win32' || process.getuid?.() === 0

describe('read-only mounts: the access check on every availability transition', () => {
  it.skipIf(posixNonRoot)(
    'chmod -w on .anime-dl, then a re-detect: read-only (mount), and it still plays',
    async () => {
      const m = make()
      const root = copyFixtureLibrary()
      const id = await attachAt(m, root)
      expect(m.svc.get(id)!.access).toBe('read-write')
      const dir = path.join(root, '.anime-dl')
      fs.chmodSync(dir, 0o555)
      chmodded.push(dir)
      await replug(m, id)
      expect(m.svc.get(id)).toMatchObject({ access: 'read-only', accessReason: 'mount' })
      expect(await m.svc.resolveItem(101, '1', 9001)).not.toBeNull()
      // Writable again, the next transition clears it.
      fs.chmodSync(dir, 0o755)
      await replug(m, id)
      expect(m.svc.get(id)!.access).toBe('read-write')
      expect(m.svc.get(id)!.accessReason).toBeUndefined()
    }
  )

  it('every transition calls checkWritable on the root: startup, re-plug and attach', async () => {
    const checks: string[] = []
    const over = {
      checkWritable: async (root: string) => {
        checks.push(root)
        return { kind: 'writable' as const }
      }
    }
    const m = make({}, over)
    const root = copyFixtureLibrary()
    const id = await attachAt(m, root)
    expect(checks).toEqual([root])
    await replug(m, id)
    expect(checks).toEqual([root, root])
    const again = make({ attachedLibraries: m.store.get('attachedLibraries') }, over)
    await again.svc.init()
    expect(checks).toEqual([root, root, root])
  })

  it('an inconclusive check (EIO) on a transition keeps a mount read-only', async () => {
    let code = 'EROFS'
    const m = make(
      {},
      {
        checkWritable: (root) =>
          checkWritable(root, async () => {
            throw err(code)
          })
      }
    )
    const root = copyFixtureLibrary()
    const id = await attachAt(m, root)
    expect(m.svc.get(id)!.accessReason).toBe('mount')
    code = 'EIO'
    await replug(m, id)
    expect(m.svc.get(id)).toMatchObject({ access: 'read-only', accessReason: 'mount' })
  })
})

describe('never written across transitions, for every kind of library', () => {
  const kinds: [string, Record<string, unknown>, SharedLibraryAttachChoice | undefined, boolean][] =
    [
      ['owned', { shikimoriUser: OWNER }, undefined, false],
      ['claimed', { shikimoriUser: null }, 'claim', false],
      ['foreign', { shikimoriUser: STRANGER }, undefined, false],
      ['videos only', { shikimoriUser: null }, 'videos', true]
    ]

  function videosOnly(root: string): void {
    const file = path.join(root, '.anime-dl', 'manifest.json')
    const mf = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...mf, owner: null, mode: 'videos' }, null, 2) + '\n')
  }

  async function run(
    init: Record<string, unknown>,
    choice: SharedLibraryAttachChoice | undefined,
    videos: boolean,
    over: Partial<AttachedLibraryServiceDeps> = {}
  ): Promise<{ root: string; before: Record<string, string>; writes: () => unknown[] }> {
    const root = copyFixtureLibrary()
    if (videos) videosOnly(root)
    const before = mtimeSnapshot(root)
    const writes = fsWritesUnder(root)
    const cache = createSnapshotCache({ dir: path.join(tempRoot(), 'cache') })
    const m = make(init, { snapshotCache: cache, ...over })
    const id = await attachAt(m, root, choice)
    await replug(m, id)
    await m.svc.refresh(id, root)
    m.svc.reportWriteFailure(id, err('EROFS'))
    await replug(m, id)
    await m.svc.classifyMissing(path.join(root, 'nope.mkv'))
    const again = make(
      { ...init, attachedLibraries: m.store.get('attachedLibraries') },
      {
        snapshotCache: cache,
        ...over
      }
    )
    await again.svc.init()
    await cache.idle()
    return { root, before, writes }
  }

  it.each(kinds)(
    '%s: the tree, the mtimes and the fs spy are unchanged',
    async (_k, init, choice, videos) => {
      const { root, before, writes } = await run(init, choice, videos)
      expect(writes()).toEqual([])
      expect(mtimeSnapshot(root)).toEqual(before)
    }
  )

  it('a create-and-delete write probe on the transitions is caught (mutation control)', async () => {
    const probe = async (root: string): Promise<{ kind: 'writable' }> => {
      const p = path.join(root, '.anime-dl', '.write-probe')
      await fs.promises.writeFile(p, '')
      await fs.promises.unlink(p)
      return { kind: 'writable' }
    }
    const { writes } = await run({ shikimoriUser: OWNER }, undefined, false, {
      checkWritable: probe
    })
    expect(writes().length).toBeGreaterThan(0)
  })
})

describe('reportWriteFailure: the demotion at write time (S9 #584)', () => {
  it.each(['EROFS', 'EACCES', 'EPERM'])(
    '%s demotes to read-only (write-failed) and emits the change',
    async (code) => {
      const m = make()
      const id = await attachAt(m, copyFixtureLibrary())
      m.onChanged.mockClear()
      expect(m.svc.reportWriteFailure(id, err(code))).toBe(true)
      expect(m.svc.get(id)).toMatchObject({ access: 'read-only', accessReason: 'write-failed' })
      expect(
        (m.store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>)[id]
      ).toMatchObject({ access: 'read-only', accessReason: 'write-failed' })
      expect(m.onChanged).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['ENOSPC', 'EIO', undefined])('%s does not demote', async (code) => {
    const m = make()
    const id = await attachAt(m, copyFixtureLibrary())
    m.onChanged.mockClear()
    expect(m.svc.reportWriteFailure(id, code ? err(code) : new Error('x'))).toBe(false)
    expect(m.svc.get(id)!.access).toBe('read-write')
    expect(m.onChanged).not.toHaveBeenCalled()
  })

  it('never throws, for an unknown library or a non-error', () => {
    const m = make()
    expect(m.svc.reportWriteFailure('nope', err('EROFS'))).toBe(false)
    expect(m.svc.reportWriteFailure('nope', null)).toBe(false)
  })

  it('the next availability transition re-checks it: writable again', async () => {
    const m = make()
    const id = await attachAt(m, copyFixtureLibrary())
    m.svc.reportWriteFailure(id, err('EROFS'))
    m.transitions.length = 0
    await replug(m, id)
    expect(m.svc.get(id)!.access).toBe('read-write')
    expect(m.svc.get(id)!.accessReason).toBeUndefined()
    // S9's trigger: the library came back, and its access turned writable.
    expect(m.transitions.map((t) => [t.available, t.becameWritable])).toEqual([
      [false, false],
      [true, true]
    ])
  })

  it('a refresh that is not a transition keeps the demotion', async () => {
    const m = make()
    const root = copyFixtureLibrary()
    const id = await attachAt(m, root)
    m.svc.reportWriteFailure(id, err('EACCES'))
    await m.svc.refresh(id, root)
    expect(m.svc.get(id)).toMatchObject({ access: 'read-only', accessReason: 'write-failed' })
  })

  it('a version read-only is never cleared: not by a write failure, not by a writable transition', async () => {
    const root = tree({
      'manifest.json': manifest(1, 1),
      'state.json': state(1, 1, { stateVersion: 2 })
    })
    const m = make()
    await m.svc.discover(root)
    const res = await m.svc.attach(LIB)
    if (!res.ok) throw new Error(res.error)
    expect(m.svc.get(LIB)).toMatchObject({ access: 'read-only', accessReason: 'version' })
    expect(m.svc.reportWriteFailure(LIB, err('EROFS'))).toBe(false)
    expect(m.svc.get(LIB)!.accessReason).toBe('version')
    await replug(m, LIB)
    expect(m.svc.get(LIB)).toMatchObject({ access: 'read-only', accessReason: 'version' })
  })
})

describe('availability transitions (S9 subscribes)', () => {
  it('attach, unplug and re-plug each emit once; a refresh and an unchanged poll emit nothing', async () => {
    const m = make()
    const root = copyFixtureLibrary()
    const id = await attachAt(m, root)
    await m.svc.refresh(id, root)
    m.svc.markSeen(id)
    await replug(m, id)
    expect(m.transitions).toEqual([
      { libraryId: id, available: true, access: 'read-write', becameWritable: false },
      { libraryId: id, available: false, access: 'read-write', becameWritable: false },
      { libraryId: id, available: true, access: 'read-write', becameWritable: false }
    ])
  })

  it('startup emits available: true for each library it reads', async () => {
    const m = make()
    await attachAt(m, copyFixtureLibrary())
    const again = make({ attachedLibraries: m.store.get('attachedLibraries') })
    await again.svc.init()
    expect(again.transitions.map((t) => [t.libraryId, t.available])).toEqual([
      [FIXTURE_LIBRARY_ID, true]
    ])
  })

  it('a listener that throws does not fail the transition, and the unsubscribe works', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = make()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const off = m.svc.onAvailabilityChanged(bad)
    const id = await attachAt(m, copyFixtureLibrary())
    await replug(m, id)
    expect(m.svc.get(id)!.available).toBe(true)
    off()
    await replug(m, id)
    expect(bad).toHaveBeenCalledTimes(3)
    expect(logged).toHaveBeenCalledTimes(3)
  })
})

describe('the disconnect classification', () => {
  it('a path under an attached root that is gone: drive-disconnected, logged once until seen again', async () => {
    const m = make()
    const root = copyFixtureLibrary()
    const id = await attachAt(m, root)
    const file = path.join(root, 'Frieren~3f2a1c', 'Frieren~3f2a1c - 01 [Crunchyroll].mp4')
    expect(await m.svc.classifyMissing(file)).toBeNull()
    fs.renameSync(root, `${root}-away`)
    expect(await m.svc.classifyMissing(file)).toBe('drive-disconnected')
    expect(m.svc.reportUnreadable(file, err('ENOENT'))).toBe(true)
    const lines = (): unknown[] =>
      m.log.warn.mock.calls.filter((c) => String(c[0]).includes('drive-disconnected'))
    expect(lines()).toHaveLength(1)
    fs.renameSync(`${root}-away`, root)
    await replug(m, id)
    fs.renameSync(root, `${root}-away`)
    expect(await m.svc.classifyMissing(file)).toBe('drive-disconnected')
    expect(lines()).toHaveLength(2)
  })

  it('a local path that is gone is never a disconnected drive', async () => {
    const m = make()
    await attachAt(m, copyFixtureLibrary())
    const local = path.join(tempRoot(), 'local.mkv')
    expect(await m.svc.classifyMissing(local)).toBeNull()
    expect(m.svc.reportUnreadable(local, err('EIO'))).toBe(false)
  })

  it('reportUnreadable maps only the disconnect codes', async () => {
    const m = make()
    const root = copyFixtureLibrary()
    await attachAt(m, root)
    const file = path.join(root, 'x.mp4')
    for (const code of ['ENOENT', 'EIO', 'ENXIO', 'ENODEV', 'EBUSY']) {
      expect(m.svc.reportUnreadable(file, err(code))).toBe(true)
    }
    expect(m.svc.reportUnreadable(file, err('EACCES'))).toBe(false)
  })
})

describe('a claim PC reads rates from the library base', () => {
  async function claimed(withBase: boolean): Promise<{ m: Made; root: string }> {
    const userData = tempRoot()
    const bases = createSyncBaseStore(path.join(userData, 'sync-bases'), fs.promises)
    if (withBase) {
      await bases.write(`library-${FIXTURE_LIBRARY_ID}`, {
        stateGeneration: 1,
        doc: {
          stateVersion: 1,
          stateMinor: 0,
          installId: 'pc-claim',
          titles: {
            '101': {
              rate: {
                malId: 52991,
                episodes: { value: 7, at: 1, origin: 'pc-claim' },
                status: { value: 'watching', at: 1, origin: 'pc-claim' },
                score: { value: 9, at: 1, origin: 'pc-claim' },
                rewatches: { value: 0, at: 1, origin: 'pc-claim' }
              }
            }
          },
          priorityOrder: { value: [], at: 1, origin: 'pc-claim' },
          tombstones: {}
        }
      })
    }
    const m = make({ shikimoriUser: null }, { syncBases: bases })
    const root = copyFixtureLibrary()
    await attachAt(m, root, 'claim')
    return { m, root }
  }

  it("shows the base's rate on the card and the detail page, drive plugged or not", async () => {
    const { m, root } = await claimed(true)
    const rate = { score: 9, status: 'watching', episodes: 7 }
    const frieren = (libs: AttachedLibraryInfo[]) => libs[0].titles.find((t) => t.animeId === 101)
    expect(frieren(await m.svc.listWithRates())?.rate).toEqual(rate)
    m.svc.markUnavailable(FIXTURE_LIBRARY_ID, root)
    fs.renameSync(root, `${root}-away`)
    expect(frieren(await m.svc.listWithRates())?.rate).toEqual(rate)
    expect((await m.svc.getTitle(FIXTURE_LIBRARY_ID, 101))?.rate).toEqual(rate)
    expect(frieren(await m.svc.listWithRates())).toBeDefined()
    expect(
      (await m.svc.listWithRates())[0].titles.find((t) => t.animeId === 202)?.rate
    ).toBeUndefined()
  })

  it('with no base file, no rate', async () => {
    const { m } = await claimed(false)
    expect((await m.svc.listWithRates())[0].titles.every((t) => t.rate === undefined)).toBe(true)
    expect((await m.svc.getTitle(FIXTURE_LIBRARY_ID, 101))?.rate).toBeUndefined()
  })

  it('an owner PC never reads the base', async () => {
    const read = vi.fn(async () => null)
    const m = make({ shikimoriUser: OWNER }, { syncBases: { read } })
    await attachAt(m, copyFixtureLibrary())
    await m.svc.listWithRates()
    await m.svc.getTitle(FIXTURE_LIBRARY_ID, 101)
    expect(read).not.toHaveBeenCalled()
  })
})
