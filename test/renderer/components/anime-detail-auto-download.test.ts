// @vitest-environment happy-dom
// The detail page's Auto-download button (#706): the account half of the gate
// comes from the trackers store's `airing` source, `isShowFinished` from that
// source's details, and a MAL-only account sees the button disabled with a hint.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AnimeDetailView from '../../../src/renderer/src/components/views/AnimeDetailView.vue'
import { offlineApi } from '../../helpers/offline-api'
import { trackerAccounts, type AccountSpec } from '../../helpers/tracker-accounts'

type CallableThenable = { (): unknown; then?: unknown; catch?: unknown; finally?: unknown }

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
const SHIKI_USER = { id: 1, nickname: 'n', avatar: '' }

const anime = (): AnimeDetail =>
  ({
    id: 1,
    title: 'Test Anime',
    titles: { romaji: 'Tesuto' },
    posterUrlSmall: 'poster.jpg',
    posterUrl: 'poster.jpg',
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2026,
    season: 'fall',
    myAnimeListId: MAL_ID,
    episodes: []
  }) as unknown as AnimeDetail

const details = (status: TrackerDetails['status']): TrackerDetails => ({
  description: null,
  genres: [],
  status,
  episodes: 12,
  episodesAired: 6,
  kind: 'tv'
})

let detailsListeners: ((e: TrackerDetailsUpdatedEvent) => void)[] = []

function installApi(opts: {
  accounts: AccountSpec
  /** Shikimori's own user and details reads, for a Shikimori account. */
  shikiStatus?: string | null
  trackerGetDetails?: ReturnType<typeof vi.fn>
  autoDlSetSubscription?: ReturnType<typeof vi.fn>
}): Record<string, ReturnType<typeof vi.fn>> {
  detailsListeners = []
  const shiki = opts.accounts.shikimori !== undefined
  const base: Record<string, ReturnType<typeof vi.fn>> = {
    getAnimeCache: vi.fn().mockResolvedValue(null),
    getAnime: vi.fn().mockResolvedValue({ source: 'api', data: anime() }),
    getEpisodesBatchCached: vi.fn().mockResolvedValue({ data: [], source: 'cache' }),
    getEpisodesBatch: vi.fn().mockResolvedValue({ data: [] }),
    fileCheckEpisodes: vi.fn().mockResolvedValue({}),
    downloadedEpisodesGet: vi.fn().mockResolvedValue({}),
    watchProgressGetAll: vi.fn().mockResolvedValue({}),
    getSetting: vi.fn().mockResolvedValue(false),
    libraryHas: vi.fn().mockResolvedValue(false),
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    libraryIsDownloaded: vi.fn().mockResolvedValue(false),
    autoDlGetSubscription: vi.fn().mockResolvedValue(null),
    autoDlSetSubscription: opts.autoDlSetSubscription ?? vi.fn().mockResolvedValue(null),
    shikimoriGetUser: vi.fn().mockResolvedValue(shiki ? SHIKI_USER : null),
    shikimoriGetRate: vi.fn().mockResolvedValue(null),
    shikimoriGetFriendsRates: vi.fn().mockResolvedValue([]),
    shikimoriGetRelated: vi.fn().mockResolvedValue([]),
    shikimoriGetAnimeDetails: vi
      .fn()
      .mockResolvedValue(
        shiki && opts.shikiStatus !== null ? { status: opts.shikiStatus ?? 'ongoing' } : null
      ),
    shikimoriGetSyncStatus: vi.fn().mockResolvedValue({ state: 'idle', queueLength: 0 }),
    shikimoriGetOfflineQueueLength: vi.fn().mockResolvedValue(0),
    trackerListAccounts: vi.fn().mockResolvedValue(trackerAccounts(opts.accounts)),
    trackerGetDetails: opts.trackerGetDetails ?? vi.fn().mockResolvedValue(null),
    onTrackerDetailsUpdated: vi.fn((cb: (e: TrackerDetailsUpdatedEvent) => void) => {
      detailsListeners.push(cb)
      return () => {}
    })
  }
  const target = { ...offlineApi().api, ...base }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get: (t, p, r) => (p in t ? Reflect.get(t, p, r) : () => makeThenable())
  })
  return base
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
  await flushPromises()
  return wrapper
}

