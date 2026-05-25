import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
import { useEpisodeList } from '../../../src/renderer/src/composables/use-episode-list'

type Api = {
  getEpisode: (id: number, animeId: number) => Promise<{ data: EpisodeDetail }>
  getEpisodesBatch: (episodeIds: number[], animeId: number) => Promise<{ data: EpisodeDetail[] }>
  watchProgressSave: (...args: unknown[]) => Promise<void>
  probeEmbedQuality: (id: number, animeId: number) => Promise<number | null>
  getSetting: (key: string) => Promise<unknown>
  probeFullScanNeeded: (animeId: number, count: number) => Promise<boolean>
  probeFullScanDone: (animeId: number, count: number) => Promise<void>
  reportQualityMismatch: (data: unknown) => Promise<void>
}

function setApi(api: Partial<Api>): void {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api }
}

function mkEpisode(
  id: number,
  episodeInt: string,
  episodeType = 'tv',
  isActive = 1
): EpisodeSummary {
  return {
    id,
    episodeInt,
    episodeFull: `Episode ${episodeInt}`,
    episodeType,
    isActive,
    firstUploadedDateTime: '2025-01-01'
  } as unknown as EpisodeSummary
}

function mkTr(id: number, type: string, author: string, height = 720): Translation {
  return {
    id,
    type,
    height,
    authorsSummary: author,
    isActive: 1
  } as unknown as Translation
}

function mkAnime(opts: {
  type?: string | null
  numberOfEpisodes?: number
  episodes: EpisodeSummary[]
}): AnimeDetail {
  return {
    id: 1,
    title: 'Test',
    titles: { ru: 'Тест', en: 'Test' },
    type: opts.type ?? null,
    numberOfEpisodes: opts.numberOfEpisodes ?? 0,
    episodes: opts.episodes,
    posterUrl: '',
    posterUrlSmall: ''
  } as unknown as AnimeDetail
}

