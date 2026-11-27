// The `tracker:*` account, auth and logout channels (#695), with the account
// lifecycle (`trackers/lifecycle.ts`) per tracker. Shikimori runs its real
// router and adapter on a mocked `shikimori.ts`; AniList and MyAnimeList run
// the generic sync service over the fake-tracker personalities, whose
// `authFlow` stands in for T6/T7's. The vault is the real one over a fake
// safeStorage, with every member spied.
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
  type MockInstance
} from 'vitest'
import { ipcMain } from 'electron'

const exchangeCode = vi.fn()
const getUser = vi.fn()

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi,
  exchangeCode: (...args: unknown[]) => exchangeCode(...args),
  getUser: (...args: unknown[]) => getUser(...args)
}))

import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeTracker, fakeCredentials, type FakeTracker } from '../helpers/fake-tracker'
import { createGenericTracker } from '../helpers/generic-tracker'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import {
  createCredentialVault,
  type CredentialVault
} from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createTrackerAuthSessions } from '../../src/main/trackers/auth-session'
import { createShikimoriProvider } from '../../src/main/trackers/shikimori.provider'
import { TRACKER_KEYS } from '../../src/main/trackers/keys'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { PERSISTED_STORE_KEYS } from '../../src/main/store/keys'
import { UNKNOWN_OWNER, type QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'

type Svc = TrackerSyncService<unknown, unknown>

const IDS = ['shikimori', 'anilist', 'mal'] as const
const A = { id: 11, nickname: 'alice', avatar: null }
const B = { id: 22, nickname: 'bob', avatar: null }

const entry = (malId: number, queuedAt: number, extra: Partial<QueuedTrackerUpdate> = {}) =>
  ({
    malId,
    rateId: malId * 10,
    before: { episodes: 1, status: 'watching', score: 0, rewatches: 0 },
    after: { episodes: 2, status: 'watching', score: 0, rewatches: 0 },
    queuedAt,
    ...extra
  }) as QueuedTrackerUpdate

/** A's live queue: one user entry and one fan-out copy (#692's `via: 'mirror'`). */
const A_QUEUE = [entry(1, 100), entry(2, 200, { via: 'mirror' })]

const vaultMembers = ['encrypt', 'commit', 'write', 'read', 'has', 'isLocked'] as const

function rig(
  opts: {
    instances?: readonly ('anilist' | 'mal')[]
    seed?: Record<string, unknown>
    newTrackerCardsEnabled?: boolean
  } = {}
) {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    installId: 'pc',
    ...opts.seed
  })
  const safe = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const realVault = { ...vault }
  const spies = Object.fromEntries(
    vaultMembers.map((m) => [m, vi.spyOn(vault, m as keyof CredentialVault)])
  ) as Record<(typeof vaultMembers)[number], Mock>
  const broadcast = vi.fn()
  const offline = { value: false }
  const isOffline = () => offline.value

  const shiki = createShikimoriSyncService({
    store: store as never,
    broadcast,
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED,
    isOffline
  })
  const shikiQueue = vi.fn()
  const steps = {
    shikimori: {
      startTimer: vi.spyOn(shiki, 'startSyncTimer').mockImplementation(() => {}),
      drain: vi.spyOn(shiki, 'syncShikimoriQueue').mockResolvedValue(undefined),
      stopTimer: vi.spyOn(shiki, 'stopSyncTimer').mockImplementation(() => {}),
      status: vi.spyOn(shiki, 'broadcastSyncStatus').mockImplementation(() => {}),
      queue: shikiQueue
    }
  } as unknown as Record<
    TrackerId,
    Record<'startTimer' | 'drain' | 'stopTimer' | 'status' | 'queue', MockInstance>
  >

  const fakes = {
    anilist: createFakeTracker('anilist'),
    mal: createFakeTracker('mal')
  }
  fakes.mal.signIn.loopback = null
  const instances = opts.instances ?? ['anilist', 'mal']
  const syncs: Partial<Record<TrackerId, Svc>> = { shikimori: shiki.tracker as Svc }
  for (const id of instances) {
    const { sync } = createGenericTracker(id, store as never, { fake: fakes[id] as never })
    syncs[id] = sync
    steps[id] = {
      startTimer: vi.spyOn(sync, 'startSyncTimer').mockImplementation(() => {}),
      drain: vi.spyOn(sync, 'syncQueue').mockResolvedValue(undefined),
      stopTimer: vi.spyOn(sync, 'stopSyncTimer').mockImplementation(() => {}),
      status: vi.spyOn(sync, 'broadcastSyncStatus').mockImplementation(() => {}),
      queue: vi.spyOn(sync, 'broadcastQueueChanged').mockImplementation(() => {})
    }
  }
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: Object.values(syncs).map((sync) => ({ sync: sync! })),
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({ store: store as never, trackers: fan, isOffline })
  const refresh = vi.spyOn(trackerRates, 'refreshInBackground').mockImplementation(() => {})
  const openExternal = vi.fn(async (_url: string) => {})
  const runAll = vi.fn(async () => ({}))
  const lifecycle = createTrackerLifecycle({
    store,
    vault,
    trackerRates,
    cancelAttempt: (id) => auth.cancel(id),
    newTrackerCardsEnabled: opts.newTrackerCardsEnabled ?? true
  })
  const auth = createTrackerAuthSessions({
    lifecycle,
    providers: {
      shikimori: createShikimoriProvider({ store }),
      anilist: fakes.anilist.provider,
      mal: fakes.mal.provider
    },
    isOffline,
    openExternal,
    log: { warn: () => {} }
  })

  ;(ipcMain.handle as unknown as Mock).mockClear()
  const deps = {
    store,
    credentialVault: vault,
    shikimoriSyncService: shiki,
    trackers: fan,
    trackerRates,
    trackerLifecycle: lifecycle,
    trackerAuth: auth,
    newTrackerCardsEnabled: opts.newTrackerCardsEnabled ?? true,
    lookupByMalIds: vi.fn(async () => ({})),
    maybeBroadcastCleanupPrompt: vi.fn(async () => {}),
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast,
    offlineService: { isOffline },
    syncRunner: { runAll }
  } as unknown as AppDeps
  registerShikimori(deps)
  registerTrackers(deps)
  // Shikimori's queue broadcast is the router's, through `broadcast`.
  broadcast.mockImplementation((channel: string, payload: { length: number }) => {
    if (channel === EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED) {
      shikiQueue(payload.length)
    }
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    (await handlers.get(channel)!({}, ...args)) as T

  const keysOf = (id: TrackerId): string[] => Object.values(TRACKER_KEYS[id])
  const snapshot = (keys: readonly string[] = PERSISTED_STORE_KEYS): string =>
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, store.get(k)])))
  /** Every key but `id`'s own and its user-scoped ones. */
  const othersOf = (id: TrackerId): string[] => {
    const own = new Set([
      ...keysOf(id),
      'shikimoriProfile',
      'shikimoriFriends',
      'shikimoriRecommendations',
      'myanimelistClientSecret'
    ])
    return PERSISTED_STORE_KEYS.filter((k) => !own.has(k) || !k.startsWith(prefixOf(id)))
  }

  return {
    store,
    safe,
    vault,
    realVault,
    spies,
    broadcast,
    offline,
    fakes,
    syncs,
    steps,
    refresh,
    runAll,
    openExternal,
    lifecycle,
    auth,
    invoke,
    keysOf,
    snapshot,
    othersOf
  }
}

