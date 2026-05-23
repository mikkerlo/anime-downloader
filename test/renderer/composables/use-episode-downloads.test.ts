import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, computed, type ComputedRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useDownloadsStore } from '../../../src/renderer/src/stores/downloads'
import { usePlayerStore } from '../../../src/renderer/src/stores/player'
import { useEpisodeDownloads } from '../../../src/renderer/src/composables/use-episode-downloads'
import type { EpisodeRow } from '../../../src/renderer/src/composables/use-episode-list'

type FileEntry = {
  type: 'mkv' | 'mp4'
  filePath: string
  translationId?: number
  author?: string
}

type Api = {
  watchProgressGetAll: (animeId: number) => Promise<Record<string, WatchProgressEntry>>
  fileCheckEpisodes: (
    animeName: string,
    episodeInts: string[]
  ) => Promise<Record<string, FileEntry[]>>
  downloadedEpisodesGet: (animeId: number) => Promise<Record<string, EpisodeMeta[]>>
  downloadedAnimeAdd: (anime: AnimeDetail) => Promise<void>
  downloadEnqueue: (requests: DownloadRequest[]) => Promise<void>
  downloadCancelByEpisode: (animeName: string, episodeLabel?: string) => Promise<void>
  fileOpen: (path: string) => Promise<string | null>
  fileShowInFolder: (path: string) => Promise<void>
  fileDeleteEpisode: (...args: unknown[]) => Promise<void>
  playerGetLocalSubtitles: (path: string) => Promise<string | null>
  playerGetStreamUrl: (
    translationId: number,
    height: number
  ) => Promise<{ streamUrl: string; subtitleContent?: string; availableStreams: unknown[] }>
  onFileEpisodesChanged: (cb: (animeName: string, data: unknown) => void) => Unsubscribe
  onDownloadProgress: (cb: (data: unknown) => void) => Unsubscribe
  onScanMergeProgress: (cb: (data: unknown) => void) => Unsubscribe
  onFixMetadataProgress: (cb: (data: unknown) => void) => Unsubscribe
  downloadGetQueue: () => Promise<EpisodeGroup[]>
  getSetting: (key: string) => Promise<unknown>
}

function noopSub(): Unsubscribe {
  return () => {}
}

// Pinia stores subscribe to broadcasts at construction; stub them so
// useDownloadsStore() doesn't throw under Vitest.
const STORE_BROADCAST_STUBS: Partial<Api> = {
  onDownloadProgress: noopSub,
  onScanMergeProgress: noopSub,
  onFixMetadataProgress: noopSub,
  downloadGetQueue: () => Promise.resolve([])
}

function setApi(api: Partial<Api>): void {
  const w = (globalThis as { window?: { api?: Partial<Api> } }).window
  const prev = w?.api ?? {}
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...prev, ...api } }
}

function installDefaultApi(): void {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...STORE_BROADCAST_STUBS } }
}

function mkEpisode(id: number, episodeInt: string): EpisodeSummary {
  return {
    id,
    episodeInt,
    episodeFull: `Episode ${episodeInt}`,
    episodeType: 'tv',
    isActive: 1,
    firstUploadedDateTime: '2025-01-01'
  } as unknown as EpisodeSummary
}

function mkRow(opts: {
  episodeId?: number
  episodeInt?: string
  selectedTrId?: number
  selectedTrType?: string
  selectedTrAuthor?: string
  selectedTrHeight?: number
  isLocked?: boolean
}): EpisodeRow {
  const ep = mkEpisode(opts.episodeId ?? 1, opts.episodeInt ?? '1')
  const selectedTr =
    opts.selectedTrId != null
      ? ({
          id: opts.selectedTrId,
          type: opts.selectedTrType ?? 'subRu',
          authorsSummary: opts.selectedTrAuthor ?? 'A',
          height: opts.selectedTrHeight ?? 720,
          isActive: 1
        } as unknown as Translation)
      : null
  return {
    episode: ep,
    allTranslations: selectedTr ? [selectedTr] : [],
    selectedTr,
    isLocked: opts.isLocked ?? false,
    lockSource: opts.isLocked ? 'queued' : null,
    downloadedTrIds: new Set()
  }
}

