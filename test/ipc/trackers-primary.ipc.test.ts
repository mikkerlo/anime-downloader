// The primary, the mirror toggles and the feature sources (#696): the three
// `tracker:set-*` setters, the primary's reassignment on a disconnect and on a
// second connect, and `tracker:accounts-changed` through the one
// `notifyAccountsChanged()` seam. Shikimori runs its real router, primary
// branch and adapter on a mocked `shikimori.ts`; AniList and MyAnimeList run
// the generic sync service over the fake-tracker personalities, with the
// capabilities #706's matrix gives them. The vault is the real one over a fake
// safeStorage, wired to the seam as `index.ts` wires it.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ipcMain } from 'electron'

const exchangeCode = vi.fn()
const getUser = vi.fn()

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi,
  exchangeCode: (...args: unknown[]) => exchangeCode(...args),
  getUser: (...args: unknown[]) => getUser(...args)
}))

import * as shikimori from '../../src/main/shikimori'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeTracker, fakeCredentials } from '../helpers/fake-tracker'
import { fakeApi, server, T0, iso } from '../helpers/fake-shikimori'
import { plainCodec } from '../helpers/generic-tracker'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import { register as registerSettings } from '../../src/main/ipc/settings.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import {
  createTrackerSyncService,
  type TrackerSyncService
} from '../../src/main/services/trackers/sync'
import { createTrackerFanOut, type PrimaryWriter } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { createTrackerChoices } from '../../src/main/services/trackers/choices'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createTrackerAuthSessions } from '../../src/main/trackers/auth-session'
import { createShikimoriProvider } from '../../src/main/trackers/shikimori.provider'
import { ANILIST_KEYS, MYANIMELIST_KEYS, TRACKER_KEYS } from '../../src/main/trackers/keys'
import {
  TRACKER_CAPABILITIES,
  type TrackerCapabilities,
  type TrackerCapability
} from '../../src/main/trackers/types'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { PERSISTED_STORE_KEYS } from '../../src/main/store/keys'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
import type { RateValues } from '../../src/main/lib/shikimori-rate'

type Svc = TrackerSyncService<unknown, unknown>
type Generic = 'anilist' | 'mal'

const A = { id: 11, nickname: 'alice', avatar: null }
const B = { id: 22, nickname: 'bob', avatar: null }
const C = { id: 33, nickname: 'carol', avatar: null }

const rv = (
  episodes: number,
  score = 7,
  status: RateValues['status'] = 'watching'
): RateValues => ({
  episodes,
  status,
  score,
  rewatches: 0
})

/** #706's matrix: MAL has no calendar and no airing info. */
function caps(missing: readonly TrackerCapability[] = []): TrackerCapabilities {
  return Object.fromEntries(
    TRACKER_CAPABILITIES.map((c) => [c, !missing.includes(c)])
  ) as unknown as TrackerCapabilities
}
const CAPS: Record<TrackerId, TrackerCapabilities> = {
  shikimori: caps(),
  anilist: caps(),
  mal: caps(['getCalendar', 'getAiringInfo', 'getFriends'])
}

const CHOICE_KEYS = ['trackerPrimary', 'trackerMirror', 'trackerFeatureSource'] as const