type Rig = ReturnType<typeof rig>

function prefixOf(id: TrackerId): string {
  return id === 'mal' ? 'myanimelist' : id
}

function fakeOf(r: Rig, id: 'anilist' | 'mal'): FakeTracker<TrackerId> {
  return r.fakes[id] as FakeTracker<TrackerId>
}

/** The Shikimori code that signs in as `user`. */
function shikimoriSignsInAs(code: string, user: TrackerUser): void {
  const prev = exchangeCode.getMockImplementation()
  const prevUser = getUser.getMockImplementation()
  exchangeCode.mockImplementation(async (c: string) =>
    c === code ? { ...fakeCredentials('shikimori', c), refresh_token: `r-${c}` } : prev?.(c)
  )
  getUser.mockImplementation(async (token: string) =>
    token === fakeCredentials('shikimori', code).access_token ? user : prevUser?.(token)
  )
}

/** `input` signs `id` in as `user`. */
function signsInAs(r: Rig, id: TrackerId, input: string, user: TrackerUser): void {
  if (id === 'shikimori') shikimoriSignsInAs(input, user)
  else fakeOf(r, id).signIn.accounts.set(input, user)
}

const malUrl = (state: string, code: string) =>
  `http://localhost/callback?code=${encodeURIComponent(code)}&state=${state}`

/**
 * A sign-in through the `tracker:*` channels: a paste with no attempt held for
 * Shikimori and AniList, and BEGIN then the redirect URL for MAL.
 */
