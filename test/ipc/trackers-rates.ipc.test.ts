// The `tracker:*` rate, sync-status and queue channels (#694). The real
// Shikimori sync service and primary branch run against `fake-shikimori.ts`,
// and an AniList instance runs the generic sync service on `fake-tracker.ts`,
// with a stand-in for T7's primary branch. MyAnimeList has no instance: its
// provider hasn't landed, so it takes the no-instance answers.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { T0, fakeApi, iso, server } from '../helpers/fake-shikimori'
import { createFakeTracker, UNMAPPED_MAL_ID } from '../helpers/fake-tracker'
import { testRateCodec, type TestRow } from '../helpers/test-rate-codec'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { ShikiAuthError, SESSION_EXPIRED_MESSAGE } from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import {
  createTrackerSyncService,
  type TrackerSyncService
} from '../../src/main/services/trackers/sync'
import { createTrackerFanOut, type PrimaryWriter } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { ANILIST_KEYS, MYANIMELIST_KEYS, SHIKIMORI_KEYS } from '../../src/main/trackers/keys'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { shikimoriRateCache } from '../../src/main/trackers/shikimori.provider'
import { NO_RATE_BEFORE, type RateValues } from '../../src/main/lib/shikimori-rate'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'

type Svc = TrackerSyncService<unknown, unknown>

const SHIKI_USER = { id: 7, nickname: 'me', avatar: '' }
const AL_USER = { id: 1, nickname: 'al', avatar: null }
const MAL = 1

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

const shikiRow = (malId: number, v: RateValues) => ({
  rate: { id: malId * 10, target_id: malId, ...v, updated_at: iso(T0) },
  shikiAnime: { id: malId, name: `#${malId}` },
  smotretAnime: null
})

const alRow = (malId: number, v: RateValues): TestRow => ({
  malId,
  remoteId: malId * 1000,
  values: v,
  updated_at: iso(T0)
})

const KEYS = { shikimori: SHIKIMORI_KEYS, anilist: ANILIST_KEYS, mal: MYANIMELIST_KEYS }

function rig(initial: Record<string, unknown> = {}) {
  const store = new InMemoryStorage({
    installId: 'pc',
    shikimoriUser: SHIKI_USER,
    shikimoriCredentials: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' },
    shikimoriUserRates: [],
    shikimoriUpdateQueue: [],
    shikimoriParkedQueues: {},
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [],
    shikimoriSessionExpired: false,
    anilistCredentials: { v: 1, enc: 'plain', data: 'blob' },
    anilistUser: AL_USER,
    anilistUserRates: [],
    anilistUpdateQueue: [],
    anilistParkedQueues: {},
    anilistSessionExpired: false,
    myanimelistCredentials: null,
    myanimelistUser: null,
    myanimelistUserRates: [],
    myanimelistUpdateQueue: [],
    myanimelistParkedQueues: {},
    myanimelistSessionExpired: false,
    trackerPrimary: 'shikimori',
    trackerMirror: {},
    syncMeta: { titles: {}, rates: {} },
    ...initial
  })
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
  const alFake = createFakeTracker('anilist')
  const anilist = createTrackerSyncService(
    {
      ...alFake.provider,
      rateCache: testRateCodec('anilist'),
      isSessionGone: (err: unknown) => err instanceof TrackerApiError && err.status === 401,
      hasTitle: (malId: number) => malId !== UNMAPPED_MAL_ID
    } as never,
    ANILIST_KEYS,
    {
      store: store as never,
      broadcast,
      syncStatusChannel: 'anilist:status',
      offlineQueueChangedChannel: 'anilist:queue',
      rateUpdatedChannel: 'anilist:rate',
      ratesRefreshedChannel: 'anilist:refreshed',
      isOffline
    }
  ) as Svc
  // AniList's primary branch is T7's; a queued unscoped user entry stands in.
  const anilistPrimary: PrimaryWriter = async (malId, change) => {
    const cached = anilist.cachedRate(malId)
    const basis = cached?.values ?? NO_RATE_BEFORE
    const after =
      change.kind === 'set'
        ? change.values
        : { ...basis, episodes: Math.max(basis.episodes, change.episode) }
    anilist.enqueue({ malId, rateId: cached?.remoteId ?? null, before: basis, after, queuedAt: 1 })
    return { result: null, basis, after }
  }
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [{ sync: shiki.tracker as Svc }, { sync: anilist, writePrimary: anilistPrimary }],
    log: { warn: () => {} }
  })
  const rates = createTrackerRates({ store: store as never, trackers: fan, isOffline })
  ;(ipcMain.handle as unknown as Mock).mockClear()
  const deps = {
    store,
    shikimoriSyncService: shiki,
    trackers: fan,
    trackerRates: rates,
    lookupByMalIds: vi.fn(async () => ({})),
    maybeBroadcastCleanupPrompt: vi.fn(async () => {}),
    runAutoDownloadTick: vi.fn(async () => ({})),
    broadcast,
    offlineService: { isOffline }
  } as unknown as AppDeps
  registerShikimori(deps)
  registerTrackers(deps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  const queueOf = (id: TrackerId) => store.get(KEYS[id].updateQueue) as QueuedTrackerUpdate[]
  return {
    store,
    broadcast,
    offline,
    shiki,
    shikiSvc: shiki.tracker as Svc,
    anilist,
    alFake,
    fan,
    rates,
    invoke,
    queueOf,
    signOut(id: TrackerId) {
      store.set(KEYS[id].user, null)
      store.set(KEYS[id].credentials, null)
    }
  }
}

