// @vitest-environment happy-dom
// Search over the titles this PC has (#571): offline the local results replace
// the remote ones, online they are the "In your library" section above them.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SearchView from '../../../src/renderer/src/components/views/SearchView.vue'
import { offlineApi } from '../../helpers/offline-api'

function anime(id: number, title = `Anime ${id}`): AnimeSearchResult {
  return {
    id,
    title,
    titles: {},
    posterUrlSmall: `https://example.invalid/${id}.jpg`,
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV',
    year: 2020,
    season: 'spring'
  }
}

function local(
  id: number,
  sources: LocalSource['kind'][],
  extra: Partial<LocalSearchResult> = {}
): LocalSearchResult {
  return {
    ...anime(id),
    localSources: sources.map((kind) => ({ kind })),
    genres: [],
    ...extra
  }
}

type Fn = ReturnType<typeof vi.fn>

function stubApi(
  overrides: Record<string, unknown>,
  mode: 'online' | 'offline-manual' = 'online'
): Record<string, Fn> {
  const target = {
    ...offlineApi(mode).api,
    searchAnime: vi.fn().mockResolvedValue({ data: [] }),
    searchLocal: vi.fn().mockResolvedValue({ results: [], corpusSize: 0 }),
    getCachedPosterIds: vi.fn().mockResolvedValue([]),
    libraryHas: vi.fn().mockResolvedValue(false),
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    libraryToggle: vi.fn().mockResolvedValue(true),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get: (t, prop, recv) => (prop in t ? Reflect.get(t, prop, recv) : () => () => {})
  })
  return target as unknown as Record<string, Fn>
}

async function submit(wrapper: VueWrapper, q: string): Promise<void> {
  await wrapper.find('input.search-input').setValue(q)
  await wrapper.find('form.search-wrap').trigger('submit')
  await flushPromises()
}

const cardIds = (wrapper: VueWrapper, selector: string): number[] =>
  wrapper
    .findAll(`${selector} img.poster`)
    .map((img) => Number(/(\d+)/.exec(img.attributes('src') ?? '')?.[1]))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SearchView — offline local search (#571)', () => {
  it('offline with matches: shows the local results with local posters and badges, and never calls searchAnime', async () => {
    const api = stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [local(1, ['starred', 'downloaded']), local(2, ['watching'])],
          corpusSize: 5
        }),
        getCachedPosterIds: vi.fn().mockResolvedValue([1, 2])
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="local-subtitle"]').text()).toContain(
      'Showing titles saved on this PC'
    )

    await submit(wrapper, 'anime')

    expect(api.searchLocal).toHaveBeenCalledWith('anime')
    expect(api.searchAnime).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
    const cards = wrapper.findAll('[data-testid="local-card"]')
    expect(cards).toHaveLength(2)
    expect(cards.map((c) => c.find('img.poster').attributes('src'))).toEqual([
      'anime-poster://1',
      'anime-poster://2'
    ])
    expect(cards[0].findAll('.local-badge').map((b) => b.text())).toEqual(['Starred', 'Downloaded'])
    expect(cards[1].findAll('.local-badge').map((b) => b.text())).toEqual(['Watching'])
    // A starred source fills the star without a libraryHas round trip.
    expect(cards[0].find('.star-btn').classes()).toContain('active')
    expect(cards[1].find('.star-btn').classes()).not.toContain('active')
    // Offline there is no "In your library" header and no 6-card cap.
    expect(wrapper.text()).not.toContain('In your library')
  })

  it('offline with a 1-character query: "Type at least 2 characters", and neither search runs', async () => {
    const api = stubApi({}, 'offline-manual')
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, ' 進 ')

    expect(wrapper.find('[data-testid="local-too-short"]').text()).toBe(
      'Type at least 2 characters'
    )
    expect(api.searchLocal).not.toHaveBeenCalled()
    expect(api.searchAnime).not.toHaveBeenCalled()
  })

  it('offline with no matches: the local-empty wording, not the network notice', async () => {
    stubApi(
      { searchLocal: vi.fn().mockResolvedValue({ results: [], corpusSize: 3 }) },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'zzz')

    expect(wrapper.find('[data-testid="local-empty"] p').text()).toBe(
      'Nothing saved on this PC matches'
    )
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
  })

  it('offline chips re-query main with genre and status', async () => {
    const searchLocal = vi.fn().mockResolvedValue({
      results: [
        local(1, ['starred'], { genres: ['Drama', 'Action'], listStatus: 'watching' }),
        local(2, ['starred'], { genres: ['Action'], listStatus: 'completed' })
      ],
      corpusSize: 2
    })
    stubApi({ searchLocal }, 'offline-manual')
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')

    const genre = wrapper.find('[data-testid="genre-chips"]')
    expect(genre.findAll('.pill-tab').map((t) => t.text())).toEqual([
      'All genres',
      'Action',
      'Drama'
    ])
    const status = wrapper.find('[data-testid="status-chips"]')
    expect(status.findAll('.pill-tab').map((t) => t.text())).toEqual([
      'Any status',
      'Watching',
      'Completed'
    ])

    searchLocal.mockResolvedValueOnce({ results: [local(1, ['starred'])], corpusSize: 2 })
    await genre.findAll('.pill-tab')[2].trigger('click')
    await flushPromises()
    expect(searchLocal).toHaveBeenLastCalledWith('anime', { genre: 'Drama' })
    expect(wrapper.findAll('[data-testid="local-card"]')).toHaveLength(1)

    searchLocal.mockResolvedValueOnce({ results: [], corpusSize: 2 })
    await wrapper.find('[data-testid="status-chips"]').findAll('.pill-tab')[2].trigger('click')
    await flushPromises()
    expect(searchLocal).toHaveBeenLastCalledWith('anime', { genre: 'Drama', status: 'completed' })
    // The chips stay, built from the unfiltered hits.
    expect(wrapper.find('[data-testid="genre-chips"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="local-empty"]').exists()).toBe(true)
  })

  it('starring a local card stores the plain search record', async () => {
    const libraryToggle = vi.fn().mockResolvedValue(true)
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [local(2, ['watching'], { genres: ['Action'], listStatus: 'watching' })],
          corpusSize: 1
        }),
        libraryToggle
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')
    await wrapper.find('[data-testid="local-card"] .star-btn').trigger('click')
    await flushPromises()

    expect(libraryToggle).toHaveBeenCalledWith(anime(2))
  })
})

