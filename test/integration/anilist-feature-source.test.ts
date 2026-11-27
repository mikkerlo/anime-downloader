// The AniList construction's #706 wiring, built the way `index.ts` builds it:
// the real provider, client and limiter against the fixture world, its sync
// instance with the event bridge, `detailsUpdatedChannel`, `prefetchDetails`
// and `onRatesRefreshed: createTickIfAiringSource(...)`, and the provider's
// `onDetailsWritten` going to the instance's `broadcastDetails`.
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import {
  createAniListWorld,
  createTestAniList,
  type AniListWorld,
  type WorldEntry
} from '../helpers/anilist-server'
import {
  createAniListSyncService,
  type AniListSyncService
} from '../../src/main/trackers/anilist/sync'
import { createAniListEventBridge } from '../../src/main/trackers/anilist/events'
import {
  plainDescription,
  trackerDetailsOf,
  type AniListDetails
} from '../../src/main/trackers/anilist/provider'
import { createTickIfAiringSource } from '../../src/main/trackers/feature-source'
import { createTrackerRatesStep } from '../../src/main/services/prepare-offline/steps/tracker-rates'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'

let world: AniListWorld | null = null
afterEach(() => {
  world?.server.restore()
  world = null
})

const ENTRY: WorldEntry = {
  id: 9001,
  mediaId: 101,
  idMal: 1,
  status: 'CURRENT',
  score: 85,
  progress: 7,
  repeat: 0,
  updatedAt: 1
}

/** `anilistUserRates` rows for `malIds`, as a list read would have cached them. */
const listRows = (...malIds: number[]) =>
  malIds.map((mal) => ({
    entry: {
      id: 9000 + mal,
      mediaId: 100 + mal,
      status: 'CURRENT',
      score: 0,
      progress: 0,
      repeat: 0,
      updatedAt: 1,
      media: { id: 100 + mal, idMal: mal }
    },
    smotretAnime: null
  }))

