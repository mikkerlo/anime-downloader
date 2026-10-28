// Every anime-cache eviction site asks the one cache scope (#570 review):
// unstarring, the vanished-files sweep, deleting a downloaded show and the
// completed-show cleanup each drop the detail cache and its poster only when
// the title is no longer cachable — not starred, not downloaded, and not
// watched in the last 90 days. Each site runs against the real scope and a
// real anime-cache service over a temp `userData`.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register as registerLibrary } from '../../src/main/ipc/library.ipc'
import { register as registerDownloads } from '../../src/main/ipc/downloads.ipc'
import { register as registerDownloadedAnime } from '../../src/main/ipc/downloaded-anime.ipc'
import { register as registerCleanup } from '../../src/main/ipc/cleanup.ipc'
import {
  createAnimeCacheService,
  type AnimeCacheService
} from '../../src/main/services/anime-cache'
import { createCacheScope } from '../../src/main/services/anime-cache/scope'
import type { AppDeps } from '../../src/main/ipc/index'

const ID = 42
const NAME = 'Scoped Anime'
const T0 = Date.UTC(2026, 9, 28, 12)
const DAY = 24 * 60 * 60 * 1000

const anime = { id: ID, title: NAME, titles: {}, posterUrlSmall: '' }

type Membership = 'none' | 'starred' | 'downloaded' | 'recent' | 'stale-watch'

interface Harness {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  store: InMemoryStorage
  cache: AnimeCacheService
  posterPath: string
  downloadDir: string
}

let root: string

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-eviction-scope-'))
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

function harness(...members: Membership[]): Harness {
  const downloadDir = path.join(root, 'downloads')
  fs.mkdirSync(downloadDir, { recursive: true })
  const store = new InMemoryStorage({
    installId: 'install-a',
    library: members.includes('starred') ? { [ID]: anime } : {},
    downloadedAnime: members.includes('downloaded') ? { [ID]: anime } : {},
    downloadedEpisodes: {},
    priorityAnimeIds: [],
    watchProgress: members.includes('recent')
      ? { [`${ID}:3`]: { position: 600, duration: 1440, updatedAt: T0 - 2 * DAY } }
      : members.includes('stale-watch')
        ? { [`${ID}:3`]: { position: 600, duration: 1440, updatedAt: T0 - 120 * DAY } }
        : {},
    animeCache: {
      [ID]: {
        animeDetail: { ...anime, episodes: [] },
        episodes: {},
        qualityProbes: {},
        cachedAt: T0 - DAY,
        posterCached: true
      }
    }
  })
  const scope = createCacheScope(store)
  const cache = createAnimeCacheService({
    store,
    userDataDir: root,
    fetchPoster: async () => null,
    isCachable: scope.isCachable
  })
  fs.mkdirSync(cache.getPosterCacheDir(), { recursive: true })
  const posterPath = cache.getPosterCachePath(ID)
  fs.writeFileSync(posterPath, 'jpeg')

  const deps = {
    store,
    animeCacheService: cache,
    downloadManager: {
      findCancellableItems: () => [],
      cancelByEpisode: vi.fn(),
      getEpisodeGroups: () => []
    },
    coldStorageService: {
      getDownloadDir: () => downloadDir,
      isAdvanced: () => false,
      dirsForScan: () => [downloadDir],
      pruneDownloadedEpisode: vi.fn()
    },
    skipAnalysisService: { pruneCacheForAnime: vi.fn(), dropDetectionsForAnime: vi.fn() },
    invalidateFileCache: vi.fn()
  } as unknown as AppDeps
  ;(ipcMain.handle as Mock).mockClear()
  registerLibrary(deps)
  registerDownloads(deps)
  registerDownloadedAnime(deps)
  registerCleanup(deps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel, ...args) => handlers.get(channel)!({}, ...args),
    store,
    cache,
    posterPath,
    downloadDir
  }
}

function survived(h: Harness): { entry: boolean; poster: boolean } {
  return { entry: h.cache.getEntry(ID) !== null, poster: fs.existsSync(h.posterPath) }
}

