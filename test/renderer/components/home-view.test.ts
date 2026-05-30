// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import HomeView from '../../../src/renderer/src/components/views/HomeView.vue'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'

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
  dismissed: string[] = []
): Record<string, ReturnType<typeof vi.fn>> {
  // Real methods HomeView calls; any other access (store `on*` subscriptions)
  // falls back to a no-op returning a no-op unsubscribe handle.
  const real: Record<string, ReturnType<typeof vi.fn>> = {
    homeGetContinueWatching: vi.fn().mockResolvedValue(entries),
    shikimoriGetAnimeRates: vi.fn().mockResolvedValue([]),
    libraryHas: vi.fn().mockResolvedValue(false),
    libraryToggle: vi.fn().mockResolvedValue(true),
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
    stubApi([])
    const shiki = useShikimoriStore()
    shiki.rates = [
      rate(10, 'planned', '2026-05-20T00:00:00Z'),
      rate(11, 'watching', '2026-05-29T00:00:00Z'),
      rate(12, 'completed', '2026-05-30T00:00:00Z'), // excluded — not an active status
      rate(13, 'planned', '2026-05-10T00:00:00Z', /* no smotret */ true)
    ] as unknown as typeof shiki.rates

    const wrapper = mount(HomeView)
    await flushPromises()

    const cards = wrapper.findAll('.poster-grid .acard')
    expect(cards).toHaveLength(2) // completed + no-smotret entries excluded
    expect(wrapper.find('.section-head h3').text()).toBe('Recently added to your list')
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

  it('resurfaces a dismissed show once its episode advances', async () => {
    // Keyed on animeId:episodeInt, not animeId — so when a refresh returns a NEWER
    // episode for the same anime (key never dismissed), the show comes back.
    const api = stubApi([resumeEntry, nextEntry], ['1:12'])
    const shiki = useShikimoriStore()
    const wrapper = mount(HomeView)
    await flushPromises()
    expect(wrapper.findAll('.cw-title').map((t) => t.text())).toEqual(['Cowboy Bebop'])

    // Episode advances: anime 1 now resumes at ep 13. Re-fetch is driven by the
    // store's deep rates watcher calling refresh().
    api.homeGetContinueWatching.mockResolvedValue([
      { ...resumeEntry, episodeInt: '13', episodeLabel: 'Episode 13', updatedAt: 3 },
      nextEntry
    ])
    shiki.rates = [] as unknown as typeof shiki.rates
    await flushPromises()

    const titles = wrapper.findAll('.cw-title').map((t) => t.text())
    expect(titles).toContain('Steins;Gate') // ep 13 (key 1:13) was never dismissed → back
    expect(titles).toContain('Cowboy Bebop')
  })
})

function rate(
  id: number,
  status: string,
  updatedAt: string,
  noSmotret = false
): Record<string, unknown> {
  return {
    rate: { id, score: 0, status, episodes: 0, rewatches: 0, updated_at: updatedAt, target_id: id },
    shikiAnime: { id, name: `Show ${id}` },
    smotretAnime: noSmotret
      ? null
      : {
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
}