async function login(r: Rig, id: TrackerId, input: string): Promise<TrackerAuthResult> {
  if (id !== 'mal') return r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, id, input)
  const begin = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_BEGIN_AUTH, 'mal')
  await vi.waitFor(() => expect(r.auth.phase('mal')).toBe('waiting'))
  const state = r.fakes.mal.signIn.begun.at(-1)!.state!
  const result = await r.invoke<TrackerAuthResult>(
    CHANNELS.TRACKER_COMPLETE_AUTH,
    'mal',
    malUrl(state, input)
  )
  expect(await begin).toEqual(result)
  return result
}

/** A stored credential: Shikimori's plain object, or a vault blob for AniList and MAL. */
async function credentialFor(r: Rig, id: TrackerId, input: string): Promise<unknown> {
  const creds = fakeCredentials(id, input)
  return id === 'shikimori' ? creds : r.vault.encrypt(creds)
}

/** `id` signed in as `user` with `queue` live and some cached state. */
async function seedSignedIn(
  r: Rig,
  id: TrackerId,
  user: TrackerUser | null,
  queue: QueuedTrackerUpdate[] = []
): Promise<void> {
  const k = TRACKER_KEYS[id]
  r.store.set(k.user, user)
  r.store.set(k.credentials, user ? await credentialFor(r, id, 'seed') : null)
  r.store.set(k.updateQueue, queue)
  r.store.set(k.userRates, [{ cached: id }])
  r.store.set(k.animeDetails, { 1: { cached: id } })
  r.spies.encrypt.mockClear()
}

const parkedOf = (r: Rig, id: TrackerId) =>
  (r.store.get(TRACKER_KEYS[id].parkedQueues) as Record<
    string,
    { nickname: string; entries: QueuedTrackerUpdate[]; parkedAt: number }
  >) ?? {}

