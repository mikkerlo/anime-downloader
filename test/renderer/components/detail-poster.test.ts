// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AnimeDetailView from '../../../src/renderer/src/components/views/AnimeDetailView.vue'

// A callable + thenable stub: unknown window.api.* methods return this, so both
// `await api.x()` (resolves undefined) and `unsub = api.onX(cb); unsub()` (callable)
// work without having to enumerate every channel the mount touches.
function makeThenable(): unknown {
  const fn = (): unknown => fn
  ;(fn as { then: unknown }).then = (res?: (v: unknown) => void): unknown => {
    res?.(undefined)
    return fn
  }
  ;(fn as { catch: unknown }).catch = (): unknown => fn
  ;(fn as { finally: unknown }).finally = (f?: () => void): unknown => {
    f?.()
    return fn
  }
  return fn
}

function detail(overrides: Partial<AnimeDetail> = {}): AnimeDetail {
  return {
    id: 1,
    title: 'Test Anime',
    titles: { romaji: 'Tesuto', ja: 'テスト' },
    posterUrlSmall: 'poster.jpg',
    posterUrl: 'poster.jpg',
    numberOfEpisodes: 24,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2021,
    season: 'spring',
    // A very long synopsis + many genres make the meta column grow tall — the
    // exact condition under which the prototype's poster used to stretch.
    descriptions: [{ source: 'x', value: 'Lorem ipsum dolor sit amet. '.repeat(120) }],
    episodes: [],
    genres: Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Genre ${i}` })),
    // No myAnimeListId → the Shikimori/Friends/Chronology side panels stay
    // unrendered, keeping this mount about the hero layout under test.
    ...overrides
  }
}

function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      getAnimeCache: vi.fn().mockResolvedValue(null),
      getAnime: vi.fn().mockResolvedValue({ source: 'api', data: detail() }),
      setAnimeCache: vi.fn().mockResolvedValue(undefined),
      getSetting: vi.fn().mockResolvedValue(null),
      libraryHas: vi.fn().mockResolvedValue(false),
      libraryIsDownloaded: vi.fn().mockResolvedValue(false),
      autoDlGetSubscription: vi.fn().mockResolvedValue(null),
      shikimoriGetUser: vi.fn().mockResolvedValue(null),
      shikimoriGetSyncStatus: vi.fn().mockResolvedValue({ state: 'idle', queueLength: 0 }),
      shikimoriGetOfflineQueueLength: vi.fn().mockResolvedValue(0)
    } as Record<string, unknown>,
    {
      get: (t, p, r) => (p in t ? Reflect.get(t, p, r) : () => makeThenable())
    }
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

describe('AnimeDetailView — hero poster layout (anti-stretch regression)', () => {
  it('keeps the poster in its own fixed column, not inside the growing meta column', async () => {
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    const top = wrapper.find('.detail-top')
    const poster = wrapper.find('.detail-poster')
    const meta = wrapper.find('.detail-meta')
    expect(top.exists()).toBe(true)
    expect(poster.exists()).toBe(true)
    expect(meta.exists()).toBe(true)

    // The poster column and the (growing) meta column are SIBLINGS under
    // .detail-top — the poster is not nested in the meta column, so it can't be
    // stretched by the synopsis/tags growing. happy-dom can't compute pixel
    // layout, so this guards the structural contract rather than measured size.
    expect(poster.element.parentElement).toBe(top.element)
    expect(meta.element.parentElement).toBe(top.element)
    expect(meta.element.contains(poster.element)).toBe(false)
    // Poster image lives inside the fixed-width wrapper.
    expect(poster.find('img').exists()).toBe(true)
  })

  it('renders a single hero synopsis with a Show more/less toggle when long', async () => {
    const wrapper = mount(AnimeDetailView, { props: { animeId: 1 } })
    await flushPromises()

    // Exactly one synopsis block (the hero owns it — no duplicate panel copy).
    expect(wrapper.findAll('.detail-synopsis')).toHaveLength(1)

    // Long synopsis starts clamped with a "Show more" toggle…
    const synopsis = wrapper.find('.detail-synopsis')
    expect(synopsis.classes()).toContain('clamped')
    const toggle = wrapper.find('.synopsis-toggle')
    expect(toggle.exists()).toBe(true)
    expect(toggle.text()).toBe('Show more')

    // …and expands on click.
    await toggle.trigger('click')
    expect(wrapper.find('.detail-synopsis').classes()).not.toContain('clamped')
    expect(wrapper.find('.synopsis-toggle').text()).toBe('Show less')
  })
})
