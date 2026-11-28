// @vitest-environment happy-dom
// The detail page's rate panel edits the primary tracker, whichever it is
// (#704). An AniList-only user gets the panel, its form filled from
// `tracker:get-rate`, and a save through `tracker:update-rate`.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AnimeDetailView from '../../../src/renderer/src/components/views/AnimeDetailView.vue'
import { offlineApi } from '../../helpers/offline-api'

type CallableThenable = {
  (): unknown
  then?: unknown
  catch?: unknown
  finally?: unknown
}

// Callable + thenable stub for any window.api.* method not explicitly mocked.
function makeThenable(): unknown {
  const fn: CallableThenable = (): unknown => fn
  fn.then = (res?: (v: unknown) => void): unknown => {
    res?.(undefined)
    return fn
  }
  fn.catch = (): unknown => fn
  fn.finally = (f?: () => void): unknown => {
    f?.()
    return fn
  }
  return fn
}

const MAL_ID = 5114

function detail(): AnimeDetail {
  return {
    id: 1,
    title: 'Test Anime',
    titles: { romaji: 'Tesuto' },
    posterUrlSmall: 'poster.jpg',
    posterUrl: 'poster.jpg',
    myAnimeListId: MAL_ID,
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2021,
    season: 'spring',
    episodes: [
      {
        id: 10,
        episodeInt: '1',
        episodeFull: 'Episode 1',
        episodeType: 'tv',
        isActive: 1,
        firstUploadedDateTime: '2025-01-01'
      }
    ]
  } as unknown as AnimeDetail
}

function anilistAccount(opts: { expired?: boolean } = {}): TrackerAccount {
  return {
    trackerId: 'anilist',
    user: { id: 7, nickname: 'al-user', avatar: null },
    hasCredentials: !opts.expired,
    sessionExpired: opts.expired === true,
    needsSetup: false,
    credentialState: opts.expired ? 'none' : 'ok'
  }
}

function signedOut(trackerId: TrackerId): TrackerAccount {
  return {
    trackerId,
    user: null,
    hasCredentials: false,
    sessionExpired: false,
    needsSetup: false,
    credentialState: 'none'
  }
}

function syncStatus(over: Partial<TrackerSyncStatus> = {}): TrackerSyncStatus {
  return {
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false,
    needsSetup: false,
    ...over
  }
}

function installApi(opts: { expired?: boolean; queueLength?: number } = {}) {
  const api = {
    getAnimeCache: vi.fn().mockResolvedValue(null),
    getAnime: vi.fn().mockResolvedValue({ source: 'api', data: detail() }),
    getEpisodesBatchCached: vi.fn().mockResolvedValue({ data: [], source: 'cache' }),
    getEpisodesBatch: vi.fn().mockResolvedValue({ data: [] }),
    fileCheckEpisodes: vi.fn().mockResolvedValue({}),
    downloadedEpisodesGet: vi.fn().mockResolvedValue({}),
    watchProgressGetAll: vi.fn().mockResolvedValue({}),
    probeEmbedQuality: vi.fn().mockResolvedValue(null),
    getSetting: vi.fn().mockResolvedValue(false),
    libraryHas: vi.fn().mockResolvedValue(false),
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    libraryIsDownloaded: vi.fn().mockResolvedValue(false),
    autoDlGetSubscription: vi.fn().mockResolvedValue(null),
    shikimoriGetUser: vi.fn().mockResolvedValue(null),
    shikimoriGetSyncStatus: vi.fn().mockResolvedValue({ state: 'idle', queueLength: 0 }),
    shikimoriGetOfflineQueueLength: vi.fn().mockResolvedValue(0),
    shikimoriGetRate: vi.fn().mockResolvedValue(null),
    shikimoriUpdateRate: vi.fn().mockResolvedValue(null),
    trackerGetRelated: vi.fn().mockResolvedValue([]),
    trackerListAccounts: vi.fn().mockResolvedValue({
      accounts: [signedOut('shikimori'), anilistAccount(opts), signedOut('mal')],
      primary: 'anilist',
      mirror: {},
      featureSources: {},
      newTrackerCardsEnabled: false
    } satisfies TrackerAccountsState),
    trackerGetRates: vi.fn(async (trackerId: TrackerId) => ({
      trackerId,
      entries: [],
      queuedAfter: {}
    })),
    trackerGetSyncStatus: vi
      .fn()
      .mockResolvedValue(
        syncStatus({ sessionExpired: opts.expired === true, queueLength: opts.queueLength ?? 0 })
      ),
    trackerGetOfflineQueueLength: vi.fn().mockResolvedValue(opts.queueLength ?? 0),
    trackerGetRate: vi.fn().mockResolvedValue({
      values: { status: 'watching', episodes: 7, score: 8, rewatches: 0 },
      stale: false
    } satisfies TrackerRateResult),
    trackerUpdateRate: vi.fn(async (_malId: number, change: TrackerRateValues) => change),
    // The Friends block's merged read (#712): an array, as main answers.
    trackerGetFriendsRates: vi.fn().mockResolvedValue([])
  }
  const target = { ...offlineApi().api, ...api }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get: (t, p, r) => (p in t ? Reflect.get(t, p, r) : () => makeThenable())
  })
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('TrackerPanel — an AniList primary (#704)', () => {
  it('renders the AniList rate from tracker:get-rate and saves through tracker:update-rate', async () => {
    const api = installApi()
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    const header = wrapper.find('.sk-logo')
    expect(header.exists()).toBe(true)
    expect(header.element.parentElement?.textContent).toContain('AniList')
    expect(api.trackerGetRate).toHaveBeenCalledWith('anilist', MAL_ID)
    expect(wrapper.find('.status-seg button.on').text()).toBe('Watching')
    expect((wrapper.find('#shiki-ep').element as HTMLInputElement).value).toBe('7')

    await wrapper.find('.sk-save-btn').trigger('click')
    await flushPromises()
    expect(api.trackerUpdateRate).toHaveBeenCalledTimes(1)
    expect(api.trackerUpdateRate).toHaveBeenCalledWith(MAL_ID, {
      episodes: 7,
      status: 'watching',
      score: 8,
      rewatches: 0
    })
    expect(api.shikimoriUpdateRate).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  // The panel gates on `anyAccount`: an expired session keeps its user, so the
  // panel and its "Sign in again" banner stay.
  it('an expired AniList session keeps the panel mounted, with the AniList banner', async () => {
    installApi({ expired: true, queueLength: 2 })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    const banner = wrapper.find('.shiki-expired')
    expect(banner.exists()).toBe(true)
    expect(banner.find('.shiki-expired-title').text()).toBe('AniList session expired')
    expect(banner.text()).toMatch(/2 changes pending/)
    wrapper.unmount()
  })
})
