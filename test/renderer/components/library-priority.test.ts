// @vitest-environment happy-dom
//
// The Priority tab over the local watchlist (#269).
//
// The load-bearing case is the signed-out one: the pill strip used to be gated
// purely on resolved Shikimori statuses, which would have hidden Priority from
// exactly the users the feature exists for.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import LibraryView from '../../../src/renderer/src/components/views/LibraryView.vue'
import { useTrackersStore } from '../../../src/renderer/src/stores/trackers'
import {
  accountsState,
  snapshotOf,
  trackerEntry,
  trackersApi,
  type TrackersApi
} from '../../helpers/trackers-api'

function anime(id: number): AnimeSearchResult {
  return {
    id,
    title: `Anime ${id}`,
    titles: {},
    posterUrlSmall: 'p.jpg',
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV',
    year: 2020,
    season: 'spring'
  }
}

function stubApi(overrides: Record<string, unknown>, trackers: TrackersApi = trackersApi()): void {
  const target = { ...trackers.api, ...overrides }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
}

/** LibraryView with three entries; priority + rates are the variables. */
function mountLibrary(
  priority: string[],
  extra: Record<string, unknown> = {},
  trackers: TrackersApi = trackersApi()
) {
  stubApi(
    {
      libraryGet: vi.fn().mockResolvedValue([anime(1), anime(2), anime(3)]),
      libraryGetStatus: vi.fn().mockResolvedValue({}),
      libraryGetPriority: vi.fn().mockResolvedValue(priority),
      ...extra
    },
    trackers
  )
  return mount(LibraryView)
}

/** `trackerId` alone connected, watching anime 1. */
function watchingOne(trackerId: TrackerId): TrackersApi {
  return trackersApi({
    accounts: accountsState([trackerId]),
    rates: { [trackerId]: [trackerEntry(trackerId, 501, 'watching', { smotretAnime: anime(1) })] }
  })
}

function tabLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.pill-tab').map((t) => t.text())
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('LibraryView — Priority tab', () => {
  it('shows the pill strip for a signed-out user with a non-empty priority list', async () => {
    // Regression: `v-if="hasStatuses && …"` hid the whole strip whenever no
    // library entry resolved to a Shikimori status, i.e. always when signed out.
    const wrapper = mountLibrary(['3'])
    await flushPromises()

    expect(wrapper.find('.pill-tabs').exists()).toBe(true)
    // No rates → the three Shikimori status pills stay hidden.
    expect(tabLabels(wrapper)).toEqual(['All', 'Priority'])
  })

  it('hides the Priority pill when nothing is prioritized', async () => {
    const wrapper = mountLibrary([])
    await flushPromises()

    expect(wrapper.find('.pill-tabs').exists()).toBe(false)
  })

  it('narrows the grid to prioritized ids in stored order, not merged-map order', async () => {
    // libraryGet returns 1,2,3; the stored priority order is 3 then 1.
    const wrapper = mountLibrary(['3', '1'])
    await flushPromises()

    await wrapper.findAll('.pill-tab')[1].trigger('click')

    const titles = wrapper.findAll('.poster-grid .acard-title').map((n) => n.text())
    expect(titles).toEqual(['Anime 3', 'Anime 1'])
    // And the rank badges read as a queue.
    expect(wrapper.findAll('.rank-badge').map((n) => n.text())).toEqual(['1', '2'])
  })

  it('keeps the Priority tab selectable after demoting its last entry', async () => {
    // Otherwise `statusFilter` would point at a tab that no longer renders,
    // stranding the user on a blank grid with no way back.
    const librarySetPriority = vi.fn().mockResolvedValue([])
    const wrapper = mountLibrary(['3'], { librarySetPriority })
    await flushPromises()

    await wrapper.findAll('.pill-tab')[1].trigger('click')
    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(1)

    await wrapper.find('.poster-grid .priority-btn').trigger('click')
    await flushPromises()

    expect(librarySetPriority).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), false)
    // The pill survives because the user is standing on it...
    expect(tabLabels(wrapper)).toEqual(['All', 'Priority'])
    // ...and the empty state is the priority-specific copy.
    expect(wrapper.find('.status-text').text()).toContain('Nothing prioritized yet')
  })

  it('promotes from the grid and flips the flag using the returned list', async () => {
    const librarySetPriority = vi.fn().mockResolvedValue(['2'])
    const wrapper = mountLibrary([], { librarySetPriority })
    await flushPromises()

    const flags = wrapper.findAll('.poster-grid .priority-btn')
    expect(flags[1].classes()).not.toContain('active')

    await flags[1].trigger('click')
    await flushPromises()

    expect(librarySetPriority).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), true)
    expect(wrapper.findAll('.poster-grid .priority-btn')[1].classes()).toContain('active')
    // The pill appears as soon as the list becomes non-empty.
    expect(tabLabels(wrapper)).toEqual(['All', 'Priority'])
  })

  it.each(['shikimori', 'anilist'] as const)(
    'renders Priority alongside the %s status pills, second in the strip',
    async (trackerId) => {
      const wrapper = mountLibrary(['2'], {}, watchingOne(trackerId))
      await flushPromises()

      expect(tabLabels(wrapper)).toEqual(['All', 'Priority', 'Watching', 'Planned', 'Completed'])
    }
  )

  it('falls back to the onboarding copy when the last entry leaves an empty library', async () => {
    // Un-starring the last (prioritized) entry from the Priority tab empties the
    // library while `statusFilter` stays on 'priority' — and `showFilterRow`
    // goes false with it, so the user cannot switch back. The empty-library
    // branch has to win over the priority one or a first-run-looking library
    // reads "Nothing prioritized yet".
    stubApi({
      libraryGet: vi
        .fn()
        .mockResolvedValueOnce([anime(1)])
        .mockResolvedValue([]),
      libraryGetStatus: vi.fn().mockResolvedValue({}),
      libraryGetPriority: vi.fn().mockResolvedValueOnce(['1']).mockResolvedValue([]),
      libraryToggle: vi.fn().mockResolvedValue(false)
    })
    const wrapper = mount(LibraryView)
    await flushPromises()

    await wrapper.findAll('.pill-tab')[1].trigger('click')
    await wrapper.find('.poster-grid .star-btn').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pill-tabs').exists()).toBe(false)
    expect(wrapper.find('.status-text').text()).toContain('No saved anime yet')
  })

  it('drops a title from the priority list when it is un-starred', async () => {
    // Main-side, LIBRARY_TOGGLE demotes on un-star; the view must reload rather
    // than keep showing a flag for a title that left the library.
    const libraryGetPriority = vi.fn().mockResolvedValueOnce(['1']).mockResolvedValue([])
    stubApi({
      libraryGet: vi
        .fn()
        .mockResolvedValueOnce([anime(1), anime(2)])
        .mockResolvedValue([anime(2)]),
      libraryGetStatus: vi.fn().mockResolvedValue({}),
      libraryGetPriority,
      libraryToggle: vi.fn().mockResolvedValue(false)
    })
    const wrapper = mount(LibraryView)
    await flushPromises()
    expect(wrapper.findAll('.poster-grid .priority-btn')[0].classes()).toContain('active')

    await wrapper.findAll('.poster-grid .star-btn')[0].trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(1)
    expect(wrapper.find('.pill-tabs').exists()).toBe(false)
  })
})