beforeEach(() => {
  vi.clearAllMocks()
  exchangeCode.mockReset()
  getUser.mockReset()
  getUser.mockRejectedValue(new Error('unknown token'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each(IDS)('#588 park and restore, per tracker: %s', (id) => {
  it('A → B parks A’s live queue (a mirror copy included) under A and resets the user-scoped state; the other trackers’ keys are untouched', async () => {
    const r = rig()
    await seedSignedIn(r, id, A, A_QUEUE)
    signsInAs(r, id, 'b', B)
    const others = r.snapshot(r.othersOf(id))

    expect(await login(r, id, 'b')).toMatchObject({
      status: 'connected',
      account: { trackerId: id, user: B, hasCredentials: true, credentialState: 'ok' }
    })

    const k = TRACKER_KEYS[id]
    expect(parkedOf(r, id)[String(A.id)]).toMatchObject({ nickname: 'alice', entries: A_QUEUE })
    expect(r.store.get(k.updateQueue)).toEqual([])
    expect(r.store.get(k.user)).toEqual(B)
    expect(r.store.get(k.userRates)).toEqual([])
    expect(r.store.get(k.animeDetails)).toEqual({})
    expect(r.store.get(k.sessionExpired)).toBe(false)
    expect(r.snapshot(r.othersOf(id))).toBe(others)
    expect(r.refresh).toHaveBeenCalledWith(id)
    expect(r.steps[id].startTimer).toHaveBeenCalledTimes(1)
    expect(r.steps[id].drain).toHaveBeenCalledTimes(1)
    expect(r.steps[id].status).toHaveBeenCalledTimes(1)
    // The Shared Library login run stays on Shikimori's login only.
    expect(r.runAll).toHaveBeenCalledTimes(id === 'shikimori' ? 1 : 0)
  })

  it('B → A restores A’s entries verbatim', async () => {
    const r = rig()
    await seedSignedIn(r, id, B, [entry(5, 50)])
    r.store.set(TRACKER_KEYS[id].parkedQueues, {
      [String(A.id)]: { nickname: 'alice', entries: A_QUEUE, parkedAt: 1 }
    })
    signsInAs(r, id, 'a', A)

    await login(r, id, 'a')

    expect(r.store.get(TRACKER_KEYS[id].updateQueue)).toEqual(A_QUEUE)
    expect(parkedOf(r, id)[String(A.id)]).toBeUndefined()
    expect(parkedOf(r, id)[String(B.id)].entries).toEqual([entry(5, 50)])
    expect(r.steps[id].queue).toHaveBeenCalledWith(...(id === 'shikimori' ? [2] : []))
  })

  it('a same-user reconnect parks nothing and keeps the caches', async () => {
    const r = rig()
    await seedSignedIn(r, id, A, A_QUEUE)
    signsInAs(r, id, 'a', A)

    await login(r, id, 'a')

    const k = TRACKER_KEYS[id]
    expect(parkedOf(r, id)).toEqual({})
    expect(r.store.get(k.updateQueue)).toEqual(A_QUEUE)
    expect(r.store.get(k.userRates)).toEqual([{ cached: id }])
    expect(r.store.get(k.animeDetails)).toEqual({ 1: { cached: id } })
    expect(r.refresh).not.toHaveBeenCalled()
  })

  it('ownerless entries go to the unknown bucket', async () => {
    const r = rig()
    await seedSignedIn(r, id, null, A_QUEUE)
    signsInAs(r, id, 'a', A)

    await login(r, id, 'a')

    expect(parkedOf(r, id)[UNKNOWN_OWNER]).toMatchObject({ nickname: '', entries: A_QUEUE })
    expect(r.store.get(TRACKER_KEYS[id].updateQueue)).toEqual([])
  })

  it('logout with keep parks, with discard parks nothing; both clear the account', async () => {
    for (const pending of ['keep', 'discard'] as const) {
      const r = rig()
      await seedSignedIn(r, id, A, A_QUEUE)
      r.store.set(TRACKER_KEYS[id].sessionExpired, true)
      const others = r.snapshot(r.othersOf(id))

      await r.invoke(CHANNELS.TRACKER_LOGOUT, id, { pending })

      const k = TRACKER_KEYS[id]
      expect(parkedOf(r, id)[String(A.id)]?.entries).toEqual(
        pending === 'keep' ? A_QUEUE : undefined
      )
      expect(r.store.get(k.credentials)).toBeNull()
      expect(r.store.get(k.user)).toBeNull()
      expect(r.store.get(k.updateQueue)).toEqual([])
      expect(r.store.get(k.userRates)).toEqual([])
      expect(r.store.get(k.sessionExpired)).toBe(false)
      expect(r.snapshot(r.othersOf(id))).toBe(others)
      expect(r.steps[id].stopTimer).toHaveBeenCalledTimes(1)
      expect(r.steps[id].status).toHaveBeenCalledTimes(1)
      expect(r.lifecycle.generation(id)).toBe(1)
    }
  })
})

describe('what survives a logout', () => {
  it('an AniList logout keeps anilistIdMap and the rate clocks, and clears anilistUserRates', async () => {
    const r = rig({ seed: { syncMeta: { titles: {}, rates: { anilist: { 1: 5 } } } } })
    await seedSignedIn(r, 'anilist', A)
    r.store.set('anilistIdMap', { 101: 1 })

    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'anilist')

    expect(r.store.get('anilistIdMap')).toEqual({ 101: 1 })
    expect(r.store.get('syncMeta')).toEqual({ titles: {}, rates: { anilist: { 1: 5 } } })
    expect(r.store.get('anilistUserRates')).toEqual([])
  })

  it('a MAL logout keeps the client config and the secret', async () => {
    const r = rig()
    await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'cid', secret: 's' })
    const secret = r.store.get('myanimelistClientSecret')
    await seedSignedIn(r, 'mal', A)

    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'mal')

    expect(r.store.get('myanimelistClientConfig')).toEqual({ clientId: 'cid' })
    expect(r.store.get('myanimelistClientSecret')).toEqual(secret)
  })
})

