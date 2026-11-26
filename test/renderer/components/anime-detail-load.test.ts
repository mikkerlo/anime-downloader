// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AnimeDetailView from '../../../src/renderer/src/components/views/AnimeDetailView.vue'
import { useTrackersStore } from '../../../src/renderer/src/stores/trackers'
import { offlineApi, type OfflineApi } from '../../helpers/offline-api'

/** A callable that also carries `then`/`catch`/`finally`. The three are optional
 *  so the bare arrow can be assigned before they are filled in below. */
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

function noAccounts(): TrackerAccountsState {
  return { accounts: [], primary: null, mirror: {}, featureSources: {} }
}

function shikimoriOnly(): TrackerAccountsState {
  return {
    accounts: [
      {
        trackerId: 'shikimori',
        user: { id: 1, nickname: 'me', avatar: null },
        hasCredentials: true,
        sessionExpired: false,
        needsSetup: false,
        credentialState: 'ok'
      }
    ],
    primary: 'shikimori',
    mirror: {},
    featureSources: {}
  }
}

function syncStatus(): TrackerSyncStatus {
  return {
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false,
    needsSetup: false
  }
}

interface ApiOverrides {
  getAnimeCache?: ReturnType<typeof vi.fn>
  getAnime?: ReturnType<typeof vi.fn>
  offline?: OfflineApi
  trackerListAccounts?: ReturnType<typeof vi.fn>
  extra?: Record<string, ReturnType<typeof vi.fn>>
}