const entry = (malId: number, queuedAt: number, extra: Partial<QueuedTrackerUpdate> = {}) =>
  ({
    malId,
    rateId: malId * 10,
    before: rv(1),
    after: rv(2),
    queuedAt,
    ...extra
  }) as QueuedTrackerUpdate

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function rig(opts: { seed?: Record<string, unknown> } = {}) {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    installId: 'pc',
    ...opts.seed
  })
  const safe = createFakeSafeStorage({ async: true })
  const offline = { value: false, anilist: true, mal: true }
  const isOffline = () => offline.value

  /** Every `tracker:accounts-changed`, with what `tracker:list-accounts` answered at that moment. */
  const accountsChanged: { payload: unknown; listed: unknown }[] = []
  let listAccounts: () => unknown = () => undefined
  const broadcast = vi.fn((channel: string, payload?: unknown) => {
    if (channel === EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED) {
      accountsChanged.push({ payload: structuredClone(payload), listed: listAccounts() })
    }
  })

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
  vi.spyOn(shiki, 'startSyncTimer').mockImplementation(() => {})
  vi.spyOn(shiki, 'syncShikimoriQueue').mockResolvedValue(undefined)
  vi.spyOn(shiki, 'stopSyncTimer').mockImplementation(() => {})
  vi.spyOn(shiki.tracker, 'startSyncTimer').mockImplementation(() => {})
  vi.spyOn(shiki.tracker, 'syncQueue').mockResolvedValue(undefined)

  const fakes = { anilist: createFakeTracker('anilist'), mal: createFakeTracker('mal') }
  fakes.mal.signIn.loopback = null
  const generic = (id: Generic): Svc => {
    const sync = createTrackerSyncService(
      { ...fakes[id].provider, rateCache: plainCodec(id), isSessionGone: () => false } as never,
      id === 'anilist' ? ANILIST_KEYS : MYANIMELIST_KEYS,
      {
        store: store as never,
        broadcast: () => {},
        syncStatusChannel: `${id}:status`,
        offlineQueueChangedChannel: `${id}:queue`,
        rateUpdatedChannel: `${id}:rate`,
        ratesRefreshedChannel: `${id}:refreshed`,
        isOffline: () => offline[id]
      }
    ) as Svc
    vi.spyOn(sync, 'startSyncTimer').mockImplementation(() => {})
    vi.spyOn(sync, 'stopSyncTimer').mockImplementation(() => {})
    return sync
  }
  const syncs = {
    shikimori: shiki.tracker as Svc,
    anilist: generic('anilist'),
    mal: generic('mal')
  }

  // AniList's primary branch is T7's; a queued user entry stands in.
  const anilistPrimary = vi.fn<PrimaryWriter>(async (malId, change) => {
    if (change.kind !== 'set') throw new Error('set only')
    const cached = syncs.anilist.cachedRate(malId)
    const basis = cached?.values ?? rv(0)
    syncs.anilist.enqueue({
      malId,
      rateId: cached?.remoteId ?? null,
      before: basis,
      after: change.values,
      queuedAt: Date.now()
    })
    return { result: null, basis, after: change.values }
  })
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [
      { sync: syncs.shikimori },
      { sync: syncs.anilist, writePrimary: anilistPrimary },
      { sync: syncs.mal }
    ],
    // As `index.ts` wires it: the lifecycle's primary, read at call time.
    primary: () => lifecycle.primary(),
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({ store: store as never, trackers: fan, isOffline })
  vi.spyOn(trackerRates, 'refreshInBackground').mockImplementation(() => {})

  // As `index.ts` wires them: the vault's `onLocked` and the lifecycle's
  // broadcast both reach `notifyAccountsChanged()`.
  const vault = createCredentialVault({
    store,
    safeStorage: safe.holder,
    onLocked: () => lifecycle.notifyAccountsChanged(),
    warn: () => {}
  })
  const lifecycle = createTrackerLifecycle({
    store,
    vault,
    trackerRates,
    cancelAttempt: (id) => auth.cancel(id),
    broadcast,
    accountsChangedChannel: EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED
  })
  const providers = {
    shikimori: { ...createShikimoriProvider({ store }), capabilities: CAPS.shikimori },
    anilist: { ...fakes.anilist.provider, capabilities: CAPS.anilist },
    mal: { ...fakes.mal.provider, capabilities: CAPS.mal }
  }
  const auth = createTrackerAuthSessions({
    lifecycle,
    providers,
    isOffline,
    openExternal: async () => {},
    log: { warn: () => {} }
  })
  const choicesLog = { error: vi.fn() }
  const choices = createTrackerChoices({
    store,
    trackers: fan,
    lifecycle,
    log: choicesLog
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
    trackerChoices: choices,
    coldStorageService: { getDownloadDir: () => '/dl' },
    lookupByMalIds: vi.fn(async () => ({})),
    maybeBroadcastCleanupPrompt: vi.fn(async () => {}),
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast,
    offlineService: { isOffline },
    syncRunner: { runAll: vi.fn(async () => ({})) }
  } as unknown as AppDeps
  registerShikimori(deps)
  registerTrackers(deps)
  registerSettings(deps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  listAccounts = () => handlers.get(CHANNELS.TRACKER_LIST_ACCOUNTS)!({})
  const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    (await handlers.get(channel)!({}, ...args)) as T

  const snapshot = (): string =>
    JSON.stringify(Object.fromEntries(PERSISTED_STORE_KEYS.map((k) => [k, store.get(k)])))
  const queueOf = (id: TrackerId) =>
    (store.get(TRACKER_KEYS[id].updateQueue) as QueuedTrackerUpdate[] | undefined) ?? []
  const connectedCount = () =>
    (['shikimori', 'anilist', 'mal'] as const).filter((id) => store.get(TRACKER_KEYS[id].user))
      .length

  return {
    store,
    safe,
    vault,
    offline,
    fakes,
    syncs,
    fan,
    anilistPrimary,
    lifecycle,
    auth,
    choices,
    choicesLog,
    trackerRates,
    broadcast,
    accountsChanged,
    invoke,
    snapshot,
    queueOf,
    connectedCount
  }
}

type Rig = ReturnType<typeof rig>

/** #696's invariant, checked after every login and logout in this file. */
function expectInvariant(r: Rig): void {
  if (r.connectedCount() >= 2) expect(r.store.get('trackerPrimary')).not.toBeNull()
}

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

/** A sign-in through `tracker:complete-auth` (a paste: Shikimori's code, AniList's token). */
async function login(
  r: Rig,
  id: 'shikimori' | 'anilist',
  input: string,
  user: TrackerUser
): Promise<TrackerAuthResult> {
  if (id === 'shikimori') shikimoriSignsInAs(input, user)
  else r.fakes.anilist.signIn.accounts.set(input, user)
  const result = await r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_COMPLETE_AUTH, id, input)
  expectInvariant(r)
  return result
}

async function logout(r: Rig, id: TrackerId): Promise<TrackerLogoutResult> {
  const result = await r.invoke<TrackerLogoutResult>(CHANNELS.TRACKER_LOGOUT, id)
  expectInvariant(r)
  return result
}

