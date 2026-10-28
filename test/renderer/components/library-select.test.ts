// @vitest-environment happy-dom
//
// Library multi-select for "Export N titles…" (#574).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { isProxy } from 'vue'
import LibraryView from '../../../src/renderer/src/components/views/LibraryView.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'

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

let exportPlan: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  exportPlan = vi.fn(async () => ({ titles: [], target: null }))
  const overrides: Record<string, unknown> = {
    libraryGet: vi.fn().mockResolvedValue([anime(1), anime(2), anime(3)]),
    libraryGetStatus: vi.fn().mockResolvedValue({}),
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    exportPlan,
    exportListJobs: vi.fn(async () => []),
    getCachedPosterIds: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(overrides, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
})

describe('LibraryView — multi-select export (#574)', () => {
  it('Select shows checkboxes; card clicks select instead of opening; Export N titles… opens the dialog', async () => {
    const w = mount(LibraryView)
    await flushPromises()
    const lib = useLibraryStore()
    const openAnime = vi.spyOn(lib, 'openAnime')
    expect(w.find('[data-testid="card-select"]').exists()).toBe(false)

    await w.find('[data-testid="library-select-toggle"]').trigger('click')
    expect(w.findAll('[data-testid="card-select"]')).toHaveLength(3)
    const exportBtn = w.find('[data-testid="library-export-selected"]')
    expect((exportBtn.element as HTMLButtonElement).disabled).toBe(true)

    const cards = w.findAll('.acard')
    await cards[0].trigger('click')
    await w.findAll('[data-testid="card-select"]')[2].trigger('change')
    expect(openAnime).not.toHaveBeenCalled()
    expect(exportBtn.text()).toBe('Export 2 titles…')
    expect(cards[0].classes()).toContain('selected')

    // Deselect and reselect through the card.
    await cards[0].trigger('click')
    expect(exportBtn.text()).toBe('Export 1 title…')
    await cards[0].trigger('click')

    await exportBtn.trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="export-dialog"]').exists()).toBe(true)
    // Selection order: 3 stayed, 1 was dropped and picked again.
    expect(exportPlan).toHaveBeenCalledWith({
      animeIds: [3, 1],
      target: null,
      name: 'Anime Library'
    })
    // IPC structured-clones its arguments, and a reactive proxy can't be cloned.
    expect(isProxy(exportPlan.mock.calls[0][0].animeIds)).toBe(false)
  })

  it('outside select mode a card click opens the title', async () => {
    const w = mount(LibraryView)
    await flushPromises()
    const openAnime = vi.spyOn(useLibraryStore(), 'openAnime')
    await w.findAll('.acard')[1].trigger('click')
    expect(openAnime).toHaveBeenCalledWith(2)
  })

  it('Done leaves select mode and clears the selection', async () => {
    const w = mount(LibraryView)
    await flushPromises()
    await w.find('[data-testid="library-select-toggle"]').trigger('click')
    await w.findAll('.acard')[0].trigger('click')
    await w.find('[data-testid="library-select-toggle"]').trigger('click')
    expect(w.find('[data-testid="card-select"]').exists()).toBe(false)
    await w.find('[data-testid="library-select-toggle"]').trigger('click')
    expect(w.find('[data-testid="library-export-selected"]').text()).toBe('Export 0 titles…')
  })
})
