// The background gates of #567: while offline these do not *schedule* network
// work at all, rather than relying on `fetchWithTimeout`'s refusal. Each case
// checks a stubbed `fetch` (rejecting, so a regression reds without touching
// the network) and the collaborators the job would otherwise call.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { ensureFfmpeg, getFfmpegDir, clearFfmpegPaths } from '../../src/main/ffmpeg-binaries'
import { ensureFpcalc, getFpcalcDir } from '../../src/main/fpcalc-binaries'
import { setOfflineCheck } from '../../src/main/lib/net'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { makeDownloadManagerStub, makeSmotretApiStub, makeHarness } from '../helpers/app-harness'

let fetchSpy: Mock
let offline = true
const isOffline = (): boolean => offline

beforeEach(() => {
  offline = true
  fetchSpy = vi.fn(async () => {
    throw new Error('network access is not expected in this test')
  })
  vi.stubGlobal('fetch', fetchSpy)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('auto-download ticks', () => {
  async function boot(): Promise<{
    autoDl: typeof import('../../src/main/auto-downloader')
    smotret: ReturnType<typeof makeSmotretApiStub>
    refresh: Mock
    dlMgr: ReturnType<typeof makeDownloadManagerStub>
  }> {
    vi.resetModules()
    const h = makeHarness({
      autoDownloadEnabled: true,
      autoDownloadSubscriptions: {
        '1': {
          animeId: 1,
          malId: 9,
          animeName: 'A',
          subscribedAt: 0,
          lastEnqueuedEpisodeInt: 0,
          lastCheckedAt: 0,
          initialEpisodesAired: 0
        }
      },
      shikimoriAnimeDetails: {},
      downloadedEpisodes: {},
      translationType: 'subRu'
    })
    const smotret = makeSmotretApiStub()
    const dlMgr = makeDownloadManagerStub()
    const refresh = vi.fn(async () => null)
    const autoDl = await import('../../src/main/auto-downloader')
    autoDl.initAutoDownloader({
      store: h.store as never,
      smotretApi: smotret as never,
      downloadManager: dlMgr as never,
      broadcast: h.broadcast,
      isShikimoriLoggedIn: () => true,
      refreshShikimoriDetails: refresh,
      isOffline
    })
    return { autoDl, smotret, refresh, dlMgr }
  }

  it.each(['startup', 'timer', 'manual'] as const)(
    'a %s tick returns before touching the network',
    async (reason) => {
      const { autoDl, smotret, refresh, dlMgr } = await boot()
      const result = await autoDl.runAutoDownloadTick(reason)
      expect(result.enqueued).toBe(0)
      expect(refresh).not.toHaveBeenCalled()
      expect(smotret.getAnime).not.toHaveBeenCalled()
      expect(dlMgr.enqueue).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  )

  it('an offline tick does not take the re-entrancy lock, so the next online tick runs', async () => {
    const { autoDl, refresh } = await boot()
    await autoDl.runAutoDownloadTick('timer')
    offline = false
    await autoDl.runAutoDownloadTick('timer')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('the 15-minute timer ticks make no network call while offline', async () => {
    vi.useFakeTimers()
    const { autoDl, refresh } = await boot()
    autoDl.startAutoDownloaderTimer()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(refresh).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('Shikimori sync timer, drain and prefetch', () => {
  function service(store: InMemoryStorage): ReturnType<typeof createShikimoriSyncService> {
    return createShikimoriSyncService({
      store,
      broadcast: vi.fn(),
      syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
      offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
      rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
      animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
      isOffline
    })
  }

  function signedInStore(): InMemoryStorage {
    return new InMemoryStorage({
      shikimoriCredentials: {
        access_token: 'a',
        refresh_token: 'r',
        // Expired: a drain that ran would start with a token refresh.
        created_at: 0,
        expires_in: 1
      },
      shikimoriUser: { id: 7, nickname: 'me' },
      shikimoriUpdateQueue: [
        {
          malId: 42,
          before: { episodes: 1, status: 'watching', score: 0 },
          after: { episodes: 2, status: 'watching', score: 0 },
          queuedAt: 1,
          ownerId: 7
        }
      ],
      shikimoriParkedQueues: {},
      shikimoriUserRates: [{ rate: { target_id: 42, status: 'watching', episodes: 1 } }],
      shikimoriAnimeDetails: {}
    })
  }

  it('the drain returns early and keeps the queue', async () => {
    const store = signedInStore()
    await service(store).syncShikimoriQueue()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(1)
  })

  it('the 60 s sync timer ticks make no network call while offline', async () => {
    vi.useFakeTimers()
    const store = signedInStore()
    const sync = service(store)
    sync.startSyncTimer()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    sync.stopSyncTimer()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(1)
  })

  it('the details prefetch returns early', async () => {
    const store = signedInStore()
    await service(store).prefetchShikimoriDetails()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the same drain does reach the network online (the control)', async () => {
    offline = false
    const store = signedInStore()
    await service(store).syncShikimoriQueue()
    expect(fetchSpy).toHaveBeenCalled()
  })
})

describe('first-launch binary installs', () => {
  let userData: string
  // A private userData: the shared electron-mock one is where
  // ffmpeg-binaries.test.ts seeds its fake binaries, in a parallel worker.
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-gates-ud-'))
    vi.mocked(app.getPath).mockReturnValue(userData)
    clearFfmpegPaths()
  })

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true })
  })

  it('uses the private userData', () => {
    expect(getFfmpegDir().startsWith(userData)).toBe(true)
    expect(getFpcalcDir().startsWith(userData)).toBe(true)
  })

  it('ensureFfmpeg skips the download while offline, without failing or reporting', async () => {
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    expect(await ensureFfmpeg(win as never, isOffline)).toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('ensureFpcalc skips the download while offline', async () => {
    expect(await ensureFpcalc(undefined, isOffline)).toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an install refused mid-way by the offline switch defers instead of reporting failure', async () => {
    // The install's own check said online; `fetchWithTimeout` then refuses.
    offline = false
    setOfflineCheck(() => true)
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    try {
      expect(await ensureFpcalc(win as never, isOffline)).toBe('')
    } finally {
      setOfflineCheck(null)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    const statuses = send.mock.calls.map((c) => (c[1] as { status: string }).status)
    expect(statuses).not.toContain('failed')
    expect(statuses.at(-1)).toBe('deferred')
  })

  it('online, the same call does try the network (the control)', async () => {
    offline = false
    await ensureFfmpeg(undefined, isOffline).catch(() => {})
    expect(fetchSpy).toHaveBeenCalled()
  })
})