type Rig = ReturnType<typeof rig>

/** How each tracker with an instance is set up for a row. */
const PER: Record<
  'shikimori' | 'anilist',
  {
    cache(r: Rig, ...rows: [number, RateValues][]): void
    serverHas(r: Rig, malId: number, v: RateValues): void
    /** The next live read fails the way a queued write survives. */
    failRead(r: Rig, err?: unknown): void
    networkError(): unknown
  }
> = {
  shikimori: {
    cache: (r, ...rows) =>
      r.store.set(
        'shikimoriUserRates',
        rows.map(([m, v]) => shikiRow(m, v))
      ),
    serverHas: (_r, malId, v) => server.set(malId, v),
    failRead: (_r, err = new TypeError('fetch failed')) =>
      fakeApi.ensureFreshToken.mockRejectedValueOnce(err as Error),
    networkError: () => new TypeError('fetch failed')
  },
  anilist: {
    cache: (r, ...rows) =>
      r.store.set(
        ANILIST_KEYS.userRates,
        rows.map(([m, v]) => alRow(m, v))
      ),
    serverHas: (r, malId, v) => r.alFake.set(malId, v),
    failRead: (r) => r.alFake.fail('network', { member: 'auth' }),
    networkError: () => new TypeError('fetch failed')
  }
}

const BOTH = ['shikimori', 'anilist'] as const

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0 + 5_000_000)
  server.reset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('tracker:get-rate, per tracker (#570 cases)', () => {
  it.each(BOTH)('%s: live, the server values, not stale', async (id) => {
    const r = rig()
    PER[id].cache(r, [MAL, rv(3)])
    PER[id].serverHas(r, MAL, rv(5))
    expect(await r.invoke(CHANNELS.TRACKER_GET_RATE, id, MAL)).toEqual({
      values: rv(5),
      stale: false
    })
  })

  it.each(BOTH)('%s: live with no row on the server, values null', async (id) => {
    const r = rig()
    expect(await r.invoke(CHANNELS.TRACKER_GET_RATE, id, MAL)).toEqual({
      values: null,
      stale: false
    })
  })

  it.each(BOTH)('%s: a network failure answers from the cache, stale', async (id) => {
    const r = rig()
    PER[id].cache(r, [MAL, rv(3)])
    PER[id].serverHas(r, MAL, rv(5))
    PER[id].failRead(r)
    expect(await r.invoke(CHANNELS.TRACKER_GET_RATE, id, MAL)).toEqual({
      values: rv(3),
      stale: true
    })
  })

  it.each(BOTH)('%s: offline answers from the cache before any read', async (id) => {
    const r = rig()
    PER[id].cache(r, [MAL, rv(3)])
    r.offline.value = true
    expect(await r.invoke(CHANNELS.TRACKER_GET_RATE, id, MAL)).toEqual({
      values: rv(3),
      stale: true
    })
    expect(fakeApi.getUserRate).not.toHaveBeenCalled()
  })

  it.each(BOTH)(
    '%s: a title missing from a non-empty cache is values: null, where the alias says null',
    async (id) => {
      const r = rig()
      PER[id].cache(r, [2, rv(3)])
      PER[id].failRead(r)
      expect(await r.invoke(CHANNELS.TRACKER_GET_RATE, id, MAL)).toEqual({
        values: null,
        stale: true
      })
      if (id === 'shikimori') {
        PER[id].failRead(r)
        expect(await r.invoke(CHANNELS.SHIKIMORI_GET_RATE, MAL)).toBeNull()
      }
    }
  )

  it.each(BOTH)('%s: an empty (never loaded) cache rethrows', async (id) => {
    const r = rig()
    PER[id].failRead(r)
    await expect(r.invoke(CHANNELS.TRACKER_GET_RATE, id, MAL)).rejects.toThrow('fetch failed')
  })
})

