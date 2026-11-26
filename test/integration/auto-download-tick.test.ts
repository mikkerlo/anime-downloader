/**
 * Auto-downloader integration tests (Phase 7 PR 3, #140).
 *
 * Drives `runAutoDownloadTick` end-to-end with an in-memory `StorageService`,
 * a stub `SmotretApi`, and a stub `DownloadManager`. Resets the
 * `auto-downloader` module per test because it carries module-level
 * state (`deps`, `tickRunning`, `lockReleaseAt`).
 */
import { describe, it, expect, vi } from 'vitest'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import {
  makeHarness,
  makeSmotretApiStub,
  makeDownloadManagerStub,
  type SmotretApiStub,
  type DownloadManagerStub
} from '../helpers/app-harness'
import type { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeTracker, type FakeTracker } from '../helpers/fake-tracker'
import { createAiringDep, type AiringDep } from '../../src/main/trackers/feature-source'
import { createShikimoriProvider } from '../../src/main/trackers/shikimori.provider'
import { TRACKER_KEYS } from '../../src/main/trackers/keys'

type AutoDownloaderModule = typeof import('../../src/main/auto-downloader')

interface Ctx {
  store: InMemoryStorage
  broadcast: ReturnType<typeof vi.fn>
  smotret: SmotretApiStub
  dlMgr: DownloadManagerStub
  refreshShikimoriDetails: ReturnType<typeof vi.fn>
  /** The `airing` dep as `index.ts` builds it, with its read spied on. */
  airing: AiringDep & { getAiringInfo: ReturnType<typeof vi.fn> }
  anilist: FakeTracker<'anilist'>
  autoDl: AutoDownloaderModule
}

/** A tracker's account: `active` has a user and credentials, `expired` the user only. */
type AccountState = 'active' | 'expired'

function accountSeed(accounts: Partial<Record<TrackerId, AccountState>>): Record<string, unknown> {
  const seed: Record<string, unknown> = {}
  for (const [id, state] of Object.entries(accounts) as [TrackerId, AccountState][]) {
    const keys = TRACKER_KEYS[id]
    seed[keys.user] = { id: 1, nickname: `${id}-user`, avatar: null }
    seed[keys.credentials] = state === 'active' ? { access_token: `${id}-token` } : null
  }
  return seed
}

async function bootCtx(
  opts: {
    initialStore?: Record<string, unknown>
    /** Shikimori-only, as every case before #706: `false` is signed out. */
    loggedIn?: boolean
    /** Replaces the Shikimori-only accounts. */
    accounts?: Partial<Record<TrackerId, AccountState>>
    refreshReturns?: Partial<ShikiAnimeDetails> | null
  } = {}
): Promise<Ctx> {
  vi.resetModules()
  const accounts = opts.accounts ?? (opts.loggedIn === false ? {} : { shikimori: 'active' })
  const harness = makeHarness({
    autoDownloadEnabled: true,
    autoDownloadSubscriptions: {},
    shikimoriAnimeDetails: {},
    anilistUserRates: [],
    downloadedEpisodes: {},
    translationType: 'subRu',
    trackerPrimary: null,
    trackerFeatureSource: {},
    ...accountSeed(accounts),
    ...opts.initialStore
  })
  const smotret = makeSmotretApiStub()
  const dlMgr = makeDownloadManagerStub()
  // The fixture names only the fields the tick reads (`episodes_aired`,
  // `episodes`), so the partial is widened here, once, rather than every case
  // spelling out the other fifteen.
  const refreshShikimoriDetails = vi.fn(
    async (_malId: number): Promise<ShikiAnimeDetails | null> =>
      (opts.refreshReturns ?? null) as ShikiAnimeDetails | null
  )
  const anilist = createFakeTracker('anilist', { store: harness.store })
  const dep = createAiringDep({
    store: harness.store,
    providers: {
      shikimori: createShikimoriProvider({
        store: harness.store,
        refreshDetails: refreshShikimoriDetails
      }),
      anilist: anilist.provider,
      mal: createFakeTracker('mal').provider
    }
  })
  const airing = { ...dep, getAiringInfo: vi.fn(dep.getAiringInfo) }
  const autoDl: AutoDownloaderModule = await import('../../src/main/auto-downloader')
  autoDl.initAutoDownloader({
    store: harness.store as unknown as Parameters<typeof autoDl.initAutoDownloader>[0]['store'],
    smotretApi: smotret as unknown as Parameters<typeof autoDl.initAutoDownloader>[0]['smotretApi'],
    downloadManager: dlMgr as unknown as Parameters<
      typeof autoDl.initAutoDownloader
    >[0]['downloadManager'],
    broadcast: harness.broadcast,
    airing
  })
  return {
    store: harness.store,
    broadcast: harness.broadcast,
    smotret,
    dlMgr,
    refreshShikimoriDetails,
    airing,
    anilist,
    autoDl
  }
}

