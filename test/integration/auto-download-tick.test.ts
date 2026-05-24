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

type AutoDownloaderModule = typeof import('../../src/main/auto-downloader')

interface Ctx {
  store: InMemoryStorage
  broadcast: ReturnType<typeof vi.fn>
  smotret: SmotretApiStub
  dlMgr: DownloadManagerStub
  refreshShikimoriDetails: ReturnType<typeof vi.fn>
  isShikimoriLoggedIn: ReturnType<typeof vi.fn>
  autoDl: AutoDownloaderModule
}

async function bootCtx(
  opts: {
    initialStore?: Record<string, unknown>
    loggedIn?: boolean
    refreshReturns?: unknown
  } = {}
): Promise<Ctx> {
  vi.resetModules()
  const harness = makeHarness({
    autoDownloadEnabled: true,
    autoDownloadSubscriptions: {},
    shikimoriAnimeDetails: {},
    downloadedEpisodes: {},
    translationType: 'subRu',
    ...opts.initialStore
  })
  const smotret = makeSmotretApiStub()
  const dlMgr = makeDownloadManagerStub()
  const refreshShikimoriDetails = vi.fn(async () => opts.refreshReturns ?? null)
  const isShikimoriLoggedIn = vi.fn(() => opts.loggedIn ?? true)
  const autoDl: AutoDownloaderModule = await import('../../src/main/auto-downloader')
  autoDl.initAutoDownloader({
    store: harness.store as unknown as Parameters<typeof autoDl.initAutoDownloader>[0]['store'],
    smotretApi: smotret as unknown as Parameters<typeof autoDl.initAutoDownloader>[0]['smotretApi'],
    downloadManager: dlMgr as unknown as Parameters<
      typeof autoDl.initAutoDownloader
    >[0]['downloadManager'],
    broadcast: harness.broadcast,
    isShikimoriLoggedIn,
    refreshShikimoriDetails
  })
  return {
    store: harness.store,
    broadcast: harness.broadcast,
    smotret,
    dlMgr,
    refreshShikimoriDetails,
    isShikimoriLoggedIn,
    autoDl
  }
}

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