/** `id` signed in as `user`, seeded directly. */
async function seedSignedIn(r: Rig, id: TrackerId, user: TrackerUser): Promise<void> {
  const k = TRACKER_KEYS[id]
  const creds = fakeCredentials(id, 'seed')
  r.store.set(k.user, user)
  r.store.set(k.credentials, id === 'shikimori' ? creds : await r.vault.encrypt(creds))
}

const accountsEvents = (r: Rig) => r.accountsChanged.map((e) => e.payload)

/** Each broadcast deep-equals `tracker:list-accounts` at that moment. */
function expectBroadcastsMatchList(r: Rig): void {
  for (const e of r.accountsChanged) expect(e.payload).toEqual(e.listed)
}

beforeEach(() => {
  vi.clearAllMocks()
  server.reset()
  exchangeCode.mockReset()
  getUser.mockReset()
  getUser.mockRejectedValue(new Error('unknown token'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  shikimori.setOnSessionExpired(undefined)
})

describe('mirror off, then discard (§2)', () => {
  /** Shikimori primary, AniList connected as a mirror; title 1 at episode 7 on both. */
  async function mirrorRig(seed: Record<string, unknown> = {}) {
    const r = rig({ seed: { trackerPrimary: 'shikimori', ...seed } })
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    server.set(1, rv(7))
    r.store.set('shikimoriUserRates', [
      {
        rate: { id: 10, target_id: 1, ...rv(7), updated_at: iso(T0) },
        shikiAnime: { id: 1, name: '#1' },
        smotretAnime: null
      }
    ])
    r.store.set(ANILIST_KEYS.userRates, [{ malId: 1, remoteId: 1000, values: rv(7) }])
    return r
  }
  const mirrorsOf = (r: Rig) => r.queueOf('anilist').filter((q) => q.via === 'mirror')

  it('a user change already in flight at the confirm queues no mirror entry once the primary resumes', async () => {
    const r = await mirrorRig()
    const gate = deferred()
    const reached = deferred()
    const send = fakeApi.updateUserRate.getMockImplementation()!
    fakeApi.updateUserRate.mockImplementationOnce(async (...args) => {
      reached.resolve()
      await gate.promise
      return send(...args)
    })

    const change = r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 1, rv(8))
    await reached.promise
    const off = await r.invoke<TrackerSetMirrorResult>(
      CHANNELS.TRACKER_SET_MIRROR,
      'anilist',
      false,
      {
        confirm: true
      }
    )
    expect(off).toEqual({ applied: true, discarded: 0 })
    gate.resolve()
    await change

    expect(server.get(1)!.episodes).toBe(8)
    expect(mirrorsOf(r)).toEqual([])
  })

  it('a user change made right after the confirm queues no mirror entry either', async () => {
    const r = await mirrorRig()
    await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: true })
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 1, rv(8))
    expect(server.get(1)!.episodes).toBe(8)
    expect(mirrorsOf(r)).toEqual([])
  })

  it('with the toggle on, the same change queues the mirror entry (the rows above are not vacuous)', async () => {
    const r = await mirrorRig()
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 1, rv(8))
    expect(mirrorsOf(r)).toMatchObject([{ malId: 1, fields: ['episodes'], after: rv(8) }])
  })

  it('without confirm: pendingMirrorChanges is the live via: mirror count, and the store is byte-identical', async () => {
    const r = await mirrorRig({
      anilistUpdateQueue: [
        entry(2, 100, { via: 'mirror' }),
        entry(3, 200),
        entry(4, 300, { via: 'mirror' }),
        entry(5, 400, { via: 'copy' })
      ]
    })
    const before = r.snapshot()
    const discard = vi.spyOn(r.fan, 'discardQueue')

    expect(await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false)).toEqual({
      applied: false,
      pendingMirrorChanges: 2
    })
    expect(
      await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: false })
    ).toEqual({ applied: false, pendingMirrorChanges: 2 })

    expect(r.snapshot()).toBe(before)
    expect(discard).not.toHaveBeenCalled()
    expect(r.accountsChanged).toEqual([])
  })

  it('with confirm: the flag is false before discardQueue runs, once, for that tracker only; the rest of the queue and the parked buckets stay', async () => {
    const merge = entry(3, 200, {
      origin: { kind: 'sync-merge', provenance: { episodes: { libraryId: 'K' } } }
    } as Partial<QueuedTrackerUpdate>)
    const copy = entry(4, 300, { via: 'copy' })
    const winner = entry(5, 400, { via: 'reconcile' })
    const parked = {
      '9': { nickname: 'old', entries: [entry(6, 50, { via: 'mirror' })], parkedAt: 1 }
    }
    const r = await mirrorRig({
      anilistUpdateQueue: [entry(2, 100, { via: 'mirror' }), merge, copy, winner],
      anilistParkedQueues: parked,
      shikimoriUpdateQueue: [entry(7, 100, { via: 'mirror' })]
    })
    const flagAtDiscard: unknown[] = []
    const real = r.fan.discardQueue.bind(r.fan)
    const discard = vi.spyOn(r.fan, 'discardQueue').mockImplementation(async (id) => {
      flagAtDiscard.push(structuredClone(r.store.get('trackerMirror')))
      return real(id)
    })

    const out = await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: true })

    expect(out).toEqual({ applied: true, discarded: 1 })
    expect(discard.mock.calls).toEqual([['anilist']])
    expect(flagAtDiscard).toEqual([{ anilist: false }])
    expect(r.store.get('trackerMirror')).toEqual({ anilist: false })
    expect(r.queueOf('anilist')).toEqual([merge, copy, winner])
    expect(r.store.get(ANILIST_KEYS.parkedQueues)).toEqual(parked)
    expect(r.queueOf('shikimori')).toEqual([entry(7, 100, { via: 'mirror' })])
    expect(accountsEvents(r)).toHaveLength(1)
    expectBroadcastsMatchList(r)
  })

  it('discarded can exceed the count shown: 2 shown, a third added while the dialog is open, 3 discarded', async () => {
    const r = await mirrorRig({
      anilistUpdateQueue: [entry(2, 100, { via: 'mirror' }), entry(3, 200, { via: 'mirror' })]
    })
    expect(await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false)).toEqual({
      applied: false,
      pendingMirrorChanges: 2
    })
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 1, rv(8))
    expect(mirrorsOf(r)).toHaveLength(3)

    expect(
      await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: true })
    ).toEqual({ applied: true, discarded: 3 })
    expect(mirrorsOf(r)).toEqual([])
  })

  it('a discard that rejects after the flag is down resolves applied: true, discarded: 0, logs, and leaves the toggle off', async () => {
    const r = await mirrorRig({ anilistUpdateQueue: [entry(2, 100, { via: 'mirror' })] })
    const failure = new Error('disk full')
    vi.spyOn(r.fan, 'discardQueue').mockRejectedValue(failure)

    expect(
      await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: true })
    ).toEqual({ applied: true, discarded: 0 })

    expect(r.store.get('trackerMirror')).toEqual({ anilist: false })
    expect(r.choicesLog.error).toHaveBeenCalledTimes(1)
    expect(r.choicesLog.error.mock.calls[0]).toEqual([
      expect.stringContaining('AniList mirror queue'),
      failure
    ])
    expect(accountsEvents(r)).toEqual([expect.objectContaining({ mirror: { anilist: false } })])
    expectBroadcastsMatchList(r)
  })

  it('rejects a tracker that isn’t connected, and the store is unchanged', async () => {
    const r = await mirrorRig()
    const before = r.snapshot()
    await expect(
      r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'mal', false, { confirm: true })
    ).rejects.toThrow(/MyAnimeList isn.t connected/)
    await expect(r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'mal', true)).rejects.toThrow(
      /isn.t connected/
    )
    expect(r.snapshot()).toBe(before)
    expect(r.accountsChanged).toEqual([])
  })

  it('rejects the current primary in both directions, leaving its stored toggle alone', async () => {
    const r = await mirrorRig({ trackerMirror: { shikimori: false } })
    const before = r.snapshot()
    const discard = vi.spyOn(r.fan, 'discardQueue')
    for (const enabled of [true, false]) {
      await expect(
        r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'shikimori', enabled, { confirm: true })
      ).rejects.toThrow(/Shikimori is the primary/)
    }
    expect(r.store.get('trackerMirror')).toEqual({ shikimori: false })
    expect(r.snapshot()).toBe(before)
    expect(discard).not.toHaveBeenCalled()
  })

  it('on: stores the toggle and offers the reconcile review; on again is a no-op with no offer and no broadcast', async () => {
    const r = await mirrorRig({ trackerMirror: { anilist: false } })
    expect(await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', true)).toEqual({
      applied: true,
      offerReconcile: true
    })
    expect(r.store.get('trackerMirror')).toEqual({ anilist: true })
    expect(accountsEvents(r)).toHaveLength(1)

    const before = r.snapshot()
    expect(await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', true)).toEqual({ applied: false })
    expect(r.snapshot()).toBe(before)
    expect(accountsEvents(r)).toHaveLength(1)
    expectBroadcastsMatchList(r)
  })

  it('a tracker missing from trackerMirror reads as on: on is a no-op, and off with confirm is applied', async () => {
    const r = await mirrorRig()
    expect(await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', true)).toEqual({ applied: false })
    expect(r.store.get('trackerMirror')).toEqual({})
    expect(
      await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: true })
    ).toMatchObject({ applied: true })
    // Already off: no second discard and no broadcast.
    const discard = vi.spyOn(r.fan, 'discardQueue')
    expect(
      await r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: true })
    ).toEqual({ applied: false })
    expect(discard).not.toHaveBeenCalled()
    expect(accountsEvents(r)).toHaveLength(1)
  })

  it('rejects a non-boolean enabled and an invalid confirm', async () => {
    const r = await mirrorRig()
    await expect(r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', 'off')).rejects.toThrow(
      /Invalid enabled/
    )
    await expect(
      r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'anilist', false, { confirm: 'yes' })
    ).rejects.toThrow(/Invalid confirm/)
    await expect(r.invoke(CHANNELS.TRACKER_SET_MIRROR, 'nope', false)).rejects.toThrow(
      /Unknown tracker/
    )
  })
})

