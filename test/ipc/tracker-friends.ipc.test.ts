// The Friends channels (#712): `tracker:get-friends*` and their delegating
// `shikimori:get-friends*` aliases, over the real routers and the real friends
// service. AniList runs end to end: the real provider, client and limiter
// against the fixture server (`test/helpers/anilist-server.ts`), its snapshot
// in the calendar's `anilist-snapshots.json`. Shikimori's three reads are the
// mocked `shikimori.ts` functions, so the aliases' payloads can be pinned.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'

const shiki = {
  ensureFreshToken: vi.fn(),
  getFriendsWithStats: vi.fn(),
  getFriendsActivity: vi.fn(),
  getFriendsRatesForAnime: vi.fn()
}

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...a: unknown[]) => shiki.ensureFreshToken(...a),
    getFriendsWithStats: (...a: unknown[]) => shiki.getFriendsWithStats(...a),
    getFriendsActivity: (...a: unknown[]) => shiki.getFriendsActivity(...a),
    getFriendsRatesForAnime: (...a: unknown[]) => shiki.getFriendsRatesForAnime(...a)
  }
})

import {
  ALICE,
  anilistFixture,
  createAniListServer,
  createTestAniList,
  type AniListReply,
  type AniListServer
} from '../helpers/anilist-server'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { shikimoriOnlyTrackers } from '../helpers/tracker-fan-out'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createTrackerFriends } from '../../src/main/services/trackers/friends'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createShikimoriProvider } from '../../src/main/trackers/shikimori.provider'
import { anilistSessionSteps } from '../../src/main/trackers/anilist/sync'
import { createAniListCalendar } from '../../src/main/trackers/anilist/calendar'
import { createAniListLimiter } from '../../src/main/trackers/anilist/limiter'
import { deadTokenError } from '../../src/main/trackers/anilist/client'
import type { AniListUser } from '../../src/main/trackers/anilist/provider'

const SHIKI_USER = { id: 7, nickname: 'me', avatar: '' }
const SHIKI_SEED = {
  shikimoriCredentials: { access_token: 'a', refresh_token: 'r' },
  shikimoriUser: SHIKI_USER,
  shikimoriUserRates: [{ rate: { target_id: 5114 } }]
}
const BOB: AniListUser = { ...ALICE, id: 6002, nickname: 'bob' }

// Shikimori's mocked reads, in the 6.x shapes.
const SHIKI_CARD = {
  id: 1,
  nickname: 'alice',
  avatar: '/a.png',
  lastOnlineAt: '2026-11-27T11:58:00.000Z',
  online: true,
  titles: 50,
  mean: 8.1,
  mutual: 3,
  watching: {
    malId: 5114,
    animeId: null,
    title: 'FMA',
    image: 'https://shikimori.io/p.jpg',
    episode: 4,
    total: 64,
    status: 'watching'
  }
}
const SHIKI_ACTIVITY = {
  friendId: 1,
  friendNickname: 'alice',
  friendAvatar: '/a.png',
  malId: 5114,
  animeName: 'Стальной алхимик',
  animeImage: 'https://shikimori.io/x.jpg',
  description: 'Просмотрен <b>5</b> эпизод',
  createdAt: '2026-11-27T10:00:00.000+03:00'
}
const SHIKI_RATE = {
  nickname: 'alice',
  avatar: '/a.png',
  status: 'completed',
  score: 9,
  episodes: 64
}
const SMOTRET = { id: 777, title: 'FMA', posterUrlSmall: 'p.jpg' }

const T0 = new Date('2026-11-27T12:00:00Z').getTime()

let dirs: string[] = []
let server: AniListServer | null = null

interface Rig {
  store: Awaited<ReturnType<typeof createTestAniList>>['store']
  dir: string
  anilistFile: string
  shikimoriFile: string
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  broadcast: Mock
  lookupByMalIds: Mock
  limiterClasses: () => string[]
  calendar: ReturnType<typeof createAniListCalendar>
  lifecycle: ReturnType<typeof createTrackerLifecycle>
}