describe('tracker:get-rates', () => {
  it('shikimori: cache-first with a background refresh; raw is the stored rows byte for byte', async () => {
    const r = rig()
    PER.shikimori.cache(r, [MAL, rv(3)], [2, rv(1)])
    const stored = JSON.stringify(r.store.get('shikimoriUserRates'))
    server.set(MAL, rv(9))

    const snap = (await r.invoke(CHANNELS.TRACKER_GET_RATES, 'shikimori')) as TrackerRatesSnapshot

    expect(JSON.stringify(snap.raw)).toBe(stored)
    expect(snap).toEqual({
      trackerId: 'shikimori',
      entries: (JSON.parse(stored) as never[]).map((row) => shikimoriRateCache.entryOf(row)),
      queuedAfter: {},
      raw: JSON.parse(stored)
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(r.store.get('shikimoriUserRates')).toEqual([
      expect.objectContaining({ rate: expect.objectContaining({ target_id: MAL, episodes: 9 }) })
    ])
  })

  it('anilist: cache-first with a background refresh, and no raw', async () => {
    const r = rig()
    PER.anilist.cache(r, [MAL, rv(3)])
    r.alFake.set(MAL, rv(9))

    const snap = (await r.invoke(CHANNELS.TRACKER_GET_RATES, 'anilist')) as TrackerRatesSnapshot

    expect(snap).not.toHaveProperty('raw')
    expect(snap.entries).toEqual([
      expect.objectContaining({ trackerId: 'anilist', malId: MAL, values: rv(3) })
    ])
    await vi.advanceTimersByTimeAsync(10)
    expect(r.store.get(ANILIST_KEYS.userRates)).toEqual([
      expect.objectContaining({ malId: MAL, values: rv(9) })
    ])
  })

  it('anilist: with nothing cached, one fetch answers', async () => {
    const r = rig()
    r.alFake.set(MAL, rv(4))
    const snap = (await r.invoke(CHANNELS.TRACKER_GET_RATES, 'anilist')) as TrackerRatesSnapshot
    expect(snap.entries).toEqual([expect.objectContaining({ malId: MAL, values: rv(4) })])
  })

  it.each(BOTH)(
    "%s: queuedAfter is the last queued after per title in that tracker's live queue",
    async (id) => {
      const r = rig()
      PER[id].cache(r, [MAL, rv(3)])
      r.offline.value = true
      const entry = (malId: number, after: RateValues, queuedAt: number) => ({
        malId,
        rateId: null,
        before: rv(0),
        after,
        queuedAt
      })
      r.store.set(KEYS[id].updateQueue, [
        entry(MAL, rv(4), 1),
        entry(2, rv(8), 2),
        entry(MAL, rv(5), 3)
      ])
      const snap = (await r.invoke(CHANNELS.TRACKER_GET_RATES, id)) as TrackerRatesSnapshot
      expect(snap.queuedAfter).toEqual({ [MAL]: rv(5), 2: rv(8) })
      // The other tracker's queue is its own.
      const other = (await r.invoke(
        CHANNELS.TRACKER_GET_RATES,
        id === 'shikimori' ? 'anilist' : 'shikimori'
      )) as TrackerRatesSnapshot
      expect(other.queuedAfter).toEqual({})
    }
  )
})

describe('tracker:update-rate and tracker:mark-episode-watched', () => {
  it("goes through applyChange with cause 'user' to the primary, and the fan-out reaches the mirror", async () => {
    const r = rig()
    const apply = vi.spyOn(r.fan, 'applyChange')
    PER.shikimori.cache(r, [MAL, rv(3)])
    PER.anilist.cache(r, [MAL, rv(3)])
    server.set(MAL, rv(3))

    expect(await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(8))).toEqual(rv(8))

    expect(apply).toHaveBeenCalledWith(
      MAL,
      { kind: 'set', values: rv(8) },
      { target: 'shikimori', cause: 'user' }
    )
    expect(server.get(MAL)!.episodes).toBe(8)
    // The mirror entry, which AniList's drain then sends.
    expect(r.anilist.getQueueLength() + r.alFake.upserts.length).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(r.alFake.upserts).toMatchObject([{ values: rv(8) }])
    expect(r.queueOf('anilist')).toEqual([])
  })

  it('opts.only, a non-primary tracker: queued to that tracker alone, nothing sent or queued on the primary', async () => {
    const r = rig()
    PER.shikimori.cache(r, [MAL, rv(3)])
    PER.anilist.cache(r, [MAL, rv(3)])
    server.set(MAL, rv(3))
    r.offline.value = true

    expect(await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(6), { only: 'anilist' })).toEqual(
      rv(6)
    )

    expect(r.queueOf('anilist')).toMatchObject([{ via: 'copy', fields: ['episodes'] }])
    expect(r.queueOf('shikimori')).toEqual([])
    expect(fakeApi.updateUserRate).not.toHaveBeenCalled()
    expect(server.get(MAL)!.episodes).toBe(3)
    r.anilist.stopSyncTimer()
  })

  it('opts.only, the primary: written there with no fan-out, so nothing is queued on the mirror', async () => {
    const r = rig()
    const apply = vi.spyOn(r.fan, 'applyChange')
    PER.shikimori.cache(r, [MAL, rv(3)])
    PER.anilist.cache(r, [MAL, rv(3)])
    server.set(MAL, rv(3))

    expect(await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(8), { only: 'shikimori' })).toEqual(
      rv(8)
    )

    expect(apply).toHaveBeenCalledWith(
      MAL,
      { kind: 'set', values: rv(8) },
      { target: 'shikimori', cause: 'user', mirrors: false }
    )
    expect(server.get(MAL)!.episodes).toBe(8)
    expect(r.queueOf('anilist')).toEqual([])
  })

  it('mark-episode-watched reaches the primary and the mirror', async () => {
    const r = rig()
    PER.shikimori.cache(r, [MAL, rv(3)])
    PER.anilist.cache(r, [MAL, rv(3)])
    server.set(MAL, rv(3))

    expect(await r.invoke(CHANNELS.TRACKER_MARK_EPISODE_WATCHED, MAL, 4)).toEqual(rv(4))

    expect(server.get(MAL)!.episodes).toBe(4)
    await vi.advanceTimersByTimeAsync(10)
    expect(r.alFake.upserts).toMatchObject([{ values: rv(4), changedFields: ['episodes'] }])
  })

  it('rejects a malformed change and episode at the boundary, calling nothing', async () => {
    const r = rig()
    const apply = vi.spyOn(r.fan, 'applyChange')
    await expect(
      r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, { ...rv(1), status: 'bogus' })
    ).rejects.toThrow('Invalid status')
    await expect(r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 0, rv(1))).rejects.toThrow('Invalid MAL id')
    await expect(r.invoke(CHANNELS.TRACKER_MARK_EPISODE_WATCHED, MAL, 'x')).rejects.toThrow(
      'Invalid episode'
    )
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('tracker:get-sync-status, get-offline-queue-length, trigger-sync, parked queues', () => {
  it("each tracker's status is its own instance's, with needsSetup", async () => {
    const r = rig({
      anilistUpdateQueue: [{ malId: MAL, rateId: null, before: rv(0), after: rv(1), queuedAt: 1 }]
    })
    expect(await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'shikimori')).toEqual({
      state: 'idle',
      queueLength: 0,
      lastSyncAt: 0,
      lastSyncError: null,
      sessionExpired: false,
      needsSetup: false
    })
    expect(await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'anilist')).toMatchObject({
      queueLength: 1,
      needsSetup: false
    })
    expect(await r.invoke(CHANNELS.TRACKER_GET_OFFLINE_QUEUE_LENGTH, 'anilist')).toBe(1)
    expect(await r.invoke(CHANNELS.TRACKER_GET_OFFLINE_QUEUE_LENGTH, 'shikimori')).toBe(0)
  })

  it('trigger-sync drains the one tracker named, or every connected one when omitted', async () => {
    const r = rig()
    const shiki = vi.spyOn(r.shikiSvc, 'syncQueue').mockResolvedValue(undefined)
    const al = vi.spyOn(r.anilist, 'syncQueue').mockResolvedValue(undefined)

    await r.invoke(CHANNELS.TRACKER_TRIGGER_SYNC, 'anilist')
    expect([shiki.mock.calls.length, al.mock.calls.length]).toEqual([0, 1])

    await r.invoke(CHANNELS.TRACKER_TRIGGER_SYNC)
    expect([shiki.mock.calls.length, al.mock.calls.length]).toEqual([1, 2])

    r.signOut('shikimori')
    await r.invoke(CHANNELS.TRACKER_TRIGGER_SYNC)
    expect([shiki.mock.calls.length, al.mock.calls.length]).toEqual([1, 3])
  })

  it.each(['shikimori', 'anilist', 'mal'] as const)(
    '%s, signed out: the parked buckets are listed, with string owner ids, and one is discarded',
    async (id) => {
      const bucket = (nickname: string, n: number, parkedAt: number) => ({
        nickname,
        parkedAt,
        entries: Array.from({ length: n }, (_, i) => ({
          malId: i + 1,
          rateId: null,
          before: rv(0),
          after: rv(1),
          queuedAt: i
        }))
      })
      const r = rig({
        [KEYS[id].parkedQueues]: { '9': bucket('nine', 2, 5), unknown: bucket('', 1, 6) }
      })
      r.signOut(id)

      expect(await r.invoke(CHANNELS.TRACKER_GET_PARKED_QUEUES, id)).toEqual([
        { trackerId: id, ownerId: '9', nickname: 'nine', count: 2, parkedAt: 5 },
        { trackerId: id, ownerId: null, nickname: '', count: 1, parkedAt: 6 }
      ])
      await r.invoke(CHANNELS.TRACKER_DISCARD_PARKED_QUEUE, id, '9')
      expect(Object.keys(r.store.get(KEYS[id].parkedQueues) as object)).toEqual(['unknown'])
      await r.invoke(CHANNELS.TRACKER_DISCARD_PARKED_QUEUE, id, null)
      expect(r.store.get(KEYS[id].parkedQueues)).toEqual({})
    }
  )
})

