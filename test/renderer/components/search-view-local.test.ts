// @vitest-environment happy-dom
// Search over the titles this PC has (#571): offline the local results replace
// the remote ones, online they are the "In your library" section above them.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SearchView from '../../../src/renderer/src/components/views/SearchView.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
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

type SourceArg = Exclude<LocalSource['kind'], 'shared'> | LocalSource

function local(
  id: number,
  sources: SourceArg[],
  extra: Partial<LocalSearchResult> = {}
): LocalSearchResult {
  return {
    ...anime(id),
    localSources: sources.map((s) => (typeof s === 'string' ? { kind: s } : s)),
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

describe('SearchView — a chip clicked while a new local search is in flight (#612 review)', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  const OLD = [
    local(1, ['starred'], { genres: ['Drama', 'Action'] }),
    local(2, ['starred'], { genres: ['Action'] })
  ]
  const NEW = [local(3, ['downloaded'], { genres: ['Comedy'] })]

  const activeGenre = (wrapper: VueWrapper): string[] =>
    wrapper
      .find('[data-testid="genre-chips"]')
      .findAll('.pill-tab')
      .filter((t) => t.classes('active'))
      .map((t) => t.text())

  async function setup(): Promise<{
    wrapper: VueWrapper
    searchLocal: Fn
    fresh: ReturnType<typeof deferred<LocalSearchResponse>>
    chip: ReturnType<typeof deferred<LocalSearchResponse>>
    submitNew: () => Promise<void>
    clickDrama: () => Promise<void>
  }> {
    const fresh = deferred<LocalSearchResponse>()
    const chip = deferred<LocalSearchResponse>()
    // The old query lands at once; the new query and any chip wait.
    const searchLocal = vi.fn((q: string, filters?: LocalSearchFilters) =>
      filters
        ? chip.promise
        : q === 'old'
          ? Promise.resolve({ results: OLD, corpusSize: 3 })
          : fresh.promise
    )
    stubApi({ searchLocal }, 'offline-manual')
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'old')
    expect(cardIds(wrapper, '.local-grid')).toEqual([1, 2])
    return {
      wrapper,
      searchLocal,
      fresh,
      chip,
      submitNew: async () => {
        await wrapper.find('input.search-input').setValue('new')
        await wrapper.find('form.search-wrap').trigger('submit')
      },
      clickDrama: async () => {
        await wrapper
          .find('[data-testid="genre-chips"]')
          .findAll('.pill-tab')
          .find((t) => t.text() === 'Drama')!
          .trigger('click')
      }
    }
  }

  async function expectNewQuery(wrapper: VueWrapper): Promise<void> {
    expect(cardIds(wrapper, '.local-grid')).toEqual([3])
    const chips = wrapper.find('[data-testid="genre-chips"]').findAll('.pill-tab')
    expect(chips.map((t) => t.text())).toEqual(['All genres', 'Comedy'])
    expect(activeGenre(wrapper)).toEqual(['All genres'])
  }

  // The review's scenario: an old chip clicked after the new query went out.
  it.each(['the new search lands first', 'the chip lands first'])(
    'a chip from the old results, clicked while the new query is in flight: %s',
    async (order) => {
      const { wrapper, fresh, chip, submitNew, clickDrama } = await setup()
      await submitNew()
      await clickDrama()

      if (order === 'the new search lands first') {
        fresh.resolve({ results: NEW, corpusSize: 3 })
        await flushPromises()
        chip.resolve({ results: [OLD[0]], corpusSize: 3 })
      } else {
        chip.resolve({ results: [OLD[0]], corpusSize: 3 })
        await flushPromises()
        // No old filtered hits under the new query's text in the meantime.
        expect(cardIds(wrapper, '.local-grid')).toEqual([1, 2])
        fresh.resolve({ results: NEW, corpusSize: 3 })
      }
      await flushPromises()
      await expectNewQuery(wrapper)
    }
  )

  it('a chip clicked on the landed results yields to a query submitted after it', async () => {
    const { wrapper, searchLocal, fresh, chip, submitNew, clickDrama } = await setup()
    await clickDrama()
    expect(searchLocal).toHaveBeenLastCalledWith('old', { genre: 'Drama' })
    await submitNew()
    chip.resolve({ results: [OLD[0]], corpusSize: 3 })
    await flushPromises()
    // The filter refined a query that is no longer the one in the input.
    expect(cardIds(wrapper, '.local-grid')).toEqual([1, 2])
    expect(activeGenre(wrapper)).toEqual(['All genres'])

    fresh.resolve({ results: NEW, corpusSize: 3 })
    await flushPromises()
    await expectNewQuery(wrapper)
  })

  it("a later chip click wins over an earlier one's late response", async () => {
    const byGenre: Record<string, ReturnType<typeof deferred<LocalSearchResponse>>> = {
      Drama: deferred(),
      Action: deferred()
    }
    const searchLocal = vi.fn((_q: string, filters?: LocalSearchFilters) =>
      filters?.genre
        ? byGenre[filters.genre].promise
        : Promise.resolve({ results: OLD, corpusSize: 3 })
    )
    stubApi({ searchLocal }, 'offline-manual')
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'old')
    const click = async (genre: string): Promise<void> => {
      await wrapper
        .find('[data-testid="genre-chips"]')
        .findAll('.pill-tab')
        .find((t) => t.text() === genre)!
        .trigger('click')
    }
    await click('Drama')
    await click('Action')

    // Distinct fake hits per chip, so the card ids say whose response painted.
    byGenre.Action.resolve({ results: [OLD[1]], corpusSize: 3 })
    await flushPromises()
    byGenre.Drama.resolve({ results: [OLD[0]], corpusSize: 3 })
    await flushPromises()

    expect(cardIds(wrapper, '.local-grid')).toEqual([2])
    expect(activeGenre(wrapper)).toEqual(['Action'])
  })
})