async function rig(
  opts: { seed?: Record<string, unknown>; media?: Record<number, number[]> } = {}
) {
  world = createAniListWorld({ entries: [ENTRY], media: opts.media })
  const broadcastToAll = vi.fn()
  const runTick = vi.fn(async () => ({}))
  const prefetchFailed = vi.fn()
  // Read at call time, as `index.ts`'s `anilistSync` is: the instance is built below.
  const late: { sync?: AniListSyncService } = {}
  const t = await createTestAniList({
    seed: opts.seed,
    provider: {
      onDetailsWritten: (malId, details) => late.sync!.broadcastDetails(malId, details)
    }
  })
  const channels = {
    rateUpdated: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
    ratesRefreshed: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
    syncStatus: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
    offlineQueueChanged: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED
  }
  const sync: AniListSyncService = createAniListSyncService(t.provider, {
    store: t.store as never,
    broadcast: createAniListEventBridge({
      broadcast: broadcastToAll,
      channels,
      rateCache: t.provider.rateCache,
      needsSetup: () => false,
      queuedAfter: () => ({})
    }),
    syncStatusChannel: channels.syncStatus,
    offlineQueueChangedChannel: channels.offlineQueueChanged,
    rateUpdatedChannel: channels.rateUpdated,
    ratesRefreshedChannel: channels.ratesRefreshed,
    detailsUpdatedChannel: EVENT_CHANNELS.TRACKER_DETAILS_UPDATED,
    prefetchDetails: (malId) => void t.provider.requestPrefetch(malId).catch(prefetchFailed),
    onRatesRefreshed: createTickIfAiringSource({ store: t.store, runTick })
  })
  late.sync = sync
  const fan = createTrackerFanOut({
    store: t.store as never,
    trackers: [{ sync: sync as unknown as TrackerSyncService<unknown, unknown> }]
  })
  const trackerRates = createTrackerRates({ store: t.store as never, trackers: fan })
  ;(ipcMain.handle as unknown as Mock).mockClear()
  registerTrackers({
    store: t.store,
    trackerRates,
    trackerLifecycle: {},
    trackerAuth: {},
    trackerChoices: {},
    newTrackerCardsEnabled: true
  } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const getDetails = async (malId: number, trackerId?: TrackerId) =>
    (await handlers.get(CHANNELS.TRACKER_GET_DETAILS)!(
      {},
      malId,
      trackerId
    )) as TrackerDetails | null
  const detailsEvents = () =>
    broadcastToAll.mock.calls
      .filter(([c]) => c === EVENT_CHANNELS.TRACKER_DETAILS_UPDATED)
      .map(([, e]) => e as TrackerDetailsUpdatedEvent)
  return { t, sync, world: world!, runTick, prefetchFailed, getDetails, detailsEvents }
}

describe("AniList's onRatesRefreshed ticks auto-download while it is the airing source", () => {
  it('a list refresh runs one rates-refreshed tick, after stamping the list cache’s age', async () => {
    const r = await rig()
    expect(r.t.provider.ratesFetchedAt()).toBe(0)
    await r.sync.refreshRates({ keepQueued: false })
    expect(r.runTick).toHaveBeenCalledTimes(1)
    expect(r.t.provider.ratesFetchedAt()).toBeGreaterThan(0)
    // The stamp makes the refreshed list answer getAiringInfo with no request.
    const before = r.world.server.calls.length
    expect(await r.t.provider.getAiringInfo(1)).toEqual({ episodesAired: 12, episodes: 12 })
    expect(r.world.server.calls.length).toBe(before)
  })

  it('no tick while a connected Shikimori primary is the airing source', async () => {
    const r = await rig({
      seed: {
        shikimoriUser: { id: 1, nickname: 's', avatar: null },
        trackerPrimary: 'shikimori'
      }
    })
    await r.sync.refreshRates({ keepQueued: false })
    expect(r.runTick).not.toHaveBeenCalled()
    expect(r.t.provider.ratesFetchedAt()).toBeGreaterThan(0)
  })

  it('an override back to AniList ticks again', async () => {
    const r = await rig({
      seed: {
        shikimoriUser: { id: 1, nickname: 's', avatar: null },
        trackerPrimary: 'shikimori',
        trackerFeatureSource: { airing: 'anilist' }
      }
    })
    await r.sync.refreshRates({ keepQueued: false })
    expect(r.runTick).toHaveBeenCalledTimes(1)
  })
})

describe('a tracker:get-details miss never restarts a running prefetch', () => {
  /** The world's Details reply for `ids`, held until `release()`. */
  function holdDetails(r: Awaited<ReturnType<typeof rig>>, ids: number[]) {
    let release!: () => void
    const held = new Promise<void>((res) => (release = res)).then(() => ({
      body: {
        data: {
          Page: {
            media: ids.map((mal) => ({
              id: 100 + mal,
              idMal: mal,
              description: `About #${mal}`,
              genres: ['Drama'],
              format: 'TV',
              episodes: 12,
              status: 'RELEASING',
              nextAiringEpisode: { episode: 5 }
            }))
          }
        }
      }
    }))
    r.world.inject('Details', held as never)
    return () => release()
  }

  const step = (r: Awaited<ReturnType<typeof rig>>) =>
    createTrackerRatesStep('anilist', {
      isConnected: () => true,
      drain: async () => {},
      refreshRates: async () => ({ entries: [], waitingMalIds: [] }) as never,
      prefetch: () => r.t.provider.prefetchDetails(),
      abortPrefetch: () => r.t.provider.abortPrefetch()
    })

  it('Prepare-offline’s details phase survives a detail-page miss: one walk, every list title cached', async () => {
    const r = await rig({ seed: { anilistUserRates: listRows(1, 3) }, media: { 3: [103] } })
    const release = holdDetails(r, [1, 3])
    const progress: string[] = []
    const run = step(r).run({
      signal: new AbortController().signal,
      progress: (p) => void (p.message && progress.push(p.message)),
      isOffline: () => false
    })
    await vi.waitFor(() => expect(r.world.server.of('Details')).toHaveLength(1))
    expect(progress).toContain('Caching AniList details')

    // A detail page for a list title mounts mid-phase.
    expect(await r.getDetails(1, 'anilist')).toBeNull()
    release()
    const result = await run

    expect(result.status).toBe('ok')
    expect(Object.keys(r.t.store.get('anilistAnimeDetails') as object).sort()).toEqual(['1', '3'])
    // Joined, not restarted: the step's walk was the only one.
    expect(r.world.server.of('Details')).toHaveLength(1)
    expect(r.prefetchFailed).not.toHaveBeenCalled()
  })

  it('a miss for a title off the list starts no prefetch (it could never answer it)', async () => {
    const r = await rig({ seed: { anilistUserRates: listRows(1) } })
    expect(await r.getDetails(2, 'anilist')).toBeNull()
    await new Promise((res) => setTimeout(res, 20))
    expect(r.world.server.of('Details')).toHaveLength(0)
  })
})

describe('the details emit (tracker:details-updated)', () => {
  it('a tracker:get-details miss is null and kicks the list prefetch, whose writes arrive normalized', async () => {
    const r = await rig({ seed: { anilistUserRates: listRows(1, 3) }, media: { 3: [103] } })
    expect(await r.getDetails(1, 'anilist')).toBeNull()
    await vi.waitFor(() => expect(r.detailsEvents()).toHaveLength(2))
    // The handler fetched nothing itself: the one read is the list prefetch's batch.
    expect(r.world.server.of('Details').map((c) => c.variables.ids)).toEqual([[1, 3]])
    const expected: TrackerDetails = {
      description: 'About #1',
      genres: ['Drama'],
      status: 'ongoing',
      episodes: 12,
      episodesAired: 4,
      kind: 'tv'
    }
    expect(r.detailsEvents()).toEqual(
      expect.arrayContaining([
        { trackerId: 'anilist', malId: 1, details: expected },
        { trackerId: 'anilist', malId: 3, details: { ...expected, description: 'About #3' } }
      ])
    )
    expect(r.prefetchFailed).not.toHaveBeenCalled()
    // Now a hit: the same normalized entry, from the cache.
    const calls = r.world.server.calls.length
    expect(await r.getDetails(1, 'anilist')).toEqual(expected)
    expect(r.world.server.calls.length).toBe(calls)
  })

  it('without a trackerId the details source (AniList, alone) is read', async () => {
    const r = await rig({ seed: { anilistUserRates: listRows(1) } })
    await r.t.provider.prefetchDetails()
    expect((await r.getDetails(1))?.description).toBe('About #1')
  })

  it('an on-list getDetails writes and emits; an off-list one does neither (ToU)', async () => {
    const r = await rig({ seed: { anilistUserRates: listRows(1) }, media: { 2: [102] } })
    await r.t.provider.getDetails(2)
    expect(r.t.store.get('anilistAnimeDetails')).toEqual({})
    expect(r.detailsEvents()).toEqual([])
    await r.t.provider.getDetails(1)
    expect(Object.keys(r.t.store.get('anilistAnimeDetails') as object)).toEqual(['1'])
    expect(r.detailsEvents()).toEqual([
      { trackerId: 'anilist', malId: 1, details: expect.objectContaining({ status: 'ongoing' }) }
    ])
  })
})

describe('the AniList construction in src/main/index.ts (source pin)', () => {
  it('passes the rig above’s wiring: the tick hook, the details channel, the prefetch, the emit', () => {
    // `index.ts` boots Electron at module scope and can't be imported here.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'),
      'utf-8'
    )
    const start = src.indexOf('const anilistProvider = createAniListProvider({')
    const end = src.indexOf("// AniList's primary branch (#703)")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const construction = src.slice(start, end)
    expect(construction).toContain(
      'onDetailsWritten: (malId, details) => anilistSync.broadcastDetails(malId, details)'
    )
    expect(construction).toContain('detailsUpdatedChannel: EVENT_CHANNELS.TRACKER_DETAILS_UPDATED')
    expect(construction).toContain('.requestPrefetch(malId)')
    expect(construction).toContain(
      "onRatesRefreshed: createTickIfAiringSource({\n    store,\n    runTick: () => runAutoDownloadTick('rates-refreshed')\n  })"
    )
    // The Shikimori construction gets neither (its details and tick stay its own).
    const shiki = src.slice(
      src.indexOf('const shikimoriSyncService = createShikimoriSyncService({')
    )
    expect(shiki.slice(0, shiki.indexOf('})'))).not.toContain('detailsUpdatedChannel')
  })
})