const button = (w: VueWrapper) => w.find('[data-testid="detail-auto-dl"]')

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AnimeDetailView — Auto-download (#706)', () => {
  it('Shikimori-only: visible and enabled, today’s tooltip; hidden on a finished show', async () => {
    installApi({ accounts: { shikimori: 'active' } })
    const w = await mountView()
    expect(button(w).exists()).toBe(true)
    expect(button(w).attributes('disabled')).toBeUndefined()
    expect(button(w).attributes('title')).toBe('Auto-download new episodes as they air')
    w.unmount()

    setActivePinia(createPinia())
    installApi({ accounts: { shikimori: 'active' }, shikiStatus: 'released' })
    const finished = await mountView()
    expect(button(finished).exists()).toBe(false)
    finished.unmount()
  })

  it('Shikimori-only: the subscribe failure alert still names Shikimori', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const api = installApi({ accounts: { shikimori: 'active' } })
    const w = await mountView()
    await button(w).trigger('click')
    await flushPromises()
    expect(api.autoDlSetSubscription).toHaveBeenCalledWith(1, true, {
      malId: MAL_ID,
      animeName: 'Tesuto'
    })
    expect(alert).toHaveBeenCalledWith(
      "Couldn't read this show's airing data from Shikimori. Please try again in a moment."
    )
    w.unmount()
  })

  it('AniList-only: enabled, and the alert names AniList', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const api = installApi({ accounts: { anilist: 'active' } })
    const w = await mountView()
    expect(button(w).exists()).toBe(true)
    expect(button(w).attributes('disabled')).toBeUndefined()
    expect(button(w).attributes('title')).toBe('Auto-download new episodes as they air')
    // The airing source's details, never Shikimori's.
    expect(api.trackerGetDetails).toHaveBeenCalledWith(MAL_ID, 'anilist')
    await button(w).trigger('click')
    await flushPromises()
    expect(alert).toHaveBeenCalledWith(
      "Couldn't read this show's airing data from AniList. Please try again in a moment."
    )
    w.unmount()
  })

  it('MAL-only: visible but disabled, with the hint; clicking does nothing', async () => {
    const api = installApi({ accounts: { mal: 'active' } })
    const w = await mountView()
    expect(button(w).exists()).toBe(true)
    expect(button(w).attributes('disabled')).toBeDefined()
    expect(button(w).attributes('title')).toBe(
      'MyAnimeList has no airing data — connect AniList or Shikimori to auto-download'
    )
    await button(w).trigger('click')
    await flushPromises()
    expect(api.autoDlSetSubscription).not.toHaveBeenCalled()
    w.unmount()
  })

  it('no account: hidden, as today', async () => {
    installApi({ accounts: {} })
    const w = await mountView()
    expect(button(w).exists()).toBe(false)
    w.unmount()
  })

  it('no account but a subscription: shown, and the tooltip names both airing trackers', async () => {
    const api = installApi({ accounts: {} })
    api.autoDlGetSubscription.mockResolvedValue({
      animeId: 1,
      malId: MAL_ID,
      animeName: 'X',
      subscribedAt: 0,
      lastEnqueuedEpisodeInt: 3,
      lastCheckedAt: 0,
      initialEpisodesAired: 3
    })
    const w = await mountView()
    expect(button(w).exists()).toBe(true)
    expect(button(w).attributes('title')).toBe(
      'Connect AniList or Shikimori to enable auto-download'
    )
    w.unmount()
  })

  it('an unknown status counts as not finished: an AniList source with a details miss is enabled', async () => {
    installApi({ accounts: { anilist: 'active' } })
    const w = await mountView()
    expect(button(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('a finished status from AniList’s cache hides it', async () => {
    installApi({
      accounts: { anilist: 'active' },
      trackerGetDetails: vi.fn().mockResolvedValue(details('released'))
    })
    const w = await mountView()
    expect(button(w).exists()).toBe(false)
    w.unmount()
  })

  it('isShowFinished flips without a remount when tracker:details-updated brings a finished status', async () => {
    installApi({ accounts: { anilist: 'active' } })
    const w = await mountView()
    expect(button(w).exists()).toBe(true)

    const fire = (e: TrackerDetailsUpdatedEvent) => detailsListeners.forEach((l) => l(e))
    // Another title, and another tracker, change nothing.
    fire({ trackerId: 'anilist', malId: MAL_ID + 1, details: details('released') })
    fire({ trackerId: 'mal', malId: MAL_ID, details: details('released') })
    await flushPromises()
    expect(button(w).exists()).toBe(true)

    fire({ trackerId: 'anilist', malId: MAL_ID, details: details('released') })
    await flushPromises()
    expect(button(w).exists()).toBe(false)
    w.unmount()
  })
})