function makeDeps(overrides: Partial<Parameters<typeof useEpisodeDownloads>[0]> = {}) {
  setActivePinia(createPinia())
  return {
    anime: ref<AnimeDetail | null>(null),
    getAnimeId: () => 1,
    getAnimeName: () => 'TestAnime',
    episodeMeta: ref<Record<string, EpisodeMeta[]>>({}),
    fileStatus: ref<Record<string, FileEntry[]>>({}),
    downloadGroups: ref<Map<string, EpisodeGroup>>(new Map()),
    watchProgress: ref<Record<string, WatchProgressEntry>>({}),
    filteredEpisodes: computed(() => [] as EpisodeSummary[]),
    episodes: ref(new Map<number, EpisodeDetail>()),
    episodeRows: computed<EpisodeRow[]>(() => []),
    getRealHeight: (tr: Translation) => tr.height,
    currentPage: ref(0),
    isPaginated: computed(() => false),
    goToPage: vi.fn().mockResolvedValue(undefined),
    loadingEpisodes: ref(false),
    shikiRate: ref<ShikiUserRate | null>(null),
    shikiUser: ref<ShikiUser | null>(null),
    shikiEpisodes: ref(0),
    shikiUserChecked: ref(true),
    shikiLoading: ref(false),
    downloadsStore: useDownloadsStore(),
    playerStore: usePlayerStore(),
    playerMode: ref<'system' | 'builtin'>('system'),
    pageSize: 30,
    ...overrides
  } as Parameters<typeof useEpisodeDownloads>[0]
}

function eps3(): ComputedRef<EpisodeSummary[]> {
  return computed(() => [mkEpisode(1, '1'), mkEpisode(2, '2'), mkEpisode(3, '3')])
}

beforeEach(() => {
  installDefaultApi()
})

describe('useEpisodeDownloads — watch progress', () => {
  it('loadWatchProgress fetches via IPC and writes to deps.watchProgress', async () => {
    const data: Record<string, WatchProgressEntry> = {
      '1': { position: 60, duration: 1440, updatedAt: 1 } as unknown as WatchProgressEntry
    }
    setApi({ watchProgressGetAll: vi.fn().mockResolvedValue(data) })
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    await dl.loadWatchProgress()
    expect(deps.watchProgress.value).toEqual(data)
  })

  it('episodeProgressPercent returns 0 below 2%', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    deps.watchProgress.value = {
      '1': { position: 10, duration: 1440 } as unknown as WatchProgressEntry,
      '2': { position: 60, duration: 1440 } as unknown as WatchProgressEntry
    }
    expect(dl.episodeProgressPercent('1')).toBe(0)
    expect(dl.episodeProgressPercent('2')).toBe(4)
  })

  it('isEpisodeWatched honors shiki completed status', () => {
    const shikiRate = ref<ShikiUserRate | null>({
      status: 'completed'
    } as unknown as ShikiUserRate)
    const deps = makeDeps({ shikiRate })
    const dl = useEpisodeDownloads(deps)
    expect(dl.isEpisodeWatched('1')).toBe(true)
  })

  it('isEpisodeWatched falls back to local watchProgress.watched', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    deps.watchProgress.value = {
      '1': { watched: true } as unknown as WatchProgressEntry
    }
    expect(dl.isEpisodeWatched('1')).toBe(true)
    expect(dl.isEpisodeWatched('2')).toBe(false)
  })
})