describe('tracker:set-primary (§1)', () => {
  it('rejects a tracker that isn’t connected; writes a connected one and broadcasts once; the current primary again writes and broadcasts nothing', async () => {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    r.store.set('trackerPrimary', 'shikimori')
    const before = r.snapshot()
    await expect(r.invoke(CHANNELS.TRACKER_SET_PRIMARY, 'mal')).rejects.toThrow(
      /MyAnimeList isn.t connected/
    )
    await expect(r.invoke(CHANNELS.TRACKER_SET_PRIMARY, 'nope')).rejects.toThrow(/Unknown tracker/)
    expect(r.snapshot()).toBe(before)
    expect(r.accountsChanged).toEqual([])

    const state = await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_SET_PRIMARY, 'anilist')
    expect(state.primary).toBe('anilist')
    expect(r.store.get('trackerPrimary')).toBe('anilist')
    expect(accountsEvents(r)).toEqual([state])

    const set = vi.spyOn(r.store, 'set')
    const again = await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_SET_PRIMARY, 'anilist')
    expect(again).toEqual(state)
    expect(set).not.toHaveBeenCalled()
    expect(accountsEvents(r)).toHaveLength(1)
    expectBroadcastsMatchList(r)
  })

  it('no queue moves, and the old primary becomes a mirror under its stored toggle', async () => {
    const r = rig({ seed: { trackerMirror: { shikimori: false } } })
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    r.store.set('trackerPrimary', 'shikimori')
    r.store.set('shikimoriUpdateQueue', [entry(1, 100)])
    r.store.set(ANILIST_KEYS.updateQueue, [entry(2, 200)])

    await r.invoke(CHANNELS.TRACKER_SET_PRIMARY, 'anilist')

    expect(r.queueOf('shikimori')).toEqual([entry(1, 100)])
    expect(r.queueOf('anilist')).toEqual([entry(2, 200)])
    expect(r.store.get('trackerMirror')).toEqual({ shikimori: false })
  })

  it('accepts a connected tracker whose session expired (user kept, credentials cleared) and one that needs setup', async () => {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    await seedSignedIn(r, 'mal', C)
    r.store.set('trackerPrimary', 'shikimori')
    r.store.set(ANILIST_KEYS.credentials, null)
    const listed = await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)
    expect(listed.accounts[1]).toMatchObject({ hasCredentials: false, sessionExpired: true })
    // No MAL client ID saved.
    expect(listed.accounts[2]).toMatchObject({ user: C, needsSetup: true })

    expect(
      (await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_SET_PRIMARY, 'anilist')).primary
    ).toBe('anilist')
    expect(
      (await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_SET_PRIMARY, 'mal')).primary
    ).toBe('mal')
    expect(r.store.get('trackerPrimary')).toBe('mal')
  })

  it('after SET_PRIMARY(anilist), a tracker:update-rate goes to AniList as the primary and mirrors to Shikimori', async () => {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    r.store.set('trackerPrimary', 'shikimori')
    server.set(1, rv(7))
    r.store.set('shikimoriUserRates', [
      {
        rate: { id: 10, target_id: 1, ...rv(7), updated_at: iso(T0) },
        shikiAnime: { id: 1, name: '#1' },
        smotretAnime: null
      }
    ])
    r.store.set(ANILIST_KEYS.userRates, [{ malId: 1, remoteId: 1000, values: rv(7) }])

    await r.invoke(CHANNELS.TRACKER_SET_PRIMARY, 'anilist')
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 1, rv(8))

    expect(r.anilistPrimary).toHaveBeenCalledTimes(1)
    expect(fakeApi.updateUserRate).not.toHaveBeenCalled()
    expect(fakeApi.createUserRate).not.toHaveBeenCalled()
    expect(r.queueOf('shikimori')).toMatchObject([{ malId: 1, via: 'mirror', after: rv(8) }])
  })
})

