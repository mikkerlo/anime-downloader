// Forget and Re-locate (#581): the `needsConfirm` round trip, the forget-hook
// contract (multi-listener, awaited `pendingCount` summed per part, awaited
// `onForgotten`), the drive never touched, and Re-locate by `libraryId` only.
// S9 (#584)'s own hook semantics are tested in S9's suite; these use fakes.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import {
  ANIME,
  MAL,
  OWNER,
  T0,
  cacheEntry,
  makeLibrary,
  makePc,
  server,
  type Pc
} from '../helpers/sync-runner'
import { createFakeTracker } from '../helpers/fake-tracker'
import {
  createTrackerSyncService,
  type TrackerSyncService
} from '../../src/main/services/trackers/sync'
import { createTrackerFanOut, type PrimaryWriter } from '../../src/main/services/trackers/fan-out'
import type { RunnerTracker } from '../../src/main/services/sync-runner'
import { ANILIST_KEYS } from '../../src/main/trackers/keys'
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
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

// --- #692 § 6: Forget strips every tracker's queues, and rebases later `via` survivors.
describe('Forget across trackers (#692 § 6)', () => {
  const v = (episodes: number): RateValues => ({
    episodes,
    status: 'watching',
    score: 7,
    rewatches: 0
  })

  /** A Shikimori-owned library K on an owner PC, with an AniList tracker beside Shikimori. */
  async function twoTrackers() {
    server.reset()
    const runnerTrackers: RunnerTracker[] = []
    const pc = makePc({
      store: {
        anilistCredentials: { v: 1, enc: 'plain', data: 'blob' },
        anilistUser: { id: 1, nickname: 'al', avatar: null },
        anilistUserRates: [],
        anilistUpdateQueue: [],
        anilistParkedQueues: {},
        trackerMirror: {}
      },
      runner: { trackers: runnerTrackers }
    })
    pc.offline.value = true
    const fake = createFakeTracker('anilist')
    const anilist = createTrackerSyncService(
      {
        ...fake.provider,
        isSessionGone: () => false,
        rateCache: {
          fromEntries: () => [],
          malIdOf: (row: { malId: number }) => row.malId,
          indexOf: (rows: { malId: number }[], malId: number) =>
            rows.findIndex((r) => r.malId === malId),
          read: (row: { values: RateValues }) => ({ remoteId: null, values: row.values }),
          patch: (row: object, values: RateValues) => ({ ...row, values })
        }
      } as never,
      ANILIST_KEYS,
      {
        store: pc.store as never,
        broadcast: () => {},
        syncStatusChannel: 'a:s',
        offlineQueueChangedChannel: 'a:q',
        rateUpdatedChannel: 'a:r',
        ratesRefreshedChannel: 'a:f',
        isOffline: () => true
      }
    ) as TrackerSyncService<unknown, unknown>
    runnerTrackers.push(pc.sync.tracker as never, anilist as never)
    const anilistPrimary: PrimaryWriter = async (malId, change) => {
      if (change.kind !== 'set') return null
      const basis = anilist.cachedRate(malId)?.values ?? v(5)
      return { result: null, basis, after: change.values }
    }
    const fan = createTrackerFanOut({
      store: pc.store as never,
      trackers: [
        { sync: pc.sync.tracker as never },
        { sync: anilist, writePrimary: anilistPrimary }
      ]
    })
    pc.store.set('trackerPrimary', 'anilist')
    const { root, libraryId } = await makeLibrary()
    await pc.attach(root)
    return { pc, fan, anilist, libraryId }
  }

  /** K's owner-leg entry 5 → 6 on Shikimori, its pending field, and the leg's display patch. */
  function ownerLeg(pc: Pc, K: string) {
    server.set(MAL, v(5), T0)
    pc.store.set('shikimoriUserRates', [cacheEntry(MAL, ANIME, v(6), T0)])
    pc.store.set('shikimoriUpdateQueue', [
      {
        malId: MAL,
        rateId: MAL * 10,
        before: v(5),
        after: v(6),
        queuedAt: 1,
        fields: ['episodes'],
        origin: { kind: 'sync-merge', provenance: { episodes: { libraryId: K } } }
      }
    ])
    const dir = path.join(pc.userData, 'sync-pending')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${OWNER.id}.json`),
      JSON.stringify({
        version: 1,
        ownerId: OWNER.id,
        rates: {
          [MAL]: {
            episodes: {
              value: 6,
              clock: { at: T0 + 10, origin: 'pc-other' },
              provenance: { libraryId: K },
              prePatch: { value: 5, serverUpdatedAt: new Date(T0).toISOString() }
            }
          }
        }
      })
    )
  }

  const shikiEpisodes = (pc: Pc) =>
    (
      pc.store.get('shikimoriUserRates') as { rate: { target_id: number; episodes: number } }[]
    ).find((e) => e.rate.target_id === MAL)?.rate.episodes

  async function forgetAndDrain(pc: Pc, libraryId: string): Promise<number> {
    expect(await pc.attached.forget(libraryId, { confirmDropPending: true })).toEqual({
      needsConfirm: false
    })
    const cached = shikiEpisodes(pc)!
    pc.offline.value = false
    await pc.sync.drainNow()
    await pc.runner.quiesce()
    return cached
  }

  it('strips a seeded provenance entry from a non-Shikimori queue, live and parked', async () => {
    const { pc, libraryId } = await twoTrackers()
    const entry = (queuedAt: number) => ({
      malId: MAL,
      rateId: null,
      before: v(5),
      after: v(6),
      queuedAt,
      fields: ['episodes'],
      origin: { kind: 'sync-merge', provenance: { episodes: { libraryId } } }
    })
    const user = { malId: 2, rateId: null, before: v(1), after: v(2), queuedAt: 3 }
    pc.store.set(ANILIST_KEYS.updateQueue, [entry(1), user])
    pc.store.set(ANILIST_KEYS.parkedQueues, {
      '9': { nickname: 'x', entries: [entry(2)], parkedAt: 1 }
    })
    await pc.attached.forget(libraryId, { confirmDropPending: true })
    expect(pc.store.get(ANILIST_KEYS.updateQueue)).toEqual([user])
    expect(pc.store.get(ANILIST_KEYS.parkedQueues)).toEqual({})
  })

  it('owner-leg entries when the owner is not primary: the cache keeps the user’s 8, and the fake ends at 8', async () => {
    const { pc, fan, libraryId } = await twoTrackers()
    ownerLeg(pc, libraryId)
    await fan.applyChange(MAL, { kind: 'set', values: v(8) }, { target: 'anilist', cause: 'user' })
    const queue = pc.store.get('shikimoriUpdateQueue') as QueuedTrackerUpdate[]
    expect(queue[1]).toMatchObject({ via: 'mirror', before: v(6), after: v(8) })

    expect(await forgetAndDrain(pc, libraryId)).toBe(8)
    expect(server.get(MAL)!.episodes).toBe(8)
  })

  it('copy variant: a copy to Shikimori setting 8 in place of the mirror entry', async () => {
    const { pc, fan, libraryId } = await twoTrackers()
    ownerLeg(pc, libraryId)
    await fan.applyChange(
      MAL,
      { kind: 'set', values: v(8) },
      { target: 'shikimori', cause: 'user' }
    )
    const queue = pc.store.get('shikimoriUpdateQueue') as QueuedTrackerUpdate[]
    expect(queue[1]).toMatchObject({ via: 'copy', before: v(6), after: v(8) })

    expect(await forgetAndDrain(pc, libraryId)).toBe(8)
    expect(server.get(MAL)!.episodes).toBe(8)
  })
})
