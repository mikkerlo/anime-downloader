// Forget and Re-locate (#581): the `needsConfirm` round trip, the forget-hook
// contract (multi-listener, awaited `pendingCount` summed per part, awaited
// `onForgotten`), the drive never touched, and Re-locate by `libraryId` only.
// S9 (#584)'s own hook semantics are tested in S9's suite; these use fakes.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  createAttachedLibraryService,
  type AttachedLibraryServiceDeps,
  type ForgetHook
} from '../../src/main/services/attached-library'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { cleanup, tempRoot, OWNER_ID } from '../helpers/shared-library'
import {
  FIXTURE_LIBRARY_ID,
  copyFixtureLibrary,
  fsWritesUnder,
  mtimeSnapshot
} from '../helpers/attached-library'

const ID = FIXTURE_LIBRARY_ID

function make(over: Partial<AttachedLibraryServiceDeps> = {}) {
  const store = new InMemoryStorage({
    shikimoriUser: null,
    downloadedAnime: {},
    attachedLibraries: {},
    sharedLibraryPromptDismissed: []
  })
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const onChanged = vi.fn()
  const svc = createAttachedLibraryService({
    store,
    checkFfmpeg: async () => ({ available: true }),
    onChanged,
    log,
    now: () => 1_000,
    ...over
  })
  return { svc, store, log, onChanged }
}

async function attached(over: Partial<AttachedLibraryServiceDeps> = {}) {
  const m = make(over)
  const root = copyFixtureLibrary()
  await m.svc.discover(root)
  // No account: the local claim, so Forget has a claim to drop.
  const res = await m.svc.attach(ID, 'claim')
  if (!res.ok) throw new Error(res.error)
  m.svc.dismissPrompt([ID, 'other-id'])
  return { ...m, root }
}

const records = (store: InMemoryStorage) =>
  store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>