describe('useEpisodeDownloads — continueTarget priority', () => {
  it('returns null when no episodes', () => {
    const dl = useEpisodeDownloads(makeDeps())
    expect(dl.continueTarget.value).toBeNull()
  })

  it('completed status → first episode (start rewatch)', () => {
    const dl = useEpisodeDownloads(
      makeDeps({
        filteredEpisodes: eps3(),
        shikiRate: ref({ status: 'completed' } as unknown as ShikiUserRate)
      })
    )
    expect(dl.continueTarget.value?.episodeInt).toBe('1')
  })

  it('priority 1: shikimori reports N completed → ep N+1', () => {
    const dl = useEpisodeDownloads(
      makeDeps({
        filteredEpisodes: eps3(),
        shikiUser: ref({ id: 1 } as unknown as ShikiUser),
        shikiEpisodes: ref(2)
      })
    )
    expect(dl.continueTarget.value?.episodeInt).toBe('3')
  })

  it('priority 2: unfinished saved position wins (most recent)', () => {
    const deps = makeDeps({ filteredEpisodes: eps3() })
    const dl = useEpisodeDownloads(deps)
    deps.watchProgress.value = {
      '1': { position: 100, duration: 1440, updatedAt: 10 } as unknown as WatchProgressEntry,
      '2': { position: 200, duration: 1440, updatedAt: 20 } as unknown as WatchProgressEntry
    }
    expect(dl.continueTarget.value?.episodeInt).toBe('2')
  })

  it('priority 3: first episode after last locally-watched', () => {
    const deps = makeDeps({ filteredEpisodes: eps3() })
    const dl = useEpisodeDownloads(deps)
    deps.watchProgress.value = {
      '1': { watched: true } as unknown as WatchProgressEntry
    }
    expect(dl.continueTarget.value?.episodeInt).toBe('2')
  })

  it('priority 4: everything watched → last episode', () => {
    const deps = makeDeps({ filteredEpisodes: eps3() })
    const dl = useEpisodeDownloads(deps)
    deps.watchProgress.value = {
      '1': { watched: true } as unknown as WatchProgressEntry,
      '2': { watched: true } as unknown as WatchProgressEntry,
      '3': { watched: true } as unknown as WatchProgressEntry
    }
    expect(dl.continueTarget.value?.episodeInt).toBe('3')
  })
})

describe('useEpisodeDownloads — continueReady', () => {
  it('false while episodes loading', () => {
    const dl = useEpisodeDownloads(
      makeDeps({
        anime: ref({ id: 1 } as unknown as AnimeDetail),
        filteredEpisodes: computed(() => [mkEpisode(1, '1')]),
        loadingEpisodes: ref(true)
      })
    )
    expect(dl.continueReady.value).toBe(false)
  })

  it('false when MAL anime but shikiUser not yet checked', () => {
    const dl = useEpisodeDownloads(
      makeDeps({
        anime: ref({ id: 1, myAnimeListId: 99 } as unknown as AnimeDetail),
        filteredEpisodes: computed(() => [mkEpisode(1, '1')]),
        shikiUserChecked: ref(false)
      })
    )
    expect(dl.continueReady.value).toBe(false)
  })

  it('false while shiki is loading', () => {
    const dl = useEpisodeDownloads(
      makeDeps({
        anime: ref({ id: 1, myAnimeListId: 99 } as unknown as AnimeDetail),
        filteredEpisodes: computed(() => [mkEpisode(1, '1')]),
        shikiUser: ref({ id: 1 } as unknown as ShikiUser),
        shikiLoading: ref(true)
      })
    )
    expect(dl.continueReady.value).toBe(false)
  })

  it('true once everything is settled', () => {
    const dl = useEpisodeDownloads(
      makeDeps({
        anime: ref({ id: 1 } as unknown as AnimeDetail),
        filteredEpisodes: computed(() => [mkEpisode(1, '1')])
      })
    )
    expect(dl.continueReady.value).toBe(true)
  })
})

