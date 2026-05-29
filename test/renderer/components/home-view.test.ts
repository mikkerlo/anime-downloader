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

function stubApi(entries: ContinueWatchingEntry[]): void {
  // Real methods HomeView calls; any other access (store `on*` subscriptions)
  // falls back to a no-op returning a no-op unsubscribe handle.
  const real: Record<string, unknown> = {
    homeGetContinueWatching: vi.fn().mockResolvedValue(entries),
    shikimoriGetAnimeRates: vi.fn().mockResolvedValue([]),
    libraryHas: vi.fn().mockResolvedValue(false),
    libraryToggle: vi.fn().mockResolvedValue(true)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(real, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
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
