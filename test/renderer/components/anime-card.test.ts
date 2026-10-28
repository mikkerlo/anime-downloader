// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AnimeCard from '../../../src/renderer/src/components/shared/AnimeCard.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'

beforeEach(() => {
  setActivePinia(createPinia())
})

const anime: AnimeSearchResult = {
  id: 1,
  title: 'Steins;Gate',
  titles: { ru: 'Врата Штейна', romaji: 'Steins;Gate' },
  posterUrlSmall: 'poster.jpg',
  numberOfEpisodes: 24,
  type: 'tv',
  typeTitle: 'TV',
  year: 2011,
  season: 'spring'
}

describe('AnimeCard', () => {
  it('anchors the star button inside the poster wrapper, not the card root', () => {
    // Regression for the design prototype's overlap bug: poster overlays must
    // live inside `.poster-wrap` so they can never collide with the title/meta
    // rendered below the poster.
    const wrapper = mount(AnimeCard, { props: { anime, starred: false } })
    const overlay = wrapper.find('.poster-wrap .star-btn')
    expect(overlay.exists()).toBe(true)
    // And it is NOT a direct child of the card root (i.e. not a sibling of info).
    expect(wrapper.find('.acard > .star-btn').exists()).toBe(false)
    // Title + meta live outside the poster wrapper.
    expect(wrapper.find('.acard-info .acard-title').exists()).toBe(true)
  })

  it('reflects the starred state and emits toggleStar on click', async () => {
    const wrapper = mount(AnimeCard, { props: { anime, starred: true } })
    expect(wrapper.find('.star-btn').classes()).toContain('active')

    await wrapper.find('.star-btn').trigger('click')
    expect(wrapper.emitted('toggleStar')).toBeTruthy()
    expect(wrapper.emitted('toggleStar')![0]).toEqual([anime])
  })

  it('anchors the priority button inside the poster wrapper too', () => {
    // Same regression as the star (#269 adds a *second* overlay): both must
    // live inside `.poster-wrap` so neither can collide with the title/meta.
    const wrapper = mount(AnimeCard, { props: { anime, starred: false, prioritized: false } })
    expect(wrapper.find('.poster-wrap .priority-btn').exists()).toBe(true)
    expect(wrapper.find('.acard > .priority-btn').exists()).toBe(false)
  })

  it('reflects the prioritized state and emits togglePriority on click', async () => {
    const wrapper = mount(AnimeCard, { props: { anime, starred: false, prioritized: true } })
    expect(wrapper.find('.priority-btn').classes()).toContain('active')

    await wrapper.find('.priority-btn').trigger('click')
    expect(wrapper.emitted('togglePriority')).toBeTruthy()
    expect(wrapper.emitted('togglePriority')![0]).toEqual([anime])
    // The two overlays are independent — priority must not fire star.
    expect(wrapper.emitted('toggleStar')).toBeFalsy()
  })

  it('still mounts when `prioritized` and its listener are omitted', async () => {
    // `prioritized` is optional, so a caller that has not been wired renders an
    // inert flag rather than throwing.
    const wrapper = mount(AnimeCard, { props: { anime, starred: false } })
    const flag = wrapper.find('.priority-btn')
    expect(flag.exists()).toBe(true)
    expect(flag.classes()).not.toContain('active')
    await flag.trigger('click')
    expect(wrapper.emitted('togglePriority')).toBeTruthy()
  })
})

// #570: a card keeps its poster offline by loading it from main's disk cache.
describe('AnimeCard — poster source (#570)', () => {
  it('uses anime-poster://<id> when the id is in the cached set', () => {
    useLibraryStore().posterIds = new Set([1])
    const wrapper = mount(AnimeCard, { props: { anime, starred: false } })
    expect(wrapper.find('img.poster').attributes('src')).toBe('anime-poster://1')
  })

  it('uses the remote posterUrlSmall when it is not — today', () => {
    useLibraryStore().posterIds = new Set([2])
    const wrapper = mount(AnimeCard, { props: { anime, starred: false } })
    expect(wrapper.find('img.poster').attributes('src')).toBe('poster.jpg')
  })

  it('switches to the cached poster once the id set loads', async () => {
    const store = useLibraryStore()
    const wrapper = mount(AnimeCard, { props: { anime, starred: false } })
    expect(wrapper.find('img.poster').attributes('src')).toBe('poster.jpg')
    store.posterIds = new Set([1])
    await wrapper.vm.$nextTick()
    expect(wrapper.find('img.poster').attributes('src')).toBe('anime-poster://1')
  })

  it('a cached poster that fails to load falls back to the remote URL', async () => {
    useLibraryStore().posterIds = new Set([1])
    const wrapper = mount(AnimeCard, { props: { anime, starred: false } })
    await wrapper.find('img.poster').trigger('error')
    expect(wrapper.find('img.poster').attributes('src')).toBe('poster.jpg')
  })
})
