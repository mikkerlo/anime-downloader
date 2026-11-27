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
import { queuedAfterOf } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createShikimoriEventBridge } from '../../src/main/trackers/events'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from './in-memory-storage'
import { ANILIST_MEDIA_IDS, createFakeTracker, type FakeTracker } from './fake-tracker'
import { createGenericTracker, datedCodec } from './generic-tracker'
import { tempRoot } from './shared-library'
import { T0, iso, server, vals, type Vals } from './fake-shikimori'

export const OWNER = { id: 4242, nickname: 'owner', avatar: '' }
export const OTHER = { id: 777, nickname: 'other', avatar: '' }
/** An AniList account (#715); its id is the plan's colliding "user 5". */
export const ANILIST_USER = { id: 5, nickname: 'al', avatar: null as string | null }
/** The v2 owner an AniList-owned library names. */
export const ANILIST_5 = { provider: 'anilist', userId: String(ANILIST_USER.id) }
/** A MyAnimeList account (#715), also user 5. */
export const MAL_USER = { id: 5, nickname: 'ml', avatar: null as string | null }
export const MAL_5 = { provider: 'mal', userId: String(MAL_USER.id) }
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
  claim: null,
  trackerAccounts: []
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
    // A layout v2 owner (#713), written by a test actor holding that account.
    tracker?: { provider: string; userId: string }
  } = {}
): Promise<{ root: string; libraryId: string }> {
  const root = path.join(tempRoot(), 'Lib')
  const libraryId = opts.libraryId ?? LIB_A
  const mode = opts.mode ?? 'metadata'
  const ownerId = opts.ownerId ?? OWNER.id
  const actor: SharedLibraryActor = opts.tracker
    ? { ...ownerActor('pc-owner', ownerId), shikimoriUserId: null, trackerAccounts: [opts.tracker] }
    : ownerActor('pc-owner', ownerId)
  const owner = opts.tracker
    ? { ...opts.tracker, nickname: 'tracker' }
    : { shikimoriId: ownerId, nickname: `u${ownerId}` }
  await createLibrary(
    root,
    {
      libraryId,
      name: `Drive ${libraryId.slice(0, 4)}`,
      owner: mode === 'metadata' ? owner : null,
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
export async function writeDrive(
  root: string,
  doc: SyncDoc,
  actor: SharedLibraryActor = ownerActor('pc-other')
): Promise<void> {
  const r = await readLibrary(root)
  if (r.status !== 'ok') throw new Error('unreadable')
  await writeState(root, doc as SharedSyncDoc, actor, r.manifest.stateGeneration)
}

/** The owner's other PC of a v2 library: an actor holding that tracker account (#715). */
export const trackerActor = (
  tracker: { provider: string; userId: string },
  installId = 'pc-other'
): SharedLibraryActor => ({
  ...ownerActor(installId),
  shikimoriUserId: null,
  trackerAccounts: [tracker]
})

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
  /** The AniList leg (#715), with `makePc({ anilist })`: the fake server and its sync instance. */
  anilist?: { fake: FakeTracker<'anilist'>; sync: TrackerSyncService<unknown, unknown> }
  mal?: { fake: FakeTracker<'mal'>; sync: TrackerSyncService<unknown, unknown> }
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
    /**
     * Wire the Shikimori emitters as `index.ts` does (#694): the real channel
     * names, the runner's trackers from the sync instance, and both services'
     * broadcast through the bridge. `broadcast` then records both events.
     */
    bridge?: boolean
    /**
     * Wire AniList as an owner tracker's leg (#715): a fake AniList server behind
     * the generic sync instance, signed in as `user` (null: signed out). Its
     * cache is `datedCodec` rows; MAL ids without an AniList media id aren't on it.
     */
    anilist?: { user?: typeof ANILIST_USER | null }
    /** The same for MyAnimeList (#715 after #702): every MAL id is on MAL. */
    mal?: { user?: typeof MAL_USER | null }
    /** Runner deps built on this PC's store before the runner is (a real provider's leg). */
    wire?: (store: InMemoryStorage) => Partial<SyncRunnerDeps>
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
    ...(opts.anilist
      ? {
          anilistUser: opts.anilist.user === undefined ? ANILIST_USER : opts.anilist.user,
          anilistCredentials:
            opts.anilist.user === null ? null : { v: 1, enc: 'plain', data: 'token' },
          anilistUpdateQueue: [],
          anilistParkedQueues: {},
          anilistUserRates: []
        }
      : {}),
    ...(opts.mal
      ? {
          myanimelistUser: opts.mal.user === undefined ? MAL_USER : opts.mal.user,
          myanimelistCredentials:
            opts.mal.user === null ? null : { v: 1, enc: 'plain', data: 'token' },
          myanimelistUpdateQueue: [],
          myanimelistParkedQueues: {},
          myanimelistUserRates: []
        }
      : {}),
    ...opts.store
  })
  const broadcast = vi.fn()
  const emit = opts.bridge
    ? createShikimoriEventBridge({
        broadcast,
        channels: {
          rateUpdated: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
          ratesRefreshed: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
          syncStatus: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
          offlineQueueChanged: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED
        },
        needsSetup: () => sync.tracker.needsSetup(),
        queuedAfter: () => queuedAfterOf(store.get('shikimoriUpdateQueue') as never)
      })
    : broadcast
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
    broadcast: emit,
    ...(opts.bridge
      ? {
          syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
          offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
          rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
          animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
          ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
        }
      : {
          syncStatusChannel: 's',
          offlineQueueChangedChannel: 'q',
          rateUpdatedChannel: 'r',
          animeDetailsUpdatedChannel: 'd'
        }),
    isOffline: () => offline.value
  })
  let anilist: Pc['anilist']
  if (opts.anilist) {
    const fake = createFakeTracker('anilist')
    const user = opts.anilist.user === undefined ? ANILIST_USER : opts.anilist.user
    if (user) fake.user.id = user.id
    anilist = createGenericTracker('anilist', store as never, {
      isOffline: () => offline.value,
      fake,
      codec: datedCodec('anilist', () => clock.t) as never,
      provider: { hasTitle: (malId: number) => ANILIST_MEDIA_IDS[malId] !== undefined }
    }) as NonNullable<Pc['anilist']>
  }
  let mal: Pc['mal']
  if (opts.mal) {
    const fake = createFakeTracker('mal')
    const user = opts.mal.user === undefined ? MAL_USER : opts.mal.user
    if (user) fake.user.id = user.id
    mal = createGenericTracker('mal', store as never, {
      isOffline: () => offline.value,
      fake,
      codec: datedCodec('mal', () => clock.t) as never
    }) as NonNullable<Pc['mal']>
  }
  const extra = [anilist, mal].filter((t): t is NonNullable<typeof t> => !!t)
  const runner = createSyncRunner({
    store: store as never,
    userDataDir: userData,
    attached,
    sync,
    isOffline: () => offline.value,
    broadcast: emit,
    ...(opts.bridge ? { trackers: [sync.tracker as TrackerSyncService<unknown, unknown>] } : {}),
    ...(extra.length > 0
      ? {
          trackers: [
            sync.tracker as TrackerSyncService<unknown, unknown>,
            ...extra.map((t) => t.sync)
          ],
          legs: extra.map((t) => ({ sync: t.sync, provider: t.fake.provider as never }))
        }
      : {}),
    appVersion: '5.0.39',
    now: () => clock.t,
    log: quiet,
    ...opts.wire?.(store),
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
    ...(anilist ? { anilist } : {}),
    ...(mal ? { mal } : {}),
    async attach(root, a = {}) {
      const r = await readLibrary(root)
      if (r.status === 'none' || !r.manifest) throw new Error('no library')
      const m = r.manifest
      const recs = (store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>) ?? {}
      // As `attach` stores them (#713): a v2 owner as `trackerOwner`, next to `owner: null`.
      const v1 = m.owner !== null && 'shikimoriId' in m.owner ? m.owner : null
      const v2 = m.owner !== null && 'provider' in m.owner ? m.owner : null
      recs[m.libraryId] = {
        root,
        name: m.name ?? 'Drive',
        mode: m.mode,
        owner: v1,
        ...(v2 ? { trackerOwner: { provider: v2.provider, userId: v2.userId } } : {}),
        access: a.access ?? 'read-write',
        ...(a.claim && v1 ? { claim: { ownerId: v1.shikimoriId, at: 1 } } : {}),
        ...(a.claim && v2
          ? { trackerClaim: { provider: v2.provider, userId: v2.userId, at: 1 } }
          : {}),
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
