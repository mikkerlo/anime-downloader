// Searching an attached Shared Library (#583), through the real `shared-library`
// and `anime` routers on one store, the real AttachedLibraryService and the
// fixture library in a temp dir: open it, then `search:local` finds its titles,
// and `anime-poster://shared/...` serves the drive poster the result points at.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import { register as registerSharedLibrary } from '../../src/main/ipc/shared-library.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { createRecentWatchIndex } from '../../src/main/lib/recent-watch'
import { createAnimePosterHandler } from '../../src/main/streaming/anime-poster-protocol'
import type { AppDeps } from '../../src/main/ipc'
import { makeHarness } from '../helpers/app-harness'
import { cleanup, tempRoot } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const SHARED = { kind: 'shared', libraryId: FIXTURE_LIBRARY_ID, libraryName: 'Fixture library' }

let handlers: Map<string, Handler>
let drive: string
let harness: ReturnType<typeof makeHarness>
let poster: (url: string) => Promise<Response>

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return Promise.resolve(handlers.get(channel)!({ sender: { id: 1 } }, ...args) as T)
}

const search = (q: string): Promise<LocalSearchResponse> => call(CHANNELS.SEARCH_LOCAL, q)

async function open(): Promise<void> {
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [drive] })
  const found = await call<SharedLibraryDiscovery>(CHANNELS.SHARED_LIBRARY_PICK_AND_DISCOVER)
  expect(found.candidates.map((c) => c.libraryId)).toEqual([FIXTURE_LIBRARY_ID])
  const res = await call<SharedLibraryAttachResult>(
    CHANNELS.SHARED_LIBRARY_ATTACH,
    FIXTURE_LIBRARY_ID
  )
  expect(res.ok).toBe(true)
}

beforeEach(() => {
  drive = copyFixtureLibrary()
  harness = makeHarness({
    shikimoriUser: null,
    shikimoriCredentials: null,
    library: {},
    downloadedAnime: {},
    animeCache: {},
    watchProgress: {},
    attachedLibraries: {}
  })
  const attachedLibraryService = createAttachedLibraryService({
    store: harness.store,
    checkFfmpeg: async () => ({ available: true }),
    log: { log: () => {}, warn: () => {}, error: () => {} }
  })
  const recentWatch = createRecentWatchIndex({
    readWatchProgress: () =>
      harness.store.get('watchProgress') as Record<string, { updatedAt: number }>
  })
  ;(BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null
  ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
  const deps = {
    store: harness.store,
    recentWatch,
    attachedLibraryService
  } as unknown as AppDeps
  registerAnime(deps)
  registerSharedLibrary(deps)
  handlers = new Map(
    (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
  )
  const handler = createAnimePosterHandler({
    posterDir: tempRoot(),
    attachedPoster: (id) => attachedLibraryService.posterFor(id),
    libraryPoster: (libraryId, id) => attachedLibraryService.libraryPosterFor(libraryId, id)
  })
  poster = (url) => handler({ url } as Request)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('search:local after opening a Shared Library', () => {
  it('a PC with nothing of its own finds the library titles once it is open', async () => {
    expect(await search('frieren')).toEqual({ results: [], corpusSize: 0 })
    await open()

    const { results, corpusSize } = await search('frieren')
    expect(corpusSize).toBe(2)
    expect(results.map((r) => [r.id, r.title, r.localSources])).toEqual([
      [101, 'Frieren', [SHARED]]
    ])
    // By the meta's Russian title, and a title with no meta by its manifest name.
    expect((await search('провожающая')).results.map((r) => r.id)).toEqual([101])
    expect((await search('dungeon')).results.map((r) => r.id)).toEqual([202])

    // The result's poster is the drive's, served through the shared form.
    const res = await poster(results[0].posterUrlSmall)
    expect(res.status).toBe(200)
    expect(
      Buffer.from(await res.arrayBuffer()).equals(
        fs.readFileSync(path.join(drive, '.anime-dl', 'posters', '101.jpg'))
      )
    ).toBe(true)
  })

  it('a title starred on this PC and on the drive is one result with both sources', async () => {
    harness.store.set('library', {
      101: {
        id: 101,
        title: 'Frieren',
        titles: { romaji: 'Sousou no Frieren' },
        posterUrlSmall: 'https://example.invalid/101.jpg',
        numberOfEpisodes: 28,
        type: 'tv',
        typeTitle: 'TV',
        year: 2023,
        season: 'fall'
      }
    })
    await open()
    const { results } = await search('sousou')
    expect(results).toHaveLength(1)
    expect(results[0].localSources).toEqual([{ kind: 'starred' }, SHARED])
    expect(results[0].posterUrlSmall).toBe('https://example.invalid/101.jpg')
  })
})