describe('an unknown tracker, a tracker with no instance, and no primary', () => {
  it.each([
    [CHANNELS.TRACKER_GET_RATE, ['nope', MAL]],
    [CHANNELS.TRACKER_GET_RATES, ['nope']],
    [CHANNELS.TRACKER_GET_SYNC_STATUS, ['nope']],
    [CHANNELS.TRACKER_GET_OFFLINE_QUEUE_LENGTH, ['nope']],
    [CHANNELS.TRACKER_TRIGGER_SYNC, ['nope']],
    [CHANNELS.TRACKER_GET_PARKED_QUEUES, ['nope']],
    [CHANNELS.TRACKER_DISCARD_PARKED_QUEUE, ['nope', null]],
    [CHANNELS.TRACKER_UPDATE_RATE, [MAL, rv(1), { only: 'nope' }]]
  ])('%s rejects an unknown trackerId', async (channel, args) => {
    const r = rig()
    await expect(r.invoke(channel, ...args)).rejects.toThrow('Unknown tracker: nope')
  })

  it('mal (no instance): reads answer from nothing or the store keys, trigger-sync does nothing, update-rate throws', async () => {
    const r = rig({
      myanimelistUpdateQueue: [
        { malId: MAL, rateId: null, before: rv(0), after: rv(1), queuedAt: 1 },
        { malId: 2, rateId: null, before: rv(0), after: rv(1), queuedAt: 2 }
      ],
      myanimelistSessionExpired: true
    })
    expect(await r.invoke(CHANNELS.TRACKER_GET_RATE, 'mal', MAL)).toBeNull()
    expect(await r.invoke(CHANNELS.TRACKER_GET_RATES, 'mal')).toEqual({
      trackerId: 'mal',
      entries: [],
      queuedAfter: {}
    })
    const length = await r.invoke(CHANNELS.TRACKER_GET_OFFLINE_QUEUE_LENGTH, 'mal')
    const status = (await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'mal')) as TrackerSyncStatus
    expect(length).toBe(2)
    expect(status).toEqual({
      state: 'idle',
      queueLength: length,
      lastSyncAt: 0,
      lastSyncError: null,
      sessionExpired: true,
      needsSetup: false
    })
    await expect(r.invoke(CHANNELS.TRACKER_TRIGGER_SYNC, 'mal')).resolves.toBeUndefined()
    await expect(
      r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(1), { only: 'mal' })
    ).rejects.toThrow('Not logged in to MyAnimeList')
    expect(fakeApi.ensureFreshToken).not.toHaveBeenCalled()
  })

  it('no primary (nothing connected): mark-episode-watched resolves null and calls no provider', async () => {
    const r = rig()
    r.signOut('shikimori')
    r.signOut('anilist')
    PER.shikimori.cache(r, [MAL, rv(3)])
    PER.anilist.cache(r, [MAL, rv(3)])

    expect(await r.invoke(CHANNELS.TRACKER_MARK_EPISODE_WATCHED, MAL, 4)).toBeNull()

    expect(fakeApi.ensureFreshToken).not.toHaveBeenCalled()
    expect(fakeApi.getUserRate).not.toHaveBeenCalled()
    expect(r.alFake.upserts).toEqual([])
    expect(r.queueOf('shikimori')).toEqual([])
    expect(r.queueOf('anilist')).toEqual([])
  })

  it('no primary (nothing connected): update-rate throws "Not logged in to …" and calls no provider', async () => {
    const r = rig()
    r.signOut('shikimori')
    r.signOut('anilist')

    await expect(r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(4))).rejects.toThrow(
      /^Not logged in to /
    )

    expect(fakeApi.ensureFreshToken).not.toHaveBeenCalled()
    expect(r.alFake.upserts).toEqual([])
    expect(r.queueOf('anilist')).toEqual([])
  })
})