async function rig(
  opts: {
    shikimori?: boolean
    anilist?: AniListUser | null
    seed?: Record<string, unknown>
    route?: (
      call: Parameters<Parameters<typeof createAniListServer>[0]>[0]
    ) => AniListReply | Promise<AniListReply>
  } = {}
): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-friends-'))
  dirs.push(dir)
  const anilistFile = path.join(dir, 'anilist-snapshots.json')
  const shikimoriFile = path.join(dir, 'shikimori-snapshots.json')
  server = createAniListServer(
    opts.route ??
      (() => ({ status: 400, body: { errors: [{ message: 'unrouted', status: 400 }] } }))
  )
  const user = opts.anilist === undefined ? null : opts.anilist
  // On a monotonic clock: the tests fake `Date`. Every request's class is recorded.
  const limiter = createAniListLimiter({ deadTokenError, now: () => performance.now() })
  const classes: string[] = []
  const schedule = limiter.schedule.bind(limiter)
  limiter.schedule = ((o, send) => {
    classes.push(o.priority)
    return schedule(o, send)
  }) as typeof limiter.schedule
  const t = await createTestAniList({
    user,
    token: user ? 'tok-alice' : null,
    seed: { ...(opts.shikimori === false ? {} : SHIKI_SEED), ...opts.seed },
    provider: { limiter }
  })
  const { store, provider } = t
  const lookupByMalIds = vi.fn(
    async (ids: number[]): Promise<Record<number, AnimeSearchResult>> =>
      Object.fromEntries(
        ids.filter((id) => id === 5114).map((id) => [id, SMOTRET as unknown as AnimeSearchResult])
      )
  )
  const calendar = createAniListCalendar({
    store: store as never,
    getCalendar: (o) => provider.getCalendar(o),
    fetchRates: async () => {},
    lookupByMalIds,
    isOffline: () => false,
    snapshotsPath: anilistFile
  })
  const shikiSync = createShikimoriSyncService({
    store: store as never,
    broadcast: () => {},
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    isOffline: () => false,
    snapshotsPath: shikimoriFile
  })
  const broadcast = vi.fn()
  const trackerFriends = createTrackerFriends({
    store: store as never,
    shikimori: { provider: createShikimoriProvider({ store: store as never }), sync: shikiSync },
    anilist: { provider, snapshots: calendar.snapshots },
    lookupByMalIds,
    isOffline: () => false,
    broadcast,
    channels: {
      shikimoriFriendsRefreshed: EVENT_CHANNELS.SHIKIMORI_FRIENDS_REFRESHED,
      friendsRefreshed: EVENT_CHANNELS.TRACKER_FRIENDS_REFRESHED
    },
    log: { warn: () => {} }
  })
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [{ sync: shikiSync.tracker as TrackerSyncService<unknown, unknown> }],
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({ store: store as never, trackers: fan })
  const lifecycle = createTrackerLifecycle({ store: store as never, vault: t.vault, trackerRates })
  const noop = (): void => {}
  lifecycle.setSteps(
    'anilist',
    anilistSessionSteps({
      provider,
      sync: {
        startSyncTimer: noop,
        syncQueue: async () => {},
        stopSyncTimer: noop,
        broadcastSyncStatus: noop,
        broadcastQueueChanged: noop
      } as never,
      calendar
    })
  )
  ;(ipcMain.handle as unknown as Mock).mockClear()
  registerTrackers({
    store,
    trackerRates,
    trackerLifecycle: lifecycle,
    trackerAuth: {},
    trackerChoices: {},
    newTrackerCardsEnabled: true,
    shikimoriSyncService: shikiSync,
    lookupByMalIds,
    offlineService: { isOffline: () => false },
    anilistCalendar: calendar,
    trackerFriends
  } as unknown as AppDeps)
  registerShikimori({
    store,
    shikimoriSyncService: shikiSync,
    ...shikimoriOnlyTrackers(store as never, shikiSync),
    lookupByMalIds,
    maybeBroadcastCleanupPrompt: async () => {},
    runAutoDownloadTick: async () => ({}),
    broadcast,
    offlineService: { isOffline: () => false },
    trackerFriends
  } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  return {
    store,
    dir,
    anilistFile,
    shikimoriFile,
    invoke: async (channel, ...args) => handlers.get(channel)!({}, ...args),
    broadcast,
    lookupByMalIds,
    limiterClasses: () => classes,
    calendar,
    lifecycle
  }
}

