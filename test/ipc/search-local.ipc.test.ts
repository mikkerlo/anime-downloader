// `search:local` (#571): one read of each corpus key per call, the `watching`
// source from the 90-day recent-watch index, and `corpusSize` so the view can
// tell "nothing on this PC" from "nothing matches".
import { describe, it, expect, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createRecentWatchIndex } from '../../src/main/lib/recent-watch'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const NOW = new Date('2026-10-28T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

function anime(id: number, title: string): AnimeSearchResult {
  return {
    id,
    title,
    titles: { romaji: title },
    posterUrlSmall: '',
    numberOfEpisodes: 1,
    type: 'tv',
    typeTitle: 'TV',
    year: 2024,
    season: 'fall'
  }
}

function harness(): {
  invoke: (...args: unknown[]) => Promise<LocalSearchResponse>
  get: Mock
} {
  const store = new InMemoryStorage({
    library: { 1: anime(1, 'Starred Saga') },
    downloadedAnime: { 2: anime(2, 'Downloaded Saga') },
    animeCache: {
      3: {
        animeDetail: {
          ...anime(3, 'Continue Saga'),
          genres: [{ id: 1, title: 'Drama' }],
          myAnimeListId: 303
        }
      }
    },
    shikimoriUserRates: [{ rate: { status: 'watching', target_id: 303 } }],
    shikimoriAnimeDetails: { 303: { details: { status: 'ongoing' } } },
    watchProgress: { '3:1': { position: 10, duration: 100, updatedAt: NOW - DAY } }
  })
  const get = vi.spyOn(store, 'get') as unknown as Mock
  const recentWatch = createRecentWatchIndex({
    readWatchProgress: () => store.get('watchProgress') as Record<string, { updatedAt: number }>,
    now: () => NOW
  })
  ;(ipcMain.handle as Mock).mockClear()
  registerAnime({ store, recentWatch } as unknown as AppDeps)
  const handler = (ipcMain.handle as Mock).mock.calls.find(
    ([channel]) => channel === CHANNELS.SEARCH_LOCAL
  )![1] as (...args: unknown[]) => LocalSearchResponse
  return { invoke: async (...args) => handler({}, ...args), get }
}

describe('search:local', () => {
  it('searches starred, downloaded and continue-watching titles with their sources', async () => {
    const { invoke } = harness()
    const { results, corpusSize } = await invoke('saga')

    expect(corpusSize).toBe(3)
    // The watching source plus the Shikimori `watching` status lift id 3.
    expect(results.map((r) => [r.id, r.localSources])).toEqual([
      [3, [{ kind: 'watching' }]],
      [2, [{ kind: 'downloaded' }]],
      [1, [{ kind: 'starred' }]]
    ])
    expect(results[0]).toMatchObject({
      listStatus: 'watching',
      genres: ['Drama'],
      airingStatus: 'ongoing'
    })
  })

  it('passes the filters through', async () => {
    const { invoke } = harness()
    expect((await invoke('saga', { genre: 'Drama' })).results.map((r) => r.id)).toEqual([3])
    expect((await invoke('saga', { status: 'completed' })).results).toEqual([])
  })

  it('reads each corpus key once per call', async () => {
    const { invoke, get } = harness()
    await invoke('saga')
    const keys = get.mock.calls.map(([key]) => key)
    for (const key of [
      'library',
      'downloadedAnime',
      'animeCache',
      'shikimoriUserRates',
      'shikimoriAnimeDetails'
    ]) {
      expect(keys.filter((k) => k === key)).toHaveLength(1)
    }
  })

  it('a 1-character query returns no results but still reports the corpus size', async () => {
    const { invoke } = harness()
    expect(await invoke('s')).toEqual({ results: [], corpusSize: 3 })
  })
})