function installApi(overrides: ApiOverrides = {}): Record<string, ReturnType<typeof vi.fn>> {
  const base: Record<string, ReturnType<typeof vi.fn>> = {
    getAnimeCache: overrides.getAnimeCache ?? vi.fn().mockResolvedValue(null),
    getAnime: overrides.getAnime ?? vi.fn().mockResolvedValue({ source: 'api', data: detail() }),
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
    // Must be a real stub: the Proxy fallback returns a thenable that resolves
    // to `undefined`, and `undefined.includes(...)` throws.
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    libraryIsDownloaded: vi.fn().mockResolvedValue(false),
    autoDlGetSubscription: vi.fn().mockResolvedValue(null),
    shikimoriGetUser: vi.fn().mockResolvedValue(null),
    trackerListAccounts: overrides.trackerListAccounts ?? vi.fn().mockResolvedValue(noAccounts()),
    trackerGetSyncStatus: vi.fn().mockResolvedValue(syncStatus()),
    trackerGetOfflineQueueLength: vi.fn().mockResolvedValue(0),
    ...overrides.extra
  }
  const target = { ...(overrides.offline ?? offlineApi()).api, ...base }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
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

describe('AnimeDetailView — offline (#568)', () => {
  const THREE_DAYS_AGO = new Date(2026, 9, 24, 12, 0, 0).getTime()
  const savedLabel = `Saved ${new Date(THREE_DAYS_AGO).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })}, offline`

  function staleCache(): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({ data: detail(), cachedAt: THREE_DAYS_AGO, stale: true })
  }

  it('offline: paints from cache without awaiting getAnime, with a "Saved <date>, offline" badge', async () => {
    const api = installApi({
      getAnimeCache: staleCache(),
      getAnime: vi.fn(() => new Promise(() => {})),
      offline: offlineApi('offline-manual')
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('h1').text()).toBe('Tesuto')
    expect(api.watchProgressGetAll).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="saved-offline-badge"]').text()).toBe(savedLabel)
    expect(wrapper.find('.chip.offline').exists()).toBe(false)
    wrapper.unmount()
  })

  it('offline: Download all and the episode download button are disabled with the reason', async () => {
    installApi({ getAnimeCache: staleCache(), offline: offlineApi('offline-auto') })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    const all = wrapper.find('[data-testid="download-all"]')
    expect(all.attributes('disabled')).toBeDefined()
    expect(all.attributes('title')).toBe('Downloads need an internet connection')
    const ep = wrapper.find('[data-testid="ep-download"]')
    expect(ep.exists()).toBe(true)
    expect(ep.attributes('disabled')).toBeDefined()
    expect(ep.attributes('title')).toBe('Downloads need an internet connection')
    wrapper.unmount()
  })

  it('online: no badge, and the download buttons are enabled — today', async () => {
    installApi({ getAnimeCache: vi.fn().mockResolvedValue(null) })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('[data-testid="saved-offline-badge"]').exists()).toBe(false)
    const all = wrapper.find('[data-testid="download-all"]')
    expect(all.attributes('disabled')).toBeUndefined()
    expect(all.attributes('title')).toBeUndefined()
    const ep = wrapper.find('[data-testid="ep-download"]')
    expect(ep.attributes('disabled')).toBeUndefined()
    expect(ep.attributes('title')).toBe('Download this episode')
    wrapper.unmount()
  })

  // #570: online, main now returns a cachable title's expired entry. The page
  // paints it at once with a neutral "Saved <date>" (no offline wording, no
  // OFFLINE chip) while the background refresh runs, and the stamp goes away
  // when the refresh lands.
  it('online: a stale cache paint shows "Saved <date>" until the refresh lands', async () => {
    let resolveAnime!: (v: unknown) => void
    installApi({
      getAnimeCache: staleCache(),
      getAnime: vi.fn(() => new Promise((r) => (resolveAnime = r)))
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('h1').text()).toBe('Tesuto')
    expect(wrapper.find('[data-testid="saved-offline-badge"]').text()).toBe(
      savedLabel.replace(/, offline$/, '')
    )
    expect(wrapper.find('.chip.offline').exists()).toBe(false)

    resolveAnime({ source: 'api', data: detail() })
    await flushPromises()
    expect(wrapper.find('[data-testid="saved-offline-badge"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('online: a fresh cache paint shows no stamp — today', async () => {
    installApi({
      getAnimeCache: vi
        .fn()
        .mockResolvedValue({ data: detail(), cachedAt: Date.now(), stale: false }),
      getAnime: vi.fn(() => new Promise(() => {}))
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()
    expect(wrapper.find('[data-testid="saved-offline-badge"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('going offline disables the download buttons without a reload', async () => {
    const offline = offlineApi()
    installApi({ offline })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()
    expect(wrapper.find('[data-testid="ep-download"]').attributes('disabled')).toBeUndefined()

    offline.emit('offline-manual')
    await flushPromises()
    expect(wrapper.find('[data-testid="ep-download"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="download-all"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('a cache paint made offline refreshes once on the online edge: chip gone, new episode listed', async () => {
    const offline = offlineApi('offline-manual')
    const ep = (n: number): EpisodeSummary => ({
      id: 9 + n,
      episodeInt: String(n),
      episodeFull: `Episode ${n}`,
      episodeType: 'tv',
      isActive: 1
    })
    // Offline, main answers get-anime from the cache (one episode); back
    // online, the API has a second one.
    const getAnime = vi
      .fn()
      .mockResolvedValueOnce({ source: 'cache', data: detail() })
      .mockResolvedValue({
        source: 'api',
        data: detail({ numberOfEpisodes: 2, episodes: [ep(1), ep(2)] })
      })
    const api = installApi({ getAnimeCache: staleCache(), getAnime, offline })
    const byIds = (ids: number[]): { data: EpisodeDetail[] } => ({
      data: ids.map((id) => ({ ...episodeDetail(700), id, episodeInt: String(id - 9) }))
    })
    api.getEpisodesBatchCached.mockImplementation(async (ids: number[]) => ({
      ...byIds(ids.filter((id) => id === 10)),
      source: 'cache'
    }))
    api.getEpisodesBatch.mockImplementation(async (ids: number[]) => byIds(ids))
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()
    expect(wrapper.find('[data-testid="saved-offline-badge"]').exists()).toBe(true)
    expect(getAnime).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.ep-row')).toHaveLength(1)

    offline.emit('online')
    await flushPromises()

    expect(getAnime).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="saved-offline-badge"]').exists()).toBe(false)
    expect(wrapper.find('.chip.offline').exists()).toBe(false)
    expect(wrapper.findAll('.ep-row')).toHaveLength(2)
    expect(api.getEpisodesBatch).toHaveBeenCalledWith([11], 1)

    offline.emit('offline-manual')
    await flushPromises()
    offline.emit('online')
    await flushPromises()
    // Now painted from the API: another edge doesn't refetch.
    expect(getAnime).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('offline with no cache entry: the OfflineNotice; back online loads once', async () => {
    const offline = offlineApi('offline-manual')
    const getAnime = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline: network access is turned off'))
      .mockResolvedValue({ source: 'api', data: detail() })
    installApi({ getAnimeCache: vi.fn().mockResolvedValue(null), getAnime, offline })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('[data-testid="offline-notice"] p').text()).toBe(
      'This title needs an internet connection'
    )
    expect(wrapper.find('h1').exists()).toBe(false)

    offline.emit('online')
    await flushPromises()
    expect(getAnime).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
    expect(wrapper.find('h1').text()).toBe('Tesuto')

    offline.emit('offline-manual')
    await flushPromises()
    offline.emit('online')
    await flushPromises()
    expect(getAnime).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})

// The rate panel's gate and Continue timing (#704). The panel mounts while the
// accounts aren't known yet, stays out with none, and from the second detail
// page on (`accountsLoaded` already true) it shows "Loading…" and holds
// Continue until the primary's rate lands, as the per-mount Shikimori user
// read did.
describe('AnimeDetailView — tracker panel gate (#704)', () => {
  const MAL_ID = 5114
  const ep = (n: number): EpisodeSummary => ({
    id: 9 + n,
    episodeInt: String(n),
    episodeFull: `Episode ${n}`,
    episodeType: 'tv',
    isActive: 1
  })
  const malDetail = (): AnimeDetail =>
    detail({ myAnimeListId: MAL_ID, numberOfEpisodes: 3, episodes: [ep(1), ep(2), ep(3)] })

  function shikimoriExtras(): Record<string, ReturnType<typeof vi.fn>> {
    return {
      shikimoriGetFriendsRates: vi.fn().mockResolvedValue([]),
      shikimoriGetAnimeDetails: vi.fn().mockResolvedValue(null),
      shikimoriGetRelated: vi.fn().mockResolvedValue([]),
      trackerGetRates: vi.fn(async (trackerId: TrackerId) => ({
        trackerId,
        entries: [],
        queuedAfter: {}
      }))
    }
  }

  const continueButton = (w: ReturnType<typeof mount>) => w.find('.detail-actions .btn-primary')

  it('with no account the panel stays absent after the check', async () => {
    installApi({
      getAnime: vi.fn().mockResolvedValue({ source: 'api', data: malDetail() }),
      extra: shikimoriExtras()
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('h1').text()).toBe('Tesuto')
    expect(wrapper.find('.sk-logo').exists()).toBe(false)
    expect(wrapper.find('.shiki-loading').exists()).toBe(false)
    expect(continueButton(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('before the accounts check resolves the panel is present and shows "Loading…"', async () => {
    installApi({
      getAnime: vi.fn().mockResolvedValue({ source: 'api', data: malDetail() }),
      trackerListAccounts: vi.fn(() => new Promise(() => {})),
      extra: shikimoriExtras()
    })
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('h1').text()).toBe('Tesuto')
    expect(wrapper.find('.side-panel .shiki-loading').text()).toBe('Loading…')
    expect(continueButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('second open: Continue waits and the panel shows "Loading…" until the primary rate lands', async () => {
    let resolveRate!: (v: TrackerRateResult) => void
    const trackerGetRate = vi.fn(
      () => new Promise<TrackerRateResult>((resolve) => (resolveRate = resolve))
    )
    // Held, so the page sits in the window before the rate load starts: the
    // episode list is painted, `accountsLoaded` is already true, and only the
    // per-mount `loading` keeps Continue off the local-progress target.
    let resolveUser!: (v: ShikiUser) => void
    const shikimoriGetUser = vi.fn(() => new Promise<ShikiUser>((r) => (resolveUser = r)))
    installApi({
      getAnime: vi.fn().mockResolvedValue({ source: 'api', data: malDetail() }),
      trackerListAccounts: vi.fn().mockResolvedValue(shikimoriOnly()),
      extra: { ...shikimoriExtras(), shikimoriGetUser, trackerGetRate }
    })
    // An earlier detail page already loaded the accounts.
    const trackers = useTrackersStore()
    await flushPromises()
    expect(trackers.accountsLoaded).toBe(true)
    expect(trackers.primary).toBe('shikimori')

    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    expect(wrapper.find('h1').text()).toBe('Tesuto')
    expect(wrapper.findAll('.ep-row')).toHaveLength(3)
    expect(trackerGetRate).not.toHaveBeenCalled()
    expect(continueButton(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.find('.side-panel .shiki-loading').text()).toBe('Loading…')
    expect(wrapper.find('#shiki-ep').exists()).toBe(false)

    resolveUser({ id: 1, nickname: 'me', avatar: '' } as ShikiUser)
    await flushPromises()

    expect(trackerGetRate).toHaveBeenCalledWith('shikimori', MAL_ID)
    expect(continueButton(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.find('.sk-logo').exists()).toBe(true)
    expect(wrapper.find('.side-panel .shiki-loading').text()).toBe('Loading…')
    expect(wrapper.find('#shiki-ep').exists()).toBe(false)

    resolveRate({
      values: { status: 'watching', episodes: 2, score: 0, rewatches: 0 },
      stale: false
    })
    await flushPromises()

    expect((wrapper.find('#shiki-ep').element as HTMLInputElement).value).toBe('2')
    expect(continueButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(continueButton(wrapper).text()).toBe('Continue · Ep 3')
    wrapper.unmount()
  })
})
