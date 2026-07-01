import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import { register } from '../../src/main/ipc/anime.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { createAnimeCacheService } from '../../src/main/services/anime-cache'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'
import type { EpisodeDetail } from '../../src/main/smotret-api'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function mkEpisode(id: number): EpisodeDetail {
  return {
    id,
    episodeFull: `Episode ${id}`,
    episodeInt: String(id),
    episodeType: 'tv',
    translations: [{ id: id * 10, type: 'subRu', authorsSummary: 'A', height: 720, isActive: 1 }]
  } as unknown as EpisodeDetail
}

describe('anime.ipc — cache-first episodes (#196)', () => {
  let handlers: Map<string, Handler>
  let getEpisodesBatch: ReturnType<typeof vi.fn>
  let store: InMemoryStorage

  function setup(seedEpisodes: Record<number, EpisodeDetail>): void {
    store = new InMemoryStorage({
      animeCache: {
        '1': {
          animeDetail: null,
          episodes: seedEpisodes,
          qualityProbes: {},
          cachedAt: Date.now(),
          posterCached: false
        }
      },
      downloadedAnime: { '1': {} },
      library: {}
    })
    const animeCacheService = createAnimeCacheService({
      store,
      userDataDir: '/tmp/anime-ipc-test',
      fetchPoster: async () => null,
      isCachable: () => true
    })
    getEpisodesBatch = vi.fn().mockRejectedValue(new Error('network down'))
    const deps = {
      smotretApi: {
        getEpisodesBatch,
        validateToken: vi.fn(),
        searchAnime: vi.fn(),
        getAnime: vi.fn(),
        getEmbed: vi.fn(),
        getEpisode: vi.fn()
      },
      animeCacheService,
      rememberAnimeMeta: vi.fn()
    } as unknown as AppDeps

    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register(deps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
  }

  beforeEach(() => {
    setup({ 1: mkEpisode(1), 2: mkEpisode(2) })
  })

  it('the cache-first channel and the network-first error-fallback return identical cached data', async () => {
    const ids = [1, 2]
    const cachedRes = (await handlers.get(CHANNELS.GET_EPISODES_BATCH_CACHED)!({}, ids, 1)) as {
      data: EpisodeDetail[]
      source: string
    }
    // GET_EPISODES_BATCH falls back to the cache because the network rejects.
    const fallbackRes = (await handlers.get(CHANNELS.GET_EPISODES_BATCH)!({}, ids, 1)) as {
      data: EpisodeDetail[]
      source: string
    }

    expect(getEpisodesBatch).toHaveBeenCalledTimes(1) // only the network-first path hit smotret
    expect(cachedRes.source).toBe('cache')
    expect(fallbackRes.source).toBe('cache')
    expect(cachedRes.data).toEqual(fallbackRes.data)
    expect(cachedRes.data.map((d) => d.id)).toEqual([1, 2])
  })

  it('filters out ids missing from the cache, in both reads', async () => {
    const ids = [1, 99] // 99 is not cached
    const cachedRes = (await handlers.get(CHANNELS.GET_EPISODES_BATCH_CACHED)!({}, ids, 1)) as {
      data: EpisodeDetail[]
    }
    const fallbackRes = (await handlers.get(CHANNELS.GET_EPISODES_BATCH)!({}, ids, 1)) as {
      data: EpisodeDetail[]
    }
    expect(cachedRes.data.map((d) => d.id)).toEqual([1])
    expect(cachedRes.data).toEqual(fallbackRes.data)
  })

  it('cache-first channel returns empty data (not a throw) when nothing is cached', async () => {
    setup({}) // no cached episodes
    const cachedRes = (await handlers.get(CHANNELS.GET_EPISODES_BATCH_CACHED)!({}, [1, 2], 1)) as {
      data: EpisodeDetail[]
      source: string
    }
    expect(cachedRes.data).toEqual([])
    expect(cachedRes.source).toBe('cache')
    // ...whereas the network-first fallback throws when it has no cache to serve.
    await expect(handlers.get(CHANNELS.GET_EPISODES_BATCH)!({}, [1, 2], 1)).rejects.toThrow()
  })

  it('a successful network batch persists every episode with ONE store write (perf regression)', async () => {
    setup({})
    getEpisodesBatch.mockResolvedValue({ data: [mkEpisode(1), mkEpisode(2), mkEpisode(3)] })
    const setSpy = vi.spyOn(store, 'set')

    const res = (await handlers.get(CHANNELS.GET_EPISODES_BATCH)!({}, [1, 2, 3], 1)) as {
      data: EpisodeDetail[]
      source: string
    }

    expect(res.source).toBe('api')
    // The old per-episode updateEpisode loop rewrote the store once per
    // episode (~60 full-file operations per 30-episode page).
    expect(setSpy).toHaveBeenCalledTimes(1)
    // ...and the batch is readable through the cache-first channel afterwards.
    const cachedRes = (await handlers.get(CHANNELS.GET_EPISODES_BATCH_CACHED)!(
      {},
      [1, 2, 3],
      1
    )) as {
      data: EpisodeDetail[]
    }
    expect(cachedRes.data.map((d) => d.id)).toEqual([1, 2, 3])
  })
})