describe('SearchView — the Starred badge follows the star (#612 review)', () => {
  const badges = (wrapper: VueWrapper): string[] =>
    wrapper.findAll('[data-testid="local-card"] .local-badge').map((b) => b.text())

  it('un-starring a local card removes its Starred badge', async () => {
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [local(1, ['starred', 'downloaded'])],
          corpusSize: 1
        }),
        libraryToggle: vi.fn().mockResolvedValue(false)
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')
    expect(badges(wrapper)).toEqual(['Starred', 'Downloaded'])

    await wrapper.find('[data-testid="local-card"] .star-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="local-card"] .star-btn').classes()).not.toContain('active')
    expect(badges(wrapper)).toEqual(['Downloaded'])
  })

  it('starring a downloaded-only local card adds the Starred badge', async () => {
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [local(2, ['downloaded'])],
          corpusSize: 1
        }),
        libraryToggle: vi.fn().mockResolvedValue(true)
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')
    expect(badges(wrapper)).toEqual(['Downloaded'])

    await wrapper.find('[data-testid="local-card"] .star-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="local-card"] .star-btn').classes()).toContain('active')
    expect(badges(wrapper)).toEqual(['Starred', 'Downloaded'])
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

describe('SearchView — titles on an attached Shared Library (#583)', () => {
  const LIB_A = '5d7c1f3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f'
  const LIB_B = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'
  const onDrive = (libraryId: string, libraryName: string): LocalSource => ({
    kind: 'shared',
    libraryId,
    libraryName
  })
  const driveTitle = (id: number, sources: SourceArg[]): LocalSearchResult =>
    local(id, sources, { posterUrlSmall: `anime-poster://shared/${LIB_A}/${id}` })

  const badges = (card: ReturnType<VueWrapper['find']>): string[] =>
    card.findAll('.local-badge').map((b) => b.text())

  it('offline: a drive title shows "On <library>" and its drive poster; two drives, two badges', async () => {
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [
            driveTitle(101, [onDrive(LIB_A, 'Stick')]),
            driveTitle(102, ['starred', onDrive(LIB_A, 'Stick'), onDrive(LIB_B, 'Backup')])
          ],
          corpusSize: 2
        })
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'frieren')

    const cards = wrapper.findAll('[data-testid="local-card"]')
    expect(badges(cards[0])).toEqual(['On Stick'])
    expect(cards[0].find('[data-testid="drive-badge"]').attributes('title')).toBe('On Stick')
    expect(cards[0].find('[data-testid="drive-badge"] svg').exists()).toBe(true)
    expect(cards[0].find('.local-badge').classes()).toContain('src-shared')
    expect(cards[0].find('img.poster').attributes('src')).toBe(`anime-poster://shared/${LIB_A}/101`)
    expect(badges(cards[1])).toEqual(['Starred', 'On Stick', 'On Backup'])
    expect(cards[1].findAll('[data-testid="drive-badge"]')).toHaveLength(2)
  })

  it('a library name is drive input and renders as text', async () => {
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [driveTitle(101, [onDrive(LIB_A, '<img src=x onerror=alert(1)>')])],
          corpusSize: 1
        })
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'frieren')
    const badge = wrapper.find('[data-testid="drive-badge"]')
    expect(badge.text()).toBe('On <img src=x onerror=alert(1)>')
    expect(badge.find('img').exists()).toBe(false)
  })

  it('clicking a drive title opens it the way the Shared Libraries tab does', async () => {
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [driveTitle(101, [onDrive(LIB_A, 'Stick')])],
          corpusSize: 1
        })
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    const store = useLibraryStore()
    const openAnime = vi.spyOn(store, 'openAnime')
    await submit(wrapper, 'frieren')
    await wrapper.find('[data-testid="local-card"] .acard').trigger('click')
    expect(openAnime).toHaveBeenCalledWith(101)
  })

  it("starring a drive title stores the poster as anime-poster://<id>, as the tab's star does", async () => {
    const libraryToggle = vi.fn().mockResolvedValue(true)
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({
          results: [driveTitle(101, [onDrive(LIB_A, 'Stick')])],
          corpusSize: 1
        }),
        libraryToggle
      },
      'offline-manual'
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'frieren')
    await wrapper.find('[data-testid="local-card"] .star-btn').trigger('click')
    await flushPromises()
    expect(libraryToggle).toHaveBeenCalledWith({
      ...anime(101),
      posterUrlSmall: 'anime-poster://101'
    })
  })

  it('online: drive titles are in the "In your library" section', async () => {
    stubApi({
      searchLocal: vi.fn().mockResolvedValue({
        results: [driveTitle(101, [onDrive(LIB_A, 'Stick')])],
        corpusSize: 1
      }),
      searchAnime: vi.fn().mockResolvedValue({ data: [anime(101), anime(7)] })
    })
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'frieren')
    const section = wrapper.find('[data-testid="local-section"]')
    expect(section.find('h3').text()).toBe('In your library')
    expect(badges(section.find('[data-testid="local-card"]'))).toEqual(['On Stick'])
    expect(cardIds(wrapper, '.remote-grid')).toEqual([7])
  })
})