describe.each(['anilist', 'mal'] as const)('the vault path (%s)', (id) => {
  it('the switch window: while the user read and then the encrypt are pending, the store keeps the old account', async () => {
    const r = rig()
    await seedSignedIn(r, id, A, A_QUEUE)
    const k = TRACKER_KEYS[id]
    const oldCreds = r.store.get(k.credentials)
    signsInAs(r, id, 'b', B)
    let releaseUser!: () => void
    let atUser!: () => void
    const reachedUser = new Promise<void>((resolve) => (atUser = resolve))
    fakeOf(r, id).signIn.gate = async (step) => {
      if (step !== 'user') return
      atUser()
      await new Promise<void>((resolve) => (releaseUser = resolve))
    }
    r.safe.hold = true

    const done = login(r, id, 'b')
    await reachedUser
    const oldAccount = (): void => {
      expect(r.store.get(k.user)).toEqual(A)
      expect(r.store.get(k.credentials)).toEqual(oldCreds)
      expect(r.store.get(k.updateQueue)).toEqual(A_QUEUE)
    }
    oldAccount()
    releaseUser()
    await vi.waitFor(() => expect(r.safe.held).toBe(1))
    oldAccount()
    r.safe.release()

    await done
    expect(r.store.get(k.user)).toEqual(B)
    expect(r.store.get(k.credentials)).not.toEqual(oldCreds)
    expect(r.store.get(k.credentials)).toMatchObject({ v: 1, enc: 'safeStorage' })
  })

  it('one synchronous step after the encrypt: encrypt, then commit beside the user and the expired flag, never write', async () => {
    const r = rig()
    await seedSignedIn(r, id, A)
    r.store.set(TRACKER_KEYS[id].sessionExpired, true)
    signsInAs(r, id, 'b', B)
    const k = TRACKER_KEYS[id]
    const seen: unknown[] = []
    r.spies.commit.mockImplementation((key, blob) => {
      r.realVault.commit(key, blob)
      queueMicrotask(() =>
        seen.push({
          credentials: r.store.get(k.credentials),
          user: r.store.get(k.user),
          sessionExpired: r.store.get(k.sessionExpired)
        })
      )
    })

    expect(await login(r, id, 'b')).toMatchObject({ status: 'connected' })

    expect(r.spies.write).not.toHaveBeenCalled()
    expect(r.spies.encrypt).toHaveBeenCalledTimes(1)
    expect(r.spies.encrypt).toHaveBeenCalledWith(fakeCredentials(id, 'b'))
    expect(r.spies.commit).toHaveBeenCalledTimes(1)
    const blob = await r.spies.encrypt.mock.results[0].value
    expect(r.spies.commit).toHaveBeenCalledWith(k.credentials, blob)
    expect(seen).toEqual([{ credentials: blob, user: B, sessionExpired: false }])
  })
})

describe('the session generation', () => {
  it('a committed login and a logout each bump that tracker’s generation by one, and no other tracker’s', async () => {
    const r = rig()
    await login(r, 'anilist', 'x')
    expect(r.lifecycle.generation('anilist')).toBe(1)
    await login(r, 'mal', 'x')
    expect(r.lifecycle.generation('mal')).toBe(1)
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'anilist')
    expect(r.lifecycle.generation('anilist')).toBe(2)
    expect(r.lifecycle.generation('mal')).toBe(1)
    expect(r.lifecycle.generation('shikimori')).toBe(0)
  })

  it('a rejected token and a failed user read leave it unchanged', async () => {
    const r = rig()
    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'bad')).toMatchObject({
      status: 'error',
      kind: 'auth'
    })
    r.fakes.anilist.signIn.failNext = 'network'
    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'x')).toMatchObject({
      status: 'error',
      kind: 'network'
    })
    expect(r.lifecycle.generation('anilist')).toBe(0)
  })

  it('the generation check alone refuses a login a logout overtook', async () => {
    const r = rig()
    await seedSignedIn(r, 'anilist', A)
    let release!: () => void
    const done = r.lifecycle.completeLogin(
      'anilist',
      async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return { credentials: fakeCredentials('anilist', 'b'), user: B }
      },
      { attempt: { isCurrent: () => true } }
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    r.lifecycle.logout('anilist')
    const afterLogout = r.snapshot()
    release()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(r.snapshot()).toBe(afterLogout)
    expect(r.lifecycle.generation('anilist')).toBe(1)
  })
})