describe('tracker:set-feature-source (§3)', () => {
  async function sourcesRig() {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    await seedSignedIn(r, 'mal', C)
    r.store.set('trackerPrimary', 'shikimori')
    return r
  }

  it('rejects (airing, mal), (calendar, mal), a tracker that isn’t connected and an unknown feature; the store is unchanged', async () => {
    const r = await sourcesRig()
    await expect(r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'airing', 'mal')).rejects.toThrow(
      /MyAnimeList can.t be the airing source/
    )
    await expect(r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'calendar', 'mal')).rejects.toThrow(
      /MyAnimeList can.t be the calendar source/
    )
    r.store.set('anilistUser', null)
    const before = r.snapshot()
    await expect(
      r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'details', 'anilist')
    ).rejects.toThrow(/AniList isn.t connected/)
    await expect(
      r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'friends', 'shikimori')
    ).rejects.toThrow(/Unknown feature/)
    await expect(r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'details', 'nope')).rejects.toThrow(
      /Unknown tracker/
    )
    expect(r.snapshot()).toBe(before)
    expect(r.accountsChanged).toEqual([])
  })

  it('MAL is a capable source for the other three features', async () => {
    const r = await sourcesRig()
    for (const feature of ['chronology', 'forYou', 'details'] as const) {
      await r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, feature, 'mal')
    }
    expect(r.store.get('trackerFeatureSource')).toEqual({
      chronology: 'mal',
      forYou: 'mal',
      details: 'mal'
    })
  })

  it('stores a capable override and broadcasts once; the stored value again is a no-op; null clears it', async () => {
    const r = await sourcesRig()
    const state = await r.invoke<TrackerAccountsState>(
      CHANNELS.TRACKER_SET_FEATURE_SOURCE,
      'airing',
      'anilist'
    )
    expect(state.featureSources).toEqual({ airing: 'anilist' })
    expect(r.store.get('trackerFeatureSource')).toEqual({ airing: 'anilist' })
    expect(accountsEvents(r)).toEqual([state])

    const set = vi.spyOn(r.store, 'set')
    await r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'airing', 'anilist')
    expect(set).not.toHaveBeenCalled()
    expect(accountsEvents(r)).toHaveLength(1)
    set.mockRestore()

    const cleared = await r.invoke<TrackerAccountsState>(
      CHANNELS.TRACKER_SET_FEATURE_SOURCE,
      'airing',
      null
    )
    expect(cleared.featureSources).toEqual({})
    expect(r.store.get('trackerFeatureSource')).toEqual({})
    expect(accountsEvents(r)).toHaveLength(2)

    await r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'airing', null)
    expect(accountsEvents(r)).toHaveLength(2)
    expectBroadcastsMatchList(r)
  })

  it('an override naming a tracker that later disconnects is kept', async () => {
    const r = await sourcesRig()
    await r.invoke(CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'calendar', 'anilist')
    await logout(r, 'anilist')
    expect(r.store.get('trackerFeatureSource')).toEqual({ calendar: 'anilist' })
  })
})

