// `tracker:get-calendar` (#709): the resolved `calendar` source's calendar.
// AniList runs end to end: the real provider, client and limiter against the
// fake AniList world (`test/helpers/anilist-server.ts`), the real AniList sync
// instance with `anilistCalendarSyncHooks`, its queue-first primary and the
// fan-out. Shikimori's branch is `shikimori:get-calendar`'s body, over the
// mocked `/api/calendar`. The pure mapping is `test/trackers/anilist-calendar.test.ts`'s.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'

const getShikiCalendar = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return { ...actual, getCalendar: (...a: unknown[]) => getShikiCalendar(...a) }
})

import {
  ALICE,
  createAniListWorld,
  createTestAniList,
  type AniListWorld,
  type WorldAiring,
  type WorldEntry
} from '../helpers/anilist-server'
import { shikimoriOnlyTrackers } from '../helpers/tracker-fan-out'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { ShikiApiError } from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { createAniListPrimary } from '../../src/main/services/trackers/anilist-primary'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createAniListLimiter } from '../../src/main/trackers/anilist/limiter'
import { deadTokenError } from '../../src/main/trackers/anilist/client'
import {
  anilistSessionSteps,
  createAniListSyncService,
  type AniListSyncService
} from '../../src/main/trackers/anilist/sync'
import {
  anilistCalendarSyncHooks,
  createAniListCalendar,
  type AniListCalendar
} from '../../src/main/trackers/anilist/calendar'
import type { AniListUser } from '../../src/main/trackers/anilist/provider'

const T0 = new Date('2026-11-27T12:00:00Z').getTime()
const MIN = 60_000
const AIR_AT = 1_764_500_000

const SHIKI_MAL = 5114
const SHIKI_SEED = {
  shikimoriCredentials: { access_token: 'a', refresh_token: 'r' },
  shikimoriUser: { id: 7, nickname: 'me' },
  shikimoriUserRates: [
    {
      rate: { id: 900, target_id: SHIKI_MAL, episodes: 3, status: 'watching', score: 7 },
      shikiAnime: { id: SHIKI_MAL },
      smotretAnime: null
    }
  ]
}