describe("an AniList details entry in tracker:get-details' shape", () => {
  const entry = (over: Partial<AniListDetails> = {}): Omit<AniListDetails, 'at' | 'anilistId'> => ({
    description: 'A synopsis.',
    genres: ['Action'],
    status: 'FINISHED',
    episodes: 26,
    episodesAired: 26,
    kind: 'TV',
    ...over
  })

  it('maps the status into Shikimori’s words; an unmapped one is unknown', () => {
    expect(trackerDetailsOf(entry()).status).toBe('released')
    expect(trackerDetailsOf(entry({ status: 'RELEASING' })).status).toBe('ongoing')
    expect(trackerDetailsOf(entry({ status: 'HIATUS' })).status).toBe('ongoing')
    expect(trackerDetailsOf(entry({ status: 'NOT_YET_RELEASED' })).status).toBe('anons')
    expect(trackerDetailsOf(entry({ status: 'CANCELLED' })).status).toBeNull()
    expect(trackerDetailsOf(entry({ status: null })).status).toBeNull()
  })

  it('keeps the counts and genres, and lower-cases the format', () => {
    expect(trackerDetailsOf(entry({ episodes: null, kind: 'TV_SHORT' }))).toEqual({
      description: 'A synopsis.',
      genres: ['Action'],
      status: 'released',
      episodes: null,
      episodesAired: 26,
      kind: 'tv_short'
    })
  })

  it('a description is plain text: line breaks kept, markup and entities gone', () => {
    expect(plainDescription('One<br><br>\nTwo <i>(Source: X)</i> &amp; &quot;Three&quot;')).toBe(
      'One\n\nTwo (Source: X) & "Three"'
    )
    expect(plainDescription('')).toBeNull()
    expect(plainDescription('<br>')).toBeNull()
    expect(plainDescription(null)).toBeNull()
  })
})