describe('the primary read rule (§0)', () => {
  const primaries = async (r: Rig) => [
    (await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)).primary,
    r.fan.primary()
  ]

  it('stored and connected → the stored one', async () => {
    const r = rig({ seed: { trackerPrimary: 'mal' } })
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'mal', C)
    expect(await primaries(r)).toEqual(['mal', 'mal'])
  })

  it('stored but disconnected → the first connected in shikimori, anilist, mal order', async () => {
    const r = rig({ seed: { trackerPrimary: 'shikimori' } })
    await seedSignedIn(r, 'mal', C)
    await seedSignedIn(r, 'anilist', B)
    expect(await primaries(r)).toEqual(['anilist', 'anilist'])
  })

  it('none connected → null', async () => {
    const r = rig({ seed: { trackerPrimary: 'anilist' } })
    expect(await primaries(r)).toEqual([null, null])
  })

  it('the fan-out reads the lifecycle’s primary at call time, so the writes follow it', async () => {
    const r = rig({ seed: { trackerPrimary: 'shikimori' } })
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    r.store.set(ANILIST_KEYS.userRates, [{ malId: 1, remoteId: 1000, values: rv(7) }])
    const lifecyclePrimary = vi.spyOn(r.lifecycle, 'primary').mockReturnValue('anilist')

    expect(r.fan.primary()).toBe('anilist')
    expect(r.trackerRates.primary()).toBe('anilist')
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 1, rv(8))
    expect(r.anilistPrimary).toHaveBeenCalledTimes(1)
    expect(fakeApi.updateUserRate).not.toHaveBeenCalled()

    lifecyclePrimary.mockReturnValue('shikimori')
    expect(r.fan.primary()).toBe('shikimori')
  })

  it('a fan-out built without the getter answers with the same rule: connected never needs a sync instance', async () => {
    const r = rig({ seed: { trackerPrimary: 'mal' } })
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'mal', C)
    const bare = createTrackerFanOut({
      store: r.store as never,
      trackers: [{ sync: r.syncs.shikimori }],
      log: { warn: () => {} }
    })
    expect(bare.primary()).toBe('mal')
    expect(bare.primary()).toBe(r.lifecycle.primary())
    r.store.set('trackerPrimary', null)
    expect([bare.primary(), r.lifecycle.primary()]).toEqual(['shikimori', 'shikimori'])
  })
})

describe('disconnecting the primary (§4)', () => {
  async function three() {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A)
    await seedSignedIn(r, 'anilist', B)
    await seedSignedIn(r, 'mal', C)
    r.store.set('trackerPrimary', 'shikimori')
    return r
  }

  it('three connected, the primary logs out: needsPrimaryChoice with the two others, the first already primary; SET_PRIMARY persists the pick', async () => {
    const r = await three()
    expect(await logout(r, 'shikimori')).toEqual({
      needsPrimaryChoice: { candidates: ['anilist', 'mal'] }
    })
    expect(r.store.get('trackerPrimary')).toBe('anilist')
    expect(accountsEvents(r)).toHaveLength(1)
    expect(accountsEvents(r)[0]).toMatchObject({ primary: 'anilist' })

    await r.invoke(CHANNELS.TRACKER_SET_PRIMARY, 'mal')
    expect(r.store.get('trackerPrimary')).toBe('mal')
    expectBroadcastsMatchList(r)
  })

  it('two connected, the primary logs out: no question, the remaining one is primary', async () => {
    const r = await three()
    await logout(r, 'mal')
    expect(await logout(r, 'shikimori')).toEqual({})
    expect(r.store.get('trackerPrimary')).toBe('anilist')
  })

  it('the last one logs out: trackerPrimary is back at its default', async () => {
    const r = await three()
    await logout(r, 'shikimori')
    await logout(r, 'mal')
    expect(r.store.get('trackerPrimary')).toBe('anilist')
    expect(await logout(r, 'anilist')).toEqual({})
    expect(r.store.get('trackerPrimary')).toBeNull()
  })

  it('logging out a tracker that isn’t the primary leaves trackerPrimary alone', async () => {
    const r = await three()
    const set = vi.spyOn(r.store, 'set')
    expect(await logout(r, 'anilist')).toEqual({})
    expect(r.store.get('trackerPrimary')).toBe('shikimori')
    expect(set.mock.calls.filter(([k]) => k === 'trackerPrimary')).toEqual([])
  })

  it('one synchronous block: a microtask queued by the write that clears the user already sees the new primary', async () => {
    const r = await three()
    const seen: unknown[] = []
    const real = r.store.set.bind(r.store)
    vi.spyOn(r.store, 'set').mockImplementation((key: string, value: unknown) => {
      real(key, value)
      if (key === 'shikimoriUser' && value === null) {
        queueMicrotask(() => seen.push(r.store.get('trackerPrimary')))
      }
    })
    await logout(r, 'shikimori')
    expect(seen).toEqual(['anilist'])
  })

  it('a never-connected logout resolves {} and writes nothing', async () => {
    const r = await three()
    r.store.set('myanimelistUser', null)
    r.store.set(MYANIMELIST_KEYS.credentials, null)
    const before = r.snapshot()
    expect(await logout(r, 'mal')).toEqual({})
    expect(r.snapshot()).toBe(before)
    expect(r.accountsChanged).toEqual([])
  })
})