/** Routes the three friends operations to their fixtures (and the id map to MAL 1 → 101). */
function friendsRoute(call: {
  operation: string
  variables: Record<string, unknown>
}): AniListReply {
  switch (call.operation) {
    case 'IdMap':
      return { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
    case 'Following':
      return { body: anilistFixture(call.variables.page === 1 ? 'following-1' : 'following-2') }
    case 'FriendsActivity':
      return { body: anilistFixture('activities') }
    case 'FriendsRates':
      return { body: anilistFixture('friends-rates') }
    default:
      return {
        status: 400,
        body: { errors: [{ message: `unrouted ${call.operation}`, status: 400 }] }
      }
  }
}

const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))
const broadcastsOn = (r: Rig, channel: string): unknown[] =>
  r.broadcast.mock.calls.filter(([c]) => c === channel).map(([, payload]) => payload)

beforeEach(() => {
  for (const fn of Object.values(shiki)) fn.mockReset()
  shiki.ensureFreshToken.mockResolvedValue('shiki-token')
  shiki.getFriendsWithStats.mockImplementation(async () => [structuredClone(SHIKI_CARD)])
  shiki.getFriendsActivity.mockImplementation(async () => [structuredClone(SHIKI_ACTIVITY)])
  shiki.getFriendsRatesForAnime.mockImplementation(async () => [structuredClone(SHIKI_RATE)])
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  server?.restore()
  server = null
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('the shikimori:get-friends* aliases keep their 6.x payloads', () => {
  it('shikimori:get-friends: the cold fetch’s cards, byte for byte, and `null` signed out', async () => {
    const r = await rig()
    const cards = await r.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS)
    expect(JSON.stringify(cards)).toBe(
      JSON.stringify([{ ...SHIKI_CARD, watching: { ...SHIKI_CARD.watching, animeId: 777 } }])
    )
    expect(shiki.getFriendsWithStats).toHaveBeenCalledWith('shiki-token', 7, new Set([5114]))
    expect(JSON.stringify(r.store.get('shikimoriFriends'))).toBe(JSON.stringify(cards))

    const signedOut = await rig({ shikimori: false })
    expect(await signedOut.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS)).toBeNull()
  })

  it('a cached read refreshes in the background: Shikimori’s cards alone on the old channel, and `{ trackerId, cards }` on the new one', async () => {
    const r = await rig({ seed: { shikimoriFriends: [{ ...SHIKI_CARD, nickname: 'old' }] } })
    expect(await r.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS)).toEqual([
      { ...SHIKI_CARD, nickname: 'old' }
    ])
    await vi.waitFor(() =>
      expect(broadcastsOn(r, EVENT_CHANNELS.SHIKIMORI_FRIENDS_REFRESHED)).toHaveLength(1)
    )
    const fresh = { ...SHIKI_CARD, watching: { ...SHIKI_CARD.watching, animeId: 777 } }
    expect(JSON.stringify(broadcastsOn(r, EVENT_CHANNELS.SHIKIMORI_FRIENDS_REFRESHED)[0])).toBe(
      JSON.stringify([fresh])
    )
    expect(broadcastsOn(r, EVENT_CHANNELS.TRACKER_FRIENDS_REFRESHED)).toEqual([
      { trackerId: 'shikimori', cards: [{ source: 'shikimori', presence: true, ...fresh }] }
    ])
  })

  it('shikimori:get-friends-activity and shikimori:get-friends-rates: byte for byte', async () => {
    const r = await rig()
    const activity = await r.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS_ACTIVITY)
    expect(JSON.stringify(activity)).toBe(
      JSON.stringify({
        data: [{ ...SHIKI_ACTIVITY, smotretAnime: SMOTRET }],
        fetchedAt: T0,
        stale: false
      })
    )
    expect(JSON.stringify(await r.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS_RATES, 5114))).toBe(
      JSON.stringify([SHIKI_RATE])
    )
    expect(shiki.getFriendsRatesForAnime).toHaveBeenCalledWith('shiki-token', 7, 5114)
  })

  it('shikimori:get-friends-rates still throws signed out, and the activity alias with no snapshot', async () => {
    const r = await rig({ shikimori: false })
    await expect(r.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS_RATES, 1)).rejects.toThrow(
      'Not logged in to Shikimori'
    )
    await expect(r.invoke(CHANNELS.SHIKIMORI_GET_FRIENDS_ACTIVITY)).rejects.toThrow(
      'Not logged in to Shikimori'
    )
  })
})