function shikiCalendarRow(malId: number): unknown {
  return {
    next_episode: 4,
    next_episode_at: '2026-11-30T15:00:00+03:00',
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

/** An AniList list entry: media id `mediaId`, MAL id `mediaId + 10000` unless given. */
function entry(mediaId: number, status = 'CURRENT', idMal: number | null = mediaId + 10_000) {
  return {
    id: 50_000 + mediaId,
    mediaId,
    idMal,
    status,
    score: 0,
    progress: 1,
    repeat: 0,
    updatedAt: 1
  } satisfies WorldEntry
}

const airs = (episode: number, extra: Partial<WorldAiring> = {}): WorldAiring => ({
  nextAiringEpisode: { episode, airingAt: AIR_AT + episode },
  ...extra
})

const BOB: AniListUser = { ...ALICE, id: 6002, nickname: 'bob' }

interface Rig {
  world: AniListWorld
  store: Awaited<ReturnType<typeof createTestAniList>>['store']
  sync: AniListSyncService
  calendar: AniListCalendar
  offline: { value: boolean }
  file: string
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  get: (force?: boolean) => Promise<TrackerCalendarResult>
  calendarRequests: () => number
  lifecycle: ReturnType<typeof createTrackerLifecycle>
}

let dirs: string[] = []

async function rig(
  opts: {
    entries?: WorldEntry[]
    airing?: Record<number, WorldAiring>
    user?: AniListUser | null
    token?: string | null
    shikimori?: boolean
    seed?: Record<string, unknown>
    /** Leave `anilistUserRates` empty instead of reading the list. */
    coldCache?: boolean
    dir?: string
  } = {}
): Promise<Rig> {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-calendar-'))
  if (!opts.dir) dirs.push(dir)
  const file = path.join(dir, 'anilist-snapshots.json')
  const world = createAniListWorld({ entries: opts.entries ?? [], airing: opts.airing ?? {} })
  const offline = { value: false }
  const lookupByMalIds = vi.fn(async () => ({}))
  const t = await createTestAniList({
    user: opts.user,
    token: opts.token,
    seed: { ...(opts.shikimori ? SHIKI_SEED : {}), ...opts.seed },
    provider: {
      // On a monotonic clock: the tests move `Date` across the 5-minute TTL.
      limiter: createAniListLimiter({ deadTokenError, now: () => performance.now() }),
      lookupByMalIds,
      isOffline: () => offline.value
    }
  })
  const { store, provider } = t
  // `sync` is read only at call time, as `index.ts` builds the pair.
  const calendar: AniListCalendar = createAniListCalendar({
    store: store as never,
    getCalendar: (o) => provider.getCalendar(o),
    fetchRates: () => sync.fetchAndCacheRates(),
    lookupByMalIds,
    isOffline: () => offline.value,
    snapshotsPath: file
  })
  const sync: AniListSyncService = createAniListSyncService(provider, {
    store: store as never,
    broadcast: () => {},
    syncStatusChannel: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
    ratesRefreshedChannel: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
    isOffline: () => offline.value,
    ...anilistCalendarSyncHooks(calendar)
  })
  // The in-app edit's own cache patch is what this file pins: its drain (and
  // so the drain's reconcile, which has its own row) doesn't run from here.
  const primary = createAniListPrimary({
    store: store as never,
    sync: {
      ...(sync as unknown as TrackerSyncService<unknown, unknown>),
      startSyncTimer: () => {},
      syncQueue: async () => {}
    } as unknown as TrackerSyncService<unknown, unknown>,
    maybeBroadcastCleanupPrompt: async () => {}
  })
  const shiki = createShikimoriSyncService({
    store: store as never,
    broadcast: () => {},
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    isOffline: () => offline.value,
    snapshotsPath: path.join(dir, 'shikimori-snapshots.json')
  })
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [
      { sync: shiki.tracker as TrackerSyncService<unknown, unknown> },
      {
        sync: sync as unknown as TrackerSyncService<unknown, unknown>,
        writePrimary: (malId, change) => primary.write(malId, change)
      }
    ],
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({
    store: store as never,
    trackers: fan,
    isOffline: () => offline.value
  })
  const lifecycle = createTrackerLifecycle({ store: store as never, vault: t.vault, trackerRates })
  lifecycle.setSteps('anilist', anilistSessionSteps({ provider, sync, calendar }))
  const offlineService = { isOffline: () => offline.value }

  ;(ipcMain.handle as unknown as Mock).mockClear()
  registerTrackers({
    store,
    trackerRates,
    trackerLifecycle: lifecycle,
    trackerAuth: {},
    trackerChoices: {},
    newTrackerCardsEnabled: true,
    shikimoriSyncService: shiki,
    lookupByMalIds,
    offlineService,
    anilistCalendar: calendar
  } as unknown as AppDeps)
  registerShikimori({
    store,
    shikimoriSyncService: shiki,
    ...shikimoriOnlyTrackers(store as never, shiki, offlineService.isOffline),
    lookupByMalIds,
    maybeBroadcastCleanupPrompt: async () => {},
    runAutoDownloadTick: async () => ({}),
    broadcast: () => {},
    offlineService
  } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> =>
    handlers.get(channel)!({}, ...args)

  if (opts.user !== null && opts.token !== null && !opts.coldCache) {
    await sync.fetchAndCacheRates()
  }
  return {
    world,
    store,
    sync,
    calendar,
    offline,
    file,
    invoke,
    get: (force = false) =>
      invoke(CHANNELS.TRACKER_GET_CALENDAR, force) as Promise<TrackerCalendarResult>,
    calendarRequests: () => world.server.of('Calendar').length,
    lifecycle
  }
}

beforeEach(() => {
  getShikiCalendar.mockReset()
  getShikiCalendar.mockResolvedValue([shikiCalendarRow(SHIKI_MAL)])
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

// The common AniList list: watching, planned and rewatching titles airing, a
// finished one, and a completed one.
const LIST = [
  entry(101),
  entry(102, 'PLANNING'),
  entry(103, 'REPEATING'),
  entry(104),
  entry(105, 'COMPLETED')
]
const AIRING: Record<number, WorldAiring> = {
  101: airs(5),
  102: airs(1),
  103: airs(13, { format: 'TV_SHORT' }),
  104: { nextAiringEpisode: null },
  105: airs(9)
}

describe('tracker:get-calendar with AniList the source', () => {
  it('returns AniList entries as CalendarEntry, one per title from nextAiringEpisode; a null one drops out', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    const res = await r.get()
    expect(res).toMatchObject({ trackerId: 'anilist', fetchedAt: T0, stale: false })
    expect(res.data.map((e) => e.malId).sort()).toEqual([10_101, 10_102, 10_103])
    expect(res.data.find((e) => e.malId === 10_101)).toEqual({
      malId: 10_101,
      animeId: null,
      name: '#10101',
      posterUrl: 'https://s4.anilist.co/cover/101.jpg',
      kind: 'tv',
      episodeInt: '5',
      nextEpisodeAt: new Date((AIR_AT + 5) * 1000).toISOString(),
      userStatus: 'watching'
    })
    expect(res.data.find((e) => e.malId === 10_102)!.userStatus).toBe('planned')
    expect(res.data.find((e) => e.malId === 10_103)!.userStatus).toBe('rewatching')
    // Only the tracked titles are asked for, by AniList id.
    expect(r.world.server.of('Calendar')[0].variables.ids).toEqual([101, 102, 103, 104])
  })

  it('kind is format lowercased: TV_SHORT → tv_short', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    const res = await r.get()
    expect(res.data.find((e) => e.malId === 10_103)!.kind).toBe('tv_short')
  })

  it('N tracked titles cost ceil(N / 50) requests, with no paging; a long-runner yields one entry', async () => {
    const entries = Array.from({ length: 120 }, (_, i) => entry(1000 + i))
    const airing = Object.fromEntries(entries.map((e) => [e.mediaId, airs(3)]))
    // Detective Conan's shape: no episode cap, hundreds of scheduled episodes.
    entries.push(entry(235, 'CURRENT', 235))
    airing[235] = airs(1181)
    const r = await rig({ entries, airing })
    const res = await r.get()
    const calls = r.world.server.of('Calendar')
    expect(calls).toHaveLength(Math.ceil(121 / 50))
    expect(calls.map((c) => (c.variables.ids as number[]).length)).toEqual([50, 50, 21])
    for (const c of calls) {
      expect(Object.keys(c.variables)).toEqual(['ids'])
      expect(c.query).not.toMatch(/page:|airingSchedules/)
    }
    expect(res.data).toHaveLength(121)
    expect(res.data.filter((e) => e.malId === 235)).toEqual([
      expect.objectContaining({ episodeInt: '1181' })
    ])
  })

  it('a title AniList answers with no idMal is dropped', async () => {
    const r = await rig({
      entries: [entry(101), entry(102)],
      airing: { 101: airs(5), 102: airs(2, { idMal: null }) }
    })
    const res = await r.get()
    expect(res.data.map((e) => e.malId)).toEqual([10_101])
  })

  it('displayAdultContent cached with anilistUser: false drops an adult title, true keeps it', async () => {
    const airing = { 101: airs(5), 102: airs(2, { isAdult: true }) }
    const off = await rig({ entries: [entry(101), entry(102)], airing })
    expect((await off.get()).data.map((e) => e.malId)).toEqual([10_101])
    const on = await rig({
      entries: [entry(101), entry(102)],
      airing,
      user: { ...ALICE, displayAdultContent: true }
    })
    expect((await on.get()).data.map((e) => e.malId).sort()).toEqual([10_101, 10_102])
  })

  it('the calendar query runs at interactive and carries no token', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    await r.get()
    expect(r.world.server.of('Calendar')[0].token).toBeNull()
  })
})

describe('the AniList calendar cache: TTL, offline and failed fetch (as #568)', () => {
  it('a fresh snapshot within the TTL is served without a fetch, stale: false', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    await r.get()
    vi.setSystemTime(T0 + MIN)
    expect(await r.get()).toMatchObject({ trackerId: 'anilist', fetchedAt: T0, stale: false })
    expect(r.calendarRequests()).toBe(1)
  })

  it('past the TTL it refetches; force refetches inside it', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    await r.get()
    vi.setSystemTime(T0 + MIN)
    expect(await r.get(true)).toMatchObject({ fetchedAt: T0 + MIN, stale: false })
    vi.setSystemTime(T0 + 7 * MIN)
    expect(await r.get()).toMatchObject({ fetchedAt: T0 + 7 * MIN, stale: false })
    expect(r.calendarRequests()).toBe(3)
  })

  it('offline: the snapshot whatever its age, stale, with no request; forced too', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    await r.get()
    vi.setSystemTime(T0 + 120 * MIN)
    r.offline.value = true
    const before = r.world.server.calls.length
    expect(await r.get()).toMatchObject({ trackerId: 'anilist', fetchedAt: T0, stale: true })
    expect(await r.get(true)).toMatchObject({ fetchedAt: T0, stale: true })
    expect((await r.get()).data).toHaveLength(3)
    expect(r.world.server.calls.length).toBe(before)
  })

  it('offline with no snapshot: the empty stale shape, no request', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    r.offline.value = true
    const before = r.world.server.calls.length
    expect(await r.get()).toEqual({ trackerId: 'anilist', data: [], fetchedAt: null, stale: true })
    expect(r.world.server.calls.length).toBe(before)
  })

  it('a failed fetch falls back to the snapshot with stale: true; with none it throws', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    r.world.inject('Calendar', { status: 500, body: { errors: [{ message: 'x', status: 500 }] } })
    await expect(r.get()).rejects.toThrow(/500/)
    await r.get()
    vi.setSystemTime(T0 + 10 * MIN)
    r.world.inject('Calendar', { status: 500, body: { errors: [{ message: 'x', status: 500 }] } })
    expect(await r.get()).toMatchObject({ fetchedAt: T0, stale: true })
  })
})