describe('a second tracker connecting (§5)', () => {
  it('AniList only, then a Shikimori login: AniList stays primary', async () => {
    const r = rig()
    await seedSignedIn(r, 'anilist', B)
    expect(r.store.get('trackerPrimary')).toBeNull()
    shikimoriSignsInAs('code-a', { ...A, avatar: '' })

    await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'shikimori', 'code-a')

    // Without the rule the fallback order would make Shikimori primary.
    expect((await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)).primary).toBe(
      'anilist'
    )
    expect(r.fan.primary()).toBe('anilist')
    expect(r.store.get('trackerPrimary')).toBe('anilist')
  })

  it('a first login, a switch and a third tracker leave a stored primary alone', async () => {
    const r = rig()
    await login(r, 'anilist', 'tok-b', B)
    expect(r.store.get('trackerPrimary')).toBeNull()
    await login(r, 'anilist', 'tok-c', C)
    expect(r.store.get('trackerPrimary')).toBeNull()
    await login(r, 'shikimori', 'code-a', { ...A, avatar: '' })
    expect(r.store.get('trackerPrimary')).toBe('anilist')
    await r.invoke(CHANNELS.TRACKER_SET_PRIMARY, 'shikimori')
    await seedSignedIn(r, 'mal', C)
    await login(r, 'anilist', 'tok-b', B)
    expect(r.store.get('trackerPrimary')).toBe('shikimori')
  })

  it('a refused (overtaken) second login writes no primary: Shikimori connected, an AniList login cancelled during vault.encrypt', async () => {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A)
    r.fakes.anilist.signIn.accounts.set('tok', B)
    const before = r.snapshot()
    r.safe.hold = true
    const begin = r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    const done = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')
    await vi.waitFor(() => expect(r.safe.held).toBe(1))
    await r.invoke(CHANNELS.TRACKER_CANCEL_AUTH, 'anilist')
    r.safe.release()

    expect(await done).toEqual({ status: 'cancelled' })
    expect(await begin).toEqual({ status: 'cancelled' })
    expect(r.store.get('trackerPrimary')).toBeNull()
    expect(r.snapshot()).toBe(before)
    expect(r.accountsChanged).toEqual([])
  })
})

