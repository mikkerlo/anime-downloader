// The online edge of #567 against the real sync service, after S0b (#588)
// split unsynced changes into the signed-in user's live queue and per-user
// parked buckets: coming back online drains the live queue only, and parked
// buckets stay parked. After #600, a 429 during that drain stops it and keeps
// the queue. After #693 every connected tracker drains on that edge: the
// AniList instance here gets the same case.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import {
  createAniListServer,
  createTestAniList,
  type AniListReply,
  type AniListServer
} from '../helpers/anilist-server'

const ensureFreshToken = vi.fn()
const getUserRate = vi.fn()
const createUserRate = vi.fn()
const updateUserRate = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...args: unknown[]) => ensureFreshToken(...args),
    getUserRate: (...args: unknown[]) => getUserRate(...args),
    createUserRate: (...args: unknown[]) => createUserRate(...args),
    updateUserRate: (...args: unknown[]) => updateUserRate(...args)
  }
})

import { ShikiApiError } from '../../src/main/shikimori'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createOfflineService } from '../../src/main/services/offline'
import { createOfflineKickoff, PREFETCH_STAGGER_MS } from '../../src/main/services/offline/kickoff'
import { createAniListSyncService } from '../../src/main/trackers/anilist/sync'
import { kickoffTrackers } from '../../src/main/services/trackers/edges'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createGenericTracker } from '../helpers/generic-tracker'

function entry(malId: number, queuedAt: number) {
  return {
    malId,
    rateId: null,
    queuedAt,
    before: { episodes: 0, status: 'watching', score: 0, rewatches: 0 },
    after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
  }
}

const serverRate = (malId: number) => ({
  id: 900 + malId,
  target_id: malId,
  episodes: 0,
  status: 'watching',
  score: 0,
  rewatches: 0
})

const PARKED = {
  '2': { nickname: 'other', entries: [entry(50, 3)], parkedAt: 9 },
  unknown: { nickname: null, entries: [entry(60, 4)], parkedAt: 9 }
}

function boot(): {
  store: InMemoryStorage
  goOnline: () => void
  anilist: ReturnType<typeof createGenericTracker<'anilist'>>
} {
  const store = new InMemoryStorage({
    workOffline: true,
    shikimoriCredentials: { access_token: 'tok', refresh_token: 'r' },
    shikimoriUser: { id: 1, nickname: 'me' },
    shikimoriUpdateQueue: [entry(10, 1), entry(11, 2)],
    shikimoriParkedQueues: structuredClone(PARKED),
    shikimoriUserRates: [],
    shikimoriAnimeDetails: {},
    // #693: a connected AniList account with its own live queue and parked buckets.
    anilistCredentials: { v: 1, enc: 'plain', data: 'blob' },
    anilistUser: { id: 1, nickname: 'anilist-user', avatar: null },
    anilistUpdateQueue: [entry(1, 1), entry(2, 2)],
    anilistParkedQueues: structuredClone(PARKED),
    anilistUserRates: []
  })
  // `offline` is read through a late binding, as `index.ts` does.
  const ref: { isOffline: () => boolean } = { isOffline: () => true }
  const sync = createShikimoriSyncService({
    store,
    broadcast: vi.fn(),
    syncStatusChannel: 's',
    offlineQueueChangedChannel: 'q',
    rateUpdatedChannel: 'r',
    animeDetailsUpdatedChannel: 'd',
    isOffline: () => ref.isOffline()
  })
  const anilist = createGenericTracker('anilist', store as never, {
    isOffline: () => ref.isOffline()
  })
  const syncs = [sync.tracker as TrackerSyncService<unknown, unknown>, anilist.sync]
  const kickoff = createOfflineKickoff({
    trackers: () => kickoffTrackers(store, syncs, vi.fn()),
    suspendDownloads: vi.fn(),
    resumeDownloads: vi.fn(),
    suspendSyncplay: vi.fn(),
    resumeSyncplay: vi.fn(),
    retryBinaries: vi.fn(),
    runAutoDownloadTick: vi.fn()
  })
  const offline = createOfflineService({
    store,
    probeUrls: () => [],
    onOnline: kickoff.onOnline,
    onOffline: kickoff.onOffline
  })
  ref.isOffline = offline.isOffline
  return { store, goOnline: () => offline.setManual(false), anilist }
}

