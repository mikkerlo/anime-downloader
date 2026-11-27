// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import HomeView from '../../../src/renderer/src/components/views/HomeView.vue'
import {
  accountsState,
  trackerEntry,
  trackersApi,
  type TrackersApi
} from '../../helpers/trackers-api'

const resumeEntry: ContinueWatchingEntry = {
  kind: 'resume',
  animeId: 1,
  animeName: 'Steins;Gate',
  posterUrl: 'poster.jpg',
  episodeInt: '12',
  episodeLabel: 'Episode 12',
  position: 300,
  duration: 1200,
  updatedAt: 1
}
const nextEntry: ContinueWatchingEntry = {
  kind: 'next',
  animeId: 2,
  animeName: 'Cowboy Bebop',
  posterUrl: 'poster2.jpg',
  episodeInt: '5',
  episodeLabel: 'Episode 5',
  updatedAt: 2
}

function stubApi(
  entries: ContinueWatchingEntry[],
  dismissed: string[] = [],
  trackers: TrackersApi = trackersApi()
): Record<string, ReturnType<typeof vi.fn>> {
  // Real methods HomeView calls; any other access (store `on*` subscriptions)
  // falls back to a no-op returning a no-op unsubscribe handle.
  const real: Record<string, ReturnType<typeof vi.fn>> = {
    ...(trackers.api as unknown as Record<string, ReturnType<typeof vi.fn>>),
    homeGetContinueWatching: vi.fn().mockResolvedValue(entries),
    shikimoriGetAnimeRates: vi.fn().mockResolvedValue([]),
    libraryHas: vi.fn().mockResolvedValue(false),
    libraryToggle: vi.fn().mockResolvedValue(true),
    // Must be a real stub: the Proxy fallback returns a *function*, and
    // `new Set(fn)` / `for (const id of fn)` throws "not iterable".
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    librarySetPriority: vi.fn().mockResolvedValue([]),
    getSetting: vi
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(key === 'dismissedContinueWatching' ? dismissed : undefined)
      ),
    setSetting: vi.fn().mockResolvedValue(undefined)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(real, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
  return real
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('HomeView', () => {
  it('renders a continue-watching card per entry with the right kind chip', async () => {
    stubApi([resumeEntry, nextEntry])
    const wrapper = mount(HomeView)
    await flushPromises()

    const cards = wrapper.findAll('.cw-card')
    expect(cards).toHaveLength(2)
    expect(wrapper.findAll('.chip.accent')).toHaveLength(1) // resume
    expect(wrapper.findAll('.chip.blue')).toHaveLength(1) // up next
    expect(cards[0].find('.cw-title').text()).toBe('Steins;Gate')
  })

  it('shows the progress bar only for resume entries', async () => {
    stubApi([resumeEntry, nextEntry])
    const wrapper = mount(HomeView)
    await flushPromises()

    const cards = wrapper.findAll('.cw-card')
    // resume → .pbar with a width; next → no .pbar, "Not started" text instead.
    expect(cards[0].find('.pbar > span').attributes('style')).toContain('width: 25%')
    expect(cards[1].find('.pbar').exists()).toBe(false)
    expect(cards[1].find('.ptext').text()).toBe('Not started')
  })

  it('renders the empty state when there is nothing to resume', async () => {
    stubApi([])
    const wrapper = mount(HomeView)
    await flushPromises()

    expect(wrapper.find('.cw-card').exists()).toBe(false)
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.find('.empty-state p').text()).toContain('All caught up')
  })

  it('renders a "Recently added" grid from recent Watching/Planned Shikimori rates', async () => {
    stubApi([], [], shikimoriPrimary(SHIKI_RATES))

    const wrapper = mount(HomeView)
    await flushPromises()

    const cards = wrapper.findAll('.poster-grid .acard')
    expect(cards).toHaveLength(2) // completed + no-smotret entries excluded
    expect(wrapper.find('.section-head h3').text()).toBe('Recently added to your list')
    expect(wrapper.find('.section-head.spaced .muted').text()).toBe('From Shikimori')
    // Most-recently-updated (id 11) sorts first.
    expect(cards[0].find('.acard-title').text()).toContain('Show 11')
  })

  it('dismisses a card, removing it and persisting the key to electron-store', async () => {
    const api = stubApi([resumeEntry, nextEntry])
    const wrapper = mount(HomeView)
    await flushPromises()

    expect(wrapper.findAll('.cw-card')).toHaveLength(2)
    await wrapper.findAll('.cw-dismiss')[0].trigger('click')
    await flushPromises()

    const cards = wrapper.findAll('.cw-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].find('.cw-title').text()).toBe('Cowboy Bebop')
    // Persisted under the animeId:episodeInt key so it survives a restart.
    expect(api.setSetting).toHaveBeenCalledWith('dismissedContinueWatching', ['1:12'])
  })

  it('shows the empty state once every card is dismissed', async () => {
    stubApi([resumeEntry, nextEntry])
    const wrapper = mount(HomeView)
    await flushPromises()

    for (const btn of wrapper.findAll('.cw-dismiss')) await btn.trigger('click')
    await flushPromises()

    expect(wrapper.find('.cw-card').exists()).toBe(false)
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.find('.empty-state p').text()).toContain('All caught up')
  })

  it('keeps a dismissal hidden across restart for the same episode (persisted key)', async () => {
    // Simulate a relaunch: getSetting returns a previously-dismissed key. The
    // matching card must be hidden on mount without any user interaction.
    const api = stubApi([resumeEntry, nextEntry], ['1:12'])
    const wrapper = mount(HomeView)
    await flushPromises()

    expect(api.getSetting).toHaveBeenCalledWith('dismissedContinueWatching')
    expect(wrapper.findAll('.cw-title').map((t) => t.text())).toEqual(['Cowboy Bebop'])
  })

  it('prunes dismissed keys that no longer match any current entry', async () => {
    // Persisted keys: '1:12' is still live (resumeEntry), '99:1' is dead — the
    // anime/episode it dismissed is no longer in the continue-watching list.
    const api = stubApi([resumeEntry, nextEntry], ['1:12', '99:1'])
    const wrapper = mount(HomeView)
    await flushPromises()

    // Dead key dropped, live key kept; pruned set persisted (array shrinks 2 → 1).
    expect(api.setSetting).toHaveBeenCalledWith('dismissedContinueWatching', ['1:12'])
    // '1:12' still hides Steins;Gate; only Cowboy Bebop remains visible.
    expect(wrapper.findAll('.cw-title').map((t) => t.text())).toEqual(['Cowboy Bebop'])
  })

  it('hides the dismiss button on unavailable (no animeId) cards', async () => {
    const unavailable: ContinueWatchingEntry = {
      kind: 'next',
      animeName: 'Unresolved Show',
      episodeInt: '1',
      episodeLabel: 'Episode 1',
      updatedAt: 1
    } as unknown as ContinueWatchingEntry
    stubApi([unavailable])
    const wrapper = mount(HomeView)
    await flushPromises()

    expect(wrapper.findAll('.cw-card')).toHaveLength(1)
    expect(wrapper.find('.cw-card.disabled').exists()).toBe(true)
    expect(wrapper.find('.cw-dismiss').exists()).toBe(false)
  })

  it('resurfaces a dismissed show once its episode advances', async () => {
    // Keyed on animeId:episodeInt, not animeId — so when a refresh returns a NEWER
    // episode for the same anime (key never dismissed), the show comes back.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const trackers = shikimoriPrimary(SHIKI_RATES)
    const api = stubApi([resumeEntry, nextEntry], ['1:12'], trackers)
    const wrapper = mount(HomeView)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.findAll('.cw-title').map((t) => t.text())).toEqual(['Cowboy Bebop'])

    // Episode advances: anime 1 now resumes at ep 13. Re-fetch is driven by the
    // store's primary rates watcher, debounced.
    api.homeGetContinueWatching.mockResolvedValue([
      { ...resumeEntry, episodeInt: '13', episodeLabel: 'Episode 13', updatedAt: 3 },
      nextEntry
    ])
    trackers.emitQueueChanged({ trackerId: 'shikimori', length: 0, queuedAfter: {} })
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    const titles = wrapper.findAll('.cw-title').map((t) => t.text())
    expect(titles).toContain('Steins;Gate') // ep 13 (key 1:13) was never dismissed → back
    expect(titles).toContain('Cowboy Bebop')
  })
})