describe('the AniList calendar is invalidated at every site that changes the tracked set', () => {
  // Each row: a cached calendar, one change, then a read inside the TTL that
  // must refetch. Mutation controls are in the PR body.
  async function cached(): Promise<Rig> {
    const r = await rig({
      entries: LIST,
      airing: AIRING,
      seed: { trackerPrimary: 'anilist' }
    })
    await r.get()
    vi.setSystemTime(T0 + MIN)
    expect(r.calendarRequests()).toBe(1)
    return r
  }

  const plan = { episodes: 0, status: 'planned', score: 0, rewatches: 0 }

  it('an in-app AniList rate edit (its cache patch)', async () => {
    const r = await cached()
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 10_105, plan)
    const res = await r.get()
    expect(r.calendarRequests()).toBe(2)
    expect(res.data.map((e) => e.malId)).toContain(10_105)
  })

  it('an offline-queued AniList edit', async () => {
    const r = await cached()
    r.offline.value = true
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 10_105, plan)
    expect((r.store.get('anilistUpdateQueue') as unknown[]).length).toBe(1)
    r.offline.value = false
    const res = await r.get()
    expect(r.calendarRequests()).toBe(2)
    expect(res.data.map((e) => e.malId)).toContain(10_105)
  })

  it('the AniList drain’s reconcile', async () => {
    const r = await rig({ entries: LIST, airing: AIRING, seed: { trackerPrimary: 'anilist' } })
    // Queued offline (its own invalidation), then a calendar built after it.
    r.offline.value = true
    await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 10_105, plan)
    r.offline.value = false
    await r.get()
    vi.setSystemTime(T0 + MIN)
    expect(r.calendarRequests()).toBe(1)

    await r.sync.drainNow()
    expect(r.world.saves()).toHaveLength(1)
    expect(r.store.get('anilistUpdateQueue')).toEqual([])
    await r.get()
    expect(r.calendarRequests()).toBe(2)
  })

  it('an AniList rate refresh', async () => {
    const r = await cached()
    r.world.entries.get(105)!.status = 'CURRENT'
    await r.sync.refreshRates({ keepQueued: false })
    const res = await r.get()
    expect(r.calendarRequests()).toBe(2)
    expect(res.data.map((e) => e.malId)).toContain(10_105)
  })

  it('control: with no change the read inside the TTL is served from the cache', async () => {
    const r = await cached()
    await r.get()
    expect(r.calendarRequests()).toBe(1)
  })
})

