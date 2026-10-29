// The merge runner's test rig (#584): a fake Shikimori server behind the real
// drain, a "PC" (in-memory store, temp userData, the real attached-library,
// Shikimori-sync and runner services) and real Shared Library trees on disk.
//
// A test file mocks the Shikimori client with `fake-shikimori.ts`'s `fakeApi`.
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'
import { createLibrary, writeState } from '../../src/main/lib/shared-library/write'
import { readLibrary } from '../../src/main/lib/shared-library/read'
import { createSyncBaseStore } from '../../src/main/lib/sync-state/bases'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createSyncRunner, type SyncRunnerDeps } from '../../src/main/services/sync-runner'
import { InMemoryStorage } from './in-memory-storage'
import { tempRoot } from './shared-library'
import { T0, iso, server, vals, type Vals } from './fake-shikimori'

export const OWNER = { id: 4242, nickname: 'owner', avatar: '' }
export const OTHER = { id: 777, nickname: 'other', avatar: '' }
export const ANIME = 101
export const MAL = 9001
export { T0, server, vals, type Vals } from './fake-shikimori'

/** A cache entry as the wholesale refresh writes it: `serverUpdatedAt` = the server's. */
export function cacheEntry(malId: number, animeId: number, v: Partial<Vals>, serverAt: number) {
  return {
    rate: {
      id: malId * 10,
      target_id: malId,
      ...vals(v),
      updated_at: iso(serverAt),
      serverUpdatedAt: iso(serverAt)
    },
    shikiAnime: { id: malId },
    smotretAnime: { id: animeId }
  }
}

/** The wholesale refresh: the cache becomes the server's rows. */
export function refreshCache(
  store: InMemoryStorage,
  animeOf: Record<number, number> = { [MAL]: ANIME }
): void {
  store.set(
    'shikimoriUserRates',
    [...server.rows].map(([malId, r]) =>
      cacheEntry(malId, animeOf[malId] ?? malId, r, Date.parse(r.updated_at))
    )
  )
}

export const ownerActor = (installId = 'pc-owner', ownerId = OWNER.id): SharedLibraryActor => ({
  installId,
  appVersion: '5.0.39',
  shikimoriUserId: ownerId,
  claim: null
})

export const LIB_A = '3b0e7a52-5c1f-4d8e-9a6b-2f4c8d1e7a90'
export const LIB_B = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'

/** A With metadata library (owned by OWNER unless `ownerId`), its state written when `doc` is given. */
export async function makeLibrary(
  opts: {
    titles?: number[]
    doc?: SyncDoc | null
    libraryId?: string
    mode?: SharedLibraryMode
    ownerId?: number
  } = {}
): Promise<{ root: string; libraryId: string }> {
  const root = path.join(tempRoot(), 'Lib')
  const libraryId = opts.libraryId ?? LIB_A
  const mode = opts.mode ?? 'metadata'
  const ownerId = opts.ownerId ?? OWNER.id
  const actor = ownerActor('pc-owner', ownerId)
  await createLibrary(
    root,
    {
      libraryId,
      name: `Drive ${libraryId.slice(0, 4)}`,
      owner: mode === 'metadata' ? { shikimoriId: ownerId, nickname: `u${ownerId}` } : null,
      mode,
      titles: (opts.titles ?? [ANIME]).map((animeId) => ({ animeId, name: `#${animeId}` })),
      items: [],
      naming: { rule: 'v1', renamed: [] }
    },
    actor
  )
  if (opts.doc) await writeState(root, opts.doc as SharedSyncDoc, actor, null)
  return { root, libraryId }
}

/** Rewrites the drive's state as the owner's other PC would. */
export async function writeDrive(root: string, doc: SyncDoc): Promise<void> {
  const r = await readLibrary(root)
  if (r.status !== 'ok') throw new Error('unreadable')
  await writeState(root, doc as SharedSyncDoc, ownerActor('pc-other'), r.manifest.stateGeneration)
}

export async function driveDoc(root: string): Promise<SharedSyncDoc | null> {
  const r = await readLibrary(root)
  return r.status === 'ok' ? (r.state?.doc ?? null) : null
}

