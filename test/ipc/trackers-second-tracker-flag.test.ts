// The second-tracker flag (#701): while it is off, a sign-in for one tracker
// is refused when another tracker has a user. Main checks at begin
// (`tracker:begin-auth`, `shikimori:get-auth-url`: no browser, no port) and
// again at commit (`trackers/lifecycle.ts`), since an attempt stays open
// after its `BEGIN` resolves. The flag is flipped through `AppDeps` and the
// lifecycle's deps, never by re-mocking `electron`. Shikimori runs its real
// router on a mocked `shikimori.ts`; AniList and MyAnimeList run the fake
// trackers' `authFlow` (`test/helpers/fake-tracker.ts`).
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import * as http from 'http'
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
import { createFakeTracker, fakeCredentials } from '../helpers/fake-tracker'
import { createGenericTracker } from '../helpers/generic-tracker'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createTrackerAuthSessions } from '../../src/main/trackers/auth-session'
import { createShikimoriProvider } from '../../src/main/trackers/shikimori.provider'
import { SECOND_TRACKER_REFUSAL, secondTrackerEnabled } from '../../src/main/trackers/flags'
import { TRACKER_KEYS } from '../../src/main/trackers/keys'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'

type Svc = TrackerSyncService<unknown, unknown>

const SHIKI = { id: 11, nickname: 'shiki', avatar: null }
const ANI = { id: 22, nickname: 'ani', avatar: null }
const REFUSED = { status: 'error', kind: 'auth', message: SECOND_TRACKER_REFUSAL }