describe('the snapshot files', () => {
  it('a Shikimori-only session never creates anilist-snapshots.json; shikimori-snapshots.json keeps its shape', async () => {
    const r = await rig()
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS)
    const merged = (await r.invoke(
      CHANNELS.TRACKER_GET_FRIENDS_ACTIVITY
    )) as TrackerFriendsActivityResult
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS_RATES, 5114)
    expect(merged.data.map((e) => e.source)).toEqual(['shikimori'])
    expect(fs.existsSync(r.anilistFile)).toBe(false)
    // What the 6.x alias writes: no `source`, no URLs.
    expect(fs.readFileSync(r.shikimoriFile, 'utf8')).toBe(
      JSON.stringify({
        version: 1,
        userId: 7,
        friendsActivity: { data: [{ ...SHIKI_ACTIVITY, smotretAnime: SMOTRET }], fetchedAt: T0 }
      })
    )
  })

  it('connecting AniList and fetching its activity creates the file, with a friendsActivity section', async () => {
    const r = await rig({ anilist: ALICE, route: friendsRoute })
    expect(fs.existsSync(r.anilistFile)).toBe(false)
    const res = (await r.invoke(
      CHANNELS.TRACKER_GET_FRIENDS_ACTIVITY
    )) as TrackerFriendsActivityResult
    // Newest first: Shikimori's item is from 2026, AniList's from 2025.
    expect(res.data.map((e) => [e.source, e.description])).toEqual([
      ['shikimori', 'Просмотрен <b>5</b> эпизод'],
      ['anilist', 'watched episode 5'],
      ['anilist', 'watched episode 1 - 3']
    ])
    const file = read(r.anilistFile) as {
      version: number
      userId: number
      friendsActivity: { data: TrackerFriendActivityEntry[]; fetchedAt: number }
    }
    expect(file).toMatchObject({ version: 1, userId: ALICE.id })
    expect(file.friendsActivity.fetchedAt).toBe(T0)
    expect(file.friendsActivity.data.map((e) => e.friendNickname)).toEqual(['bob', 'dave'])
  })
})