export async function driveGeneration(root: string): Promise<number | null> {
  const r = await readLibrary(root)
  return r.status === 'ok' ? r.manifest.stateGeneration : null
}

export interface Pc {
  store: InMemoryStorage
  userData: string
  broadcast: ReturnType<typeof vi.fn>
  attached: ReturnType<typeof createAttachedLibraryService>
  sync: ReturnType<typeof createShikimoriSyncService>
  runner: ReturnType<typeof createSyncRunner>
  offline: { value: boolean }
  clock: { t: number }
  bases: ReturnType<typeof createSyncBaseStore>
  attach(
    root: string,
    opts?: { claim?: boolean; access?: 'read-write' | 'read-only' }
  ): Promise<string>
}

export function makePc(
  opts: {
    installId?: string
    user?: typeof OWNER | null
    store?: Record<string, unknown>
    runner?: Partial<SyncRunnerDeps>
    writable?: (root: string) => Promise<{ kind: 'writable' } | { kind: 'read-only'; code: string }>
  } = {}
): Pc {
  const user = opts.user === undefined ? OWNER : opts.user
  const userData = tempRoot()
  const store = new InMemoryStorage({
    installId: opts.installId ?? 'pc-owner',
    shikimoriUser: user,
    shikimoriCredentials: user
      ? { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' }
      : null,
    shikimoriUpdateQueue: [],
    shikimoriParkedQueues: {},
    shikimoriUserRates: [],
    shikimoriAnimeDetails: {},
    malIdMap: { [String(MAL)]: { id: ANIME } },
    watchProgress: {},
    library: {},
    downloadedAnime: {},
    priorityAnimeIds: [],
    dismissedContinueWatching: [],
    skipDetections: {},
    syncMeta: { titles: {}, rates: {} },
    attachedLibraries: {},
    ...opts.store
  })
  const broadcast = vi.fn()
  const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const bases = createSyncBaseStore(path.join(userData, 'sync-bases'), fs.promises)
  const attached = createAttachedLibraryService({
    store,
    checkFfmpeg: async () => ({ available: true }),
    checkWritable: opts.writable ?? (async () => ({ kind: 'writable' })),
    syncBases: bases,
    log: quiet
  })
  const offline = { value: false }
  const clock = { t: T0 + 10_000_000 }
  const sync = createShikimoriSyncService({
    store: store as never,
    broadcast,
    syncStatusChannel: 's',
    offlineQueueChangedChannel: 'q',
    rateUpdatedChannel: 'r',
    animeDetailsUpdatedChannel: 'd',
    isOffline: () => offline.value
  })
  const runner = createSyncRunner({
    store: store as never,
    userDataDir: userData,
    attached,
    sync,
    isOffline: () => offline.value,
    broadcast,
    appVersion: '5.0.39',
    now: () => clock.t,
    log: quiet,
    ...opts.runner
  })
  // The settle listener and the forget hook; triggers are driven by hand in tests.
  runner.start({ triggers: false })
  return {
    store,
    userData,
    broadcast,
    attached,
    sync,
    runner,
    offline,
    clock,
    bases,
    async attach(root, a = {}) {
      const r = await readLibrary(root)
      if (r.status === 'none' || !r.manifest) throw new Error('no library')
      const m = r.manifest
      const recs = (store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>) ?? {}
      recs[m.libraryId] = {
        root,
        name: m.name ?? 'Drive',
        mode: m.mode,
        owner: m.owner,
        access: a.access ?? 'read-write',
        ...(a.claim && m.owner ? { claim: { ownerId: m.owner.shikimoriId, at: 1 } } : {}),
        lastSeenAt: 0,
        lastSyncAt: null
      }
      store.set('attachedLibraries', recs)
      await attached.init()
      return m.libraryId
    }
  }
}

/** A `watchProgress` row as a 'playback' / 'mark' save leaves it. */
export function progressRow(watched: boolean, at: number, position = 0) {
  return {
    position,
    duration: 1440,
    updatedAt: at,
    watched,
    ...(watched ? { watchedAt: at } : {}),
    sync: { position: { at, origin: 'pc' }, watched: { at, origin: 'pc' } }
  }
}
