// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SearchView from '../../../src/renderer/src/components/views/SearchView.vue'
import LibraryView from '../../../src/renderer/src/components/views/LibraryView.vue'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'

function anime(id: number, typeTitle: string): AnimeSearchResult {
  return {
    id,
    title: `Anime ${id}`,
    titles: {},
    posterUrlSmall: 'p.jpg',
    numberOfEpisodes: 12,
    type: typeTitle.toLowerCase(),
    typeTitle,
    year: 2020,
    season: 'spring'
  }
}

function stubApi(overrides: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(overrides, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SearchView', () => {
  it('renders a card per result and a type filter that narrows them', async () => {
    stubApi({
      searchAnime: vi
        .fn()
        .mockResolvedValue({ data: [anime(1, 'TV'), anime(2, 'TV'), anime(3, 'Movie')] }),
      libraryHas: vi.fn().mockResolvedValue(false),
      libraryToggle: vi.fn().mockResolvedValue(true)
    })
    const wrapper = mount(SearchView)
    await wrapper.find('input.search-input').setValue('x')
    await wrapper.find('form.search-wrap').trigger('submit')
    await flushPromises()

    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(3)
    // Two distinct typeTitles → "All" + TV + Movie.
    const tabs = wrapper.findAll('.pill-tab')
    expect(tabs.map((t) => t.text())).toEqual(['All', 'TV', 'Movie'])

    await tabs[2].trigger('click') // Movie
    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(1)
  })

  it('shows the empty state when a search returns nothing', async () => {
    stubApi({ searchAnime: vi.fn().mockResolvedValue({ data: [] }), libraryHas: vi.fn() })
    const wrapper = mount(SearchView)
    await wrapper.find('input.search-input').setValue('zzz')
    await wrapper.find('form.search-wrap').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.poster-grid').exists()).toBe(false)
    expect(wrapper.find('.empty-state p').text()).toContain('No titles match')
  })
})

describe('LibraryView', () => {
  function rate(smotretId: number, status: string): Record<string, unknown> {
    return {
      rate: {
        id: smotretId,
        score: 0,
        status,
        episodes: 0,
        rewatches: 0,
        updated_at: '',
        target_id: smotretId
      },
      shikiAnime: { id: smotretId, name: `Anime ${smotretId}` },
      smotretAnime: anime(smotretId, 'TV')
    }
  }

  it('renders the saved library and filters by Shikimori status', async () => {
    stubApi({
      libraryGet: vi.fn().mockResolvedValue([anime(1, 'TV'), anime(2, 'TV'), anime(3, 'TV')]),
      libraryGetStatus: vi.fn().mockResolvedValue({ 1: { starred: true, downloaded: true } })
    })
    const shiki = useShikimoriStore()
    shiki.rates = [rate(1, 'watching'), rate(2, 'completed')] as unknown as typeof shiki.rates

    const wrapper = mount(LibraryView)
    await flushPromises()

    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(3)
    // Status tabs appear because rates resolved against library ids.
    const tabs = wrapper.findAll('.pill-tab')
    expect(tabs.map((t) => t.text())).toEqual(['All', 'Watching', 'Planned', 'Completed'])

    await tabs[1].trigger('click') // Watching → only id 1
    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(1)

    await tabs[3].trigger('click') // Completed → only id 2
    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(1)
  })

  it('hides the status tabs when no library entry has a Shikimori status', async () => {
    stubApi({
      libraryGet: vi.fn().mockResolvedValue([anime(9, 'TV')]),
      libraryGetStatus: vi.fn().mockResolvedValue({})
    })
    // Rates exist but for a show NOT in the library — tabs must stay hidden
    // (regression: gating on rate count alone showed empty non-"All" tabs).
    const shiki = useShikimoriStore()
    shiki.rates = [rate(1234, 'watching')] as unknown as typeof shiki.rates

    const wrapper = mount(LibraryView)
    await flushPromises()

    expect(wrapper.find('.pill-tabs').exists()).toBe(false)
    expect(wrapper.findAll('.poster-grid .acard')).toHaveLength(1)
  })
})
