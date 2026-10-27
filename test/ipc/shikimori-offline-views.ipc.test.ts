// Calendar and friends activity while offline (#568). Both lists come from the
// shikimori-sync service's in-memory snapshot, whatever its age, stamped with
// the Shikimori user it was fetched for; nothing on the offline path reaches
// the token refresh, `lookupByMalIds` or `fetch`.
//
// The Shikimori client is mocked, but every network-facing mock refuses with
// `OfflineError` while the real OfflineService reports offline — which is what
// `fetchWithTimeout` does underneath them in the app.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { OfflineError } from '../../src/main/lib/net'

const ensureFreshToken = vi.fn()
const getFriendsActivity = vi.fn()
const getCalendar = vi.fn()
const getUserRate = vi.fn()
const updateUserRate = vi.fn()
const getUser = vi.fn()
const exchangeCode = vi.fn()
const getUserAnimeRates = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a),
    getFriendsActivity: (...a: unknown[]) => getFriendsActivity(...a),
    getCalendar: (...a: unknown[]) => getCalendar(...a),
    getUserRate: (...a: unknown[]) => getUserRate(...a),
    updateUserRate: (...a: unknown[]) => updateUserRate(...a),
    getUser: (...a: unknown[]) => getUser(...a),
    exchangeCode: (...a: unknown[]) => exchangeCode(...a),
    getUserAnimeRates: (...a: unknown[]) => getUserAnimeRates(...a)
  }
})

import { register } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { ShikiApiError } from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createOfflineService, type OfflineService } from '../../src/main/services/offline'

const MAL = 5114
const T0 = new Date('2026-10-27T12:00:00Z').getTime()
const HOUR = 60 * 60 * 1000

function cachedRate(malId: number): unknown {
  return {
    rate: { id: 900 + malId, target_id: malId, episodes: 3, status: 'watching', score: 7 },
    shikiAnime: { id: malId },
    smotretAnime: null
  }
}

function calendarRow(malId: number): unknown {
  return {
    next_episode: 4,
    next_episode_at: '2026-10-30T15:00:00+03:00',
    duration: 24,
    anime: {
      id: malId,
      name: 'FMA',
      russian: 'Стальной алхимик',
      image: { original: '/o.jpg', preview: '/p.jpg', x96: '/x96.jpg', x48: '/x48.jpg' },
      url: '/animes/1',
      kind: 'tv',
      score: '9',
      status: 'ongoing',
      episodes: 12,
      episodes_aired: 3
    }
  }
}

function activityRow(): unknown {
  return {
    friendId: 1,
    friendNickname: 'alice',
    friendAvatar: '',
    malId: MAL,
    animeName: 'FMA',
    animeImage: 'i.jpg',
    description: 'Watched episode 5',
    createdAt: '2026-10-27T10:00:00Z'
  }
}

interface Harness {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  store: InMemoryStorage
  offline: OfflineService
  lookupByMalIds: Mock
}

function harness(): Harness {
  const store = new InMemoryStorage({
    shikimoriCredentials: { access_token: 'a', refresh_token: 'r' },
    shikimoriUser: { id: 7, nickname: 'me' },
    shikimoriUserRates: [cachedRate(MAL)],
    shikimoriUpdateQueue: [],
    shikimoriParkedQueues: {},
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [],
    shikimoriSessionExpired: false
  })
  const broadcast = vi.fn()
  const offline = createOfflineService({
    store,
    probeUrls: () => [],
    onOnline: vi.fn(),
    onOffline: vi.fn()
  })
  const sync = createShikimoriSyncService({
    store,
    broadcast,
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    isOffline: offline.isOffline
  })
  const lookupByMalIds = vi.fn(async () => ({}))
  register({
    store,
    shikimoriSyncService: sync,
    lookupByMalIds,
    maybeBroadcastCleanupPrompt: vi.fn(async () => undefined),
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast,
    offlineService: offline
  } as unknown as AppDeps)

  // What `fetchWithTimeout` does under each of them.
  const net =
    <T>(value: () => T) =>
    async (): Promise<T> => {
      if (offline.isOffline()) throw new OfflineError()
      return value()
    }
  ensureFreshToken.mockImplementation(net(() => 'access-token'))
  getCalendar.mockImplementation(net(() => [calendarRow(MAL)]))
  getFriendsActivity.mockImplementation(net(() => [activityRow()]))
  getUserRate.mockImplementation(net(() => null))
  getUserAnimeRates.mockImplementation(net(() => []))

  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel, ...args) => handlers.get(channel)!({}, ...args),
    store,
    offline,
    lookupByMalIds
  }
}

type Snapshot = { data: { name?: string; friendNickname?: string }[]; fetchedAt: number | null }