function rig(opts: { enabled: boolean }) {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    installId: 'pc'
  })
  const safe = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const commit = vi.spyOn(vault, 'commit')
  const broadcast = vi.fn()
  const isOffline = (): boolean => false

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
  vi.spyOn(shiki, 'broadcastSyncStatus').mockImplementation(() => {})

  const fakes = { anilist: createFakeTracker('anilist'), mal: createFakeTracker('mal') }
  const syncs: Svc[] = [shiki.tracker as Svc]
  for (const id of ['anilist', 'mal'] as const) {
    const { sync } = createGenericTracker(id, store as never, { fake: fakes[id] as never })
    vi.spyOn(sync, 'startSyncTimer').mockImplementation(() => {})
    vi.spyOn(sync, 'syncQueue').mockResolvedValue(undefined)
    vi.spyOn(sync, 'stopSyncTimer').mockImplementation(() => {})
    vi.spyOn(sync, 'broadcastSyncStatus').mockImplementation(() => {})
    vi.spyOn(sync, 'broadcastQueueChanged').mockImplementation(() => {})
    syncs.push(sync)
  }
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: syncs.map((sync) => ({ sync })),
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({ store: store as never, trackers: fan, isOffline })
  vi.spyOn(trackerRates, 'refreshInBackground').mockImplementation(() => {})
  const openExternal = vi.fn(async (_url: string) => {})
  const createServer = vi.fn((listener: http.RequestListener) => http.createServer(listener))
  const lifecycle = createTrackerLifecycle({
    store,
    vault,
    trackerRates,
    cancelAttempt: (id) => auth.cancel(id),
    broadcast,
    accountsChangedChannel: EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED,
    newTrackerCardsEnabled: true,
    secondTrackerEnabled: opts.enabled,
    hasPrimaryWriter: (id) => fan.hasPrimaryWriter(id)
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
    createServer,
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
    newTrackerCardsEnabled: true,
    secondTrackerEnabled: opts.enabled,
    lookupByMalIds: vi.fn(async () => ({})),
    maybeBroadcastCleanupPrompt: vi.fn(async () => {}),
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast,
    offlineService: { isOffline },
    syncRunner: { runAll: vi.fn(async () => ({})) }
  } as unknown as AppDeps
  registerShikimori(deps)
  registerTrackers(deps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    (await handlers.get(channel)!({}, ...args)) as T

  return {
    store,
    safe,
    commit,
    broadcast,
    fakes,
    fan,
    lifecycle,
    auth,
    openExternal,
    createServer,
    invoke
  }
}

type Rig = ReturnType<typeof rig>

/** The Shikimori code that signs in as `user`. */
function shikimoriSignsInAs(code: string, user: TrackerUser): void {
  exchangeCode.mockImplementation(async (c: string) =>
    c === code ? { ...fakeCredentials('shikimori', c), refresh_token: `r-${c}` } : undefined
  )
  getUser.mockImplementation(async (token: string) =>
    token === fakeCredentials('shikimori', code).access_token ? user : undefined
  )
}

function seedUser(r: Rig, id: TrackerId, user: TrackerUser): void {
  r.store.set(TRACKER_KEYS[id].user, user)
  r.store.set(TRACKER_KEYS[id].credentials, id === 'shikimori' ? { access_token: 'seed' } : null)
}

const accountsEvents = (r: Rig): TrackerAccountsState[] =>
  r.broadcast.mock.calls
    .filter(([c]) => c === EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED)
    .map(([, s]) => s as TrackerAccountsState)

beforeEach(() => {
  vi.clearAllMocks()
  exchangeCode.mockReset()
  getUser.mockReset()
})

describe('secondTrackerEnabled(isPackaged)', () => {
  it('is on unpackaged and off packaged', () => {
    expect(secondTrackerEnabled(false)).toBe(true)
    expect(secondTrackerEnabled(true)).toBe(false)
  })

  it('index.ts computes it once and hands the same value to AppDeps and the lifecycle', () => {
    const INDEX = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')
    expect(INDEX).toContain('const secondTracker = secondTrackerEnabled(app.isPackaged)')
    expect(INDEX.split('secondTrackerEnabled: secondTracker').length - 1).toBe(2)
    expect(INDEX).toContain('hasPrimaryWriter: (id) => trackerFanOut.hasPrimaryWriter(id)')
  })
})

describe('flag off', () => {
  it('Shikimori connected: BEGIN AniList is refused, with no browser and no attempt', async () => {
    const r = rig({ enabled: false })
    seedUser(r, 'shikimori', SHIKI)
    await expect(r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')).rejects.toThrow(
      SECOND_TRACKER_REFUSAL
    )
    expect(r.openExternal).not.toHaveBeenCalled()
    expect(r.auth.phase('anilist')).toBeNull()
    expect(r.fakes.anilist.signIn.begun).toEqual([])
  })

  it('Shikimori connected: BEGIN MyAnimeList binds no port and opens no browser', async () => {
    const r = rig({ enabled: false })
    seedUser(r, 'shikimori', SHIKI)
    await expect(r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'mal')).rejects.toThrow(
      SECOND_TRACKER_REFUSAL
    )
    expect(r.createServer).not.toHaveBeenCalled()
    expect(r.openExternal).not.toHaveBeenCalled()
    expect(r.auth.phase('mal')).toBeNull()
  })

  it('Shikimori connected: an AniList paste is refused at commit, and trackerPrimary stays null', async () => {
    const r = rig({ enabled: false })
    seedUser(r, 'shikimori', SHIKI)
    r.fakes.anilist.signIn.accounts.set('tok', ANI)
    expect(r.store.get('trackerPrimary')).toBeNull()

    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')).toEqual(REFUSED)
    expect(r.store.get('anilistUser')).toBeNull()
    expect(r.store.get('anilistCredentials')).toBeNull()
    expect(r.store.get('anilistSessionExpired')).toBe(false)
    expect(r.store.get('trackerPrimary')).toBeNull()
    expect(r.commit).not.toHaveBeenCalled()
    expect(r.auth.phase('anilist')).toBeNull()
  })

  it('AniList only: the Shikimori connect is refused on every path', async () => {
    const r = rig({ enabled: false })
    seedUser(r, 'anilist', ANI)
    shikimoriSignsInAs('code', SHIKI)

    await expect(r.invoke(CHANNELS.SHIKIMORI_GET_AUTH_URL)).rejects.toThrow(SECOND_TRACKER_REFUSAL)
    await expect(r.invoke(CHANNELS.TRACKER_BEGIN_AUTH, 'shikimori')).rejects.toThrow(
      SECOND_TRACKER_REFUSAL
    )
    // The alias rejects with the same message; the commit writes nothing.
    await expect(r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')).rejects.toThrow(
      SECOND_TRACKER_REFUSAL
    )
    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'shikimori', 'code')).toEqual(REFUSED)
    expect(r.store.get('shikimoriUser')).toBeNull()
    expect(r.store.get('shikimoriCredentials')).toBeNull()
    expect(r.store.get('trackerPrimary')).toBeNull()
    expect(r.openExternal).not.toHaveBeenCalled()
  })

  it('a Shikimori reconnect while its user is still set is allowed', async () => {
    const r = rig({ enabled: false })
    seedUser(r, 'shikimori', SHIKI)
    shikimoriSignsInAs('again', SHIKI)

    expect(await r.invoke(CHANNELS.SHIKIMORI_GET_AUTH_URL)).toMatch(/^https:/)
    const begin = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_BEGIN_AUTH, 'shikimori')
    await vi.waitFor(() => expect(r.openExternal).toHaveBeenCalledTimes(1))
    r.auth.cancel('shikimori')
    expect(await begin).toEqual({ status: 'cancelled' })
    expect(await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'again')).toEqual(SHIKI)
    expect(r.store.get('shikimoriCredentials')).toMatchObject({
      access_token: fakeCredentials('shikimori', 'again').access_token
    })
  })

  it('begin AniList, Shikimori commits, then the AniList paste is refused at commit', async () => {
    const r = rig({ enabled: false })
    r.fakes.anilist.signIn.accounts.set('tok', ANI)
    shikimoriSignsInAs('code', SHIKI)

    const begin = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    await vi.waitFor(() => expect(r.auth.phase('anilist')).toBe('waiting'))
    expect(await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')).toEqual(SHIKI)

    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')).toEqual(REFUSED)
    expect(await begin).toEqual(REFUSED)
    expect(r.store.get('anilistUser')).toBeNull()
    expect(r.store.get('anilistCredentials')).toBeNull()
    expect(r.store.get('shikimoriUser')).toEqual(SHIKI)
    expect(r.store.get('trackerPrimary')).toBeNull()
    expect(r.commit).not.toHaveBeenCalled()
  })

  it('a Shikimori commit during the AniList encrypt: the AniList commit is refused after the encrypt', async () => {
    const r = rig({ enabled: false })
    r.fakes.anilist.signIn.accounts.set('tok', ANI)
    shikimoriSignsInAs('code', SHIKI)
    r.safe.hold = true

    const done = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')
    // The user read has resolved; the encrypt is pending.
    await vi.waitFor(() => expect(r.safe.held).toBe(1))
    expect(await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')).toEqual(SHIKI)
    r.safe.release()

    expect(await done).toEqual(REFUSED)
    expect(r.store.get('anilistUser')).toBeNull()
    expect(r.store.get('anilistCredentials')).toBeNull()
    expect(r.commit).not.toHaveBeenCalled()
  })
})