/** smotret answers each listed episode with one 720p `subRu` translation. */
function serveEpisodes(ctx: Ctx, ints: number[]): void {
  ctx.smotret.getAnime.mockResolvedValue({
    data: { episodes: ints.map((n) => ({ id: 100 + n, episodeInt: String(n) })) }
  })
  ctx.smotret.getEpisode.mockImplementation(async (id: number) => ({
    data: {
      id,
      episodeFull: String(id - 100),
      translations: [{ id: id * 10, type: 'subRu', isActive: 1, height: 720, authorsSummary: 'A' }]
    }
  }))
  ctx.smotret.getEmbed.mockResolvedValue({ stream: [{ height: 720, urls: ['x'] }] })
}

const enqueuedEpisodes = (ctx: Ctx): string[] =>
  ctx.dlMgr.enqueue.mock.calls.map((c) => (c[0][0] as { episodeInt: string }).episodeInt)

function sub(opts: { animeId: number; malId: number; lastEnqueued?: number; name?: string }) {
  return {
    [String(opts.animeId)]: {
      animeId: opts.animeId,
      malId: opts.malId,
      animeName: opts.name ?? 'Anime',
      subscribedAt: 0,
      lastEnqueuedEpisodeInt: opts.lastEnqueued ?? 0,
      lastCheckedAt: 0,
      initialEpisodesAired: opts.lastEnqueued ?? 0
    }
  }
}

function detailsCache(malId: number, opts: { aired: number; total: number }) {
  return {
    [String(malId)]: {
      details: { episodes_aired: opts.aired, episodes: opts.total },
      fetchedAt: Date.now()
    }
  }
}

describe('runAutoDownloadTick — gating', () => {
  it('emits an empty result + AUTO_DL_TICK_RESULT when autoDownloadEnabled is false', async () => {
    const ctx = await bootCtx({ initialStore: { autoDownloadEnabled: false } })
    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(0)
    expect(result.skipped).toBe(0)
    expect(ctx.dlMgr.enqueue).not.toHaveBeenCalled()
    expect(ctx.broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.AUTO_DL_TICK_RESULT, result)
  })

  it('returns immediately with no subscriptions', async () => {
    const ctx = await bootCtx({ initialStore: { autoDownloadSubscriptions: {} } })
    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(0)
    expect(ctx.smotret.getAnime).not.toHaveBeenCalled()
  })

  it('returns immediately when not logged in to Shikimori', async () => {
    const ctx = await bootCtx({
      loggedIn: false,
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 5, total: 12 })
      }
    })
    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(0)
    expect(ctx.smotret.getAnime).not.toHaveBeenCalled()
  })

  it('skips a subscription when episodes_aired is 0', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 0, total: 12 })
      }
    })
    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.details).toContainEqual(
      expect.objectContaining({ animeId: 1, outcome: 'no-episodes-aired' })
    )
    expect(ctx.dlMgr.enqueue).not.toHaveBeenCalled()
  })
})

