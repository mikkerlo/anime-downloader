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
/** The cold root, when a test configures one. */
let coldDir: string | null
/** `storageMode === 'advanced'`, kept apart from `coldDir` so a test can flip back to simple. */
let advanced: boolean

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-eviction-scope-'))
  coldDir = null
  advanced = false
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

function harness(...members: Membership[]): Harness {
  const downloadDir = path.join(root, 'downloads')
  fs.mkdirSync(downloadDir, { recursive: true })
  const configuredRoots = (): string[] => [downloadDir, coldDir].filter((r): r is string => !!r)
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
      isAdvanced: () => advanced,
      getColdStorageDir: () => coldDir,
      dirsForScan: () => (advanced && coldDir ? [downloadDir, coldDir] : [downloadDir]),
      allConfiguredRoots: () => configuredRoots(),
      missingConfiguredRoot: () => configuredRoots().find((r) => !fs.existsSync(r)) ?? null,
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

  // #661: red on the hot-only sweep, which dropped the record and evicted the cache.
  const filesOnlyInCold = (): void => {
    coldDir = path.join(root, 'cold')
    fs.mkdirSync(path.join(coldDir, NAME), { recursive: true })
    fs.writeFileSync(path.join(coldDir, NAME, `${NAME} - 01.mkv`), 'v')
  }

  it('advanced mode, files only in cold: keeps the record and the cache', async () => {
    advanced = true
    filesOnlyInCold()
    const h = harness('downloaded')
    await sweep(h)
    expect(Object.keys(h.store.get('downloadedAnime') as object)).toEqual([String(ID)])
    expect(survived(h)).toEqual(KEPT)
  })

  // Nothing moves cold files back on a flip to simple mode, so a mode-scoped root set misses them.
  it('flipped back to simple mode, files only in cold: keeps the record and the cache', async () => {
    filesOnlyInCold()
    const h = harness('downloaded')
    await sweep(h)
    expect(Object.keys(h.store.get('downloadedAnime') as object)).toEqual([String(ID)])
    expect(survived(h)).toEqual(KEPT)
  })

  it('cold configured but away: keeps the record and the cache, and logs the skip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      advanced = true
      coldDir = path.join(root, 'cold-unplugged')
      const h = harness('downloaded')
      await sweep(h)
      expect(Object.keys(h.store.get('downloadedAnime') as object)).toEqual([String(ID)])
      expect(survived(h)).toEqual(KEPT)
      expect(warn).toHaveBeenCalledWith(
        `[storage] skipping downloadedAnime sweep — configured root is missing: ${coldDir}`
      )
    } finally {
      warn.mockRestore()
    }
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

  it("drops the title's downloadedEpisodes entries and leaves other titles' alone", async () => {
    const h = harness('downloaded')
    seedEntries(h)
    await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
    expect(Object.keys(h.store.get('downloadedEpisodes') as object)).toEqual(['7:1:71'])
  })

  it('advanced mode, the title only in hot: the folder goes and the entries are dropped', async () => {
    advanced = true
    coldDir = path.join(root, 'cold')
    fs.mkdirSync(coldDir)
    const h = harness('downloaded')
    const folder = path.join(h.downloadDir, NAME)
    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, `${NAME} - 01.mkv`), 'v')
    seedEntries(h)
    await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
    expect(fs.existsSync(folder)).toBe(false)
    expect(Object.keys(h.store.get('downloadedEpisodes') as object)).toEqual(['7:1:71'])
  })

  // An unremovable file stands in for one the player holds open on Windows.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a folder left on disk keeps its entries, so the export tree still finds it',
    async () => {
      const h = harness('downloaded')
      const folder = path.join(h.downloadDir, NAME)
      fs.mkdirSync(folder)
      fs.writeFileSync(path.join(folder, `${NAME} - 01.mkv`), 'v')
      fs.chmodSync(folder, 0o555)
      try {
        seedEntries(h)
        await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
        expect(fs.existsSync(path.join(folder, `${NAME} - 01.mkv`))).toBe(true)
        expect(Object.keys(h.store.get('downloadedEpisodes') as object).sort()).toEqual([
          `${ID}:1:11`,
          `${ID}:2:11`,
          '7:1:71'
        ])
        expect(h.store.get('downloadedAnime')).toEqual({})
      } finally {
        fs.chmodSync(folder, 0o755)
      }
    }
  )

  describe("a title's episodes under its ru folder (#663)", () => {
    const RU = 'Шоу'

    function ruTitle(h: Harness): void {
      h.store.set('downloadedAnime', { [ID]: { ...anime, titles: { romaji: NAME, ru: RU } } })
      seedEntries(h)
    }

    function put(dir: string, folder: string, file: string): string {
      fs.mkdirSync(path.join(dir, folder), { recursive: true })
      const fp = path.join(dir, folder, file)
      fs.writeFileSync(fp, 'v')
      return fp
    }

    function episodeOneUnderRu(h: Harness): { ruVideo: string; ruSubs: string; video: string } {
      return {
        ruVideo: put(h.downloadDir, RU, `${RU} - 01 [Studio].mp4`),
        ruSubs: put(h.downloadDir, RU, `${RU} - 01 [Studio].ass`),
        video: put(h.downloadDir, NAME, `${NAME} - 02 [Studio].mp4`)
      }
    }

    const entries = (h: Harness): string[] =>
      Object.keys(h.store.get('downloadedEpisodes') as object).sort()

    // Red on the old handler, which removed only the `animeName` folder.
    it('deletes the video and subtitles under the ru folder, then the empty folder', async () => {
      const h = harness('downloaded')
      ruTitle(h)
      const { ruVideo, ruSubs, video } = episodeOneUnderRu(h)
      await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
      expect(fs.existsSync(ruVideo)).toBe(false)
      expect(fs.existsSync(ruSubs)).toBe(false)
      expect(fs.existsSync(video)).toBe(false)
      expect(fs.existsSync(path.join(h.downloadDir, RU))).toBe(false)
      expect(entries(h)).toEqual(['7:1:71'])
    })

    it("leaves another title's file in a shared ru folder, and the folder", async () => {
      const h = harness('downloaded')
      ruTitle(h)
      const { ruVideo } = episodeOneUnderRu(h)
      const other = put(h.downloadDir, RU, `${RU} - 05 [Other].mp4`)
      await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
      expect(fs.existsSync(ruVideo)).toBe(false)
      expect(fs.existsSync(other)).toBe(true)
      expect(fs.existsSync(path.join(h.downloadDir, RU))).toBe(true)
      expect(entries(h)).toEqual(['7:1:71'])
    })

    it('deletes every candidate of an episode: both containers and the legacy name', async () => {
      const h = harness('downloaded')
      ruTitle(h)
      const files = [
        put(h.downloadDir, RU, `${RU} - 01 [Studio].mkv`),
        put(h.downloadDir, RU, `${RU} - 01 [Studio].mp4`),
        put(h.downloadDir, RU, `${RU} - 01.mp4`)
      ]
      await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
      expect(files.filter((fp) => fs.existsSync(fp))).toEqual([])
      expect(fs.existsSync(path.join(h.downloadDir, RU))).toBe(false)
    })

    it('advanced mode, the ru folder in cold: its file and folder go too', async () => {
      advanced = true
      coldDir = path.join(root, 'cold')
      fs.mkdirSync(coldDir)
      const h = harness('downloaded')
      ruTitle(h)
      const coldVideo = put(coldDir, RU, `${RU} - 01 [Studio].mkv`)
      const video = put(h.downloadDir, NAME, `${NAME} - 02 [Studio].mp4`)
      await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
      expect(fs.existsSync(coldVideo)).toBe(false)
      expect(fs.existsSync(path.join(coldDir, RU))).toBe(false)
      expect(fs.existsSync(video)).toBe(false)
      expect(entries(h)).toEqual(['7:1:71'])
    })

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'a locked file under the ru folder keeps the entries',
      async () => {
        const h = harness('downloaded')
        ruTitle(h)
        const { ruVideo } = episodeOneUnderRu(h)
        const ruFolder = path.join(h.downloadDir, RU)
        fs.chmodSync(ruFolder, 0o555)
        try {
          await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
          expect(fs.existsSync(ruVideo)).toBe(true)
          expect(fs.existsSync(path.join(h.downloadDir, NAME))).toBe(false)
          expect(entries(h)).toEqual([`${ID}:1:11`, `${ID}:2:11`, '7:1:71'])
        } finally {
          fs.chmodSync(ruFolder, 0o755)
        }
      }
    )

    // Red without the helper's `author ?? ''`: the throw landed after the record was deleted.
    it('an entry with no author still completes the delete', async () => {
      const h = harness('downloaded')
      h.store.set('downloadedAnime', { [ID]: { ...anime, titles: { romaji: NAME, ru: RU } } })
      h.store.set('downloadedEpisodes', {
        [`${ID}:1:11`]: { translationType: 'subRu', quality: 720, translationId: 11 }
      })
      const ruVideo = put(h.downloadDir, RU, `${RU} - 01.mp4`)
      await expect(h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)).resolves.toBeUndefined()
      expect(h.store.get('downloadedAnime')).toEqual({})
      expect(fs.existsSync(ruVideo)).toBe(false)
      expect(fs.existsSync(path.join(h.downloadDir, RU))).toBe(false)
      expect(entries(h)).toEqual([])
      expect(survived(h)).toEqual(EVICTED)
    })

    it('a subtitle whose video is already gone is removed, and so is the folder', async () => {
      const h = harness('downloaded')
      ruTitle(h)
      const ruSubs = put(h.downloadDir, RU, `${RU} - 01 [Studio].ass`)
      await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
      expect(fs.existsSync(ruSubs)).toBe(false)
      expect(fs.existsSync(path.join(h.downloadDir, RU))).toBe(false)
      expect(entries(h)).toEqual(['7:1:71'])
    })

    // The folder stands in for one Explorer holds open on Windows (EPERM/EBUSY).
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'a ru folder that cannot be removed once its files are gone drops the entries',
      async () => {
        const h = harness('downloaded')
        ruTitle(h)
        const ruVideo = put(h.downloadDir, RU, `${RU} - 01 [Studio].mp4`)
        fs.chmodSync(h.downloadDir, 0o555)
        try {
          await h.invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, ID, NAME)
          expect(fs.existsSync(ruVideo)).toBe(false)
          expect(fs.existsSync(path.join(h.downloadDir, RU))).toBe(true)
          expect(entries(h)).toEqual(['7:1:71'])
        } finally {
          fs.chmodSync(h.downloadDir, 0o755)
        }
      }
    )
  })
})

function seedEntries(h: Harness): void {
  const entry = (translationId: number): object => ({
    translationType: 'subRu',
    author: 'Studio',
    quality: 720,
    translationId
  })
  h.store.set('downloadedEpisodes', {
    [`${ID}:1:11`]: entry(11),
    [`${ID}:2:11`]: entry(11),
    '7:1:71': entry(71)
  })
}

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

  it("drops the title's downloadedEpisodes entries and leaves other titles' alone", async () => {
    const h = harness('downloaded')
    seedEntries(h)
    await h.invoke(CHANNELS.CLEANUP_EXECUTE, ID, NAME)
    expect(Object.keys(h.store.get('downloadedEpisodes') as object)).toEqual(['7:1:71'])
  })
})
