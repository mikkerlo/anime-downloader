// `search:local` (#571): one read of each corpus key per call, the `watching`
// source from the 90-day recent-watch index, and `corpusSize` so the view can
// tell "nothing on this PC" from "nothing matches". Attached Shared Libraries
// (#583) join the corpus while S7c (#581) reports them available, read from
// memory, never from the drive.
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createRecentWatchIndex } from '../../src/main/lib/recent-watch'
import {
  createAttachedLibraryService,
  type AttachedLibraryService
} from '../../src/main/services/attached-library'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { cleanup } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'

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

function harness(
  attachedLibraryService: Pick<AttachedLibraryService, 'availableSnapshots'> = {
    availableSnapshots: () => []
  }
): {
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
  registerAnime({ store, recentWatch, attachedLibraryService } as unknown as AppDeps)
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

describe('search:local over attached Shared Libraries (#583)', () => {
  const OWNER = { id: 4242, nickname: 'owner', avatar: '' }
  const STRANGER = { id: 777, nickname: 'stranger', avatar: '' }
  const SHARED = { kind: 'shared', libraryId: FIXTURE_LIBRARY_ID, libraryName: 'Fixture library' }

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  /** The real service with the fixture library attached at a temp root. */
  async function attached(
    user: typeof OWNER | null
  ): Promise<{ svc: AttachedLibraryService; root: string }> {
    const svc = createAttachedLibraryService({
      store: new InMemoryStorage({
        shikimoriUser: user,
        shikimoriCredentials: null,
        downloadedAnime: {},
        attachedLibraries: {}
      }),
      checkFfmpeg: async () => ({ available: true }),
      log: { log: () => {}, warn: () => {}, error: () => {} }
    })
    const root = copyFixtureLibrary()
    const [candidate] = await svc.discover(root)
    const res = await svc.attach(candidate.libraryId!)
    if (!res.ok) throw new Error(res.error)
    return { svc, root }
  }

  /**
   * Every `fs.promises` call during `run` that names a path under `root`. The
   * service and S5's reader only use `fs.promises` (`fsWritesUnder` relies on
   * the same), and the sync API can't be spied on from ESM.
   */
  async function driveCalls(root: string, run: () => Promise<unknown>): Promise<string[]> {
    const roots = [root, fs.realpathSync(root)]
    const under = (a: unknown): boolean =>
      typeof a === 'string' &&
      roots.some((r) => path.resolve(a) === r || path.resolve(a).startsWith(r + path.sep))
    const seen: string[] = []
    const spyAll = (target: Record<string, unknown>, label: string, names: string[]): void => {
      for (const name of names) {
        const original = target[name] as (...a: unknown[]) => unknown
        vi.spyOn(target as never, name as never).mockImplementation(((...args: unknown[]) => {
          if (args.slice(0, 2).some(under)) seen.push(`${label}${name}(${String(args[0])})`)
          return original.apply(target, args)
        }) as never)
      }
    }
    const promises = fs.promises as unknown as Record<string, unknown>
    spyAll(
      promises,
      'fs.promises.',
      Object.keys(promises).filter((k) => typeof promises[k] === 'function')
    )
    try {
      await run()
    } finally {
      vi.restoreAllMocks()
    }
    return seen
  }

  it('the spy sees a drive read, so an empty list means none happened', async () => {
    const { root } = await attached(OWNER)
    const calls = await driveCalls(root, () =>
      fs.promises.stat(path.join(root, '.anime-dl', 'manifest.json'))
    )
    expect(calls).toHaveLength(1)
  })

  it('an available library is searched; unavailable it drops out, and back it returns, with no drive I/O', async () => {
    const { svc, root } = await attached(OWNER)
    const { invoke } = harness(svc)

    const plugged = await driveCalls(root, async () => {
      const { results, corpusSize } = await invoke('frieren')
      expect(results.map((r) => [r.id, r.localSources])).toEqual([[101, [SHARED]]])
      expect(results[0].posterUrlSmall).toBe(`anime-poster://shared/${FIXTURE_LIBRARY_ID}/101`)
      // The three local titles plus Frieren and Dungeon Meshi.
      expect(corpusSize).toBe(5)
    })
    expect(plugged).toEqual([])

    // What the poller does when the drive goes away (S7c).
    svc.markUnavailable(FIXTURE_LIBRARY_ID, root)
    const unplugged = await driveCalls(root, async () => {
      expect(await invoke('frieren')).toEqual({ results: [], corpusSize: 3 })
    })
    expect(unplugged).toEqual([])

    // ...and when it is back.
    expect(await svc.reopenAt(FIXTURE_LIBRARY_ID, root)).toBe(true)
    const replugged = await driveCalls(root, async () => {
      expect((await invoke('dungeon')).results.map((r) => [r.id, r.localSources])).toEqual([
        [202, [SHARED]]
      ])
    })
    expect(replugged).toEqual([])
  })

  it('a foreign library (logged in as someone else) is still searchable', async () => {
    const { svc } = await attached(STRANGER)
    expect(svc.list()[0].role).toBe('foreign')
    const { invoke } = harness(svc)
    expect((await invoke('frieren')).results.map((r) => r.id)).toEqual([101])
  })
})