describe('runAutoDownloadTick — enqueue flow', () => {
  it('enqueues a single new episode end-to-end', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9, lastEnqueued: 0 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 1, total: 12 })
      }
    })
    ctx.smotret.getAnime.mockResolvedValue({
      data: { episodes: [{ id: 100, episodeInt: '1' }] }
    })
    ctx.smotret.getEpisode.mockResolvedValue({
      data: {
        id: 100,
        episodeFull: '1',
        translations: [
          {
            id: 1001,
            type: 'subRu',
            isActive: 1,
            height: 1080,
            authorsSummary: 'Subber'
          }
        ]
      }
    })
    ctx.smotret.getEmbed.mockResolvedValue({
      stream: [{ height: 1080, urls: ['https://x'] }]
    })

    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(1)
    expect(ctx.dlMgr.enqueue).toHaveBeenCalledTimes(1)
    const req = ctx.dlMgr.enqueue.mock.calls[0][0][0] as { translationId: number; height: number }
    expect(req.translationId).toBe(1001)
    expect(req.height).toBe(1080)
    expect(ctx.broadcast).toHaveBeenCalledWith(
      EVENT_CHANNELS.AUTO_DL_ENQUEUED,
      expect.objectContaining({ animeId: 1, episodeInt: '1' })
    )
  })

  it('skips episodes that are already downloaded but advances lastEnqueued', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9, lastEnqueued: 0 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 2, total: 12 }),
        downloadedEpisodes: { '1:1': { translationType: 'subRu' } }
      }
    })
    ctx.smotret.getAnime.mockResolvedValue({
      data: { episodes: [{ id: 101, episodeInt: '2' }] }
    })
    ctx.smotret.getEpisode.mockResolvedValue({
      data: {
        id: 101,
        episodeFull: '2',
        translations: [{ id: 2001, type: 'subRu', isActive: 1, height: 720, authorsSummary: 'A' }]
      }
    })
    ctx.smotret.getEmbed.mockResolvedValue({ stream: [{ height: 720, urls: ['x'] }] })

    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    // Episode 1 was already downloaded → skipped; episode 2 was enqueued
    expect(result.enqueued).toBe(1)
    expect(result.details).toContainEqual(
      expect.objectContaining({ episodeInt: '1', outcome: 'already-downloaded' })
    )
    expect(result.details).toContainEqual(
      expect.objectContaining({ episodeInt: '2', outcome: 'enqueued' })
    )
  })

  it('caps at MAX_ENQUEUES_PER_TICK = 10 and surfaces cap-reached', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9, lastEnqueued: 0 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 20, total: 24 })
      }
    })
    ctx.smotret.getAnime.mockResolvedValue({
      data: {
        episodes: Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, episodeInt: String(i + 1) }))
      }
    })
    ctx.smotret.getEpisode.mockImplementation(async (id: number) => ({
      data: {
        id,
        episodeFull: String(id - 99),
        translations: [
          { id: id * 10, type: 'subRu', isActive: 1, height: 720, authorsSummary: 'A' }
        ]
      }
    }))
    ctx.smotret.getEmbed.mockResolvedValue({ stream: [{ height: 720, urls: ['x'] }] })

    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(10)
    expect(result.details).toContainEqual(expect.objectContaining({ outcome: 'cap-reached' }))
  })

  it('marks no-translation outcome when active translations do not match user preference', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9, lastEnqueued: 0 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 1, total: 12 })
      }
    })
    ctx.smotret.getAnime.mockResolvedValue({
      data: { episodes: [{ id: 100, episodeInt: '1' }] }
    })
    ctx.smotret.getEpisode.mockResolvedValue({
      data: {
        id: 100,
        episodeFull: '1',
        translations: [
          // Only voice translations available, but user preference is subRu (the global default)
          { id: 999, type: 'voiceEn', isActive: 1, height: 720, authorsSummary: 'B' }
        ]
      }
    })

    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.details).toContainEqual(
      expect.objectContaining({ animeId: 1, outcome: 'no-translation' })
    )
  })

  it('records error outcome when smotret API throws', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9, lastEnqueued: 0 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 1, total: 12 })
      }
    })
    ctx.smotret.getAnime.mockRejectedValue(new Error('smotret-api-down'))

    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.errors).toBe(1)
    expect(result.details).toContainEqual(
      expect.objectContaining({ animeId: 1, outcome: 'error', message: 'smotret-api-down' })
    )
  })

  it('persists updated lastEnqueuedEpisodeInt after a successful enqueue', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9, lastEnqueued: 0 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 3, total: 12 })
      }
    })
    ctx.smotret.getAnime.mockResolvedValue({
      data: {
        episodes: [
          { id: 100, episodeInt: '1' },
          { id: 101, episodeInt: '2' },
          { id: 102, episodeInt: '3' }
        ]
      }
    })
    ctx.smotret.getEpisode.mockImplementation(async (id: number) => ({
      data: {
        id,
        episodeFull: String(id - 99),
        translations: [
          { id: id * 10, type: 'subRu', isActive: 1, height: 720, authorsSummary: 'A' }
        ]
      }
    }))
    ctx.smotret.getEmbed.mockResolvedValue({ stream: [{ height: 720, urls: ['x'] }] })

    await ctx.autoDl.runAutoDownloadTick('manual')
    const subs = ctx.store.get('autoDownloadSubscriptions') as Record<
      string,
      { lastEnqueuedEpisodeInt: number }
    >
    expect(subs['1'].lastEnqueuedEpisodeInt).toBe(3)
  })

  it('respects reentrancy lock — a second concurrent tick is a no-op', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 9, lastEnqueued: 0 }),
        shikimoriAnimeDetails: detailsCache(9, { aired: 1, total: 12 })
      }
    })
    let resolveFirst!: () => void
    ctx.smotret.getAnime.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFirst = () => r({ data: { episodes: [{ id: 100, episodeInt: '1' }] } } as never)
        })
    )
    ctx.smotret.getEpisode.mockResolvedValue({
      data: {
        id: 100,
        episodeFull: '1',
        translations: [{ id: 1001, type: 'subRu', isActive: 1, height: 720, authorsSummary: 'A' }]
      }
    })
    ctx.smotret.getEmbed.mockResolvedValue({ stream: [{ height: 720, urls: ['x'] }] })

    const p1 = ctx.autoDl.runAutoDownloadTick('manual')
    const p2 = ctx.autoDl.runAutoDownloadTick('manual')
    // The aired count is an awaited `getAiringInfo` read (#706), so p1 reaches
    // smotret a few microtasks in; p2 was already refused at the lock.
    await vi.waitFor(() => expect(ctx.smotret.getAnime).toHaveBeenCalled())
    resolveFirst()
    const [r1, r2] = await Promise.all([p1, p2])
    // r2 ran while r1 still held the lock → r2 should be a no-op
    expect(r1.enqueued).toBe(1)
    expect(r2.enqueued).toBe(0)
    expect(ctx.dlMgr.enqueue).toHaveBeenCalledTimes(1)
  })
})