describe('the AniList session and list edges', () => {
  it('session expired (anilistUser kept, anilistCredentials cleared): the calendar still loads', async () => {
    const warm = await rig({ entries: LIST, airing: AIRING })
    const rows = warm.store.get('anilistUserRates')
    const r = await rig({
      entries: LIST,
      airing: AIRING,
      token: null,
      seed: { anilistUserRates: rows }
    })
    expect(r.store.get('anilistCredentials')).toBeNull()
    const res = await r.get()
    expect(res).toMatchObject({ trackerId: 'anilist', stale: false })
    expect(res.data).toHaveLength(3)
    expect(r.world.server.of('Calendar')[0].token).toBeNull()
  })

  it('session expired with a failing fetch: the snapshot is served', async () => {
    const warm = await rig({ entries: LIST, airing: AIRING })
    const rows = warm.store.get('anilistUserRates')
    const r = await rig({
      entries: LIST,
      airing: AIRING,
      token: null,
      seed: { anilistUserRates: rows }
    })
    await r.get()
    vi.setSystemTime(T0 + 10 * MIN)
    r.world.inject('Calendar', { status: 500, body: { errors: [{ message: 'x', status: 500 }] } })
    expect(await r.get()).toMatchObject({ fetchedAt: T0, stale: true })
  })

  it('an empty anilistUserRates is filled first', async () => {
    const r = await rig({ entries: LIST, airing: AIRING, coldCache: true })
    expect(r.store.get('anilistUserRates')).toEqual([])
    const res = await r.get()
    expect(r.world.server.of('MediaListCollection')).toHaveLength(1)
    expect(res.data).toHaveLength(3)
  })

  it('an empty anilistUserRates and a failing list read: logs, returns no entries, no throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await rig({ entries: LIST, airing: AIRING, coldCache: true })
    r.world.inject('MediaListCollection', {
      status: 500,
      body: { errors: [{ message: 'x', status: 500 }] }
    })
    const res = await r.get()
    expect(res).toMatchObject({ trackerId: 'anilist', data: [], stale: false })
    expect(r.calendarRequests()).toBe(0)
    expect(warn).toHaveBeenCalledWith('[anilist] calendar: rate fetch failed:', expect.anything())
  })
})

