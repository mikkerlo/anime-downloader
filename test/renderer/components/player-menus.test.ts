// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import QualityMenu from '../../../src/renderer/src/components/player/QualityMenu.vue'
import TranslationMenu from '../../../src/renderer/src/components/player/TranslationMenu.vue'
import Anime4KMenu from '../../../src/renderer/src/components/player/Anime4KMenu.vue'
import PlayerTitleBar from '../../../src/renderer/src/components/player/PlayerTitleBar.vue'
import EpisodeNavButton from '../../../src/renderer/src/components/player/EpisodeNavButton.vue'

// These guard the *wiring* (emit contracts), not the CSS — the #167 restyle
// renames/retunes classes, so a markup-only assertion wouldn't catch a silent
// handler regression. Each test clicks a real option and checks the emitted
// payload PlayerView depends on.

describe('QualityMenu', () => {
  const streams = [
    { height: 1080, url: 'u1080' },
    { height: 720, url: 'u720' }
  ]

  it('emits toggle-menu when the trigger button is clicked', async () => {
    const w = mount(QualityMenu, {
      props: { open: false, availableStreams: streams, selectedHeight: 720 }
    })
    await w.find('.preset-btn').trigger('click')
    expect(w.emitted('toggle-menu')).toHaveLength(1)
  })

  it('emits select with the chosen stream object', async () => {
    const w = mount(QualityMenu, {
      props: { open: true, availableStreams: streams, selectedHeight: 720 }
    })
    const options = w.findAll('.preset-option')
    expect(options).toHaveLength(2)
    await options[0].trigger('click')
    expect(w.emitted('select')?.[0]).toEqual([{ height: 1080, url: 'u1080' }])
  })
})

describe('Anime4KMenu', () => {
  const base = {
    open: true,
    preset: 'off' as const,
    presetLabel: 'Anime4K',
    gpuName: 'Test GPU'
  }

  it('emits select with the preset key for the clicked option', async () => {
    const w = mount(Anime4KMenu, { props: base })
    const options = w.findAll('.preset-option')
    // off, mode-a, mode-b, mode-c
    expect(options).toHaveLength(4)
    await options[1].trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['mode-a'])
  })

  it('marks the trigger active when a shader preset is on', () => {
    const off = mount(Anime4KMenu, { props: base })
    expect(off.find('.preset-btn').classes()).not.toContain('active')
    const on = mount(Anime4KMenu, { props: { ...base, preset: 'mode-b' } })
    expect(on.find('.preset-btn').classes()).toContain('active')
  })
})

describe('TranslationMenu', () => {
  const groups = [
    { type: 'subRu', label: 'RU SUB', items: [{ id: 1, label: 'A', type: 'subRu', height: 720 }] },
    { type: 'voiceRu', label: 'RU DUB', items: [{ id: 2, label: 'B', type: 'voiceRu', height: 1080 }] }
  ]

  it('emits open-group when a type group is clicked (types level)', async () => {
    const w = mount(TranslationMenu, {
      props: {
        open: true,
        loading: false,
        level: 'types',
        selectedTypeGroup: '',
        groups,
        selectedItems: [],
        activeTranslationId: 0,
        activeDownloadedTrIds: [],
        currentLabel: 'Translation'
      }
    })
    await w.findAll('.group-option')[1].trigger('click')
    expect(w.emitted('open-group')?.[0]).toEqual(['voiceRu'])
  })

  it('emits select with the translation when an item is clicked (items level)', async () => {
    const item = { id: 2, label: 'B', type: 'voiceRu', height: 1080 }
    const w = mount(TranslationMenu, {
      props: {
        open: true,
        loading: false,
        level: 'items',
        selectedTypeGroup: 'voiceRu',
        groups,
        selectedItems: [item],
        activeTranslationId: 1,
        activeDownloadedTrIds: [2],
        currentLabel: 'A'
      }
    })
    // First option is the "back" row (groups.length > 1); the item follows.
    const items = w.findAll('.preset-option:not(.back-option)')
    await items[items.length - 1].trigger('click')
    expect(w.emitted('select')?.[0]).toEqual([item])
  })
})

describe('PlayerTitleBar', () => {
  const base = {
    animeName: 'Test',
    subtitle: 'Episode 1 of 12 · 1080p · AniLibria',
    prefetchInFlight: null
  }

  it('emits close from the back button', async () => {
    const w = mount(PlayerTitleBar, { props: base })
    await w.find('.close-btn').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('renders the anime title and the metadata sub-line', () => {
    const w = mount(PlayerTitleBar, { props: base })
    expect(w.find('.pt-title').text()).toBe('Test')
    expect(w.find('.pt-sub').text()).toBe('Episode 1 of 12 · 1080p · AniLibria')
  })

  it('renders the prefetch chip only when a prefetch is in flight', () => {
    const idle = mount(PlayerTitleBar, { props: base })
    expect(idle.find('.prefetch-indicator').exists()).toBe(false)
    const busy = mount(PlayerTitleBar, {
      props: {
        ...base,
        prefetchInFlight: { episodeInt: '4', translationId: 9, progress: 47, speed: 0 }
      }
    })
    expect(busy.find('.prefetch-indicator').exists()).toBe(true)
  })

  // Episode nav moved out of the title bar into the control bar (#167) — the
  // wiring is now covered by EpisodeNavButton below.
})

describe('EpisodeNavButton (control-bar episode nav, relocated #167)', () => {
  it('emits nav when clicked', async () => {
    const w = mount(EpisodeNavButton, { props: { direction: 'next', disabled: false } })
    await w.find('button').trigger('click')
    expect(w.emitted('nav')).toHaveLength(1)
  })

  it('is disabled (and does not emit) when disabled', async () => {
    const w = mount(EpisodeNavButton, { props: { direction: 'prev', disabled: true } })
    expect((w.find('button').element as HTMLButtonElement).disabled).toBe(true)
    await w.find('button').trigger('click')
    expect(w.emitted('nav')).toBeUndefined()
  })

  it('uses a direction-specific title', () => {
    const prev = mount(EpisodeNavButton, { props: { direction: 'prev', disabled: false } })
    const next = mount(EpisodeNavButton, { props: { direction: 'next', disabled: false } })
    expect(prev.find('button').attributes('title')).toContain('Previous')
    expect(next.find('button').attributes('title')).toContain('Next')
  })
})