describe('tracker:get-friends', () => {
  it('is cache-first on anilistFriends, with a background refresh on tracker:friends-refreshed', async () => {
    const cached = [{ id: 6001, nickname: 'bob-old', avatar: '', titles: 1, mean: 5 }]
    const r = await rig({
      shikimori: false,
      anilist: ALICE,
      route: friendsRoute,
      seed: { anilistFriends: cached }
    })
    const res = (await r.invoke(CHANNELS.TRACKER_GET_FRIENDS)) as TrackerFriendsResult
    expect(res.cards.map((c) => [c.source, c.nickname])).toEqual([['anilist', 'bob-old']])
    expect(res.sources).toEqual({ anilist: { status: 'ok' } })
    await vi.waitFor(() =>
      expect(broadcastsOn(r, EVENT_CHANNELS.TRACKER_FRIENDS_REFRESHED)).toHaveLength(1)
    )
    const [event] = broadcastsOn(
      r,
      EVENT_CHANNELS.TRACKER_FRIENDS_REFRESHED
    ) as TrackerFriendsRefreshedEvent[]
    expect(event.trackerId).toBe('anilist')
    expect(event.cards.map((c) => [c.nickname, c.mean, c.presence, c.mutual])).toEqual([
      ['bob', 7.84, false, null],
      ['carol', 0, false, null],
      ['dave', 8.5, false, null]
    ])
    expect(
      (r.store.get('anilistFriends') as { nickname: string }[]).map((f) => f.nickname)
    ).toEqual(['bob', 'carol', 'dave'])
    expect(broadcastsOn(r, EVENT_CHANNELS.SHIKIMORI_FRIENDS_REFRESHED)).toEqual([])
  })

  it('every AniList friends request runs at the interactive class', async () => {
    const r = await rig({ anilist: ALICE, route: friendsRoute })
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS)
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS_ACTIVITY)
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS_RATES, 1)
    expect(server!.calls.map((c) => c.operation)).toEqual([
      'Following',
      'Following',
      'FriendsActivity',
      'IdMap',
      'FriendsRates'
    ])
    expect(r.limiterClasses()).toEqual(Array(5).fill('interactive'))
  })

  it('friends’ rates for a title AniList doesn’t have make no AniList request', async () => {
    const r = await rig({
      anilist: ALICE,
      route: friendsRoute,
      seed: { anilistIdMap: { '42': { anilistId: null, at: T0 } } }
    })
    const res = (await r.invoke(CHANNELS.TRACKER_GET_FRIENDS_RATES, 42)) as TrackerFriendRates[]
    expect(res.map((s) => [s.source, s.status, s.rates.length])).toEqual([
      ['shikimori', 'ok', 1],
      ['anilist', 'ok', 0]
    ])
    expect(server!.calls).toEqual([])
  })

  it('an AniList account switch mid-fetch: the old user’s cards are neither stored nor broadcast', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const r = await rig({
      shikimori: false,
      anilist: ALICE,
      seed: { anilistFriends: [{ id: 1, nickname: 'alices-old', avatar: '', titles: 0, mean: 0 }] },
      route: async (call) => {
        if (call.operation === 'Following') await held
        return friendsRoute(call)
      }
    })
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS)
    await vi.waitFor(() => expect(server!.of('Following')).toHaveLength(1))
    // The switch's reset, then Bob.
    r.store.set('anilistFriends', [])
    r.store.set('anilistUser', BOB)
    release()
    await vi.waitFor(() => expect(server!.of('Following').length).toBeGreaterThanOrEqual(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.store.get('anilistFriends')).toEqual([])
    expect(broadcastsOn(r, EVENT_CHANNELS.TRACKER_FRIENDS_REFRESHED)).toEqual([])
  })
})

describe('AniList logout', () => {
  it('clears anilistFriends and the whole anilist-snapshots.json, keeps anilistIdMap and Shikimori’s', async () => {
    const r = await rig({ anilist: ALICE, route: friendsRoute })
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS)
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS_ACTIVITY)
    await r.invoke(CHANNELS.TRACKER_GET_FRIENDS_RATES, 1)
    r.calendar.snapshots.put('calendar', {
      data: [],
      fetchedAt: T0,
      userId: ALICE.id,
      invalidated: false
    })
    await vi.waitFor(() =>
      expect((r.store.get('anilistFriends') as unknown[]).length).toBeGreaterThan(0)
    )
    expect(Object.keys(read(r.anilistFile) as object).sort()).toEqual([
      'calendar',
      'friendsActivity',
      'userId',
      'version'
    ])
    const idMap = r.store.get('anilistIdMap')
    expect(idMap).toMatchObject({ '1': { anilistId: 101 } })
    const shikimoriFriends = JSON.stringify(r.store.get('shikimoriFriends'))
    const shikimoriSnapshots = fs.readFileSync(r.shikimoriFile, 'utf8')

    r.lifecycle.logout('anilist')

    expect(r.store.get('anilistFriends')).toEqual([])
    expect(fs.existsSync(r.anilistFile)).toBe(false)
    expect(r.calendar.snapshots.get('friendsActivity')).toBeNull()
    expect(r.store.get('anilistIdMap')).toEqual(idMap)
    expect(JSON.stringify(r.store.get('shikimoriFriends'))).toBe(shikimoriFriends)
    expect(fs.readFileSync(r.shikimoriFile, 'utf8')).toBe(shikimoriSnapshots)
  })
})
