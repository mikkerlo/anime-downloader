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
})
