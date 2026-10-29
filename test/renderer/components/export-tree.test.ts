// @vitest-environment happy-dom
//
// The export tree (#574): tri-state selection over title → translation →
// episode, and the size totals.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ExportTree from '../../../src/renderer/src/components/shared-library/ExportTree.vue'
import {
  allKeys,
  sizeOf,
  stateOf,
  titleSize,
  toSelection,
  toggle
} from '../../../src/renderer/src/components/shared-library/export-selection'
import { exportEstimate } from '../../../src/shared/shared-library-export'

const ep = (
  animeId: number,
  tid: number,
  n: string,
  size: number,
  state: ExportTreeEpisode['state'] = 'ready'
): ExportTreeEpisode => ({
  key: `${animeId}:${n}:${tid}`,
  episodeInt: n,
  label: `Episode ${n}`,
  state,
  size,
  unmerged: false
})

const TITLES: ExportTreeTitle[] = [
  {
    animeId: 1,
    name: 'Alpha',
    translations: [
      {
        translationId: 11,
        author: 'A',
        translationType: 'subRu',
        quality: 720,
        episodes: [ep(1, 11, '1', 100), ep(1, 11, '2', 200), ep(1, 11, '3', 0, 'missing')]
      },
      {
        translationId: 12,
        author: 'B',
        translationType: 'voiceRu',
        quality: 1080,
        episodes: [ep(1, 12, '1', 1000)]
      }
    ],
    notDownloaded: [{ episodeInt: '4', label: 'Episode 4', options: [], unavailable: null }]
  },
  {
    animeId: 2,
    name: 'Beta',
    translations: [
      {
        translationId: 21,
        author: 'C',
        translationType: 'subRu',
        quality: 720,
        episodes: [ep(2, 21, '1', 7, 'busy')]
      }
    ],
    notDownloaded: []
  }
]

describe('export selection helpers', () => {
  it('tri-state over ready keys only', () => {
    const alpha = allKeys([TITLES[0]])
    expect(alpha).toEqual(['1:1:11', '1:2:11', '1:1:12'])
    expect(stateOf(alpha, new Set())).toBe('unchecked')
    expect(stateOf(alpha, new Set(['1:1:11']))).toBe('partial')
    expect(stateOf(alpha, new Set(alpha))).toBe('checked')
    expect(stateOf([], new Set())).toBe('unchecked')
  })

  it('a click on a checked node clears it, on anything else selects all of it', () => {
    const alpha = allKeys([TITLES[0]])
    const partial = new Set(['1:1:11'])
    expect([...toggle(alpha, partial)].sort()).toEqual([...alpha].sort())
    expect(toggle(alpha, new Set(alpha)).size).toBe(0)
  })

  it('sizes count ready episodes, and the estimate skips missing, busy and present', () => {
    expect(sizeOf(TITLES[0].translations[0].episodes)).toBe(300)
    expect(titleSize(TITLES[0])).toBe(1300)
    const selected = new Set(['1:1:11', '1:2:11', '1:3:11', '2:1:21', '1:1:12'])
    expect(exportEstimate(TITLES, selected, ['1:1:12'])).toEqual({
      bytes: 300,
      items: 2,
      unmerged: 0,
      alreadyThere: 1,
      skipped: 2
    })
    expect(toSelection(TITLES, new Set(['1:2:11']))).toEqual([
      { animeId: 1, translationId: 11, episodeInt: '2' }
    ])
  })
})

describe('ExportTree.vue', () => {
  function mountTree(selected: Set<string>) {
    return mount(ExportTree, { props: { titles: TITLES, selected, present: ['1:1:12'] } })
  }

  it('renders the title checkbox indeterminate on a partial selection, with per-node sizes', () => {
    const w = mountTree(new Set(['1:1:11']))
    const title = w.find('[data-testid="tree-title-1"]').element as HTMLInputElement
    expect(title.indeterminate).toBe(true)
    expect(title.checked).toBe(false)
    const tr = w.find('[data-testid="tree-translation-12"]').element as HTMLInputElement
    expect(tr.checked).toBe(false)
    expect(w.text()).toContain('1.3 KB')
    expect(w.text()).toContain('Not downloaded')
    expect(w.text()).toContain('On the drive')
    // Missing and busy episodes can't be selected; a node with nothing ready is disabled.
    expect(
      (w.find('[data-testid="tree-episode-1:3:11"]').element as HTMLInputElement).disabled
    ).toBe(true)
    expect((w.find('[data-testid="tree-title-2"]').element as HTMLInputElement).disabled).toBe(true)
  })

  it('clicking a partial title selects every ready episode under it', async () => {
    const w = mountTree(new Set(['1:1:11']))
    await w.find('[data-testid="tree-title-1"]').trigger('change')
    const emitted = w.emitted('update:selected')![0][0] as Set<string>
    expect([...emitted].sort()).toEqual(['1:1:11', '1:1:12', '1:2:11'])
  })

  it('clicking a checked translation clears only its episodes', async () => {
    const w = mountTree(new Set(['1:1:11', '1:2:11', '1:1:12']))
    expect((w.find('[data-testid="tree-title-1"]').element as HTMLInputElement).checked).toBe(true)
    await w.find('[data-testid="tree-translation-11"]').trigger('change')
    const emitted = w.emitted('update:selected')![0][0] as Set<string>
    expect([...emitted]).toEqual(['1:1:12'])
  })

  it('collapses a title', async () => {
    const w = mountTree(new Set())
    expect(w.find('[data-testid="tree-translation-11"]').exists()).toBe(true)
    await w.find('.caret').trigger('click')
    expect(w.find('[data-testid="tree-translation-11"]').exists()).toBe(false)
  })
})