describe('a sign-in overtaken mid-flight', () => {
  function gateAt(fake: FakeTracker<TrackerId>, step: 'exchange' | 'user') {
    let release!: () => void
    let reached!: () => void
    const atGate = new Promise<void>((resolve) => (reached = resolve))
    fake.signIn.gate = async (s) => {
      if (s !== step) return
      reached()
      await new Promise<void>((resolve) => (release = resolve))
    }
    return { atGate, release: () => release() }
  }

  it('a cancel during exchanging: nothing written, the generation unchanged, the completion cancelled', async () => {
    const r = rig()
    const before = r.snapshot()
    const gate = gateAt(fakeOf(r, 'anilist'), 'exchange')
    const begin = r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    const done = r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')
    await gate.atGate
    expect(r.auth.phase('anilist')).toBe('exchanging')
    await r.invoke(CHANNELS.TRACKER_CANCEL_AUTH, 'anilist')
    gate.release()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(await begin).toEqual({ status: 'cancelled' })
    expect(r.snapshot()).toBe(before)
    expect(r.lifecycle.generation('anilist')).toBe(0)
  })

  it('a logout during vault.encrypt (never connected): the store byte-identical, the generation unchanged', async () => {
    const r = rig()
    const before = r.snapshot()
    r.safe.hold = true
    const done = login(r, 'mal', 'code')
    await vi.waitFor(() => expect(r.safe.held).toBe(1))
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'mal')
    r.safe.release()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(r.snapshot()).toBe(before)
    expect(r.lifecycle.generation('mal')).toBe(0)
  })

  it('a logout during vault.encrypt (connected): only the logout lands', async () => {
    const r = rig()
    await seedSignedIn(r, 'anilist', A, A_QUEUE)
    signsInAs(r, 'anilist', 'b', B)
    r.safe.hold = true
    const done = login(r, 'anilist', 'b')
    await vi.waitFor(() => expect(r.safe.held).toBe(1))
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'anilist')
    const afterLogout = r.snapshot()
    r.safe.release()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(r.snapshot()).toBe(afterLogout)
    expect(r.store.get('anilistUser')).toBeNull()
    expect(r.lifecycle.generation('anilist')).toBe(1)
  })

  it('a second BEGIN during the user read', async () => {
    const r = rig()
    const before = r.snapshot()
    const gate = gateAt(fakeOf(r, 'anilist'), 'user')
    const first = r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    const done = r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')
    await gate.atGate
    const second = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    expect(await first).toEqual({ status: 'cancelled' })
    gate.release()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(r.snapshot()).toBe(before)
    expect(r.lifecycle.generation('anilist')).toBe(0)
    expect(r.auth.phase('anilist')).toBe('waiting')
    r.auth.cancel('anilist')
    expect(await second).toEqual({ status: 'cancelled' })
  })

  it('an attempt-less completion, then a cancel while the user read is pending', async () => {
    const r = rig()
    const before = r.snapshot()
    const gate = gateAt(fakeOf(r, 'anilist'), 'user')
    const done = r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')
    await gate.atGate
    await r.invoke(CHANNELS.TRACKER_CANCEL_AUTH, 'anilist')
    gate.release()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(r.snapshot()).toBe(before)
    expect(r.lifecycle.generation('anilist')).toBe(0)
  })

  it('an attempt-less completion, then a never-connected logout while the user read is pending', async () => {
    const r = rig()
    const before = r.snapshot()
    const gate = gateAt(fakeOf(r, 'anilist'), 'user')
    const done = r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')
    await gate.atGate
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'anilist')
    gate.release()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(r.snapshot()).toBe(before)
  })
})

describe('logout of a tracker that was never connected', () => {
  it('is a no-op that never reaches the vault or bumps the generation', async () => {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A, A_QUEUE)
    const before = r.snapshot()
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'anilist')
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'mal', { pending: 'discard' })
    expect(r.snapshot()).toBe(before)
    for (const m of vaultMembers) expect(r.spies[m], m).not.toHaveBeenCalled()
    expect(r.safe.untouched()).toBe(true)
    expect(r.lifecycle.generation('anilist')).toBe(0)
    expect(r.steps.anilist.stopTimer).not.toHaveBeenCalled()
  })
})

describe('no sync instance yet', () => {
  it('a restore and a logout complete without throwing, and skip the timer, drain and status steps', async () => {
    const r = rig({ instances: [] })
    r.store.set('anilistParkedQueues', {
      [String(A.id)]: { nickname: 'alice', entries: A_QUEUE, parkedAt: 1 }
    })
    signsInAs(r, 'anilist', 'a', A)

    expect(await login(r, 'anilist', 'a')).toMatchObject({ status: 'connected' })
    expect(r.store.get('anilistUpdateQueue')).toEqual(A_QUEUE)
    expect(r.steps.anilist).toBeUndefined()

    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'anilist')
    expect(r.store.get('anilistUser')).toBeNull()
    expect(parkedOf(r, 'anilist')[String(A.id)].entries).toEqual(A_QUEUE)
  })
})

