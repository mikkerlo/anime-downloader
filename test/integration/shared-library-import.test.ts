// Copy to this PC (#579) through the real `shared-library` and `player`
// routers: the S7a (#578) fixture library attached with the real
// AttachedLibraryService, copied into a temp hot root of the real
// ColdStorageService, and then played from the local branch with no library
// attached.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { register as registerPlayer } from '../../src/main/ipc/player.ipc'
import { register as registerSharedLibrary } from '../../src/main/ipc/shared-library.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { createSharedLibraryImportService } from '../../src/main/services/shared-library-import'
import { sanitizeFilename } from '../../src/main/download-manager'
import { parseEpisodeFromFilename } from '../../src/main/lib/filename'
import type { AppDeps } from '../../src/main/ipc'
import { makeHarness } from '../helpers/app-harness'
import { cleanup, snapshot, tempRoot } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'
import { fakePresence } from '../helpers/shared-library-export'
import { FRIEREN, FRIEREN_MP4, MESHI, keys, setMetaTitle } from '../helpers/shared-library-import'

type Handler = (event: unknown, ...args: unknown[]) => unknown

let handlers: Map<string, Handler>
let parent: string
let downloadDir: string
let userData: string
let drive: string
let harness: ReturnType<typeof makeHarness>
let attached: ReturnType<typeof createAttachedLibraryService>
let svc: ReturnType<typeof createSharedLibraryImportService>

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return Promise.resolve(handlers.get(channel)!({ sender: { id: 1 } }, ...args) as T)
}

const findLocal = (
  animeName: string,
  episodeInt: string,
  translationId: number,
  animeId?: number
): Promise<PlayerLocalFileResult | null> =>
  call(CHANNELS.PLAYER_FIND_LOCAL_FILE, animeName, episodeInt, translationId, episodeInt, animeId)

async function attach(): Promise<void> {
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [drive] })
  await call<SharedLibraryDiscovery>(CHANNELS.SHARED_LIBRARY_PICK_AND_DISCOVER)
  const r = await call<SharedLibraryAttachResult>(
    CHANNELS.SHARED_LIBRARY_ATTACH,
    FIXTURE_LIBRARY_ID
  )
  expect(r.ok).toBe(true)
}

async function importKeys(ks: string[]): Promise<ImportJobView> {
  const r = await call<ImportStartResult>(CHANNELS.IMPORT_START, {
    libraryId: FIXTURE_LIBRARY_ID,
    selection: keys(...ks),
    destination: 'hot'
  })
  if (!r.ok) throw new Error(r.reason)
  await svc.settled(r.job.jobId)
  return (await call<ImportJobView[]>(CHANNELS.IMPORT_LIST_JOBS))[0]
}