describe('the Shikimori branch and the source switch', () => {
  it('a Shikimori source returns exactly what shikimori:get-calendar returns for the same store', async () => {
    const a = await rig({ shikimori: true, user: null })
    const b = await rig({ shikimori: true, user: null })
    const alias = await a.invoke(CHANNELS.SHIKIMORI_GET_CALENDAR, false)
    const routed = await b.get()
    expect(routed).toEqual({ trackerId: 'shikimori', ...(alias as object) })
    expect(routed.data[0]).toMatchObject({ name: 'Стальной алхимик', userStatus: 'watching' })
  })

  it('Shikimori offline with no snapshot: the alias’s empty stale shape', async () => {
    const a = await rig({ shikimori: true, user: null })
    const b = await rig({ shikimori: true, user: null })
    a.offline.value = true
    b.offline.value = true
    const alias = await a.invoke(CHANNELS.SHIKIMORI_GET_CALENDAR, false)
    expect(await b.get()).toEqual({ trackerId: 'shikimori', ...(alias as object) })
    expect(alias).toEqual({ data: [], fetchedAt: null, stale: true })
    expect(getShikiCalendar).not.toHaveBeenCalled()
  })

  it('Shikimori with a failing fetch and no snapshot: both channels throw', async () => {
    getShikiCalendar.mockRejectedValue(new ShikiApiError('Shikimori API error: 500', 500))
    const r = await rig({ shikimori: true, user: null })
    await expect(r.get()).rejects.toThrow(/500/)
    await expect(r.invoke(CHANNELS.SHIKIMORI_GET_CALENDAR, false)).rejects.toThrow(/500/)
  })

  it('Shikimori → AniList → Shikimori within 5 minutes: two independent caches, no refetch on the way back', async () => {
    const r = await rig({
      shikimori: true,
      entries: LIST,
      airing: AIRING,
      seed: { trackerPrimary: 'shikimori' }
    })
    expect(await r.get()).toMatchObject({ trackerId: 'shikimori', fetchedAt: T0 })
    vi.setSystemTime(T0 + MIN)
    r.store.set('trackerPrimary', 'anilist')
    const al = await r.get()
    expect(al).toMatchObject({ trackerId: 'anilist', fetchedAt: T0 + MIN })
    expect(al.data).toHaveLength(3)
    vi.setSystemTime(T0 + 2 * MIN)
    r.store.set('trackerPrimary', 'shikimori')
    expect(await r.get()).toMatchObject({ trackerId: 'shikimori', fetchedAt: T0, stale: false })
    expect(getShikiCalendar).toHaveBeenCalledTimes(1)
    r.store.set('trackerPrimary', 'anilist')
    expect(await r.get()).toMatchObject({ trackerId: 'anilist', fetchedAt: T0 + MIN })
    expect(r.calendarRequests()).toBe(1)
  })

  it('a calendar-source override picks the tracker whatever the primary', async () => {
    const r = await rig({
      shikimori: true,
      entries: LIST,
      airing: AIRING,
      seed: { trackerPrimary: 'shikimori', trackerFeatureSource: { calendar: 'anilist' } }
    })
    expect(await r.get()).toMatchObject({ trackerId: 'anilist' })
    expect(getShikiCalendar).not.toHaveBeenCalled()
  })

  it('MyAnimeList only: the empty shape, and no request', async () => {
    const r = await rig({
      user: null,
      seed: { myanimelistUser: { id: 77, nickname: 'mal', avatar: null } }
    })
    expect(await r.get()).toEqual({ trackerId: null, data: [], fetchedAt: null, stale: false })
    expect(r.world.server.calls).toHaveLength(0)
    expect(getShikiCalendar).not.toHaveBeenCalled()
  })

  it('no account: the empty shape, and no request', async () => {
    const r = await rig({ user: null })
    expect(await r.get(true)).toEqual({ trackerId: null, data: [], fetchedAt: null, stale: false })
    expect(r.world.server.calls).toHaveLength(0)
    expect(getShikiCalendar).not.toHaveBeenCalled()
  })
})