describe('the Shikimori aliases', () => {
  it('a BEGIN(shikimori) finished through SHIKIMORI_EXCHANGE_CODE resolves cancelled, and no attempt is left held', async () => {
    const r = rig()
    shikimoriSignsInAs('code-a', { ...A, avatar: '' })
    const begin = r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'shikimori')
    await vi.waitFor(() => expect(r.auth.phase('shikimori')).toBe('waiting'))
    expect(r.openExternal).toHaveBeenCalledWith(expect.stringContaining('/oauth/authorize?'))

    expect(await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code-a')).toEqual({
      ...A,
      avatar: ''
    })
    expect(await begin).toEqual({ status: 'cancelled' })
    expect(r.auth.phase('shikimori')).toBeNull()
    expect(r.store.get('shikimoriUser')).toEqual({ ...A, avatar: '' })
  })

  it('TRACKER_COMPLETE_AUTH(shikimori) runs the same exchange as the alias', async () => {
    const r = rig()
    shikimoriSignsInAs('code-a', { ...A, avatar: '' })
    const result = await r.invoke<TrackerAuthResult>(
      CHANNELS.TRACKER_COMPLETE_AUTH,
      'shikimori',
      'code-a'
    )
    expect(result).toMatchObject({ status: 'connected', account: { user: { ...A, avatar: '' } } })
    expect(exchangeCode).toHaveBeenCalledWith('code-a')
    expect(r.store.get('shikimoriCredentials')).toEqual({
      ...fakeCredentials('shikimori', 'code-a'),
      refresh_token: 'r-code-a'
    })
  })

  it('only the new path refuses offline: the aliases behave as today', async () => {
    const r = rig()
    r.offline.value = true
    shikimoriSignsInAs('code-a', { ...A, avatar: '' })
    expect(await r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'shikimori')).toEqual({ status: 'offline' })
    expect(await r.invoke(CHANNELS.SHIKIMORI_GET_AUTH_URL)).toMatch(/\/oauth\/authorize\?/)
    expect(await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code-a')).toMatchObject({ id: A.id })
  })

  it('SHIKIMORI_LOGOUT still clears a signed-out profile’s live queue, as 6.x does', async () => {
    const r = rig()
    await seedSignedIn(r, 'shikimori', null, A_QUEUE)
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'shikimori')
    expect(r.store.get('shikimoriUpdateQueue')).toEqual(A_QUEUE)
    await r.invoke(CHANNELS.SHIKIMORI_LOGOUT)
    expect(r.store.get('shikimoriUpdateQueue')).toEqual([])
    expect(r.lifecycle.generation('shikimori')).toBe(0)
  })
})

describe('the vault on a Shikimori-only profile', () => {
  it('list-accounts, a Shikimori login and logout (both paths) never call the vault', async () => {
    const r = rig()
    shikimoriSignsInAs('code-a', { ...A, avatar: '' })
    await r.invoke(CHANNELS.TRACKER_LIST_ACCOUNTS)
    await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'shikimori', 'code-a')
    await r.invoke(CHANNELS.TRACKER_LIST_ACCOUNTS)
    await r.invoke(CHANNELS.TRACKER_LOGOUT, 'shikimori')
    await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code-a')
    await r.invoke(CHANNELS.SHIKIMORI_LOGOUT, { pending: 'discard' })
    for (const m of vaultMembers) expect(r.spies[m], m).not.toHaveBeenCalled()
    expect(r.safe.untouched()).toBe(true)
  })
})

describe('tracker:list-accounts', () => {
  it('one account per tracker, connected or not, with the resolved primary and the stored choices', async () => {
    const r = rig({
      seed: { trackerPrimary: 'mal', trackerMirror: { anilist: false }, trackerFeatureSource: {} }
    })
    await seedSignedIn(r, 'anilist', A)
    // Shikimori's session expired: the user kept, the credentials cleared.
    r.store.set('shikimoriUser', { ...B, avatar: '' })

    const state = await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)

    expect(state.accounts.map((a) => a.trackerId)).toEqual(['shikimori', 'anilist', 'mal'])
    expect(state.accounts[0]).toEqual({
      trackerId: 'shikimori',
      user: { ...B, avatar: '' },
      hasCredentials: false,
      sessionExpired: true,
      needsSetup: false,
      credentialState: 'none'
    })
    expect(state.accounts[1]).toMatchObject({
      user: A,
      hasCredentials: true,
      sessionExpired: false,
      credentialState: 'ok'
    })
    // MAL isn't connected, so the stored primary falls back to the first connected.
    expect(state.primary).toBe('shikimori')
    expect(state.mirror).toEqual({ anilist: false })
    expect(state.featureSources).toEqual({})
  })

  it('needsSetup: MAL with no client ID, or any tracker whose instance reports it', async () => {
    const r = rig()
    const needs = async () =>
      (await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)).accounts.map(
        (a) => a.needsSetup
      )
    expect(await needs()).toEqual([false, false, true])
    await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'cid' })
    expect(await needs()).toEqual([false, false, false])
    vi.spyOn(r.syncs.mal!, 'needsSetup').mockReturnValue(true)
    vi.spyOn(r.syncs.anilist!, 'needsSetup').mockReturnValue(true)
    expect(await needs()).toEqual([false, true, true])
  })

  it('credentialState is locked only after a failed decrypt, and a sign-in replaces the blob', async () => {
    const r = rig()
    await seedSignedIn(r, 'anilist', A)
    r.safe.key = 'another-keyring'
    const state = async () =>
      (await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)).accounts[1]
        .credentialState
    expect(await state()).toBe('ok')
    expect(r.spies.read).not.toHaveBeenCalled()
    expect(await r.vault.read('anilistCredentials')).toEqual({ state: 'locked' })
    expect(await state()).toBe('locked')
    expect(await state()).toBe('locked')
    signsInAs(r, 'anilist', 'a', A)
    await login(r, 'anilist', 'a')
    expect(await state()).toBe('ok')
  })
})