beforeEach(() => {
  parent = fs.realpathSync(tempRoot())
  downloadDir = path.join(parent, 'hot')
  userData = path.join(parent, 'userData')
  fs.mkdirSync(downloadDir)
  fs.mkdirSync(userData)
  drive = copyFixtureLibrary()
  harness = makeHarness({
    downloadDir,
    storageMode: 'simple',
    hotStorageDir: '',
    coldStorageDir: '',
    downloadedEpisodes: {},
    downloadedAnime: {},
    animeCache: {},
    watchProgress: {},
    attachedLibraries: {}
  })
  const coldStorageService = createColdStorageService({
    store: harness.store as never,
    downloadsFallbackDir: downloadDir,
    sanitizeFilename,
    parseEpisodeFromFilename,
    scanEpisodeFiles: () => ({}),
    invalidateFileCache: () => {},
    broadcast: harness.broadcast,
    usageProgressChannel: 'usage-progress',
    cleanupPendingChannel: 'cleanup-pending',
    cleanupFinishedChannel: 'cleanup-finished',
    fileEpisodesChangedChannel: 'file-episodes-changed'
  })
  attached = createAttachedLibraryService({
    store: harness.store,
    checkFfmpeg: async () => ({ available: true }),
    log: { log: () => {}, warn: () => {}, error: () => {} }
  })
  svc = createSharedLibraryImportService({
    userDataDir: userData,
    store: harness.store,
    library: (id) => attached.get(id),
    localRoots: () => ({ hot: coldStorageService.getDownloadDir(), cold: null }),
    sanitizeFilename,
    mergeStatus: () => null,
    presence: fakePresence(),
    broadcast: (job) => harness.broadcast('import:job-updated', job),
    candidates: async () => [],
    throttleMs: 0
  })
  const deps = {
    store: harness.store,
    coldStorageService,
    mp4StatsService: { recordCheck: vi.fn() },
    downloadManager: {
      getMergeStatus: vi.fn().mockReturnValue(null),
      getPartialVideoPath: vi.fn().mockReturnValue(null)
    },
    playerLockService: { open: vi.fn(), close: vi.fn() },
    playerPresenceService: { open: vi.fn(), close: vi.fn() },
    getFfmpegPath: () => '',
    getFfprobePath: () => '',
    attachedLibraryService: attached,
    sharedLibraryImport: svc
  } as unknown as AppDeps
  ;(BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null
  ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
  registerPlayer(deps)
  registerSharedLibrary(deps)
  handlers = new Map(
    (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('Copy to this PC from the fixture library', () => {
  it('lands under the full local name (the drive’s is shortened), with arrivedAt, and plays with no library attached', async () => {
    await attach()
    const plan = await call<ImportPlan>(CHANNELS.IMPORT_PLAN, {
      libraryId: FIXTURE_LIBRARY_ID,
      animeIds: [101]
    })
    expect(plan.titles.map((t) => t.name)).toEqual(['Sousou no Frieren'])
    const before = Date.now()
    const job = await importKeys([FRIEREN])
    expect(job).toMatchObject({ status: 'completed', itemsDone: 1 })

    const local = path.join(
      downloadDir,
      'Sousou no Frieren',
      'Sousou no Frieren - 01 [Crunchyroll].mp4'
    )
    expect(fs.readFileSync(local)).toEqual(fs.readFileSync(path.join(drive, FRIEREN_MP4)))
    expect(fs.existsSync(path.join(downloadDir, 'Frieren~3f2a1c'))).toBe(false)
    const eps = harness.store.get<Record<string, { arrivedAt?: number }>>('downloadedEpisodes')!
    expect(eps[FRIEREN].arrivedAt).toBeGreaterThanOrEqual(before)

    // The drive "unplugged": the local branch finds it, by the name the player rebuilds.
    await attached.forget(FIXTURE_LIBRARY_ID)
    expect(attached.list()).toEqual([])
    const hit = await findLocal('Sousou no Frieren', '1', 9001, 101)
    expect(hit).toEqual({
      filePath: local,
      subtitleContent: fs.readFileSync(local.replace(/\.mp4$/, '.ass'), 'utf8')
    })
  })

  it('never overwrites this PC’s downloadedAnime, animeCache or poster; the file lands under the local name', async () => {
    setMetaTitle(drive, 101, 'Foreign Name')
    const localAnime = {
      id: 101,
      title: 'Local Name',
      titles: { romaji: 'Local Name' },
      posterUrlSmall: 'https://example.invalid/local.jpg',
      numberOfEpisodes: 28,
      type: 'tv',
      typeTitle: 'TV',
      year: 2023,
      season: 'fall'
    }
    const localCache = {
      animeDetail: { ...localAnime, posterUrl: '', descriptions: [], episodes: [], genres: [] },
      episodes: {},
      qualityProbes: {},
      cachedAt: 1,
      posterCached: true
    }
    harness.store.set('downloadedAnime', { '101': localAnime })
    harness.store.set('animeCache', { '101': localCache })
    const poster = path.join(userData, 'poster-cache', '101.jpg')
    fs.mkdirSync(path.dirname(poster), { recursive: true })
    fs.writeFileSync(poster, 'local poster')
    const was = {
      anime: JSON.stringify(harness.store.get('downloadedAnime')),
      cache: JSON.stringify(harness.store.get('animeCache'))
    }

    await attach()
    await importKeys([FRIEREN])

    const local = path.join(downloadDir, 'Local Name', 'Local Name - 01 [Crunchyroll].mp4')
    expect(fs.existsSync(local)).toBe(true)
    expect(fs.existsSync(path.join(downloadDir, 'Foreign Name'))).toBe(false)
    expect(JSON.stringify(harness.store.get('downloadedAnime'))).toBe(was.anime)
    expect(JSON.stringify(harness.store.get('animeCache'))).toBe(was.cache)
    expect(fs.readFileSync(poster, 'utf8')).toBe('local poster')
    await attached.forget(FIXTURE_LIBRARY_ID)
    expect((await findLocal('Local Name', '1', 9001, 101))?.filePath).toBe(local)
  })

  it('a snapshot title of "..": nothing is created for it, nothing lands above the root, and the other titles still import', async () => {
    setMetaTitle(drive, 101, '..')
    await attach()
    const plan = await call<ImportPlan>(CHANNELS.IMPORT_PLAN, {
      libraryId: FIXTURE_LIBRARY_ID,
      animeIds: null
    })
    expect(plan.rejected.map((r) => r.key)).toEqual([FRIEREN])
    const before = snapshot(parent)

    // That title alone: refused, nothing changes anywhere under the root's parent.
    const alone = await call<ImportStartResult>(CHANNELS.IMPORT_START, {
      libraryId: FIXTURE_LIBRARY_ID,
      selection: keys(FRIEREN),
      destination: 'hot'
    })
    expect(alone.ok).toBe(false)
    expect(snapshot(parent)).toEqual(before)

    // Import all, the `..` item forced into the selection: only Dungeon Meshi lands.
    const job = await importKeys([FRIEREN, MESHI])
    expect(job).toMatchObject({ status: 'completed', itemsDone: 1, itemsTotal: 1 })
    const after = snapshot(parent)
    const added = Object.keys(after).filter((k) => !(k in before))
    expect(added.filter((k) => !k.startsWith(`userData${path.sep}`))).toEqual([
      path.join('hot', 'Dungeon Meshi', 'Dungeon Meshi - 01 [AniLibria].mkv')
    ])
    for (const [k, v] of Object.entries(before)) expect(after[k]).toBe(v)
    expect(Object.keys(harness.store.get<object>('downloadedEpisodes')!)).toEqual([MESHI])
    expect(fs.existsSync(path.join(parent, '.. - 01 [Crunchyroll].mp4'))).toBe(false)
  })
})