let fetchSpy: Mock
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  realFetch = globalThis.fetch
  fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const calendar = (h: Harness, force = false): Promise<unknown> =>
  h.invoke(CHANNELS.SHIKIMORI_GET_CALENDAR, force)
const activity = (h: Harness): Promise<unknown> => h.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS_ACTIVITY)

describe('calendar offline (#568)', () => {
  it('returns a 2-hour-old snapshot with stale: true and does not refetch', async () => {
    const h = harness()
    await calendar(h)
    vi.setSystemTime(T0 + 2 * HOUR)
    h.offline.setManual(true)
    getCalendar.mockClear()

    const res = await calendar(h)

    expect(res).toEqual({
      data: [expect.objectContaining({ malId: MAL, name: 'Стальной алхимик' })],
      fetchedAt: T0,
      stale: true
    })
    expect(getCalendar).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an offline rate edit does not empty the calendar', async () => {
    const h = harness()
    await calendar(h)
    h.offline.setManual(true)

    await h.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, MAL, 4, 'watching', 7, 0)
    expect((h.store.get('shikimoriUpdateQueue') as unknown[]).length).toBe(1)

    const res = (await calendar(h)) as Snapshot & { stale: boolean }
    expect(res.data.map((e) => e.name)).toEqual(['Стальной алхимик'])
    expect(res).toMatchObject({ fetchedAt: T0, stale: true })
  })

  it('serves the snapshot even when forced', async () => {
    const h = harness()
    await calendar(h)
    h.offline.setManual(true)
    expect(await calendar(h, true)).toMatchObject({ fetchedAt: T0, stale: true })
  })

  it('with no snapshot returns the empty stale shape and touches no network', async () => {
    const h = harness()
    h.offline.setManual(true)
    expect(await calendar(h)).toEqual({ data: [], fetchedAt: null, stale: true })
    expect(getCalendar).not.toHaveBeenCalled()
    expect(ensureFreshToken).not.toHaveBeenCalled()
    expect(h.lookupByMalIds).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('calendar online (#568) — today, plus the failed-fetch fallback', () => {
  it('a fresh snapshot within the TTL is served without a fetch, stale: false', async () => {
    const h = harness()
    await calendar(h)
    vi.setSystemTime(T0 + 60_000)
    const res = await calendar(h)
    expect(res).toMatchObject({ fetchedAt: T0, stale: false })
    expect(getCalendar).toHaveBeenCalledTimes(1)
  })

  it('an invalidated snapshot is a miss online and refetches', async () => {
    const h = harness()
    await calendar(h)
    updateUserRate.mockResolvedValue({
      id: 900 + MAL,
      target_id: MAL,
      episodes: 4,
      status: 'watching',
      score: 7
    })
    getUserRate.mockImplementation(async () => ({
      id: 900 + MAL,
      target_id: MAL,
      episodes: 3,
      status: 'watching',
      score: 7
    }))
    await h.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, MAL, 4, 'watching', 7, 0)
    vi.setSystemTime(T0 + 60_000)

    const res = await calendar(h)
    expect(getCalendar).toHaveBeenCalledTimes(2)
    expect(res).toMatchObject({ fetchedAt: T0 + 60_000, stale: false })
  })

  it('a failed fetch falls back to the snapshot with stale: true', async () => {
    const h = harness()
    await calendar(h)
    vi.setSystemTime(T0 + 10 * 60_000)
    getCalendar.mockRejectedValue(new ShikiApiError('Shikimori API error: 500', 500))
    expect(await calendar(h)).toMatchObject({ fetchedAt: T0, stale: true })
  })

  it('a failed fetch with no snapshot still throws', async () => {
    const h = harness()
    getCalendar.mockRejectedValue(new ShikiApiError('Shikimori API error: 500', 500))
    await expect(calendar(h)).rejects.toThrow(/500/)
  })
})

describe('friends activity offline (#568)', () => {
  it('returns the snapshot without ensureFreshToken, lookupByMalIds or fetch', async () => {
    const h = harness()
    await activity(h)
    vi.setSystemTime(T0 + 3 * HOUR)
    h.offline.setManual(true)
    vi.clearAllMocks()

    const res = await activity(h)

    expect(res).toEqual({
      data: [expect.objectContaining({ friendNickname: 'alice', smotretAnime: null })],
      fetchedAt: T0,
      stale: true
    })
    expect(ensureFreshToken).not.toHaveBeenCalled()
    expect(getFriendsActivity).not.toHaveBeenCalled()
    expect(h.lookupByMalIds).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with no snapshot returns the empty stale shape and calls none of them', async () => {
    const h = harness()
    h.offline.setManual(true)

    expect(await activity(h)).toEqual({ data: [], fetchedAt: null, stale: true })
    expect(ensureFreshToken).not.toHaveBeenCalled()
    expect(getFriendsActivity).not.toHaveBeenCalled()
    expect(h.lookupByMalIds).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('friends activity online (#568)', () => {
  it('fetches every time and returns stale: false', async () => {
    const h = harness()
    expect(await activity(h)).toMatchObject({ fetchedAt: T0, stale: false })
    vi.setSystemTime(T0 + 1000)
    expect(await activity(h)).toMatchObject({ fetchedAt: T0 + 1000, stale: false })
    expect(getFriendsActivity).toHaveBeenCalledTimes(2)
  })

  it('a failed fetch falls back to the snapshot with stale: true', async () => {
    const h = harness()
    await activity(h)
    getFriendsActivity.mockRejectedValue(new ShikiApiError('Shikimori API error: 500', 500))
    expect(await activity(h)).toMatchObject({ fetchedAt: T0, stale: true })
  })

  it('a failed fetch with no snapshot still throws', async () => {
    const h = harness()
    getFriendsActivity.mockRejectedValue(new ShikiApiError('Shikimori API error: 500', 500))
    await expect(activity(h)).rejects.toThrow(/500/)
  })
})

describe('snapshots are per user (#568)', () => {
  it('a snapshot fetched for user 7 is not served to user 8', async () => {
    const h = harness()
    await calendar(h)
    await activity(h)
    h.store.set('shikimoriUser', { id: 8, nickname: 'other' })
    h.offline.setManual(true)

    expect(await calendar(h)).toEqual({ data: [], fetchedAt: null, stale: true })
    expect(await activity(h)).toEqual({ data: [], fetchedAt: null, stale: true })

    // Still user 7's: back on 7 they are served again.
    h.store.set('shikimoriUser', { id: 7, nickname: 'me' })
    expect(await calendar(h)).toMatchObject({ fetchedAt: T0, stale: true })
    expect(await activity(h)).toMatchObject({ fetchedAt: T0, stale: true })
  })

  it("fetches that finish after a switch don't evict the new user's snapshots", async () => {
    const h = harness()
    h.store.set('shikimoriUser', { id: 8, nickname: 'other' })
    await calendar(h)
    await activity(h)

    // User 7 starts both fetches; the account switches to 8 before they land.
    h.store.set('shikimoriUser', { id: 7, nickname: 'me' })
    let releaseCalendar!: () => void
    let releaseActivity!: () => void
    getCalendar.mockImplementationOnce(
      () => new Promise((r) => (releaseCalendar = () => r([calendarRow(MAL)])))
    )
    getFriendsActivity.mockImplementationOnce(
      () => new Promise((r) => (releaseActivity = () => r([activityRow()])))
    )
    vi.setSystemTime(T0 + HOUR)
    const pendingCalendar = calendar(h, true)
    const pendingActivity = activity(h)
    await vi.waitFor(() => expect(getFriendsActivity).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getCalendar).toHaveBeenCalledTimes(2))
    h.store.set('shikimoriUser', { id: 8, nickname: 'other' })
    releaseCalendar()
    releaseActivity()
    // The caller still gets its result.
    const later = expect.toSatisfy((t: number) => t >= T0 + HOUR)
    expect(await pendingCalendar).toMatchObject({ fetchedAt: later, stale: false })
    expect(await pendingActivity).toMatchObject({ fetchedAt: later, stale: false })

    h.offline.setManual(true)
    expect(await calendar(h)).toMatchObject({ fetchedAt: T0, stale: true })
    expect(await activity(h)).toMatchObject({ fetchedAt: T0, stale: true })
  })

  it('logout clears both snapshots', async () => {
    const h = harness()
    await calendar(h)
    await activity(h)

    await h.invoke(CHANNELS.SHIKIMORI_LOGOUT)
    // Same user again, so a surviving snapshot would be served.
    h.store.set('shikimoriUser', { id: 7, nickname: 'me' })
    h.offline.setManual(true)

    expect(await calendar(h)).toEqual({ data: [], fetchedAt: null, stale: true })
    expect(await activity(h)).toEqual({ data: [], fetchedAt: null, stale: true })
  })

  it('an account switch clears both snapshots', async () => {
    const h = harness()
    await calendar(h)
    await activity(h)
    exchangeCode.mockResolvedValue({ access_token: 'b', refresh_token: 'rb' })
    getUser.mockResolvedValue({ id: 8, nickname: 'other' })

    await h.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')
    h.store.set('shikimoriUser', { id: 7, nickname: 'me' })
    h.offline.setManual(true)

    expect(await calendar(h)).toEqual({ data: [], fetchedAt: null, stale: true })
    expect(await activity(h)).toEqual({ data: [], fetchedAt: null, stale: true })
  })
})
