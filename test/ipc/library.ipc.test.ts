// Behavior of the library IPC router around the local priority list (#269).
//
// Priority persists *ids only* (`priorityAnimeIds`), rendering from the
// `library` snapshot, so the whole feature rests on one invariant:
// priority ⊆ library. These tests pin the three places that enforce it —
// promote (stars if needed), un-star (demotes), and read (prunes) — plus the
// ordering guarantee that makes the Priority tab read as a queue.
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register } from '../../src/main/ipc/library.ipc'
import type { AppDeps } from '../../src/main/ipc/index'

function anime(id: number): AnimeSearchResult {
  return {
    id,
    title: `Anime ${id}`,
    titles: {},
    posterUrlSmall: 'p.jpg',
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV',
    year: 2020,
    season: 'spring'
  } as AnimeSearchResult
}

function registerRouter(initial: Record<string, unknown> = {}): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  store: InMemoryStorage
  deleteEntry: Mock
} {
  const store = new InMemoryStorage({
    library: {},
    downloadedAnime: {},
    priorityAnimeIds: [],
    ...initial
  })
  const deleteEntry = vi.fn()
  register({ store, animeCacheService: { deleteEntry } } as unknown as AppDeps)

  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel, ...args) => handlers.get(channel)!({}, ...args),
    store,
    deleteEntry
  }
}

/** `library[key]` map, for asserting the invariant without casting at each site. */
function lib(store: InMemoryStorage): Record<string, AnimeSearchResult> {
  return store.get('library') as Record<string, AnimeSearchResult>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('library IPC — library-set-priority', () => {
  it('stars a not-yet-starred anime when promoting it (priority ⊆ library)', async () => {
    const { invoke, store } = registerRouter()

    const result = await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(7), true)

    // Both writes land, from the one handler — a renderer doing them as two
    // round-trips could half-fail and leave a dangling id.
    expect(lib(store)['7']).toMatchObject({ id: 7 })
    expect(store.get('priorityAnimeIds')).toEqual(['7'])
    expect(result).toEqual(['7'])
  })

  it('leaves an already-starred entry untouched when promoting', async () => {
    const existing = { ...anime(7), title: 'Saved snapshot' }
    const { invoke, store } = registerRouter({ library: { '7': existing } })

    await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(7), true)

    // The stored snapshot is not clobbered by the payload of a promote.
    expect(lib(store)['7'].title).toBe('Saved snapshot')
    expect(store.get('priorityAnimeIds')).toEqual(['7'])
  })

  it('appends in promote order and does not duplicate on a repeat promote', async () => {
    const { invoke, store } = registerRouter()

    await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(3), true)
    await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(1), true)
    const again = await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(3), true)

    expect(again).toEqual(['3', '1'])
    expect(store.get('priorityAnimeIds')).toEqual(['3', '1'])
  })

  it('stars a title that lives only in downloadedAnime when promoting it', async () => {
    // Deliberately stricter than the read's `library ∪ downloadedAnime` test:
    // `downloadedAnime` is file-derived and volatile (a "Remove files" click
    // drops it), so anchoring a prioritization only there would let a file
    // deletion silently evaporate it. `library` is the durable record of intent.
    const { invoke, store } = registerRouter({ downloadedAnime: { '7': anime(7) } })

    const result = await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(7), true)

    expect(lib(store)['7']).toMatchObject({ id: 7 })
    expect(result).toEqual(['7'])
  })

  it('prunes unresolvable ids from its return, matching library-get-priority', async () => {
    // Regression: the write returned the raw stored array while the read pruned
    // it, and every renderer assigns `priorityIds` from *both* — so a dangling
    // id invisible on load came back on the next toggle, and in `LibraryView`
    // consumed a rank slot (badges reading `1, 3, 4`) until the next reload.
    const { invoke, store } = registerRouter({
      library: { '1': anime(1) },
      downloadedAnime: { '2': anime(2) },
      priorityAnimeIds: ['404', '1']
    })

    // Promote: the new id is appended, the dangling one is dropped from the view.
    expect(await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(2), true)).toEqual(['1', '2'])
    // Repeat promote (the early-return branch) agrees.
    expect(await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(2), true)).toEqual(['1', '2'])
    // Demote, and the no-op demote of an absent id, likewise.
    expect(await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(2), false)).toEqual(['1'])
    expect(await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(99), false)).toEqual(['1'])
    // Pruning stays display-only — the dangling id is never written away.
    expect(store.get('priorityAnimeIds')).toEqual(['404', '1'])
    // ...and matches what a fresh load would report.
    expect(await invoke(CHANNELS.LIBRARY_GET_PRIORITY)).toEqual(['1'])
  })

  it('demotes without touching library membership, and no-ops on an absent id', async () => {
    const { invoke, store } = registerRouter({
      library: { '3': anime(3), '1': anime(1) },
      priorityAnimeIds: ['3', '1']
    })

    const afterDemote = await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(3), false)
    expect(afterDemote).toEqual(['1'])
    // Demoting is not un-starring.
    expect(Object.keys(lib(store)).sort()).toEqual(['1', '3'])

    const noop = await invoke(CHANNELS.LIBRARY_SET_PRIORITY, anime(99), false)
    expect(noop).toEqual(['1'])
    expect(store.get('priorityAnimeIds')).toEqual(['1'])
  })
})