describe('flag on', () => {
  it('Shikimori connected: BEGIN AniList opens the browser, the paste commits, and Shikimori stays primary', async () => {
    const r = rig({ enabled: true })
    seedUser(r, 'shikimori', SHIKI)
    r.fakes.anilist.signIn.accounts.set('tok', ANI)

    const begin = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    await vi.waitFor(() => expect(r.openExternal).toHaveBeenCalledTimes(1))
    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')).toMatchObject({
      status: 'connected'
    })
    expect(await begin).toMatchObject({ status: 'connected' })
    expect(r.store.get('anilistUser')).toEqual(ANI)
    expect(r.store.get('trackerPrimary')).toBe('shikimori')
  })

  it('AniList only: the Shikimori connect goes through every path', async () => {
    const r = rig({ enabled: true })
    seedUser(r, 'anilist', ANI)
    shikimoriSignsInAs('code', SHIKI)
    expect(await r.invoke(CHANNELS.SHIKIMORI_GET_AUTH_URL)).toMatch(/^https:/)
    expect(await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')).toEqual(SHIKI)
    expect(r.store.get('shikimoriUser')).toEqual(SHIKI)
  })

  it('begin AniList, Shikimori commits, then the AniList paste commits too', async () => {
    const r = rig({ enabled: true })
    r.fakes.anilist.signIn.accounts.set('tok', ANI)
    shikimoriSignsInAs('code', SHIKI)
    const begin = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_BEGIN_AUTH, 'anilist')
    await vi.waitFor(() => expect(r.auth.phase('anilist')).toBe('waiting'))
    await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
    expect(await r.invoke(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')).toMatchObject({
      status: 'connected'
    })
    expect(await begin).toMatchObject({ status: 'connected' })
    expect(r.store.get('anilistUser')).toEqual(ANI)
  })

  it('a Shikimori commit during the AniList encrypt: both commit', async () => {
    const r = rig({ enabled: true })
    r.fakes.anilist.signIn.accounts.set('tok', ANI)
    shikimoriSignsInAs('code', SHIKI)
    r.safe.hold = true
    const done = r.invoke<TrackerAuthResult>(CHANNELS.TRACKER_COMPLETE_AUTH, 'anilist', 'tok')
    await vi.waitFor(() => expect(r.safe.held).toBe(1))
    await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
    r.safe.release()
    expect(await done).toMatchObject({ status: 'connected' })
    expect(r.store.get('anilistUser')).toEqual(ANI)
    expect(r.commit).toHaveBeenCalledTimes(1)
  })
})

describe('the accounts state', () => {
  it.each([true, false])(
    'secondTrackerEnabled is the deps value (%s) on list-accounts and accounts-changed',
    async (enabled) => {
      const r = rig({ enabled })
      const listed = await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)
      expect(listed.secondTrackerEnabled).toBe(enabled)
      r.lifecycle.notifyAccountsChanged()
      expect(accountsEvents(r).map((s) => s.secondTrackerEnabled)).toEqual([enabled])
    }
  )

  it('primaryCapable lists the trackers with a registered primary writer, in TrackerId order', async () => {
    const r = rig({ enabled: true })
    // The Shikimori router registers Shikimori's.
    expect(
      (await r.invoke<TrackerAccountsState>(CHANNELS.TRACKER_LIST_ACCOUNTS)).primaryCapable
    ).toEqual(['shikimori'])
    r.fan.setPrimaryWriter('mal', async () => null)
    r.fan.setPrimaryWriter('anilist', async () => null)
    r.lifecycle.notifyAccountsChanged()
    expect(accountsEvents(r).at(-1)?.primaryCapable).toEqual(['shikimori', 'anilist', 'mal'])
  })
})
