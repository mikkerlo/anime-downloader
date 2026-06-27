// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AnimeDetailView from '../../../src/renderer/src/components/views/AnimeDetailView.vue'

// Callable + thenable stub for any window.api.* method not explicitly mocked.
function makeThenable(): unknown {
  const fn = (): unknown => fn
  ;(fn as { then: unknown }).then = (res?: (v: unknown) => void): unknown => {
    res?.(undefined)
    return fn
  }
  ;(fn as { catch: unknown }).catch = (): unknown => fn
  ;(fn as { finally: unknown }).finally = (f?: () => void): unknown => {
    f?.()
    return fn
  }
  return fn
}

function detail(overrides: Partial<AnimeDetail> = {}): AnimeDetail {
  return {
    id: 1,
    title: 'Test Anime',
    titles: { romaji: 'Tesuto', ja: 'テスト' },
    posterUrlSmall: 'poster.jpg',
    posterUrl: 'poster.jpg',
    numberOfEpisodes: 1,
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
    ],
    ...overrides
  } as unknown as AnimeDetail
}

function episodeDetail(translationId: number): EpisodeDetail {
  return {
    id: 10,
    episodeFull: 'Episode 1',
    episodeInt: '1',
    episodeType: 'tv',
    translations: [
      { id: translationId, type: 'subRu', authorsSummary: 'A', height: 720, isActive: 1 }
    ]
  } as unknown as EpisodeDetail
}

interface ApiOverrides {
  getAnimeCache?: ReturnType<typeof vi.fn>
  getAnime?: ReturnType<typeof vi.fn>
}

function installApi(overrides: ApiOverrides = {}): Record<string, ReturnType<typeof vi.fn>> {
  const base: Record<string, ReturnType<typeof vi.fn>> = {
    getAnimeCache: overrides.getAnimeCache ?? vi.fn().mockResolvedValue(null),
    getAnime: overrides.getAnime ?? vi.fn().mockResolvedValue({ source: 'api', data: detail() }),
    setAnimeCache: vi.fn().mockResolvedValue(undefined),
    getEpisodesBatchCached: vi
      .fn()
      .mockResolvedValue({ data: [episodeDetail(700)], source: 'cache' }),
    getEpisodesBatch: vi.fn().mockResolvedValue({ data: [episodeDetail(700)] }),
    fileCheckEpisodes: vi.fn().mockResolvedValue({}),
    downloadedEpisodesGet: vi.fn().mockResolvedValue({}),
    watchProgressGetAll: vi.fn().mockResolvedValue({}),
    probeEmbedQuality: vi.fn().mockResolvedValue(null),
    getSetting: vi.fn().mockResolvedValue(false),
    libraryHas: vi.fn().mockResolvedValue(false),
    libraryIsDownloaded: vi.fn().mockResolvedValue(false),
    autoDlGetSubscription: vi.fn().mockResolvedValue(null),
    shikimoriGetUser: vi.fn().mockResolvedValue(null),
    shikimoriGetSyncStatus: vi.fn().mockResolvedValue({ state: 'idle', queueLength: 0 }),
    shikimoriGetOfflineQueueLength: vi.fn().mockResolvedValue(0)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(base, {
    get: (t, p, r) => (p in t ? Reflect.get(t, p, r) : () => makeThenable())
  })
  return base
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AnimeDetailView — load path (#196)', () => {
  it('runs a single file scan per open on a cache-rendered open', async () => {
    const api = installApi({
      getAnimeCache: vi.fn().mockResolvedValue({ data: detail(), cachedAt: Date.now() })
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    // checkFileStatus = fileCheckEpisodes + downloadedEpisodesGet — exactly once,
    // not the old twice (cache path AND api path).
    expect(api.fileCheckEpisodes).toHaveBeenCalledTimes(1)
    expect(api.downloadedEpisodesGet).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('paints episode rows from the cache-first channel', async () => {
    const api = installApi({
      getAnimeCache: vi.fn().mockResolvedValue({ data: detail(), cachedAt: Date.now() })
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(api.getEpisodesBatchCached).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('backgrounds getAnime: mount-tail runs and the offline chip stays while the refresh is pending', async () => {
    // getAnime never resolves — proves the cache render does not block on it.
    const api = installApi({
      getAnimeCache: vi.fn().mockResolvedValue({ data: detail(), cachedAt: Date.now() }),
      getAnime: vi.fn(() => new Promise(() => {}))
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    // Mount-tail (watch progress) ran even though getAnime is still pending.
    expect(api.watchProgressGetAll).toHaveBeenCalled()
    // Rendered from cache → OFFLINE chip is showing and stays.
    expect(wrapper.find('.chip.offline').exists()).toBe(true)
    wrapper.unmount()
  })

  it('a FAILING background getAnime keeps dataSource on cache (offline chip persists)', async () => {
    const api = installApi({
      getAnimeCache: vi.fn().mockResolvedValue({ data: detail(), cachedAt: Date.now() }),
      getAnime: vi.fn().mockRejectedValue(new Error('offline'))
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(api.getAnime).toHaveBeenCalled()
    expect(wrapper.find('.chip.offline').exists()).toBe(true)
    wrapper.unmount()
  })

  it('a successful background getAnime refresh clears the offline chip', async () => {
    installApi({
      getAnimeCache: vi.fn().mockResolvedValue({ data: detail(), cachedAt: Date.now() }),
      getAnime: vi.fn().mockResolvedValue({ source: 'api', data: detail() })
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('.chip.offline').exists()).toBe(false)
    wrapper.unmount()
  })

  it('cold open (no cache) runs a single file scan after fetching the detail', async () => {
    const api = installApi() // getAnimeCache → null
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(api.getAnime).toHaveBeenCalledTimes(1)
    expect(api.fileCheckEpisodes).toHaveBeenCalledTimes(1)
    expect(api.downloadedEpisodesGet).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