// #570 review: the library list and the cached-poster ids are read in
// parallel, and the cards still wait for the ids, so a cached poster is their
// very first src (never a remote request that the id set then replaces).
describe('LibraryView — poster ids (#570)', () => {
  it('reads both at once, and the first card src is anime-poster://', async () => {
    let resolveIds!: (ids: number[]) => void
    const libraryGet = vi.fn().mockResolvedValue([anime(1)])
    const getCachedPosterIds = vi.fn(() => new Promise<number[]>((r) => (resolveIds = r)))
    const wrapper = mountLibrary([], { libraryGet, getCachedPosterIds })
    await flushPromises()

    expect(getCachedPosterIds).toHaveBeenCalledTimes(1)
    expect(libraryGet).toHaveBeenCalledTimes(1)
    expect(wrapper.find('img.poster').exists()).toBe(false)

    resolveIds([1])
    await flushPromises()
    expect(wrapper.find('img.poster').attributes('src')).toBe('anime-poster://1')
  })
})

// #698: the hydrate gate goes through `useTrackersStore().refreshRates`.
describe('LibraryView — hydrating the primary rates (#698)', () => {
  const ENTRY = trackerEntry('anilist', 501, 'watching', { smotretAnime: anime(1) })

  function libraryApi(trackers: TrackersApi): void {
    stubApi(
      {
        libraryGet: vi.fn().mockResolvedValue([anime(1), anime(2), anime(3)]),
        libraryGetStatus: vi.fn().mockResolvedValue({}),
        libraryGetPriority: vi.fn().mockResolvedValue([])
      },
      trackers
    )
  }

  it('a cold cache: the gate calls the store action, whose reply alone fills the tabs', async () => {
    const trackers = trackersApi({ accounts: accountsState(['anilist']) })
    // The store's first pull found nothing (offline, nothing cached); by the
    // time Library mounts, the cold-cache fetch answers. No broadcast follows it.
    trackers.api.trackerGetRates
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(snapshotOf('anilist', [ENTRY]))
    libraryApi(trackers)
    useTrackersStore()
    await flushPromises()
    expect(trackers.api.trackerGetRates).toHaveBeenCalledTimes(1)

    const wrapper = mount(LibraryView)
    await flushPromises()

    expect(trackers.api.trackerGetRates.mock.calls).toEqual([['anilist'], ['anilist']])
    expect(tabLabels(wrapper)).toEqual(['All', 'Watching', 'Planned', 'Completed'])
  })

  it("mounting during the store's first pull sends no second trackerGetRates", async () => {
    const trackers = trackersApi({ accounts: accountsState(['anilist']) })
    let answer!: (s: TrackerRatesSnapshot) => void
    trackers.api.trackerGetRates.mockImplementation(
      () => new Promise<TrackerRatesSnapshot>((r) => (answer = r))
    )
    libraryApi(trackers)
    useTrackersStore()
    await flushPromises()
    expect(trackers.api.trackerGetRates).toHaveBeenCalledTimes(1)

    const wrapper = mount(LibraryView)
    await flushPromises()
    expect(trackers.api.trackerGetRates).toHaveBeenCalledTimes(1)

    answer(snapshotOf('anilist', [ENTRY]))
    await flushPromises()
    expect(tabLabels(wrapper)).toEqual(['All', 'Watching', 'Planned', 'Completed'])
  })

  it('no account: no rates are asked for', async () => {
    const trackers = trackersApi()
    libraryApi(trackers)
    mount(LibraryView)
    await flushPromises()
    expect(trackers.api.trackerGetRates).not.toHaveBeenCalled()
  })
})