describe('an expired session keeps its instance: it queues, and its status says so', () => {
  it('shikimori: user set, credentials null, the flag set', async () => {
    const r = rig({
      shikimoriCredentials: null,
      shikimoriSessionExpired: true,
      trackerMirror: { anilist: false }
    })
    PER.shikimori.cache(r, [MAL, rv(3)])
    fakeApi.ensureFreshToken.mockRejectedValue(new ShikiAuthError(SESSION_EXPIRED_MESSAGE))

    expect(await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'shikimori')).toMatchObject({
      sessionExpired: true
    })
    expect(await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(4))).toEqual(rv(4))
    expect(r.queueOf('shikimori')).toMatchObject([{ malId: MAL, after: rv(4) }])
    expect(await r.invoke(CHANNELS.TRACKER_MARK_EPISODE_WATCHED, MAL, 5)).toEqual(rv(5))
    expect(r.queueOf('shikimori')).toHaveLength(2)
  })

  it('anilist: user set, credentials null, the flag set, and it is the only account, so the primary', async () => {
    const r = rig({ anilistCredentials: null, anilistSessionExpired: true })
    r.signOut('shikimori')
    PER.anilist.cache(r, [MAL, rv(3)])
    r.alFake.fail('auth', { times: 99 })

    expect(await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'anilist')).toMatchObject({
      sessionExpired: true
    })
    expect(await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(4))).toEqual(rv(4))
    expect(r.queueOf('anilist')).toMatchObject([{ malId: MAL, after: rv(4) }])
    expect(await r.invoke(CHANNELS.TRACKER_MARK_EPISODE_WATCHED, MAL, 5)).toEqual(rv(5))
    expect(r.queueOf('anilist')).toHaveLength(2)
    r.anilist.stopSyncTimer()
  })
})