describe('useEpisodeDownloads — continueLabel', () => {
  it('shows Resume when position > 0 and not watched', () => {
    const deps = makeDeps({
      filteredEpisodes: computed(() => [mkEpisode(1, '5')])
    })
    const dl = useEpisodeDownloads(deps)
    deps.watchProgress.value = {
      '5': { position: 60, duration: 1440, updatedAt: 1 } as unknown as WatchProgressEntry
    }
    expect(dl.continueLabel.value).toBe('Resume · Ep 5')
  })

  it('shows Continue when no saved position', () => {
    const dl = useEpisodeDownloads(
      makeDeps({
        filteredEpisodes: computed(() => [mkEpisode(1, '5')])
      })
    )
    expect(dl.continueLabel.value).toBe('Continue · Ep 5')
  })
})

describe('useEpisodeDownloads — file helpers', () => {
  it('hasAnyFile reflects fileStatus', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    deps.fileStatus.value = {
      '1': [{ type: 'mkv', filePath: '/x.mkv', author: 'tag' }]
    }
    expect(dl.hasAnyFile('1')).toBe(true)
    expect(dl.hasAnyFile('2')).toBe(false)
  })

  it('getFileForTranslation matches by sanitized author tag', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    deps.fileStatus.value = {
      '1': [
        { type: 'mkv', filePath: '/Anidub.mkv', author: 'Anidub' },
        { type: 'mp4', filePath: '/AniLibria.mp4', author: 'AniLibria' }
      ]
    }
    deps.episodeMeta.value = {
      '1': [
        { translationId: 10, author: 'Anidub' } as unknown as EpisodeMeta,
        { translationId: 20, author: 'AniLibria' } as unknown as EpisodeMeta
      ]
    }
    expect(dl.getFileForTranslation('1', 10)?.filePath).toBe('/Anidub.mkv')
    expect(dl.getFileForTranslation('1', 20)?.filePath).toBe('/AniLibria.mp4')
    expect(dl.getFileForTranslation('1', 999)).toBeNull()
  })

  it('getFileForTranslation falls back to a legacy untagged file when sole entry', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    deps.fileStatus.value = { '1': [{ type: 'mkv', filePath: '/legacy.mkv' }] }
    deps.episodeMeta.value = {
      '1': [{ translationId: 7, author: 'X' } as unknown as EpisodeMeta]
    }
    expect(dl.getFileForTranslation('1', 7)?.filePath).toBe('/legacy.mkv')
  })

  it('selectedTrHasFile only true when selectedTr is set and matched', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    deps.fileStatus.value = {
      '1': [{ type: 'mkv', filePath: '/file.mkv', author: 'A' }]
    }
    deps.episodeMeta.value = {
      '1': [{ translationId: 100, author: 'A' } as unknown as EpisodeMeta]
    }
    const row = mkRow({ episodeId: 1, episodeInt: '1', selectedTrId: 100 })
    expect(dl.selectedTrHasFile(row)).toBe(true)
    const noTr = mkRow({ episodeInt: '1' })
    expect(dl.selectedTrHasFile(noTr)).toBe(false)
  })
})