describe('setSubscription', () => {
  it('removes the subscription when enabled=false', async () => {
    const ctx = await bootCtx({
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 5, malId: 9 })
      }
    })
    const result = await ctx.autoDl.setSubscription(5, false)
    expect(result).toBeNull()
    const map = ctx.store.get('autoDownloadSubscriptions') as Record<string, unknown>
    expect(map['5']).toBeUndefined()
  })

  it('refuses to subscribe when cache is missing AND refreshShikimoriDetails returns null', async () => {
    const ctx = await bootCtx({ refreshReturns: null })
    const result = await ctx.autoDl.setSubscription(5, true, { malId: 9, animeName: 'X' })
    expect(result).toBeNull()
    expect(ctx.refreshShikimoriDetails).toHaveBeenCalledWith(9)
  })

  it('stamps lastEnqueuedEpisodeInt to episodes_aired so it does not backfill', async () => {
    const ctx = await bootCtx({
      refreshReturns: { episodes_aired: 7, episodes: 12 }
    })
    const result = await ctx.autoDl.setSubscription(5, true, { malId: 9, animeName: 'X' })
    expect(result?.lastEnqueuedEpisodeInt).toBe(7)
    expect(result?.initialEpisodesAired).toBe(7)
  })
})

// #706: the tick and `setSubscription` read the resolved `airing` source, and
// the tick runs while that source has credentials. MAL ids 1 and 2 are mapped
// on the fake AniList; 9999 isn't.
describe('the airing source (#706)', () => {
  const AIRED_6 = { episodesAired: 6, episodes: 12 }

  it('only AniList: a subscription at 5 enqueues episode 6, and shikimoriAnimeDetails is never read', async () => {
    const ctx = await bootCtx({
      accounts: { anilist: 'active' },
      initialStore: { autoDownloadSubscriptions: sub({ animeId: 1, malId: 1, lastEnqueued: 5 }) }
    })
    ctx.anilist.airing.set(1, AIRED_6)
    serveEpisodes(ctx, [5, 6])
    const get = vi.spyOn(ctx.store, 'get')

    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(1)
    expect(enqueuedEpisodes(ctx)).toEqual(['6'])
    expect(ctx.airing.getAiringInfo).toHaveBeenCalledWith('anilist', 1)
    expect(get.mock.calls.filter(([k]) => k === 'shikimoriAnimeDetails')).toEqual([])
    expect(ctx.refreshShikimoriDetails).not.toHaveBeenCalled()
  })

  it('MAL-only: the tick returns at the gate; no smotret read and no getAiringInfo on any provider', async () => {
    const ctx = await bootCtx({
      accounts: { mal: 'active' },
      initialStore: { autoDownloadSubscriptions: sub({ animeId: 1, malId: 1, lastEnqueued: 0 }) }
    })
    expect(ctx.airing.source()).toBeNull()
    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.details).toEqual([])
    expect(ctx.smotret.getAnime).not.toHaveBeenCalled()
    expect(ctx.airing.getAiringInfo).not.toHaveBeenCalled()
    expect(ctx.broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.AUTO_DL_TICK_RESULT, result)
  })

  it('an active AniList session does not open the tick while the Shikimori source has expired', async () => {
    const ctx = await bootCtx({
      accounts: { shikimori: 'expired', anilist: 'active' },
      initialStore: {
        trackerPrimary: 'shikimori',
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 1, lastEnqueued: 5 }),
        // Both would enqueue episode 6 if the tick opened.
        shikimoriAnimeDetails: detailsCache(1, { aired: 6, total: 12 })
      }
    })
    ctx.anilist.airing.set(1, AIRED_6)
    serveEpisodes(ctx, [6])
    // An expired session keeps its source.
    expect(ctx.airing.source()).toBe('shikimori')

    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.enqueued).toBe(0)
    expect(ctx.dlMgr.enqueue).not.toHaveBeenCalled()
    expect(ctx.airing.getAiringInfo).not.toHaveBeenCalled()
    expect(ctx.anilist.serverReads).toEqual([])
  })

  it('a null from AniList (no mapping) is no-episodes-aired', async () => {
    const ctx = await bootCtx({
      accounts: { anilist: 'active' },
      initialStore: { autoDownloadSubscriptions: sub({ animeId: 1, malId: 9999, lastEnqueued: 0 }) }
    })
    const result = await ctx.autoDl.runAutoDownloadTick('manual')
    expect(result.details).toEqual([
      { animeId: 1, animeName: 'Anime', episodeInt: '', outcome: 'no-episodes-aired' }
    ])
    expect(ctx.smotret.getAnime).not.toHaveBeenCalled()
  })

  it('a fresh on-list AniList title answers from the list cache: episode 6 only, no server read', async () => {
    const ctx = await bootCtx({
      accounts: { anilist: 'active' },
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 1, lastEnqueued: 5 }),
        anilistUserRates: [{ malId: 1, airing: { ...AIRED_6, fetchedAt: Date.now() - 60_000 } }]
      }
    })
    // The server is ahead of the cached list.
    ctx.anilist.airing.set(1, { episodesAired: 7, episodes: 12 })
    serveEpisodes(ctx, [6, 7])

    await ctx.autoDl.runAutoDownloadTick('manual')
    expect(enqueuedEpisodes(ctx)).toEqual(['6'])
    expect(ctx.anilist.serverReads).toEqual([])
  })

  it('a list cache older than 6 h goes to the server', async () => {
    const ctx = await bootCtx({
      accounts: { anilist: 'active' },
      initialStore: {
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 1, lastEnqueued: 5 }),
        anilistUserRates: [
          { malId: 1, airing: { ...AIRED_6, fetchedAt: Date.now() - 7 * 60 * 60 * 1000 } }
        ]
      }
    })
    ctx.anilist.airing.set(1, { episodesAired: 7, episodes: 12 })
    serveEpisodes(ctx, [6, 7])

    await ctx.autoDl.runAutoDownloadTick('manual')
    expect(enqueuedEpisodes(ctx)).toEqual(['6', '7'])
    expect(ctx.anilist.serverReads).toEqual([{ member: 'getAiringInfo', malId: 1 }])
  })

  it('a null episode total is no cap', async () => {
    const ctx = await bootCtx({
      accounts: { anilist: 'active' },
      initialStore: { autoDownloadSubscriptions: sub({ animeId: 1, malId: 1, lastEnqueued: 13 }) }
    })
    ctx.anilist.airing.set(1, { episodesAired: 14, episodes: null })
    serveEpisodes(ctx, [14])
    await ctx.autoDl.runAutoDownloadTick('manual')
    expect(enqueuedEpisodes(ctx)).toEqual(['14'])
  })

  it('an override picks the source: AniList over a Shikimori primary', async () => {
    const ctx = await bootCtx({
      accounts: { shikimori: 'active', anilist: 'active' },
      initialStore: {
        trackerPrimary: 'shikimori',
        trackerFeatureSource: { airing: 'anilist' },
        autoDownloadSubscriptions: sub({ animeId: 1, malId: 1, lastEnqueued: 5 }),
        shikimoriAnimeDetails: detailsCache(1, { aired: 8, total: 12 })
      }
    })
    ctx.anilist.airing.set(1, AIRED_6)
    serveEpisodes(ctx, [6, 7, 8])
    await ctx.autoDl.runAutoDownloadTick('manual')
    expect(enqueuedEpisodes(ctx)).toEqual(['6'])
  })

  it('setSubscription stamps lastEnqueuedEpisodeInt from the AniList source', async () => {
    const ctx = await bootCtx({ accounts: { anilist: 'active' } })
    ctx.anilist.airing.set(1, AIRED_6)
    const result = await ctx.autoDl.setSubscription(5, true, { malId: 1, animeName: 'X' })
    expect(result?.lastEnqueuedEpisodeInt).toBe(6)
    expect(result?.initialEpisodesAired).toBe(6)
    expect(ctx.refreshShikimoriDetails).not.toHaveBeenCalled()
  })

  it('setSubscription still refuses when the source reads 0 aired, or there is no source', async () => {
    const ctx = await bootCtx({ accounts: { anilist: 'active' } })
    ctx.anilist.airing.set(1, { episodesAired: 0, episodes: 12 })
    expect(await ctx.autoDl.setSubscription(5, true, { malId: 1, animeName: 'X' })).toBeNull()

    const malOnly = await bootCtx({ accounts: { mal: 'active' } })
    expect(await malOnly.autoDl.setSubscription(5, true, { malId: 1, animeName: 'X' })).toBeNull()
    expect(malOnly.airing.getAiringInfo).not.toHaveBeenCalled()
  })
})