/** The drain sleeps 250 ms between items. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000)
}

beforeEach(() => {
  vi.useFakeTimers()
  ensureFreshToken.mockReset().mockResolvedValue('access-token')
  getUserRate.mockReset().mockImplementation(async (_t, _u, malId: number) => serverRate(malId))
  createUserRate.mockReset()
  updateUserRate.mockReset().mockImplementation(async (_t, rateId: number) => ({
    ...serverRate(rateId - 900),
    episodes: 1
  }))
})

describe('the online edge drains the live queue only (#567 × #588)', () => {
  it('sends the signed-in user’s entries and leaves every parked bucket alone', async () => {
    const { store, goOnline } = boot()
    goOnline()
    await settle()

    const drained = getUserRate.mock.calls.map((c) => c[2])
    expect(drained.sort()).toEqual([10, 11])
    expect(getUserRate.mock.calls.every((c) => c[1] === 1)).toBe(true)
    expect(store.get('shikimoriUpdateQueue')).toEqual([])
    expect(store.get('shikimoriParkedQueues')).toEqual(PARKED)
  })

  it('the AniList instance too: its live queue drains and its parked buckets stay (#693)', async () => {
    const { store, goOnline, anilist } = boot()
    goOnline()
    await settle()

    const sent = anilist.fake.upserts.map((u) => u.ref.malId)
    expect(sent.sort()).toEqual([1, 2])
    expect(anilist.fake.upserts.every((u) => u.session.userId === 1)).toBe(true)
    expect(store.get('anilistUpdateQueue')).toEqual([])
    expect(store.get('anilistParkedQueues')).toEqual(PARKED)
  })

  it('nothing drains while still offline', async () => {
    const { store } = boot()
    await settle()
    expect(getUserRate).not.toHaveBeenCalled()
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(2)
  })

  it('a 5xx during the online drain keeps that item and drains the rest (#602)', async () => {
    getUserRate.mockImplementation(async (_t, _u, malId: number) => {
      if (malId === 10) throw new ShikiApiError('Shikimori API error: 503', 503)
      return serverRate(malId)
    })
    const { store, goOnline } = boot()
    goOnline()
    await settle()
    expect(getUserRate.mock.calls.map((c) => c[2]).sort()).toEqual([10, 11])
    const kept = store.get('shikimoriUpdateQueue') as Array<{ malId: number; queuedAt: number }>
    expect(kept.map((q) => [q.malId, q.queuedAt])).toEqual([[10, 1]])
    expect(store.get('shikimoriParkedQueues')).toEqual(PARKED)
  })

  it('an OfflineError mid-drain (offline again) stops it and keeps the queue', async () => {
    const { OfflineError } = await import('../../src/main/lib/net')
    getUserRate.mockRejectedValue(new OfflineError())
    const { store, goOnline } = boot()
    goOnline()
    await settle()
    expect(getUserRate).toHaveBeenCalledTimes(1)
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(2)
  })

  it('a 429 during the online drain stops it and keeps the queue (#600)', async () => {
    getUserRate.mockReset().mockRejectedValue(new ShikiApiError('Shikimori API error: 429', 429))
    const { store, goOnline } = boot()
    goOnline()
    await settle()
    expect(getUserRate).toHaveBeenCalledTimes(1)
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(2)
    expect(store.get('shikimoriParkedQueues')).toEqual(PARKED)
  })
})

describe('AniList’s details prefetch on the online edge (#703)', () => {
  let server: AniListServer | null = null
  afterEach(() => {
    server?.restore()
    server = null
  })

  async function anilistEdge(details: () => AniListReply) {
    server = createAniListServer((call) =>
      call.operation === 'Details' ? details() : { status: 400, body: {} }
    )
    const row = (mal: number) => ({
      entry: {
        id: mal,
        mediaId: 100 + mal,
        status: 'CURRENT',
        score: 0,
        progress: 0,
        repeat: 0,
        updatedAt: 1,
        media: { id: 100 + mal, idMal: mal }
      },
      smotretAnime: null
    })
    const t = await createTestAniList({ seed: { anilistUserRates: [row(1), row(2)] } })
    const sync = createAniListSyncService(t.provider, {
      store: t.store as never,
      broadcast: () => {},
      syncStatusChannel: 's',
      offlineQueueChangedChannel: 'q',
      rateUpdatedChannel: 'r',
      ratesRefreshedChannel: 'rr'
    }) as unknown as TrackerSyncService<unknown, unknown>
    const kickoff = createOfflineKickoff({
      // As `index.ts` builds it.
      trackers: () =>
        kickoffTrackers(t.store, [sync], vi.fn(), { anilist: () => t.provider.prefetchDetails() }),
      suspendDownloads: vi.fn(),
      resumeDownloads: vi.fn(),
      suspendSyncplay: vi.fn(),
      resumeSyncplay: vi.fn(),
      retryBinaries: vi.fn(),
      runAutoDownloadTick: vi.fn()
    })
    return { t, kickoff }
  }

  it('the online edge schedules it at the PREFETCH_STAGGER_MS mark', async () => {
    const { kickoff, t } = await anilistEdge(() => ({
      body: { data: { Page: { media: [{ id: 101, idMal: 1, description: 'd', genres: [] }] } } }
    }))
    kickoff.onOnline()
    await vi.advanceTimersByTimeAsync(PREFETCH_STAGGER_MS - 1)
    expect(server!.of('Details')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(server!.of('Details')).toHaveLength(1))
    expect(server!.of('Details')[0].variables).toEqual({ ids: [1, 2] })
    await vi.waitFor(() =>
      expect(Object.keys(t.store.get('anilistAnimeDetails') as object)).toEqual(['1'])
    )
  })

  it('a failure logs [offline] AniList details prefetch failed:', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { kickoff } = await anilistEdge(() => ({ status: 500, body: {} }))
      kickoff.onOnline()
      await vi.advanceTimersByTimeAsync(PREFETCH_STAGGER_MS)
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[offline] AniList details prefetch failed:',
          expect.anything()
        )
      )
    } finally {
      warn.mockRestore()
    }
  })
})
