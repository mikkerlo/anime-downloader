// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DownloadsView from '../../../src/renderer/src/components/views/DownloadsView.vue'

function item(overrides: Partial<DownloadProgressItem> = {}): DownloadProgressItem {
  return {
    id: 'v1',
    translationId: 1,
    kind: 'video',
    url: 'http://x/v.mp4',
    filename: 'v.mp4',
    animeName: 'Test',
    episodeLabel: 'Episode 1',
    quality: 720,
    status: 'completed',
    bytesReceived: 100,
    totalBytes: 100,
    speed: 0,
    ...overrides
  }
}

function group(id: number, overrides: Partial<EpisodeGroup> = {}): EpisodeGroup {
  return {
    translationId: id,
    animeName: 'Test Anime',
    animeId: 1,
    episodeInt: '1',
    episodeLabel: 'Episode 1',
    quality: 720,
    translationType: 'sub',
    author: 'A',
    video: item(),
    subtitle: null,
    mergeStatus: 'pending',
    hasMergeEntry: false,
    ...overrides
  }
}

function stubApi(groups: EpisodeGroup[]): void {
  const real: Record<string, unknown> = {
    downloadGetQueue: vi.fn().mockResolvedValue(groups)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(real, {
    get: (t, p, r) => (p in t ? Reflect.get(t, p, r) : () => () => {})
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('DownloadsView — status left-border card class', () => {
  // Each fixture pins a group state to the status string the card uses as its
  // class; the scoped CSS maps that class to the left-border colour. happy-dom
  // can't read computed colours, so the testable contract is the class itself.
  const cases: { label: string; group: EpisodeGroup; expected: string }[] = [
    {
      label: 'downloading',
      group: group(1, { video: item({ status: 'downloading', bytesReceived: 50 }) }),
      expected: 'downloading'
    },
    {
      label: 'queued',
      group: group(2, { video: item({ status: 'queued', bytesReceived: 0 }) }),
      expected: 'queued'
    },
    {
      label: 'paused',
      group: group(3, { video: item({ status: 'paused', bytesReceived: 50 }) }),
      expected: 'paused'
    },
    {
      label: 'failed',
      group: group(4, { video: item({ status: 'failed', error: 'boom' }) }),
      expected: 'failed'
    },
    {
      label: 'ready-for-merge',
      group: group(5, { video: item({ status: 'completed' }), mergeStatus: 'pending' }),
      expected: 'ready-for-merge'
    },
    {
      label: 'merging',
      group: group(6, {
        video: item({ status: 'completed' }),
        mergeStatus: 'merging',
        mergePercent: 40
      }),
      expected: 'merging'
    },
    {
      label: 'merged',
      group: group(7, { video: item({ status: 'completed' }), mergeStatus: 'completed' }),
      expected: 'merged'
    },
    {
      label: 'merge-failed',
      group: group(8, {
        video: item({ status: 'completed' }),
        mergeStatus: 'failed',
        mergeError: 'ffmpeg died'
      }),
      expected: 'merge-failed'
    }
  ]

  it.each(cases)(
    'maps a $label group to the .$expected card class',
    async ({ group, expected }) => {
      stubApi([group])
      const wrapper = mount(DownloadsView)
      await flushPromises()

      const card = wrapper.find('.dl-card')
      expect(card.exists()).toBe(true)
      expect(card.classes()).toContain(expected)
    }
  )

  it('renders the active/done/failed summary counts from group states', async () => {
    stubApi([
      group(1, { video: item({ status: 'downloading', bytesReceived: 10 }) }), // active
      group(2, { video: item({ status: 'completed' }), mergeStatus: 'completed' }), // done (merged)
      group(3, { video: item({ status: 'completed' }), mergeStatus: 'pending' }), // done (ready)
      group(4, { video: item({ status: 'failed', error: 'x' }) }) // failed
    ])
    const wrapper = mount(DownloadsView)
    await flushPromises()

    expect(wrapper.find('.dl-stat .n.active').text()).toBe('1')
    expect(wrapper.find('.dl-stat .n.done').text()).toBe('2')
    expect(wrapper.find('.dl-stat .n.failed').text()).toBe('1')
  })

  it('shows the empty state with no downloads', async () => {
    stubApi([])
    const wrapper = mount(DownloadsView)
    await flushPromises()

    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.find('.dl-card').exists()).toBe(false)
  })
})