describe('useEpisodeDownloads — buildTranslationList / buildAllEpisodes', () => {
  it('buildTranslationList projects allTranslations through getRealHeight', () => {
    const probed = new Map<number, number>([[2, 1080]])
    const dl = useEpisodeDownloads(
      makeDeps({
        getRealHeight: (tr: Translation) => probed.get(tr.id) ?? tr.height
      })
    )
    const row = mkRow({ selectedTrId: 1, selectedTrAuthor: 'A', selectedTrHeight: 720 })
    row.allTranslations = [
      { id: 1, type: 'subRu', authorsSummary: 'A', height: 720, isActive: 1 } as Translation,
      { id: 2, type: 'voiceRu', authorsSummary: 'B', height: 720, isActive: 1 } as Translation
    ]
    const list = dl.buildTranslationList(row)
    expect(list).toEqual([
      { id: 1, label: 'A', type: 'subRu', height: 720 },
      { id: 2, label: 'B', type: 'voiceRu', height: 1080 }
    ])
  })

  it('buildAllEpisodes covers active translations + downloadedTrIds', () => {
    const ep = mkEpisode(1, '1')
    const detail = {
      ...ep,
      translations: [
        { id: 10, type: 'subRu', authorsSummary: 'A', height: 720, isActive: 1 } as Translation,
        { id: 11, type: 'voiceRu', authorsSummary: 'B', height: 480, isActive: 0 } as Translation
      ],
      duration: 1440,
      mediaInfo: null,
      translationCount: 2
    } as unknown as EpisodeDetail
    const episodes = ref(new Map<number, EpisodeDetail>([[1, detail]]))
    const deps = makeDeps({
      filteredEpisodes: computed(() => [ep]),
      episodes
    })
    const dl = useEpisodeDownloads(deps)
    deps.episodeMeta.value = {
      '1': [{ translationId: 10, author: 'A' } as unknown as EpisodeMeta]
    }
    const out = dl.buildAllEpisodes()
    expect(out).toHaveLength(1)
    expect(out[0].translations).toEqual([{ id: 10, label: 'A', type: 'subRu', height: 720 }])
    expect(out[0].downloadedTrIds).toEqual([10])
  })
})

describe('useEpisodeDownloads — downloadGroupChanged', () => {
  it('returns false for two undefineds', () => {
    const dl = useEpisodeDownloads(makeDeps())
    expect(dl.downloadGroupChanged(undefined, undefined)).toBe(false)
  })

  it('returns true when one side missing', () => {
    const dl = useEpisodeDownloads(makeDeps())
    expect(dl.downloadGroupChanged(undefined, { mergeStatus: 'idle' } as EpisodeGroup)).toBe(true)
  })

  it('detects mergeStatus / video.bytesReceived deltas', () => {
    const dl = useEpisodeDownloads(makeDeps())
    const a = {
      mergeStatus: 'idle',
      video: { status: 'downloading', bytesReceived: 100, totalBytes: 200, speed: 50 }
    } as unknown as EpisodeGroup
    const b = {
      mergeStatus: 'idle',
      video: { status: 'downloading', bytesReceived: 150, totalBytes: 200, speed: 50 }
    } as unknown as EpisodeGroup
    expect(dl.downloadGroupChanged(a, b)).toBe(true)
    expect(dl.downloadGroupChanged(a, a)).toBe(false)
  })
})

describe('useEpisodeDownloads — updateDownloadGroups', () => {
  it('filters by animeName + writes change-detected snapshot', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    dl.updateDownloadGroups([
      {
        animeName: 'TestAnime',
        episodeLabel: 'Episode 1',
        mergeStatus: 'idle',
        video: { status: 'downloading', bytesReceived: 50, totalBytes: 100 }
      } as unknown as EpisodeGroup,
      {
        animeName: 'OtherAnime',
        episodeLabel: 'Episode 1'
      } as unknown as EpisodeGroup
    ])
    expect(deps.downloadGroups.value.size).toBe(1)
    expect(deps.downloadGroups.value.has('Episode 1')).toBe(true)
  })

  it('skips write when nothing changed', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    const group = {
      animeName: 'TestAnime',
      episodeLabel: 'Episode 1',
      mergeStatus: 'idle',
      video: { status: 'downloading', bytesReceived: 50, totalBytes: 100 }
    } as unknown as EpisodeGroup
    dl.updateDownloadGroups([group])
    const ref1 = deps.downloadGroups.value
    dl.updateDownloadGroups([group])
    expect(deps.downloadGroups.value).toBe(ref1)
  })

  it('detects removals as a change', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    dl.updateDownloadGroups([
      {
        animeName: 'TestAnime',
        episodeLabel: 'Episode 1',
        mergeStatus: 'idle'
      } as unknown as EpisodeGroup
    ])
    dl.updateDownloadGroups([])
    expect(deps.downloadGroups.value.size).toBe(0)
  })
})

