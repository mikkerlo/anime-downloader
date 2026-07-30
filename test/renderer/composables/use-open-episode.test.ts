import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useOpenEpisode } from '../../../src/renderer/src/composables/use-open-episode'
import { usePlayerStore } from '../../../src/renderer/src/stores/player'

type ApiMocks = {
  getAnime: ReturnType<typeof vi.fn>
  getEpisodesBatchCached: ReturnType<typeof vi.fn>
  downloadedEpisodesGet: ReturnType<typeof vi.fn>
  playerGetStreamUrl: ReturnType<typeof vi.fn>
}

let api: ApiMocks

function makeAnime(episodeCount = 3): AnimeDetail {
  return {
    id: 42,
    title: 'COTE',
    titles: { romaji: 'Classroom of the Elite' },
    posterUrlSmall: '',
    posterUrl: '',
    numberOfEpisodes: episodeCount,
    type: 'tv',
    typeTitle: 'TV',
    year: 2017,
    season: 'summer',
    descriptions: [],
    genres: [],
    myAnimeListId: 35507,
    episodes: Array.from({ length: episodeCount }, (_, i) => ({
      id: 100 + i,
      episodeFull: `${i + 1} серия`,
      episodeInt: String(i + 1),
      episodeType: 'tv',
      isActive: 1
    }))
  }
}

function makeDetail(id: number, episodeInt: string, trIds: number[]): EpisodeDetail {
  return {
    id,
    episodeFull: `${episodeInt} серия`,
    episodeInt,
    episodeType: 'tv',
    translations: trIds.map((trId, i) => ({
      id: trId,
      type: i % 2 === 0 ? 'subRu' : 'voiceRu',
      typeKind: 'sub',
      typeLang: 'ru',
      authorsSummary: `author-${trId}`,
      isActive: 1,
      width: 1920,
      height: 1080 - i * 360,
      duration: '24:00'
    }))
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  api = {
    getAnime: vi.fn(async () => ({ data: makeAnime(), source: 'api' })),
    getEpisodesBatchCached: vi.fn(async (ids: number[]) => ({
      data: ids.map((id) => makeDetail(id, String(id - 99), [500 + id, 600 + id])),
      source: 'api'
    })),
    downloadedEpisodesGet: vi.fn(async () => ({})),
    playerGetStreamUrl: vi.fn(async () => ({
      streamUrl: 'https://cdn.example/stream.m3u8',
      subtitleContent: 'subs',
      availableStreams: [{ height: 1080, url: 'https://cdn.example/1080' }]
    }))
  }
  ;(globalThis as { window?: { api: unknown } }).window = { api }
})

describe('useOpenEpisode', () => {
  it('assembles a streaming PlayerPayload for the target episode + translation', async () => {
    const { openEpisode } = useOpenEpisode()
    const result = await openEpisode({ animeId: 42, episodeInt: '2', translationId: 601 })
    expect(result).toEqual({ ok: true })

    const payload = usePlayerStore().playerState
    expect(payload).not.toBeNull()
    expect(payload!.animeId).toBe(42)
    expect(payload!.malId).toBe(35507)
    expect(payload!.animeName).toBe('Classroom of the Elite')
    expect(payload!.episodeLabel).toBe('2')
    expect(payload!.episodeIndex).toBe(1)
    expect(payload!.translationId).toBe(601)
    expect(payload!.streamUrl).toBe('https://cdn.example/stream.m3u8')
    expect(payload!.filePath).toBe('')
    expect(payload!.allEpisodes).toHaveLength(3)
    expect(payload!.allEpisodes[1].translations.map((t) => t.id)).toEqual([601, 701])
    expect(api.playerGetStreamUrl).toHaveBeenCalledWith(601, expect.any(Number))
  })

  it('falls back to the best available translation when the requested one is missing', async () => {
    const { openEpisode } = useOpenEpisode()
    const result = await openEpisode({ animeId: 42, episodeInt: '1', translationId: 99999 })
    expect(result).toEqual({ ok: true })
    const payload = usePlayerStore().playerState
    // Highest-quality translation of episode 1 (id 600, 1080p) wins.
    expect(payload!.translationId).toBe(600)
  })

  it('tries the next translation when a stream resolution returns null', async () => {
    api.playerGetStreamUrl
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ streamUrl: 'u2', subtitleContent: null, availableStreams: [] })
    const { openEpisode } = useOpenEpisode()
    const result = await openEpisode({ animeId: 42, episodeInt: '1', translationId: 600 })
    expect(result).toEqual({ ok: true })
    expect(api.playerGetStreamUrl).toHaveBeenCalledTimes(2)
    expect(usePlayerStore().playerState!.translationId).toBe(700)
  })

  it('reports an error when the episode does not exist', async () => {
    const { openEpisode } = useOpenEpisode()
    const result = await openEpisode({ animeId: 42, episodeInt: '9' })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('9') })
    expect(usePlayerStore().playerState).toBeNull()
  })

  it('reports an error when no stream is playable at all', async () => {
    api.playerGetStreamUrl.mockResolvedValue(null)
    const { openEpisode } = useOpenEpisode()
    const result = await openEpisode({ animeId: 42, episodeInt: '1' })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('stream') })
    expect(usePlayerStore().playerState).toBeNull()
  })

  it('only fetches details for the page window containing the target', async () => {
    api.getAnime.mockResolvedValue({ data: makeAnime(70), source: 'api' })
    const { openEpisode } = useOpenEpisode()
    await openEpisode({ animeId: 42, episodeInt: '35' })
    const ids = api.getEpisodesBatchCached.mock.calls[0][0] as number[]
    // Episode 35 (index 34) lives in the second 30-episode page: indexes 30–59.
    expect(ids).toHaveLength(30)
    expect(ids[0]).toBe(130)
    expect(ids[29]).toBe(159)
  })

  it('marks downloaded translations from episode metadata', async () => {
    api.downloadedEpisodesGet.mockResolvedValue({
      '1': [{ translationId: 600, author: 'author-600' }]
    })
    const { openEpisode } = useOpenEpisode()
    await openEpisode({ animeId: 42, episodeInt: '1' })
    const payload = usePlayerStore().playerState
    expect(payload!.allEpisodes[0].downloadedTrIds).toEqual([600])
    expect(payload!.downloadedTrIds).toEqual([600])
  })
})