describe('tickIfAiringSource (#706)', () => {
  async function wire(
    accounts: Partial<Record<TrackerId, AccountState>>,
    extra: Record<string, unknown> = {}
  ) {
    const { createTickIfAiringSource } = await import('../../src/main/trackers/feature-source')
    const store = makeHarness({ ...accountSeed(accounts), ...extra }).store
    const runTick = vi.fn(async () => ({}))
    return { tick: createTickIfAiringSource({ store, runTick }), runTick }
  }

  it("AniList's refresh runs one 'rates-refreshed' tick while AniList is the airing source", async () => {
    const { tick, runTick } = await wire({ anilist: 'active' })
    tick('anilist')
    expect(runTick).toHaveBeenCalledTimes(1)
  })

  it('and none while Shikimori is', async () => {
    const { tick, runTick } = await wire(
      { shikimori: 'active', anilist: 'active' },
      { trackerPrimary: 'shikimori' }
    )
    tick('anilist')
    expect(runTick).not.toHaveBeenCalled()
  })

  it('a failed tick is logged, not thrown', async () => {
    const { createTickIfAiringSource } = await import('../../src/main/trackers/feature-source')
    const store = makeHarness(accountSeed({ anilist: 'active' })).store
    const warn = vi.fn()
    const tick = createTickIfAiringSource({
      store,
      runTick: async () => {
        throw new Error('boom')
      },
      log: { warn }
    })
    tick('anilist')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
  })
})