describe('useEpisodeDownloads — actions', () => {
  it('downloadAll skips locked / has-file rows; enqueues the rest', async () => {
    const downloadEnqueue = vi.fn().mockResolvedValue(undefined)
    const downloadedAnimeAdd = vi.fn().mockResolvedValue(undefined)
    setApi({
      getSetting: vi.fn().mockResolvedValue('valid-token'),
      downloadEnqueue,
      downloadedAnimeAdd
    })
    const lockedRow = mkRow({
      episodeId: 1,
      episodeInt: '1',
      selectedTrId: 100,
      isLocked: true
    })
    const hasFileRow = mkRow({ episodeId: 2, episodeInt: '2', selectedTrId: 101 })
    const newRow = mkRow({
      episodeId: 3,
      episodeInt: '3',
      selectedTrId: 102,
      selectedTrType: 'voiceRu',
      selectedTrAuthor: 'X',
      selectedTrHeight: 1080
    })
    const deps = makeDeps({
      anime: ref({ id: 99 } as unknown as AnimeDetail),
      episodeRows: computed(() => [lockedRow, hasFileRow, newRow])
    })
    const dl = useEpisodeDownloads(deps)
    // Mark episode 2 as having a file
    deps.fileStatus.value = {
      '2': [{ type: 'mkv', filePath: '/x.mkv', author: 'A' }]
    }
    deps.episodeMeta.value = {
      '2': [{ translationId: 101, author: 'A' } as unknown as EpisodeMeta]
    }
    await dl.downloadAll()
    expect(downloadedAnimeAdd).toHaveBeenCalled()
    expect(downloadEnqueue).toHaveBeenCalledTimes(1)
    const requests = downloadEnqueue.mock.calls[0][0] as DownloadRequest[]
    expect(requests).toHaveLength(1)
    expect(requests[0].translationId).toBe(102)
    expect(requests[0].height).toBe(1080)
  })

  it('downloadAll early-returns on missing token', async () => {
    const downloadEnqueue = vi.fn()
    setApi({
      getSetting: vi.fn().mockResolvedValue(''),
      downloadEnqueue
    })
    const dl = useEpisodeDownloads(
      makeDeps({
        anime: ref({ id: 1 } as unknown as AnimeDetail),
        episodeRows: computed(() => [mkRow({ episodeId: 1, episodeInt: '1', selectedTrId: 50 })])
      })
    )
    await dl.downloadAll()
    expect(downloadEnqueue).not.toHaveBeenCalled()
    expect(dl.errorMessage.value).toMatch(/token/i)
  })

  it('cancelEpisodeDownload + cancelAllDownloads route to IPC', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    setApi({ downloadCancelByEpisode: cancel })
    const dl = useEpisodeDownloads(makeDeps())
    await dl.cancelEpisodeDownload('Episode 7')
    expect(cancel).toHaveBeenCalledWith('TestAnime', 'Episode 7')
    await dl.cancelAllDownloads()
    expect(cancel).toHaveBeenCalledWith('TestAnime')
  })
})

describe('useEpisodeDownloads — pure utilities', () => {
  it('dlProgress returns 0 on null/zero totalBytes, otherwise percent', () => {
    const dl = useEpisodeDownloads(makeDeps())
    expect(dl.dlProgress(null)).toBe(0)
    expect(
      dl.dlProgress({ totalBytes: 0, bytesReceived: 10 } as unknown as DownloadProgressItem)
    ).toBe(0)
    expect(
      dl.dlProgress({ totalBytes: 200, bytesReceived: 50 } as unknown as DownloadProgressItem)
    ).toBe(25)
  })

  it('getGroup lookups the per-episodeFull entry', () => {
    const deps = makeDeps()
    const dl = useEpisodeDownloads(deps)
    const g = { episodeLabel: 'Episode 1' } as unknown as EpisodeGroup
    deps.downloadGroups.value = new Map([['Episode 1', g]])
    expect(dl.getGroup('Episode 1')).toStrictEqual(g)
    expect(dl.getGroup('Episode 2')).toBeUndefined()
  })
})