const KEPT = { entry: true, poster: true }
const EVICTED = { entry: false, poster: false }

describe('createCacheScope', () => {
  it('accepts starred, downloaded and recently watched titles, and nothing else', () => {
    expect(createCacheScope(harness('starred').store).isCachable(ID)).toBe(true)
    expect(createCacheScope(harness('downloaded').store).isCachable(ID)).toBe(true)
    expect(createCacheScope(harness('recent').store).isCachable(ID)).toBe(true)
    expect(createCacheScope(harness('stale-watch').store).isCachable(ID)).toBe(false)
    expect(createCacheScope(harness('none').store).isCachable(ID)).toBe(false)
  })
})

describe('library-toggle: unstarring', () => {
  // Red on the old site, which kept only downloaded titles.
  it('keeps the cache and poster of a title watched in the last 90 days', async () => {
    const h = harness('starred', 'recent')
    expect(await h.invoke(CHANNELS.LIBRARY_TOGGLE, anime)).toBe(false)
    expect(survived(h)).toEqual(KEPT)
  })

  it('keeps them for a downloaded title — as before', async () => {
    const h = harness('starred', 'downloaded')
    await h.invoke(CHANNELS.LIBRARY_TOGGLE, anime)
    expect(survived(h)).toEqual(KEPT)
  })

  it('still evicts a title neither downloaded nor recently watched', async () => {
    const h = harness('starred', 'stale-watch')
    await h.invoke(CHANNELS.LIBRARY_TOGGLE, anime)
    expect(survived(h)).toEqual(EVICTED)
  })
})

describe('download-cancel-by-episode: the vanished-files sweep', () => {
  const sweep = (h: Harness): Promise<unknown> =>
    h.invoke(CHANNELS.DOWNLOAD_CANCEL_BY_EPISODE, NAME)

  // Red on the old sweep, which evicted every title it dropped from downloadedAnime.
  it('drops the downloaded record but keeps the cache of a starred title', async () => {
    const h = harness('downloaded', 'starred')
    await sweep(h)
    expect(h.store.get('downloadedAnime')).toEqual({})
    expect(survived(h)).toEqual(KEPT)
  })

  it('keeps the cache of a recently watched title', async () => {
    const h = harness('downloaded', 'recent')
    await sweep(h)
    expect(survived(h)).toEqual(KEPT)
  })

  it('still evicts a title that is no longer cachable', async () => {
    const h = harness('downloaded')
    await sweep(h)
    expect(h.store.get('downloadedAnime')).toEqual({})
    expect(survived(h)).toEqual(EVICTED)
  })

  it('leaves everything alone while the files are still on disk', async () => {
    const h = harness('downloaded')
    fs.mkdirSync(path.join(h.downloadDir, NAME), { recursive: true })
    fs.writeFileSync(path.join(h.downloadDir, NAME, `${NAME} - 01.mp4`), 'v')
    await sweep(h)
    expect(Object.keys(h.store.get('downloadedAnime') as object)).toEqual([String(ID)])
    expect(survived(h)).toEqual(KEPT)
  })
})

describe('downloaded-anime-delete', () => {
  it('keeps the cache of a starred title', async () => {
    const h = harness('downloaded', 'starred')
    await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
    expect(survived(h)).toEqual(KEPT)
  })

  it('evicts a title that is no longer cachable', async () => {
    const h = harness('downloaded')
    await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
    expect(survived(h)).toEqual(EVICTED)
  })
})

describe('cleanup-execute', () => {
  it('keeps the cache of a recently watched title', async () => {
    const h = harness('downloaded', 'recent')
    await h.invoke(CHANNELS.CLEANUP_EXECUTE, ID, NAME)
    expect(survived(h)).toEqual(KEPT)
  })

  it('evicts a title that is no longer cachable', async () => {
    const h = harness('downloaded', 'stale-watch')
    await h.invoke(CHANNELS.CLEANUP_EXECUTE, ID, NAME)
    expect(survived(h)).toEqual(EVICTED)
  })
})
