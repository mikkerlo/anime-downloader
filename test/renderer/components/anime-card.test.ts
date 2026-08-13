// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AnimeCard from '../../../src/renderer/src/components/shared/AnimeCard.vue'

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
