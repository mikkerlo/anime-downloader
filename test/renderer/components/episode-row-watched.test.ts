// @vitest-environment happy-dom
//
// The episode row's mark-(un)watched button (#572): the one UI path to the new
// `watch-progress:set-watched`, which is the first way to clear `watched`.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import EpisodeRowView from '../../../src/renderer/src/components/detail/EpisodeRow.vue'
import {
  EpisodeDownloadsKey,
  EpisodeListKey
} from '../../../src/renderer/src/components/detail/keys'
import { useDownloadsStore } from '../../../src/renderer/src/stores/downloads'
import { usePlayerStore } from '../../../src/renderer/src/stores/player'
import { useEpisodeDownloads } from '../../../src/renderer/src/composables/use-episode-downloads'
import type { EpisodeRow } from '../../../src/renderer/src/composables/use-episode-list'

function stubApi(overrides: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(overrides, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
}

function row(episodeInt: string): EpisodeRow {
  return {
    episode: {
      id: 100 + Number(episodeInt),
      episodeInt,
      episodeFull: `Episode ${episodeInt}`,
      episodeType: 'tv',
      isActive: 1,
      firstUploadedDateTime: '2025-01-01'
    } as unknown as EpisodeSummary,
    allTranslations: [],
    selectedTr: null,
    isLocked: false,
    lockSource: null,
    downloadedTrIds: new Set()
  }
}

/** Mounts one row over a real `useEpisodeDownloads`, backed by a fake main-side map. */
function mountRow(initial: Record<string, WatchProgressEntry>) {
  const persisted: Record<string, WatchProgressEntry> = structuredClone(initial)
  const setWatched = vi.fn(async (_animeId: number, episodeInt: string, watched: boolean) => {
    persisted[episodeInt] = {
      ...(persisted[episodeInt] ?? { position: 0, duration: 0, updatedAt: 0 }),
      watched
    }
    return persisted[episodeInt]
  })
  stubApi({
    watchProgressSetWatched: setWatched,
    watchProgressGetAll: vi.fn(async () => structuredClone(persisted)),
    downloadGetQueue: vi.fn(async () => [])
  })
  setActivePinia(createPinia())
  const downloads = useEpisodeDownloads({
    anime: ref(null),
    getAnimeId: () => 5,
    getAnimeName: () => 'Five',
    episodeMeta: ref({}),
    fileStatus: ref({}),
    downloadGroups: ref(new Map()),
    watchProgress: ref(structuredClone(initial)),
    filteredEpisodes: computed(() => []),
    episodes: ref(new Map()),
    episodeRows: computed(() => []),
    getRealHeight: (tr: Translation) => tr.height,
    currentPage: ref(0),
    isPaginated: computed(() => false),
    goToPage: vi.fn(),
    loadingEpisodes: ref(false),
    shikiRate: ref(null),
    shikiUser: ref(null),
    shikiEpisodes: ref(0),
    shikiUserChecked: ref(true),
    shikiLoading: ref(false),
    downloadsStore: useDownloadsStore(),
    playerStore: usePlayerStore(),
    playerMode: ref<'system' | 'builtin'>('system'),
    pageSize: 30
  } as Parameters<typeof useEpisodeDownloads>[0])
  const wrapper = mount(EpisodeRowView, {
    props: { row: row('3'), playerMode: 'system', translationType: 'subRu', posterUrl: 'p.jpg' },
    global: {
      provide: {
        [EpisodeListKey as symbol]: {
          getRealHeight: () => 720,
          qualityLabel: () => '720p',
          onEpisodeTranslationChange: vi.fn()
        },
        [EpisodeDownloadsKey as symbol]: downloads
      }
    }
  })
  return { wrapper, setWatched }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EpisodeRow — mark as (un)watched', () => {
  it('unwatches a watched episode and the row updates', async () => {
    const { wrapper, setWatched } = mountRow({
      '3': { position: 0, duration: 1420, updatedAt: 1, watched: true, watchedAt: 1 }
    })
    const button = wrapper.get('button.ep-watched-toggle')
    expect(wrapper.get('.ep-row').classes()).toContain('watched')
    expect(button.attributes('title')).toBe('Mark as unwatched')
    expect(button.classes()).toContain('iconbtn')

    await button.trigger('click')
    await flushPromises()

    expect(setWatched).toHaveBeenCalledWith(5, '3', false)
    expect(wrapper.get('.ep-row').classes()).not.toContain('watched')
    expect(wrapper.get('button.ep-watched-toggle').attributes('title')).toBe('Mark as watched')
  })

  it('marks an unwatched episode watched', async () => {
    const { wrapper, setWatched } = mountRow({})
    expect(wrapper.get('button.ep-watched-toggle').attributes('title')).toBe('Mark as watched')

    await wrapper.get('button.ep-watched-toggle').trigger('click')
    await flushPromises()

    expect(setWatched).toHaveBeenCalledWith(5, '3', true)
    expect(wrapper.get('.ep-row').classes()).toContain('watched')
    expect(wrapper.get('button.ep-watched-toggle').attributes('title')).toBe('Mark as unwatched')
  })

  // Like every other progress writer, so Home's continue-watching refreshes.
  it("announces the write with the 'watch-progress-updated' window event", async () => {
    const heard = vi.fn()
    window.addEventListener('watch-progress-updated', heard)
    try {
      const { wrapper } = mountRow({})
      await wrapper.get('button.ep-watched-toggle').trigger('click')
      await flushPromises()
      expect(heard).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('watch-progress-updated', heard)
    }
  })
})