describe('SearchView — "In your library" online (#571)', () => {
  it('renders the local section above the remote results, de-duplicated by id', async () => {
    const order: string[] = []
    const api = stubApi({
      searchLocal: vi.fn(async () => {
        order.push('local')
        return { results: [local(2, ['starred']), local(5, ['downloaded'])], corpusSize: 9 }
      }),
      searchAnime: vi.fn(async () => {
        order.push('remote')
        return { data: [anime(1), anime(2), anime(3), anime(5)] }
      })
    })
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')

    expect(order).toEqual(['local', 'remote'])
    expect(api.searchLocal).toHaveBeenCalledWith('anime')
    const section = wrapper.find('[data-testid="local-section"]')
    expect(section.find('h3').text()).toBe('In your library')
    expect(cardIds(wrapper, '.local-grid')).toEqual([2, 5])
    expect(cardIds(wrapper, '.remote-grid')).toEqual([1, 3])
    // Above: the section precedes the remote grid in document order.
    const html = wrapper.html()
    expect(html.indexOf('data-testid="local-section"')).toBeLessThan(html.indexOf('remote-grid'))
  })

  it('caps the section at 6 with "Show all", and de-duplicates only what it shows', async () => {
    const locals = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => local(id, ['starred']))
    stubApi({
      searchLocal: vi.fn().mockResolvedValue({ results: locals, corpusSize: 8 }),
      searchAnime: vi.fn().mockResolvedValue({ data: [anime(7), anime(8), anime(9)] })
    })
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')

    expect(cardIds(wrapper, '.local-grid')).toEqual([1, 2, 3, 4, 5, 6])
    expect(cardIds(wrapper, '.remote-grid')).toEqual([7, 8, 9])

    await wrapper.find('[data-testid="local-show-all"]').trigger('click')
    expect(cardIds(wrapper, '.local-grid')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(cardIds(wrapper, '.remote-grid')).toEqual([9])
    expect(wrapper.find('[data-testid="local-show-all"]').text()).toBe('Show less')
  })

  it('a 1-character query online runs the remote search as today and hides the section', async () => {
    const api = stubApi({
      searchAnime: vi.fn().mockResolvedValue({ data: [anime(1)] })
    })
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'x')

    expect(api.searchLocal).not.toHaveBeenCalled()
    expect(api.searchAnime).toHaveBeenCalledWith('x')
    expect(wrapper.find('[data-testid="local-section"]').exists()).toBe(false)
    expect(cardIds(wrapper, '.remote-grid')).toEqual([1])
  })

  it('no local hits: no section, and the remote results render as before', async () => {
    stubApi({ searchAnime: vi.fn().mockResolvedValue({ data: [anime(1), anime(2)] }) })
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')

    expect(wrapper.find('[data-testid="local-section"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Search results')
    expect(cardIds(wrapper, '.remote-grid')).toEqual([1, 2])
  })

  it('a failed local search leaves the remote search working', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubApi({
      searchLocal: vi.fn().mockRejectedValue(new Error('boom')),
      searchAnime: vi.fn().mockResolvedValue({ data: [anime(1)] })
    })
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')

    expect(wrapper.find('[data-testid="local-section"]').exists()).toBe(false)
    expect(cardIds(wrapper, '.remote-grid')).toEqual([1])
    err.mockRestore()
  })
})