afterEach(() => {
  vi.useRealTimers()
})

function smotret(id: number): AnimeSearchResult {
  return {
    id,
    title: `Show ${id}`,
    titles: {},
    posterUrlSmall: 'p.jpg',
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV',
    year: 2020,
    season: 'spring'
  }
}

function rate(
  trackerId: TrackerId,
  id: number,
  status: ShikiUserRateStatus,
  updatedAt: string | null,
  noSmotret = false
): TrackerRateEntry {
  return trackerEntry(trackerId, id, status, {
    updatedAt: updatedAt === null ? null : Date.parse(updatedAt),
    smotretAnime: noSmotret ? null : smotret(id)
  })
}

const SHIKI_RATES = [
  rate('shikimori', 10, 'planned', '2026-05-20T00:00:00Z'),
  rate('shikimori', 11, 'watching', '2026-05-29T00:00:00Z'),
  rate('shikimori', 12, 'completed', '2026-05-30T00:00:00Z'), // excluded — not an active status
  rate('shikimori', 13, 'planned', '2026-05-10T00:00:00Z', /* no smotret */ true)
]

/** A signed-in Shikimori as the primary, its list answering `trackerGetRates`. */
function shikimoriPrimary(entries: TrackerRateEntry[]): TrackersApi {
  return trackersApi({ accounts: accountsState(['shikimori']), rates: { shikimori: entries } })
}