describe('the MAL client config', () => {
  it('GET returns { clientId, hasSecret } and never the secret; SET stores, null clears, omitted keeps', async () => {
    const r = rig()
    expect(await r.invoke(CHANNELS.TRACKER_GET_CLIENT_CONFIG, 'mal')).toEqual({
      clientId: null,
      hasSecret: false
    })
    expect(
      await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'cid', secret: 's3' })
    ).toEqual({ clientId: 'cid', hasSecret: true })
    expect(r.spies.encrypt).toHaveBeenCalledWith('s3')
    expect(JSON.stringify(r.store.get('myanimelistClientSecret'))).not.toContain('s3')
    expect(await r.invoke(CHANNELS.TRACKER_GET_CLIENT_CONFIG, 'mal')).toEqual({
      clientId: 'cid',
      hasSecret: true
    })
    expect(await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'cid2' })).toEqual(
      { clientId: 'cid2', hasSecret: true }
    )
    expect(
      await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'cid2', secret: null })
    ).toEqual({ clientId: 'cid2', hasSecret: false })
    expect(r.store.get('myanimelistClientSecret')).toBeNull()
  })

  it('the secret is stored before the config claims it', async () => {
    const r = rig()
    r.safe.hold = true
    const done = r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'c', secret: 's' })
    await vi.waitFor(() => expect(r.safe.held).toBe(1))
    expect(r.store.get('myanimelistClientConfig')).toBeNull()
    r.safe.release()
    expect(await done).toEqual({ clientId: 'c', hasSecret: true })
  })

  it('rejects a non-MAL tracker and an invalid input', async () => {
    const r = rig()
    await expect(r.invoke(CHANNELS.TRACKER_GET_CLIENT_CONFIG, 'anilist')).rejects.toThrow(
      /no client config/
    )
    await expect(
      r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'shikimori', { clientId: 'c' })
    ).rejects.toThrow(/no client config/)
    await expect(
      r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: '  ' })
    ).rejects.toThrow(/client ID/)
    await expect(
      r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'c', secret: 1 })
    ).rejects.toThrow(/secret/)
  })
})

describe('argument validation', () => {
  it('rejects an unknown tracker, a non-string paste and an unknown pending option', async () => {
    const r = rig()
    await expect(r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'kitsu')).rejects.toThrow(/Unknown tracker/)
    await expect(r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 42)).rejects.toThrow(
      /sign-in input/
    )
    await expect(
      r.invoke(CHANNELS.TRACKER_LOGOUT, 'anilist', { pending: 'later' })
    ).rejects.toThrow(/pending/)
  })
})

describe('the new-tracker-cards flag (#703 § 8), through AppDeps', () => {
  it('off: tracker:begin-auth and tracker:complete-auth refuse AniList, and the state says false', async () => {
    const r = rig({ newTrackerCardsEnabled: false })
    signsInAs(r, 'anilist', 'tok', A)
    await expect(r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')).rejects.toThrow(
      "AniList sign-in isn't available in this build yet"
    )
    await expect(r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')).rejects.toThrow(
      "AniList sign-in isn't available in this build yet"
    )
    expect(r.openExternal).not.toHaveBeenCalled()
    expect(r.store.get('anilistUser')).toBeNull()
    expect(r.spies.encrypt).not.toHaveBeenCalled()
    const state = await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)
    expect(state.newTrackerCardsEnabled).toBe(false)
  })

  it('off: a Shikimori sign-in still goes through', async () => {
    const r = rig({ newTrackerCardsEnabled: false })
    signsInAs(r, 'shikimori', 'code', A)
    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'shikimori', 'code')).toMatchObject({
      status: 'connected'
    })
  })

  it('on: both proceed, and the state says true', async () => {
    const r = rig({ newTrackerCardsEnabled: true })
    signsInAs(r, 'anilist', 'tok', A)
    const begin = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    await vi.waitFor(() => expect(r.openExternal).toHaveBeenCalledTimes(1))
    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')).toMatchObject({
      status: 'connected',
      account: { trackerId: 'anilist', user: A }
    })
    expect(await begin).toMatchObject({ status: 'connected' })
    const state = await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)
    expect(state.newTrackerCardsEnabled).toBe(true)
  })
})