describe('tracker:accounts-changed (§6)', () => {
  it('fires once per login, switch and logout, each payload deep-equal to tracker:list-accounts at that moment', async () => {
    const r = rig()
    await login(r, 'shikimori', 'code-a', { ...A, avatar: '' })
    expect(accountsEvents(r)).toHaveLength(1)
    await login(r, 'anilist', 'tok-b', B)
    expect(accountsEvents(r)).toHaveLength(2)
    await login(r, 'anilist', 'tok-c', C)
    expect(accountsEvents(r)).toHaveLength(3)
    await logout(r, 'shikimori')
    expect(accountsEvents(r)).toHaveLength(4)
    expect(accountsEvents(r).at(-1)).toMatchObject({ primary: 'anilist' })
    await logout(r, 'anilist')
    expect(accountsEvents(r)).toHaveLength(5)
    expectBroadcastsMatchList(r)
    expect(accountsEvents(r).at(-1)).toMatchObject({ primary: null })
  })

  it('a Shikimori session expiry: once, with hasCredentials false and the user kept', async () => {
    const r = rig()
    await seedSignedIn(r, 'shikimori', A)
    r.store.set('shikimoriCredentials', {
      access_token: 'old',
      refresh_token: 'r-old',
      token_type: 'Bearer',
      expires_in: 1,
      created_at: 1
    })
    // As `index.ts` sets the hook.
    shikimori.setOnSessionExpired(() => {
      r.broadcast(EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS)
      r.lifecycle.notifyAccountsChanged()
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    )
    const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
      '../../src/main/shikimori'
    )
    await expect(actual.ensureFreshToken(r.store as never)).rejects.toThrow()

    expect(accountsEvents(r)).toHaveLength(1)
    expect((accountsEvents(r)[0] as TrackerAccountsState).accounts[0]).toMatchObject({
      user: A,
      hasCredentials: false,
      sessionExpired: true
    })
    expectBroadcastsMatchList(r)
  })

  it('a failed vault decrypt: once, with credentialState locked; a second read of the same blob doesn’t repeat it', async () => {
    const r = rig()
    await seedSignedIn(r, 'anilist', B)
    r.safe.key = 'another-keyring'
    expect(await r.vault.read('anilistCredentials')).toEqual({ state: 'locked' })
    expect(await r.vault.read('anilistCredentials')).toEqual({ state: 'locked' })

    expect(accountsEvents(r)).toHaveLength(1)
    expect((accountsEvents(r)[0] as TrackerAccountsState).accounts[1]).toMatchObject({
      credentialState: 'locked'
    })
    expectBroadcastsMatchList(r)
  })

  it('a client config that changes MAL’s Needs setup: once; one that doesn’t, never', async () => {
    const r = rig()
    await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'cid' })
    expect(accountsEvents(r)).toHaveLength(1)
    expect((accountsEvents(r)[0] as TrackerAccountsState).accounts[2].needsSetup).toBe(false)
    await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'cid2' })
    expect(accountsEvents(r)).toHaveLength(1)
    expectBroadcastsMatchList(r)
  })

  it('the seam carries whatever the state builder returns, so a field it adds reaches the broadcast', async () => {
    const r = rig()
    const real = r.lifecycle.accountsState
    vi.spyOn(r.lifecycle, 'accountsState').mockImplementation(() => ({
      ...real(),
      secondTrackerEnabled: true
    }))
    r.lifecycle.notifyAccountsChanged()
    expect(accountsEvents(r)).toEqual([expect.objectContaining({ secondTrackerEnabled: true })])
  })

  describe('index.ts wires every existing site to the seam', () => {
    const INDEX = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')
    const callArgs = (callee: string): string => {
      const start = INDEX.indexOf(`${callee}(`)
      expect(start, `${callee}( in index.ts`).toBeGreaterThan(-1)
      let depth = 0
      for (let i = start + callee.length; i < INDEX.length; i++) {
        if (INDEX[i] === '(') depth++
        else if (INDEX[i] === ')' && --depth === 0) return INDEX.slice(start, i + 1)
      }
      throw new Error(`unbalanced ${callee}`)
    }

    it('the Shikimori expiry hook calls notifyAccountsChanged beside broadcastSyncStatus', () => {
      const hook = callArgs('shikimori.setOnSessionExpired')
      expect(hook).toContain('broadcastSyncStatus()')
      expect(hook).toContain('trackerLifecycle.notifyAccountsChanged()')
    })

    it('the vault’s onLocked calls it', () => {
      expect(callArgs('createCredentialVault')).toMatch(
        /onLocked:\s*\(\)\s*=>\s*trackerLifecycle\.notifyAccountsChanged\(\)/
      )
    })

    it('the fan-out reads the lifecycle’s primary', () => {
      expect(callArgs('createTrackerFanOut')).toMatch(
        /primary:\s*\(\)\s*=>\s*trackerLifecycle\.primary\(\)/
      )
    })

    it('the lifecycle gets the broadcast and the channel', () => {
      const args = callArgs('createTrackerLifecycle')
      expect(args).toContain('accountsChangedChannel: EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED')
      expect(args).toContain('broadcast: broadcastToAll')
    })
  })
})

describe('the settings guard still refuses direct writes', () => {
  it.each([
    ['trackerPrimary', CHANNELS.TRACKER_SET_PRIMARY, 'tracker:set-primary'],
    ['trackerMirror', CHANNELS.TRACKER_SET_MIRROR, 'tracker:set-mirror'],
    ['trackerFeatureSource', CHANNELS.TRACKER_SET_FEATURE_SOURCE, 'tracker:set-feature-source']
  ])('set-setting(%s) names %s', async (key, channel, literal) => {
    const r = rig()
    expect(channel).toBe(literal)
    for (const k of [key, `${key}.anilist`]) {
      await expect(r.invoke(CHANNELS.SET_SETTING, k, 'anilist')).rejects.toThrow(
        `set-setting refuses '${k}' — use ${literal}`
      )
    }
    expect(r.store.get(key)).toEqual(STORE_DEFAULTS[key as keyof typeof STORE_DEFAULTS])
  })
})

describe('the Shikimori-only hard constraint (§7)', () => {
  it('a login, a switch that parks, and a logout never write the three keys', async () => {
    const r = rig()
    const set = vi.spyOn(r.store, 'set')
    await login(r, 'shikimori', 'code-a', { ...A, avatar: '' })
    r.store.set('shikimoriUpdateQueue', [entry(1, 100)])
    await login(r, 'shikimori', 'code-b', { ...B, avatar: '' })
    expect(Object.keys(r.store.get('shikimoriParkedQueues') as object)).toEqual([String(A.id)])
    await logout(r, 'shikimori')
    await r.invoke(CHANNELS.SHIKIMORI_LOGOUT)

    expect(set.mock.calls.filter(([k]) => (CHOICE_KEYS as readonly string[]).includes(k))).toEqual(
      []
    )
    for (const k of CHOICE_KEYS) expect(r.store.get(k)).toEqual(STORE_DEFAULTS[k])
  })
})