describe('library IPC — library-toggle', () => {
  it('drops the id from priorityAnimeIds when un-starring a prioritized anime', async () => {
    // Regression: before #269 the un-star branch wrote only `library`, so the
    // priority id survived with nothing left to render from.
    const { invoke, store } = registerRouter({
      library: { '3': anime(3), '1': anime(1) },
      priorityAnimeIds: ['3', '1']
    })

    const result = await invoke(CHANNELS.LIBRARY_TOGGLE, anime(3))

    expect(result).toBe(false)
    expect(lib(store)['3']).toBeUndefined()
    expect(store.get('priorityAnimeIds')).toEqual(['1'])
  })

  it('leaves the priority list alone when un-starring a non-prioritized anime', async () => {
    const { invoke, store } = registerRouter({
      library: { '3': anime(3), '1': anime(1) },
      priorityAnimeIds: ['1']
    })

    await invoke(CHANNELS.LIBRARY_TOGGLE, anime(3))

    expect(store.get('priorityAnimeIds')).toEqual(['1'])
  })

  it('does not add to the priority list when starring', async () => {
    const { invoke, store } = registerRouter()

    const result = await invoke(CHANNELS.LIBRARY_TOGGLE, anime(5))

    expect(result).toBe(true)
    expect(store.get('priorityAnimeIds')).toEqual([])
  })
})

describe('library IPC — library-get-priority', () => {
  it('preserves stored order rather than library iteration order', async () => {
    const { invoke } = registerRouter({
      library: { '1': anime(1), '2': anime(2), '3': anime(3) },
      priorityAnimeIds: ['3', '1']
    })

    expect(await invoke(CHANNELS.LIBRARY_GET_PRIORITY)).toEqual(['3', '1'])
  })

  it('prunes ids absent from library ∪ downloadedAnime, without writing back', async () => {
    const { invoke, store } = registerRouter({
      library: { '1': anime(1) },
      downloadedAnime: { '2': anime(2) },
      priorityAnimeIds: ['1', '2', '404']
    })

    expect(await invoke(CHANNELS.LIBRARY_GET_PRIORITY)).toEqual(['1', '2'])
    // Prune-on-read is a display backstop, not a repair: a read handler that
    // persisted would destroy data if `library` were ever transiently empty.
    expect(store.get('priorityAnimeIds')).toEqual(['1', '2', '404'])
  })

  it('tolerates a store that predates the key', async () => {
    const store = new InMemoryStorage({ library: {}, downloadedAnime: {} })
    const deleteEntry = vi.fn()
    register({ store, animeCacheService: { deleteEntry } } as unknown as AppDeps)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )

    expect(await handlers.get(CHANNELS.LIBRARY_GET_PRIORITY)!({})).toEqual([])
  })
})
