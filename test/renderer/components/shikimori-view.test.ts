// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ShikimoriView from '../../../src/renderer/src/components/views/ShikimoriView.vue'

function rate(id: number, status: string, episodes = 1, aired = 1): ShikiAnimeRateEntry {
  return {
    rate: { id, target_id: id, status, episodes, score: 8, updated_at: '2026-05-30T00:00:00Z' },
    shikiAnime: {
      id,
      name: `Show ${id}`,
      russian: `Шоу ${id}`,
      image: { original: 'https://shikimori.one/p.jpg', preview: '', x96: '', x48: '' },
      episodes: 12,
      episodes_aired: aired,
      kind: 'tv',
      score: '8.0',
      status: 'released'
    },
    smotretAnime: null
  } as unknown as ShikiAnimeRateEntry
}

const PROFILE: ShikimoriProfile = {
  id: 1,
  nickname: 'tester',
  avatar: '',
  friendsCount: 3,
  lists: [
    { status: 'planned', n: 12 },
    { status: 'watching', n: 7 },
    { status: 'completed', n: 41 },
    { status: 'dropped', n: 2 }
  ],
  scores: [0, 0, 0, 0, 1, 1, 6, 19, 14, 8],
  genres: [
    { name: 'Экшен', n: 9 },
    { name: 'Драма', n: 5 }
  ],
  stats: { titles: 62, episodes: 540, mean: 8.12, daysWatched: 9.0 }
}

const RATES = [rate(10, 'completed'), rate(11, 'completed'), rate(12, 'watching', 1, 5)]

function stubApi(opts: {
  user?: ShikiUser | null
  rates?: ShikiAnimeRateEntry[]
  profile?: ShikimoriProfile | null
}): Record<string, ReturnType<typeof vi.fn>> {
  const real: Record<string, ReturnType<typeof vi.fn>> = {
    shikimoriGetUser: vi.fn().mockResolvedValue(opts.user ?? null),
    shikimoriGetAnimeRates: vi.fn().mockResolvedValue(opts.rates ?? []),
    shikimoriGetProfile: vi.fn().mockResolvedValue(opts.profile ?? null),
    libraryGetStatus: vi.fn().mockResolvedValue({}),
    libraryToggle: vi.fn().mockResolvedValue(true),
    shellOpenExternal: vi.fn().mockResolvedValue(true)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(real, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
  return real
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ShikimoriView', () => {
  it('renders the four headline stats from the profile', async () => {
    stubApi({ user: { id: 1, nickname: 'tester', avatar: '' }, rates: RATES, profile: PROFILE })
    const wrapper = mount(ShikimoriView)
    await flushPromises()

    const bigs = wrapper.findAll('.sk-big')
    expect(bigs).toHaveLength(4)
    expect(bigs[0].find('.v').text()).toBe('62')
    expect(bigs[1].find('.v').text()).toBe('540')
  })

  it('renders one legend entry per non-empty list and a 10-bar histogram', async () => {
    stubApi({ user: { id: 1, nickname: 'tester', avatar: '' }, rates: RATES, profile: PROFILE })
    const wrapper = mount(ShikimoriView)
    await flushPromises()

    expect(wrapper.findAll('.sk-leg')).toHaveLength(4)
    expect(wrapper.findAll('.sk-hbar')).toHaveLength(10)
  })

  it('a legend click sets the watchlist status filter', async () => {
    stubApi({ user: { id: 1, nickname: 'tester', avatar: '' }, rates: RATES, profile: PROFILE })
    const wrapper = mount(ShikimoriView)
    await flushPromises()

    // Default filter is "to_watch" → only the watching/unwatched entry (id 12).
    expect(wrapper.findAll('.results-grid .card-wrap')).toHaveLength(1)

    // Click the "Completed" legend → filter switches, grid shows both completed.
    const completed = wrapper.findAll('.sk-leg').find((b) => b.text().includes('Completed'))
    await completed!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.results-grid .card-wrap')).toHaveLength(2)
  })

  it('shows the connect affordance when logged out', async () => {
    stubApi({ user: null })
    const wrapper = mount(ShikimoriView)
    await flushPromises()

    expect(wrapper.find('.sk-profile').exists()).toBe(false)
    expect(wrapper.find('.empty-state').text()).toContain('Connect your Shikimori')
  })
})