describe('userData/anilist-snapshots.json', () => {
  const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))

  it('a Shikimori-only session never creates it', async () => {
    const r = await rig({ shikimori: true, user: null })
    await r.get()
    await r.get(true)
    expect(fs.existsSync(path.join(path.dirname(r.file), 'shikimori-snapshots.json'))).toBe(true)
    expect(fs.existsSync(r.file)).toBe(false)
  })

  it('appears only after a successful AniList calendar fetch, keyed by anilistUser.id', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    expect(fs.existsSync(r.file)).toBe(false)
    r.world.inject('Calendar', { status: 500, body: { errors: [{ message: 'x', status: 500 }] } })
    await expect(r.get()).rejects.toThrow()
    expect(fs.existsSync(r.file)).toBe(false)
    const res = await r.get()
    expect(read(r.file)).toEqual({
      version: 1,
      userId: ALICE.id,
      calendar: { data: res.data, fetchedAt: T0 }
    })
  })

  it('survives a restart: loaded for the same user, a miss online, served offline', async () => {
    const first = await rig({ entries: LIST, airing: AIRING })
    await first.get()
    const dir = path.dirname(first.file)
    // Inside the TTL, a loaded calendar is still a miss online.
    vi.setSystemTime(T0 + MIN)
    const online = await rig({ entries: LIST, airing: AIRING, dir })
    expect(await online.get()).toMatchObject({ fetchedAt: T0 + MIN, stale: false })
    expect(online.calendarRequests()).toBe(1)
    vi.setSystemTime(T0 + 60 * MIN)
    const offline = await rig({ entries: LIST, airing: AIRING, dir })
    offline.offline.value = true
    expect(await offline.get()).toMatchObject({ fetchedAt: T0 + MIN, stale: true })
    expect((await offline.get()).data).toHaveLength(3)
    expect(offline.calendarRequests()).toBe(0)
  })

  it('a file for another userId is deleted at startup', async () => {
    const first = await rig({ entries: LIST, airing: AIRING })
    await first.get()
    const dir = path.dirname(first.file)
    const other = await rig({ entries: LIST, airing: AIRING, dir, user: BOB })
    expect(fs.existsSync(other.file)).toBe(false)
    other.offline.value = true
    expect(await other.get()).toEqual({
      trackerId: 'anilist',
      data: [],
      fetchedAt: null,
      stale: true
    })
  })

  it('a file with no AniList account is deleted at startup', async () => {
    const first = await rig({ entries: LIST, airing: AIRING })
    await first.get()
    const signedOut = await rig({ dir: path.dirname(first.file), user: null })
    expect(fs.existsSync(signedOut.file)).toBe(false)
  })

  it('is deleted on AniList logout', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    await r.get()
    expect(fs.existsSync(r.file)).toBe(true)
    r.lifecycle.logout('anilist')
    expect(fs.existsSync(r.file)).toBe(false)
    // Same user again, so a surviving in-memory snapshot would be served.
    r.store.set('anilistUser', ALICE)
    r.offline.value = true
    expect(await r.get()).toEqual({ trackerId: 'anilist', data: [], fetchedAt: null, stale: true })
  })

  it('is deleted on an AniList account switch', async () => {
    const r = await rig({ entries: LIST, airing: AIRING })
    await r.get()
    expect(fs.existsSync(r.file)).toBe(true)
    await r.lifecycle.completeLogin('anilist', async () => ({
      credentials: { accessToken: 'tok-bob', expiresAt: null },
      user: BOB
    }))
    expect(r.store.get('anilistUser')).toMatchObject({ id: BOB.id })
    expect(fs.existsSync(r.file)).toBe(false)
    r.store.set('anilistUser', ALICE)
    r.offline.value = true
    expect(await r.get()).toEqual({ trackerId: 'anilist', data: [], fetchedAt: null, stale: true })
  })

  it('a fetch that outlives an AniList switch never evicts the new user’s snapshot', async () => {
    const r = await rig({ entries: LIST, airing: AIRING, user: BOB })
    await r.get()
    const bobs = read(r.file)

    // Alice's fetch starts; the account switches back to Bob before it lands.
    r.store.set('anilistUser', ALICE)
    let release!: (reply: unknown) => void
    r.world.inject('Calendar', new Promise((resolve) => (release = resolve)) as never)
    vi.setSystemTime(T0 + 60 * MIN)
    const pending = r.get(true)
    await vi.waitFor(() => expect(r.calendarRequests()).toBe(2))
    r.store.set('anilistUser', BOB)
    release({ body: { data: { Page: { media: [] } } } })

    // The caller still gets its result; Bob's file and snapshot are untouched.
    expect(await pending).toMatchObject({
      trackerId: 'anilist',
      fetchedAt: expect.toSatisfy((t: number) => t >= T0 + 60 * MIN),
      stale: false
    })
    expect(read(r.file)).toEqual(bobs)
    r.offline.value = true
    expect(await r.get()).toMatchObject({ fetchedAt: T0, stale: true })
  })
})