function makeDeps(overrides: Partial<Parameters<typeof useEpisodeList>[0]> = {}) {
  setActivePinia(createPinia())
  const libraryStore = useLibraryStore()
  return {
    anime: ref<AnimeDetail | null>(null),
    getAnimeId: () => 1,
    getInitialAuthor: () => undefined,
    translationType: ref('subRu'),
    selectedAuthor: ref(''),
    episodeMeta: ref<Record<string, EpisodeMeta[]>>({}),
    fileStatus: ref({}),
    downloadGroups: ref(new Map<string, EpisodeGroup>()),
    watchProgress: ref<Record<string, WatchProgressEntry>>({}),
    libraryStore,
    checkFileStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

beforeEach(() => {
  setApi({})
  // Minimal DOM stubs so applyFocusEpisode (which queries the episode-row by
  // dataset) can run in the node test environment.
  ;(globalThis as { document?: { querySelector: () => null } }).document = {
    querySelector: () => null
  }
  ;(globalThis as { CSS?: { escape: (s: string) => string } }).CSS = {
    escape: (s: string) => s
  }
})

describe('useEpisodeList — filtering & paging', () => {
  it('returns [] before anime is loaded', () => {
    const list = useEpisodeList(makeDeps())
    expect(list.filteredEpisodes.value).toEqual([])
  })

  it('filters to anime.type when matched count equals numberOfEpisodes', () => {
    const anime = ref<AnimeDetail | null>(
      mkAnime({
        type: 'tv',
        numberOfEpisodes: 2,
        episodes: [mkEpisode(1, '1', 'tv'), mkEpisode(2, '2', 'tv'), mkEpisode(3, '1.5', 'special')]
      })
    )
    const list = useEpisodeList(makeDeps({ anime }))
    expect(list.filteredEpisodes.value.map((e) => e.id)).toEqual([1, 2])
  })

  it('falls back to allActive when type filter does not equal numberOfEpisodes', () => {
    const anime = ref<AnimeDetail | null>(
      mkAnime({
        type: 'tv',
        numberOfEpisodes: 3,
        episodes: [mkEpisode(1, '1', 'tv'), mkEpisode(2, '2', 'tv'), mkEpisode(3, '1.5', 'special')]
      })
    )
    const list = useEpisodeList(makeDeps({ anime }))
    expect(list.filteredEpisodes.value.map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('preserves fractional episodes (.5) in allActive fallback', () => {
    const anime = ref<AnimeDetail | null>(
      mkAnime({
        type: null,
        episodes: [mkEpisode(1, '1'), mkEpisode(2, '1.5'), mkEpisode(3, '2')]
      })
    )
    const list = useEpisodeList(makeDeps({ anime }))
    expect(list.filteredEpisodes.value.map((e) => e.episodeInt)).toEqual(['1', '1.5', '2'])
  })

  it('paginates at PAGE_SIZE=30', () => {
    const eps: EpisodeSummary[] = []
    for (let i = 1; i <= 50; i++) eps.push(mkEpisode(i, String(i)))
    const anime = ref<AnimeDetail | null>(mkAnime({ episodes: eps }))
    const list = useEpisodeList(makeDeps({ anime }))
    expect(list.isPaginated.value).toBe(true)
    expect(list.totalPages.value).toBe(2)
    expect(list.pagedEpisodes.value.length).toBe(30)
    list.currentPage.value = 1
    expect(list.pagedEpisodes.value.length).toBe(20)
  })
})

describe('useEpisodeList — loadPageEpisodes', () => {
  it('fetches a whole page in a single bulk getEpisodesBatch call (not per-episode)', async () => {
    const eps: EpisodeSummary[] = []
    for (let i = 1; i <= 30; i++) eps.push(mkEpisode(i, String(i)))
    const getEpisodesBatch = vi.fn(async (ids: number[]) => ({
      data: ids.map((id) => ({
        id,
        episodeFull: `Episode ${id}`,
        episodeInt: String(id),
        episodeType: 'tv',
        translations: [mkTr(1000 + id, 'subRu', 'A')]
      })) as unknown as EpisodeDetail[]
    }))
    const getEpisode = vi.fn()
    setApi({
      getEpisodesBatch,
      getEpisode,
      probeEmbedQuality: vi.fn().mockResolvedValue(null),
      getSetting: vi.fn().mockResolvedValue(false)
    })
    const anime = ref<AnimeDetail | null>(mkAnime({ episodes: eps }))
    const list = useEpisodeList(makeDeps({ anime }))

    await list.loadPageEpisodes()

    expect(getEpisode).not.toHaveBeenCalled()
    expect(getEpisodesBatch).toHaveBeenCalledTimes(1)
    expect(getEpisodesBatch.mock.calls[0][0]).toEqual(eps.map((e) => e.id))
    expect(list.episodes.value.size).toBe(30)
  })

  it('synthesizes an empty-translation entry for episodes absent from the response', async () => {
    const eps = [mkEpisode(1, '1'), mkEpisode(2, '2')]
    setApi({
      // Only episode 1 comes back with translations; episode 2 is absent.
      getEpisodesBatch: vi.fn(async () => ({
        data: [
          {
            id: 1,
            episodeFull: 'Episode 1',
            episodeInt: '1',
            episodeType: 'tv',
            translations: [mkTr(101, 'subRu', 'A')]
          }
        ] as unknown as EpisodeDetail[]
      })),
      probeEmbedQuality: vi.fn().mockResolvedValue(null),
      getSetting: vi.fn().mockResolvedValue(false)
    })
    const anime = ref<AnimeDetail | null>(mkAnime({ episodes: eps }))
    const list = useEpisodeList(makeDeps({ anime }))

    await list.loadPageEpisodes()

    expect(list.episodes.value.size).toBe(2)
    expect(list.episodes.value.get(2)?.translations).toEqual([])
  })
})

describe('useEpisodeList — episodeRows selection priority', () => {
  function build(opts: {
    translationType?: string
    selectedAuthor?: string
    episodeMeta?: Record<string, EpisodeMeta[]>
    downloadGroups?: Map<string, EpisodeGroup>
    watchProgress?: Record<string, WatchProgressEntry>
    translations: Translation[]
  }) {
    const ep = mkEpisode(100, '5', 'tv')
    const anime = ref<AnimeDetail | null>(mkAnime({ episodes: [ep] }))
    const deps = makeDeps({
      anime,
      translationType: ref(opts.translationType ?? 'subRu'),
      selectedAuthor: ref(opts.selectedAuthor ?? ''),
      episodeMeta: ref(opts.episodeMeta ?? {}),
      downloadGroups: ref(opts.downloadGroups ?? new Map()),
      watchProgress: ref(opts.watchProgress ?? {})
    })
    const list = useEpisodeList(deps)
    list.episodes.value = new Map([
      [
        100,
        {
          ...ep,
          translations: opts.translations,
          duration: 1440,
          mediaInfo: null,
          translationCount: opts.translations.length
        } as unknown as EpisodeDetail
      ]
    ])
    return list
  }

  it('priority 1: queued download locks the row', () => {
    const groups = new Map<string, EpisodeGroup>([
      [
        'Episode 5',
        {
          animeName: 'X',
          episodeLabel: 'Episode 5',
          translationId: 200,
          mergeStatus: 'idle',
          video: { status: 'downloading' }
        } as unknown as EpisodeGroup
      ]
    ])
    const list = build({
      translations: [mkTr(200, 'voiceRu', 'A'), mkTr(201, 'subRu', 'B')],
      downloadGroups: groups
    })
    const row = list.episodeRows.value[0]
    expect(row.isLocked).toBe(true)
    expect(row.lockSource).toBe('queued')
    expect(row.selectedTr?.id).toBe(200)
  })

  it('priority 2: episodeOverrides wins over downloaded & defaults', () => {
    const list = build({
      translationType: 'subRu',
      translations: [mkTr(1, 'subRu', 'A'), mkTr(2, 'subRu', 'B')]
    })
    list.episodeOverrides.value = new Map([[100, 2]])
    expect(list.episodeRows.value[0].selectedTr?.id).toBe(2)
  })

  it('priority 3: remembered watchProgress translationId wins over downloaded', () => {
    const list = build({
      translationType: 'subRu',
      episodeMeta: {
        '5': [{ translationId: 1, translationType: 'subRu', author: 'A' } as unknown as EpisodeMeta]
      },
      watchProgress: {
        '5': { position: 0, duration: 0, translationId: 99 } as unknown as WatchProgressEntry
      },
      translations: [mkTr(1, 'subRu', 'A'), mkTr(99, 'voiceRu', 'B')]
    })
    expect(list.episodeRows.value[0].selectedTr?.id).toBe(99)
  })

  it('priority 4: any downloaded translation beats global default', () => {
    const list = build({
      translationType: 'subRu',
      selectedAuthor: 'A',
      episodeMeta: {
        '5': [
          { translationId: 50, translationType: 'voiceRu', author: 'A' } as unknown as EpisodeMeta
        ]
      },
      translations: [mkTr(10, 'subRu', 'A'), mkTr(50, 'voiceRu', 'A')]
    })
    expect(list.episodeRows.value[0].selectedTr?.id).toBe(50)
  })

  it('priority 5: global default (translationType + author)', () => {
    const list = build({
      translationType: 'subRu',
      selectedAuthor: 'B',
      translations: [mkTr(1, 'subRu', 'A'), mkTr(2, 'subRu', 'B')]
    })
    expect(list.episodeRows.value[0].selectedTr?.id).toBe(2)
  })

  it('falls through to first translation of matching type when author missing', () => {
    const list = build({
      translationType: 'voiceRu',
      selectedAuthor: 'Missing',
      translations: [mkTr(1, 'voiceRu', 'X'), mkTr(2, 'voiceRu', 'Y')]
    })
    const row = list.episodeRows.value[0]
    expect(row.selectedTr?.type).toBe('voiceRu')
    expect(['X', 'Y']).toContain(row.selectedTr?.authorsSummary)
  })
})

describe('useEpisodeList — helpers', () => {
  it('qualityLabel rounds down', () => {
    const list = useEpisodeList(makeDeps())
    expect(list.qualityLabel(1080)).toBe('1080p')
    expect(list.qualityLabel(900)).toBe('720p')
    expect(list.qualityLabel(700)).toBe('480p')
    expect(list.qualityLabel(360)).toBe('360p')
  })

  it('getRealHeight reads probed quality before reported', () => {
    const list = useEpisodeList(makeDeps())
    list.realQuality.value = new Map([[5, 1080]])
    expect(list.getRealHeight(mkTr(5, 'subRu', 'X', 720))).toBe(1080)
    expect(list.getRealHeight(mkTr(6, 'subRu', 'Y', 480))).toBe(480)
  })

  it('bestPerAuthor keeps highest quality per (type, author)', () => {
    const list = useEpisodeList(makeDeps())
    const out = list.bestPerAuthor([
      mkTr(1, 'subRu', 'A', 480),
      mkTr(2, 'subRu', 'A', 1080),
      mkTr(3, 'subRu', 'B', 720)
    ])
    expect(out.map((t) => t.id).sort()).toEqual([2, 3])
  })
})

describe('useEpisodeList — onEpisodeTranslationChange', () => {
  it('updates overrides and persists via IPC', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    setApi({ watchProgressSave: save })
    const deps = makeDeps({
      watchProgress: ref({
        '3': { position: 60, duration: 1440, translationId: 1 } as unknown as WatchProgressEntry
      })
    })
    const list = useEpisodeList(deps)
    list.onEpisodeTranslationChange(7, '3', 99)
    expect(list.episodeOverrides.value.get(7)).toBe(99)
    expect(save).toHaveBeenCalledWith(1, '3', 60, 1440, undefined, 99)
  })
})

describe('useEpisodeList — applyFocusEpisode', () => {
  it('clears focus when target is not in the list', async () => {
    const anime = ref<AnimeDetail | null>(mkAnime({ episodes: [mkEpisode(1, '1')] }))
    const deps = makeDeps({ anime })
    const list = useEpisodeList(deps)
    await list.applyFocusEpisode('999')
    expect(list.focusApplied.value).toBe(true)
  })

  it('marks focus applied even if DOM lookup fails', async () => {
    setApi({
      getEpisodesBatch: vi.fn().mockImplementation((ids: number[]) =>
        Promise.resolve({
          data: ids.map((id) => ({ id, translations: [] }) as unknown as EpisodeDetail)
        })
      ),
      getSetting: vi.fn().mockResolvedValue(false)
    })
    const eps: EpisodeSummary[] = []
    for (let i = 1; i <= 50; i++) eps.push(mkEpisode(i, String(i)))
    const anime = ref<AnimeDetail | null>(mkAnime({ episodes: eps }))
    const deps = makeDeps({ anime })
    const list = useEpisodeList(deps)
    // target on page 1 (index 35), forces goToPage(1)
    await list.applyFocusEpisode('35')
    expect(list.focusApplied.value).toBe(true)
    expect(list.currentPage.value).toBe(1)
  })
})