// #698: the Home rail reads the primary tracker, whichever it is.
describe('HomeView — the primary tracker (#698)', () => {
  const AL_RATES = [
    rate('anilist', 20, 'watching', '2026-06-01T00:00:00Z'),
    rate('anilist', 21, 'rewatching', '2026-06-03T00:00:00Z'),
    rate('anilist', 22, 'planned', '2026-06-02T00:00:00Z'),
    rate('anilist', 23, 'dropped', '2026-06-04T00:00:00Z'),
    rate('anilist', 24, 'watching', '2026-06-05T00:00:00Z', /* no smotret */ true)
  ]

  function cardTitles(wrapper: ReturnType<typeof mount>): string[] {
    return wrapper.findAll('.poster-grid .acard .acard-title').map((t) => t.text())
  }

  it('only AniList connected: the AniList titles with a smotret match, newest first, from AniList', async () => {
    stubApi(
      [],
      [],
      trackersApi({ accounts: accountsState(['anilist']), rates: { anilist: AL_RATES } })
    )
    const wrapper = mount(HomeView)
    await flushPromises()

    expect(cardTitles(wrapper)).toEqual(['Show 21', 'Show 22', 'Show 20'])
    expect(wrapper.find('.section-head.spaced .muted').text()).toBe('From AniList')
  })

  it('a null updatedAt sorts as NaN, as a missing updated_at did', async () => {
    // NaN makes the comparator 0 against every row: these keep the input order.
    const rates = [
      rate('shikimori', 30, 'watching', null),
      rate('shikimori', 31, 'watching', '2026-06-01T00:00:00Z'),
      rate('shikimori', 32, 'watching', null)
    ]
    stubApi([], [], shikimoriPrimary(rates))
    const wrapper = mount(HomeView)
    await flushPromises()
    expect(cardTitles(wrapper)).toEqual(['Show 30', 'Show 31', 'Show 32'])
  })

  it("the refresh kick refreshes the primary's rates through the store", async () => {
    const trackers = trackersApi({
      accounts: accountsState(['anilist']),
      rates: { anilist: AL_RATES }
    })
    stubApi([], [], trackers)
    const wrapper = mount(HomeView)
    await flushPromises()
    trackers.api.trackerGetRates.mockClear()

    await wrapper.find('.refresh-btn').trigger('click')
    await flushPromises()
    expect(trackers.api.trackerGetRates.mock.calls).toEqual([['anilist']])
  })

  it('with no primary the refresh kick asks for no rates', async () => {
    const trackers = trackersApi()
    const api = stubApi([], [], trackers)
    const wrapper = mount(HomeView)
    await flushPromises()

    await wrapper.find('.refresh-btn').trigger('click')
    await flushPromises()
    expect(trackers.api.trackerGetRates).not.toHaveBeenCalled()
    expect(api.shikimoriGetAnimeRates).not.toHaveBeenCalled()
    expect(api.homeGetContinueWatching).toHaveBeenCalledTimes(2)
  })

  it('a primary switch refetches the rail and flips the header to AniList', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const trackers = trackersApi({
      accounts: accountsState(['shikimori', 'anilist'], 'shikimori'),
      rates: { shikimori: SHIKI_RATES, anilist: AL_RATES }
    })
    const api = stubApi([], [], trackers)
    const wrapper = mount(HomeView)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('.section-head.spaced .muted').text()).toBe('From Shikimori')
    expect(cardTitles(wrapper)).toEqual(['Show 11', 'Show 10'])
    const before = api.homeGetContinueWatching.mock.calls.length

    trackers.emitAccounts(accountsState(['shikimori', 'anilist'], 'anilist'))
    await flushPromises()
    expect(wrapper.find('.section-head.spaced .muted').text()).toBe('From AniList')
    expect(cardTitles(wrapper)).toEqual(['Show 21', 'Show 22', 'Show 20'])

    await vi.advanceTimersByTimeAsync(1000)
    expect(api.homeGetContinueWatching).toHaveBeenCalledTimes(before + 1)
  })

  it("a drain's burst of queue events for the primary refetches once, after the debounce", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const trackers = trackersApi({
      accounts: accountsState(['anilist']),
      rates: { anilist: AL_RATES }
    })
    const api = stubApi([], [], trackers)
    mount(HomeView)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    const before = api.homeGetContinueWatching.mock.calls.length

    for (let n = 5; n > 0; n--) {
      trackers.emitQueueChanged({
        trackerId: 'anilist',
        length: n,
        queuedAfter: { 20: { episodes: 6 - n, status: 'watching', score: 0, rewatches: 0 } }
      })
      await flushPromises()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(api.homeGetContinueWatching).toHaveBeenCalledTimes(before)

    await vi.advanceTimersByTimeAsync(1000)
    expect(api.homeGetContinueWatching).toHaveBeenCalledTimes(before + 1)
  })

  it("a mirror's events never refetch the rail; the primary's own still do", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const trackers = trackersApi({
      accounts: accountsState(['shikimori', 'anilist'], 'shikimori'),
      rates: { shikimori: SHIKI_RATES, anilist: AL_RATES }
    })
    const api = stubApi([], [], trackers)
    mount(HomeView)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    const before = api.homeGetContinueWatching.mock.calls.length

    // AniList is a mirror here: its refresh and its queue are not the rail's list.
    trackers.emitRatesRefreshed({ trackerId: 'anilist', entries: AL_RATES.slice(1) })
    trackers.emitQueueChanged({
      trackerId: 'anilist',
      length: 1,
      queuedAfter: { 20: { episodes: 2, status: 'watching', score: 0, rewatches: 0 } }
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.homeGetContinueWatching).toHaveBeenCalledTimes(before)

    // The primary's own refresh still refetches.
    trackers.emitRatesRefreshed({ trackerId: 'shikimori', entries: SHIKI_RATES.slice(1) })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.homeGetContinueWatching).toHaveBeenCalledTimes(before + 1)
  })
})

// #570: continue-watching cards keep their poster offline from main's cache.
describe('HomeView — cached posters (#570)', () => {
  it('a card with a cached poster loads anime-poster://<id>, the rest stay remote', async () => {
    const api = stubApi([resumeEntry, nextEntry])
    api.getCachedPosterIds = vi.fn().mockResolvedValue([1])
    const wrapper = mount(HomeView)
    await flushPromises()

    const imgs = wrapper.findAll('.cw-poster img')
    expect(imgs.map((i) => i.attributes('src'))).toEqual(['anime-poster://1', 'poster2.jpg'])
  })

  it('a failing cached poster falls back to the remote URL, not to the blank tile', async () => {
    const api = stubApi([resumeEntry])
    api.getCachedPosterIds = vi.fn().mockResolvedValue([1])
    const wrapper = mount(HomeView)
    await flushPromises()

    await wrapper.find('.cw-poster img').trigger('error')
    expect(wrapper.find('.cw-poster img').attributes('src')).toBe('poster.jpg')
    await wrapper.find('.cw-poster img').trigger('error')
    expect(wrapper.find('.cw-poster img').exists()).toBe(false)
    expect(wrapper.find('.cw-poster-fallback').exists()).toBe(true)
  })
})