describe('failure isolation', () => {
  it("with AniList's session expired, every Shikimori channel answers as before and only AniList's status says expired", async () => {
    const r = rig({ anilistSessionExpired: true })
    r.alFake.fail('auth', { times: 99 })
    PER.shikimori.cache(r, [MAL, rv(3)])
    PER.anilist.cache(r, [MAL, rv(3)])
    server.set(MAL, rv(3))
    r.store.set('anilistUpdateQueue', [
      { malId: MAL, rateId: null, before: rv(0), after: rv(2), queuedAt: 1 }
    ])

    await r.invoke(CHANNELS.TRACKER_TRIGGER_SYNC)
    await vi.advanceTimersByTimeAsync(10)

    expect(await r.invoke(CHANNELS.TRACKER_GET_RATE, 'shikimori', MAL)).toEqual({
      values: rv(3),
      stale: false
    })
    expect(await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, MAL, rv(4), { only: 'shikimori' })).toEqual(
      rv(4)
    )
    expect(server.get(MAL)!.episodes).toBe(4)
    expect(await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'shikimori')).toMatchObject({
      sessionExpired: false,
      lastSyncError: null
    })
    expect(await r.invoke(CHANNELS.TRACKER_GET_SYNC_STATUS, 'anilist')).toMatchObject({
      sessionExpired: true,
      queueLength: 1
    })
    expect(await r.invoke(CHANNELS.TRACKER_GET_OFFLINE_QUEUE_LENGTH, 'shikimori')).toBe(0)
    r.anilist.stopSyncTimer()
  })
})