function hook(
  count?: SharedLibraryPendingCount | (() => Promise<SharedLibraryPendingCount>),
  onForgotten: (id: string) => Promise<void> = async () => {}
) {
  const h = {
    ...(count !== undefined
      ? { pendingCount: vi.fn(typeof count === 'function' ? count : () => count) }
      : {}),
    onForgotten: vi.fn(onForgotten)
  }
  return h as ForgetHook & { onForgotten: ReturnType<typeof vi.fn> }
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('Forget', () => {
  it('removes the entry, the claim and the dismissed entry, and never writes under the root', async () => {
    const m = await attached()
    expect(records(m.store)[ID].claim?.ownerId).toBe(OWNER_ID)
    const before = mtimeSnapshot(m.root)
    const writes = fsWritesUnder(m.root)

    expect(await m.svc.forget(ID)).toEqual({ needsConfirm: false })

    expect(records(m.store)[ID]).toBeUndefined()
    expect(m.svc.get(ID)).toBeNull()
    expect(m.svc.list()).toEqual([])
    expect(m.store.get('sharedLibraryPromptDismissed')).toEqual(['other-id'])
    expect(m.svc.roots()).toEqual([])
    expect(m.onChanged).toHaveBeenCalled()
    expect(writes()).toEqual([])
    expect(mtimeSnapshot(m.root)).toEqual(before)
  })

  it('an async pendingCount of { 3, 1 }: the first call asks and changes nothing; the confirmed call forgets and runs onForgotten once', async () => {
    const m = await attached()
    const h = hook(async () => ({ libraryChanges: 3, resolutions: 1 }))
    m.svc.registerForgetHook(h)
    const stored = structuredClone(records(m.store))

    expect(await m.svc.forget(ID)).toEqual({
      needsConfirm: true,
      pendingCount: { libraryChanges: 3, resolutions: 1 }
    })
    expect(records(m.store)).toEqual(stored)
    expect(m.svc.get(ID)?.available).toBe(true)
    expect(m.store.get('sharedLibraryPromptDismissed')).toEqual([ID, 'other-id'])
    expect(h.onForgotten).not.toHaveBeenCalled()

    expect(await m.svc.forget(ID, { confirmDropPending: true })).toEqual({ needsConfirm: false })
    expect(records(m.store)[ID]).toBeUndefined()
    expect(h.onForgotten).toHaveBeenCalledTimes(1)
    expect(h.onForgotten).toHaveBeenCalledWith(ID)
  })

  it('two hooks: the two numbers are summed separately', async () => {
    const m = await attached()
    m.svc.registerForgetHook(hook({ libraryChanges: 2, resolutions: 0 }))
    m.svc.registerForgetHook(hook(async () => ({ libraryChanges: 1, resolutions: 4 })))
    expect(await m.svc.forget(ID)).toEqual({
      needsConfirm: true,
      pendingCount: { libraryChanges: 3, resolutions: 4 }
    })
  })

  it('a sync { 0, 0 } needs no confirmation; { 0, 2 } does', async () => {
    const zero = await attached()
    zero.svc.registerForgetHook(hook({ libraryChanges: 0, resolutions: 0 }))
    expect(await zero.svc.forget(ID)).toEqual({ needsConfirm: false })
    expect(records(zero.store)[ID]).toBeUndefined()

    const m = await attached()
    m.svc.registerForgetHook(hook({ libraryChanges: 0, resolutions: 2 }))
    expect(await m.svc.forget(ID)).toEqual({
      needsConfirm: true,
      pendingCount: { libraryChanges: 0, resolutions: 2 }
    })
    expect(records(m.store)[ID]).toBeDefined()
  })

  it('two registered hooks both run; an unsubscribed one does not', async () => {
    const m = await attached()
    const a = hook()
    const b = hook()
    const gone = hook({ libraryChanges: 9, resolutions: 9 })
    m.svc.registerForgetHook(a)
    const off = m.svc.registerForgetHook(gone)
    m.svc.registerForgetHook(b)
    off()
    off()
    expect(await m.svc.forget(ID)).toEqual({ needsConfirm: false })
    expect(a.onForgotten).toHaveBeenCalledTimes(1)
    expect(b.onForgotten).toHaveBeenCalledTimes(1)
    expect(gone.onForgotten).not.toHaveBeenCalled()
    expect(gone.pendingCount).not.toHaveBeenCalled()
  })

  it('resolves only after every async onForgotten settled; a rejecting hook is logged and the others still run', async () => {
    const m = await attached()
    let release!: () => void
    const slow = hook(
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const failing = hook(undefined, async () => {
      throw new Error('boom')
    })
    const after = hook()
    m.svc.registerForgetHook(slow)
    m.svc.registerForgetHook(failing)
    m.svc.registerForgetHook(after)

    let settled = false
    const p = m.svc.forget(ID).then((r) => {
      settled = true
      return r
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(slow.onForgotten).toHaveBeenCalled()
    expect(after.onForgotten).toHaveBeenCalled()
    expect(settled).toBe(false)
    release()
    expect(await p).toEqual({ needsConfirm: false })
    expect(m.log.error).toHaveBeenCalledWith(
      expect.stringContaining('forget hook failed'),
      expect.any(Error)
    )
  })

  it("waits for the library's sync run (step 1) before counting", async () => {
    let finishSync!: () => void
    const order: string[] = []
    const m = await attached({
      syncIdle: () =>
        new Promise<void>((resolve) => {
          finishSync = () => {
            order.push('sync done')
            resolve()
          }
        })
    })
    m.svc.registerForgetHook(
      hook(async () => {
        order.push('count')
        return { libraryChanges: 0, resolutions: 0 }
      })
    )
    const p = m.svc.forget(ID)
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual([])
    finishSync()
    await p
    expect(order).toEqual(['sync done', 'count'])
  })

  it('a poller re-read that lands after Forget does not bring the entry back', async () => {
    const m = await attached()
    const re = m.svc.reopenAt(ID, m.root)
    await m.svc.forget(ID)
    await re
    expect(records(m.store)[ID]).toBeUndefined()
    expect(m.svc.list()).toEqual([])
  })
})

describe('Re-locate', () => {
  it('refuses a folder whose libraryId differs, and changes nothing', async () => {
    const m = await attached()
    const other = copyFixtureLibrary()
    const file = path.join(other, '.anime-dl', 'manifest.json')
    const man = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(
      file,
      JSON.stringify({ ...man, libraryId: '0f0f0f0f-0000-4000-8000-00000000000f' })
    )
    const res = await m.svc.relocate(ID, path.dirname(other))
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining('holds a different Shared Library')
    })
    expect(records(m.store)[ID].root).toBe(m.root)
  })

  it('a folder with no library is refused too', async () => {
    const m = await attached()
    const empty = tempRoot()
    const res = await m.svc.relocate(ID, empty)
    expect(res.ok).toBe(false)
    expect(records(m.store)[ID].root).toBe(m.root)
  })

  it('accepts the same libraryId at a new path (or one level below), and it becomes available there', async () => {
    const m = await attached()
    const parent = path.join(tempRoot(), 'NEWSTICK')
    fs.mkdirSync(parent)
    const moved = path.join(parent, 'Anime')
    fs.renameSync(m.root, moved)
    const res = await m.svc.relocate(ID, parent)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.library.root).toBe(moved)
      expect(res.library.available).toBe(true)
    }
    expect(records(m.store)[ID].root).toBe(moved)
  })
})