describe('SearchView — a title on this PC and on a drive asks for the bare poster (#629)', () => {
  const LIB = '5d7c1f3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f'
  const stick: LocalSource = { kind: 'shared', libraryId: LIB, libraryName: 'Stick' }
  const REMOTE = 'https://example.invalid/7.jpg'

  async function posterOf(
    results: LocalSearchResult[],
    mode: 'online' | 'offline-manual' = 'offline-manual'
  ): Promise<{ wrapper: VueWrapper; src: () => string | undefined }> {
    stubApi(
      {
        searchLocal: vi.fn().mockResolvedValue({ results, corpusSize: results.length }),
        getCachedPosterIds: vi.fn().mockResolvedValue([])
      },
      mode
    )
    const wrapper = mount(SearchView)
    await flushPromises()
    await submit(wrapper, 'anime')
    return {
      wrapper,
      src: () => wrapper.find('[data-testid="local-card"] img.poster').attributes('src')
    }
  }

  it('offline, starred here and on a drive, uncached: the bare anime-poster://<id>', async () => {
    const { src } = await posterOf([local(7, ['starred', stick])])
    expect(src()).toBe('anime-poster://7')
  })

  it('online too: the drive poster replaces the remote one in "In your library"', async () => {
    const { wrapper, src } = await posterOf([local(7, ['starred', stick])], 'online')
    expect(wrapper.find('[data-testid="local-section"] h3').text()).toBe('In your library')
    expect(src()).toBe('anime-poster://7')
  })

  it('a starred-only title with an uncached id keeps the remote URL', async () => {
    const { src } = await posterOf([local(7, ['starred'])])
    expect(src()).toBe(REMOTE)
  })

  it('a drive-only title keeps its anime-poster://shared/... URL', async () => {
    const { src } = await posterOf([
      local(7, [stick], { posterUrlSmall: `anime-poster://shared/${LIB}/7` })
    ])
    expect(src()).toBe(`anime-poster://shared/${LIB}/7`)
  })

  it('a record already storing the bare anime-poster://<id> renders exactly that', async () => {
    const { src } = await posterOf([
      local(7, ['starred', stick], { posterUrlSmall: 'anime-poster://7' })
    ])
    expect(src()).toBe('anime-poster://7')
  })

  it('an error on the bare form falls back to the remote URL once, and stays there', async () => {
    const { wrapper, src } = await posterOf([local(7, ['starred', stick])])
    const img = (): ReturnType<VueWrapper['find']> =>
      wrapper.find('[data-testid="local-card"] img.poster')
    expect(src()).toBe('anime-poster://7')
    await img().trigger('error')
    expect(src()).toBe(REMOTE)
    await img().trigger('error')
    expect(src()).toBe(REMOTE)
  })
})
