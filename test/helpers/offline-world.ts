/**
 * One "PC" for the offline scenario matrix (#659): store keys, hot and cold
 * folders with the episode files a `WorldSpec` declares, and the real services
 * Prepare for offline and the player read them through.
 *
 * Built on `makeHarness` / `InMemoryStorage` (see `app-harness.ts`), not as an
 * `App` reconstruction: steps 3 and 4 get their deps from the production
 * builders in `services/prepare-offline/wiring.ts`, called over this world's
 * services in the same order as `index.ts` (the deps before the download
 * manager exists), and only the routers a row's oracles and actions call are
 * registered on the mocked `ipcMain`. Steps 5 and 6 run over the real
 * attached-library service, as `index.ts` hands it to step 5; a world with a
 * `library` attaches a copy of the checked-in fixture library in `ready()`.
 * Steps 1 and 2 run over hand-written deps (this world's binaries folder, and
 * a stand-in for the Shikimori sync service), and every step asks the real
 * offline service, over the store's `workOffline`, whether it is offline.
 *
 * One world at a time: the `ipcMain` mock has one handler map and `handle`
 * overwrites quietly, so a second live world's routers would answer the first
 * world's `invoke`. `buildWorld` throws while a world is live, and `dispose()`
 * clears the mock (`__reset()`).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcRenderer } from 'electron'
import { vi } from 'vitest'
import { __enableIpcLoop, __reset } from '../setup/electron-mock'
import { makeHarness } from './app-harness'
import type { InMemoryStorage } from './in-memory-storage'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { DownloadManager, sanitizeFilename } from '../../src/main/download-manager'
import { parseEpisodeFromFilename } from '../../src/main/lib/filename'
import { createEpisodeFileScanner } from '../../src/main/lib/episode-file-scan'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { createAnimeCacheService } from '../../src/main/services/anime-cache'
import { createCacheScope } from '../../src/main/services/anime-cache/scope'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { createOfflineService } from '../../src/main/services/offline'
import { createAttachedIntegrityStep } from '../../src/main/services/prepare-offline/steps/attached-integrity'
import { createBinariesStep } from '../../src/main/services/prepare-offline/steps/binaries'
import { createLibrarySyncStep } from '../../src/main/services/prepare-offline/steps/library-sync'
import { createShikimoriRatesStep } from '../../src/main/services/prepare-offline/steps/shikimori-rates'
import { createLocalIntegrityStep } from '../../src/main/services/prepare-offline/steps/local-integrity'
import { createMetadataStep } from '../../src/main/services/prepare-offline/steps/metadata'
import { localIntegrityDeps, metadataDeps } from '../../src/main/services/prepare-offline/wiring'
import {
  createPrepareOfflineService,
  type PrepareStepContext,
  type PrepareStepResult
} from '../../src/main/services/prepare-offline'
import { createSharedLibraryExportService } from '../../src/main/services/shared-library-export'
import { createSharedLibraryImportService } from '../../src/main/services/shared-library-import'
import { register as registerPlayer } from '../../src/main/ipc/player.ipc'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import { register as registerDownloads } from '../../src/main/ipc/downloads.ipc'
import { register as registerDownloadedAnime } from '../../src/main/ipc/downloaded-anime.ipc'
import { register as registerSharedLibrary } from '../../src/main/ipc/shared-library.ipc'
import type { AppDeps } from '../../src/main/ipc'
import type { AnimeDetail } from '../../src/main/smotret-api'
import { VIDEO_EXTS } from '../../src/shared/episode-files'
import { FIXTURE_LIBRARY, FIXTURE_LIBRARY_ID } from './attached-library'
import { fakePresence } from './shared-library-export'
import { keys, setMetaTitle } from './shared-library-import'

const DAY = 24 * 60 * 60 * 1000

export interface Names {
  romaji?: string
  ru?: string
  title: string
}

export interface EntrySpec {
  ep: string
  trId: number
  /** `animeId:ep:trId` (default) or the legacy `animeId:ep`. */
  key?: 'three' | 'two'
  where?: 'hot' | 'cold'
  /** The folder and file name; default the title's download-time first name. */
  under?: string
  file?: 'healthy' | 'empty' | 'truncated' | 'none'
  /** The entry's author tag (default `Author`). */
  author?: string
  /** The file is tagged with this author instead of the entry's: another translation's file. */
  fileAuthor?: string
  /** The file carries no author tag (a pre-tag download). */
  untagged?: boolean
  ext?: 'mp4' | 'mkv'
}

export interface TitleSpec {
  id: number
  /** `downloadedAnime[id]`, the name the files were downloaded under. */
  downloaded?: Names
  /** `library[id]` (starred). */
  library?: Names
  /** `animeCache[id]`: the details offline `GET_ANIME` answers with; `null` is `animeDetail: null`. */
  cache?: Names | null
  /** `recentAnimeMeta[id]`. */
  recent?: Names
  /** `autoDownloadSubscriptions[id]` with this `animeName`: the folder its auto-downloads land in. */
  subscribed?: string
  watchedDaysAgo?: number
  /** What the stub smotret server answers for step 3 (default the download-time names). */
  remote?: Names
  /** Video items in the download queue that have no file yet (cancel-by-episode). */
  queued?: { ep: string; trId: number }[]
  entries: EntrySpec[]
}

/** A `.part` under `<root>/<under>/`, owned by a queue item in `status`, or by none. */
export interface PartSpec {
  under: string
  ep: string
  author?: string
  where?: 'hot' | 'cold'
  status: 'downloading' | 'queued' | 'cancelled' | null
}

/** A copy of the checked-in fixture library (`FIXTURE_LIBRARY`), attached in `ready()`. */
export interface LibrarySpec {
  /** The drive's snapshot names these titles so (`setMetaTitle`), before it is attached. */
  names?: Record<number, string>
  /** Items (`animeId:ep:trId`) deleted from the drive, or cut to the wrong size, once attached. */
  damaged?: Record<string, 'missing' | 'wrong-size'>
  /** The drive is unplugged once attached, and the poller noticed (`markUnavailable`). */
  away?: boolean
}

export interface WorldSpec {
  mode?: 'simple' | 'advanced'
  /** The configured cold root is not on disk (an unplugged drive). */
  coldAway?: boolean
  /** ffmpeg and ffprobe installed (default true). */
  ffmpeg?: boolean
  /** The `playerMode` setting (default `system`). */
  playerMode?: 'system' | 'builtin'
  /** Work offline during the run (default true): the store's `workOffline`, so `offline-manual`. */
  offline?: boolean
  /** Logged in to Shikimori, with this many edits in the offline queue; logged out without it. */
  shikimori?: { queued: number }
  titles: TitleSpec[]
  parts?: PartSpec[]
  library?: LibrarySpec
}

export type Router =
  | 'player'
  | 'anime'
  | 'downloads'
  | 'downloaded-anime'
  | 'shared-library'
  | 'export'

/** What a user does before Prepare runs. */
export type Action =
  /** Step 3 in an online run before the trip (the stub smotret server answers). */
  | { do: 'metadata' }
  /** Library → Delete; `locked` keeps the folders on disk, as a file held open on Windows does. */
  | { do: 'delete'; id: number; locked?: boolean }
  /** Cancel a queued episode from the Downloads view (the title's `queued` items). */
  | { do: 'cancel-by-episode'; id: number; ep: string }
  /** The file whose name contains `match` is unlinked right before step 4 stats it. */
  | { do: 'unlink-before-stat'; match: string }
  /** Copy to this PC of these drive items (`animeId:ep:trId`) into the hot root. */
  | { do: 'copy-to-pc'; keys: string[] }

export const ACTION_ROUTERS: Record<Action['do'], Router[]> = {
  metadata: [],
  delete: ['downloaded-anime'],
  'cancel-by-episode': ['downloads'],
  'unlink-before-stat': [],
  'copy-to-pc': ['shared-library']
}

export type StepRun = PrepareStepResult | { failed: string }

/** What the step made of one entry, from a run over that entry alone. */
export type Outcome = { kind: 'ok' } | { kind: 'skipped' } | { kind: 'line'; text: string }

/** What step 5 made of one item of an available library, from a run over that item alone. */
export interface ItemOutcome {
  /** `animeId:ep:trId`. */
  key: string
  /** The item's file on the drive. */
  file: string
  outcome: Outcome
}

/** One step of a `runPrepare()`, its detail texts normalised. */
export interface PreparedStep {
  id: PrepareOfflineStepId
  status: PrepareOfflineStepState['status']
  reason?: string
  details: string[]
}

export interface Snapshot {
  store: Record<string, unknown>
  files: Record<string, { mtimeMs: number; size: number }>
}

export interface World {
  readonly spec: WorldSpec
  readonly store: InMemoryStorage
  readonly root: string
  readonly hot: string
  readonly cold: string
  /** The attached library's root (a copy of the fixture library), or null without a `library`. */
  readonly drive: string | null
  /**
   * Each entry key and the video file the world wrote for it (absent for
   * `file: 'none'`), and each Copy to this PC's entry and the file it landed.
   */
  readonly files: ReadonlyMap<string, string>
  /** Titles a Library → Delete removed in this world. */
  readonly deleted: Set<number>
  /** Attaches the spec's library and applies its damage; a no-op without one. Call it first. */
  ready(): Promise<void>
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  act(action: Action): Promise<void>
  runStep(id: 'local-integrity' | 'metadata' | 'attached-integrity'): Promise<StepRun>
  /** All six steps through the real runner, in `index.ts`'s order (a copy of it). */
  runPrepare(): Promise<PreparedStep[]>
  /** Step 4 over each entry alone, so a count in the summary is tied to its entry. */
  entryOutcomes(): Promise<Map<string, Outcome>>
  /** Step 5 over each item of each available library alone. */
  itemOutcomes(): Promise<ItemOutcome[]>
  /** The attached libraries, as step 5 lists them. */
  libraries(): AttachedLibraryInfo[]
  /** The route the detail page takes offline: `GET_ANIME`, then `find-local-file` under `getAnimeName`. */
  playOffline(
    animeId: number,
    ep: string,
    trId: number
  ): Promise<{ opened: false; why: string } | { opened: true; name: string; file: string | null }>
  /** Whether the title's page opens offline (`GET_ANIME` answers). */
  opensOffline(animeId: number): Promise<true | string>
  /** Ids with a row in the export tree. */
  exportPlan(): Promise<number[]>
  /** A restart's `downloadedEpisodes` reconcile. */
  restart(): void
  snapshot(): Snapshot
  /** A temp path made readable: `<hot>`, `<cold>`, `<root>`. */
  norm(text: string): string
  dispose(): void
}

export const first = (n: Names): string => n.romaji || n.ru || n.title
export const named = (name: string): Names => ({ romaji: name, title: name })
export const entryKey = (animeId: number, e: EntrySpec): string =>
  e.key === 'two' ? `${animeId}:${e.ep}` : `${animeId}:${e.ep}:${e.trId}`

const record = (id: number, n: Names): AnimeSearchResult =>
  ({
    id,
    title: n.title,
    titles: {
      ...(n.romaji !== undefined ? { romaji: n.romaji } : {}),
      ...(n.ru ? { ru: n.ru } : {})
    },
    posterUrlSmall: ''
  }) as AnimeSearchResult

const details = (id: number, n: Names, eps: string[]): AnimeDetail =>
  ({
    ...record(id, n),
    posterUrl: '',
    descriptions: [],
    genres: [],
    episodes: eps.map((e, i) => ({
      id: id * 100 + i,
      episodeInt: e,
      episodeFull: `${e} серия`,
      episodeType: 'tv',
      isActive: 1
    }))
  }) as unknown as AnimeDetail

const CONTENT = { healthy: 'video-bytes', empty: '', truncated: 'truncated' } as const

let live = false
/** The temp root of a build that threw before it returned a world. */
let unfinished: string | null = null

/** Test-only: runs right after a build registers its routers, so a test can make it throw there. */
export const buildHooks: { afterRegister: (() => void) | null } = { afterRegister: null }

export function buildWorld(spec: WorldSpec, routers: Iterable<Router> = []): World {
  if (live) throw new Error('buildWorld: another world is still live; dispose() it first')
  // A build that threw partway left no live world, but may have left its
  // folders and some handlers.
  if (unfinished) fs.rmSync(unfinished, { recursive: true, force: true })
  __reset()
  const need = new Set(routers)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offline-world-')))
  unfinished = root
  const hot = path.join(root, 'hot')
  const cold = path.join(root, 'cold')
  const userData = path.join(root, 'userData')
  fs.mkdirSync(hot)
  fs.mkdirSync(userData)
  const advanced = spec.mode === 'advanced'
  if (advanced && !spec.coldAway) fs.mkdirSync(cold)
  const drive = spec.library ? path.join(root, 'drive', 'Fixture library') : null
  if (drive) {
    fs.cpSync(FIXTURE_LIBRARY, drive, { recursive: true })
    for (const [id, name] of Object.entries(spec.library!.names ?? {})) {
      setMetaTitle(drive, Number(id), name)
    }
  }

  const downloadedEpisodes: Record<string, unknown> = {}
  const downloadedAnime: Record<string, unknown> = {}
  const library: Record<string, unknown> = {}
  const animeCache: Record<string, unknown> = {}
  const recentAnimeMeta: Record<string, unknown> = {}
  const autoDownloadSubscriptions: Record<string, AutoDownloadSubscription> = {}
  const watchProgress: Record<string, unknown> = {}
  const files = new Map<string, string>()

  const writeFile = (
    where: 'hot' | 'cold' | undefined,
    under: string,
    name: string,
    body: string
  ): string => {
    const base = where === 'cold' ? cold : hot
    const dir = path.join(base, sanitizeFilename(under))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }
  const fileName = (under: string, ep: string, tag: string | null, ext: string): string => {
    const base = sanitizeFilename(`${under} - ${ep.padStart(2, '0')}`)
    return `${tag === null ? base : `${base} [${sanitizeFilename(tag)}]`}.${ext}`
  }

  for (const t of spec.titles) {
    if (t.downloaded) downloadedAnime[t.id] = record(t.id, t.downloaded)
    if (t.library) library[t.id] = record(t.id, t.library)
    if (t.recent) recentAnimeMeta[t.id] = record(t.id, t.recent)
    if (t.subscribed !== undefined) {
      autoDownloadSubscriptions[t.id] = {
        animeId: t.id,
        malId: t.id * 10,
        animeName: t.subscribed,
        subscribedAt: 0,
        lastEnqueuedEpisodeInt: 0,
        lastCheckedAt: 0,
        initialEpisodesAired: 0
      }
    }
    if (t.cache !== undefined) {
      animeCache[t.id] = {
        animeDetail:
          t.cache === null
            ? null
            : details(
                t.id,
                t.cache,
                t.entries.map((e) => e.ep)
              ),
        episodes: {},
        qualityProbes: {},
        cachedAt: Date.now(),
        posterCached: false
      }
    }
    if (t.watchedDaysAgo !== undefined) {
      watchProgress[`${t.id}:${t.entries[0]?.ep ?? '1'}`] = {
        position: 600,
        duration: 1440,
        updatedAt: Date.now() - t.watchedDaysAgo * DAY
      }
    }
    const nameSource = t.downloaded ?? t.recent ?? t.library ?? t.cache
    for (const e of t.entries) {
      const author = e.author ?? 'Author'
      const key = entryKey(t.id, e)
      downloadedEpisodes[key] = {
        translationType: 'subRu',
        author,
        quality: 720,
        translationId: e.trId
      }
      const kind = e.file ?? 'healthy'
      // A file on an unplugged cold drive isn't on this PC's disk.
      if (kind === 'none' || (e.where === 'cold' && spec.coldAway)) continue
      const under = e.under ?? (nameSource ? first(nameSource) : `#${t.id}`)
      const tag = e.untagged ? null : (e.fileAuthor ?? author)
      const file = writeFile(
        e.where,
        under,
        fileName(under, e.ep, tag, e.ext ?? 'mp4'),
        CONTENT[kind]
      )
      // Another translation's file is on disk, but it isn't this entry's.
      if (e.fileAuthor === undefined || e.fileAuthor === author) files.set(key, file)
    }
  }

  // The queue the download-manager stub answers from. `getActiveDownloadByPath`
  // is the real method run over this queue, so a `.part` is owned exactly when
  // a non-cancelled item's `path.resolve(downloadDir, filename)` is its path.
  type QueueItem = {
    kind: 'video'
    animeId: number
    animeName: string
    episodeInt: string
    episodeLabel: string
    translationId: number
    author: string
    filename: string
    status: 'downloading' | 'queued' | 'cancelled'
    bytesReceived: number
    totalBytes: number
  }
  const queue: QueueItem[] = []
  for (const p of spec.parts ?? []) {
    const name = fileName(p.under, p.ep, p.author ?? 'Author', 'mp4')
    writeFile(p.where, p.under, `${name}.part`, 'partial')
    if (p.status === null) continue
    queue.push({
      kind: 'video',
      animeId: 0,
      animeName: p.under,
      episodeInt: p.ep,
      episodeLabel: `${p.ep} серия`,
      translationId: 0,
      author: p.author ?? 'Author',
      filename: path.join(sanitizeFilename(p.under), name),
      status: p.status,
      bytesReceived: 7,
      totalBytes: 100
    })
  }
  for (const t of spec.titles) {
    const nameSource = t.downloaded ?? t.recent ?? t.library ?? t.cache
    const animeName = nameSource ? first(nameSource) : `#${t.id}`
    for (const q of t.queued ?? []) {
      queue.push({
        kind: 'video',
        animeId: t.id,
        animeName,
        episodeInt: q.ep,
        episodeLabel: `${q.ep} серия`,
        translationId: q.trId,
        author: 'Author',
        filename: path.join(
          sanitizeFilename(animeName),
          fileName(animeName, q.ep, 'Author', 'mp4')
        ),
        status: 'queued',
        bytesReceived: 0,
        totalBytes: 0
      })
    }
  }

  const { store } = makeHarness({
    storageMode: advanced ? 'advanced' : 'simple',
    downloadDir: hot,
    hotStorageDir: advanced ? hot : '',
    coldStorageDir: advanced ? cold : '',
    downloadedEpisodes,
    downloadedAnime,
    library,
    animeCache,
    recentAnimeMeta,
    autoDownloadSubscriptions,
    watchProgress,
    priorityAnimeIds: [],
    autoCleanupSnoozedAnimeIds: {},
    workOffline: spec.offline !== false,
    shikimoriUser: spec.shikimori ? { id: 7, nickname: 'Viewer' } : null,
    shikimoriUserRates: [],
    shikimoriUpdateQueue: Array.from({ length: spec.shikimori?.queued ?? 0 }, (_, i) => ({
      malId: 9000 + i,
      rateId: 9900 + i,
      before: { episodes: 1, status: 'watching', score: 6, rewatches: 0 },
      after: { episodes: 2, status: 'watching', score: 6, rewatches: 0 },
      queuedAt: 1000 + i
    })),
    attachedLibraries: {},
    playerMode: spec.playerMode ?? 'system',
    prepareOfflineLastRun: null
  })

  const coldStorageService = createColdStorageService({
    store,
    downloadsFallbackDir: hot,
    sanitizeFilename,
    parseEpisodeFromFilename,
    scanEpisodeFiles: () => ({}) as never,
    invalidateFileCache: () => {},
    broadcast: () => {},
    usageProgressChannel: 'usage',
    cleanupPendingChannel: 'pending',
    cleanupFinishedChannel: 'finished',
    fileEpisodesChangedChannel: 'changed'
  })
  const attachedLibraryService = createAttachedLibraryService({
    store,
    checkFfmpeg: async () => ({ available: spec.ffmpeg !== false }),
    log: { log: () => {}, warn: () => {}, error: () => {} }
  })
  const scope = createCacheScope(store)
  const animeCacheService = createAnimeCacheService({
    store,
    userDataDir: userData,
    fetchPoster: async () => Buffer.from('jpeg'),
    isCachable: scope.isCachable
  })
  const remoteOf = new Map(
    spec.titles.map((t) => [t.id, t.remote ?? t.downloaded ?? t.recent ?? t.library ?? t.cache])
  )
  const smotretApi = {
    getAnime: async (id: number) => {
      const n = remoteOf.get(id)
      if (!n) throw new Error(`stub smotret: no title ${id}`)
      const t = spec.titles.find((x) => x.id === id)!
      const data = details(
        id,
        n,
        t.entries.map((e) => e.ep)
      )
      // `fetchPoster` is a stub, so this URL is never fetched.
      return { data: { ...data, posterUrl: `https://poster.invalid/${id}.jpg` } }
    },
    getEpisodesBatch: async () => ({ data: [] })
  }

  // ffprobe: a real file at the path `getFfprobePath` returns, so the shipped
  // `existsSync` guard in `localIntegrityDeps` passes; the probe itself is a
  // stub that reads what the world wrote. Step 1 checks the same folder.
  const bin = path.join(root, 'bin')
  const ffmpegBin = path.join(bin, 'ffmpeg')
  const ffprobe = path.join(bin, 'ffprobe')
  const fpcalc = path.join(bin, 'fpcalc')
  fs.mkdirSync(bin)
  fs.writeFileSync(fpcalc, '')
  if (spec.ffmpeg !== false) {
    fs.writeFileSync(ffmpegBin, '')
    fs.writeFileSync(ffprobe, '')
  }
  const offlineService = createOfflineService({
    store,
    probeUrls: () => [],
    onOnline: () => {},
    onOffline: () => {},
    probe: async () => false
  })
  const isOffline = (): boolean => offlineService.isOffline()
  const probeDuration = async (
    _ffprobe: string,
    file: string
  ): Promise<{ duration: number } | { error: string }> =>
    fs.readFileSync(file, 'utf8') === CONTENT.truncated
      ? { error: 'moov atom not found' }
      : { duration: 1420 }

  // As in `index.ts`: the step deps are built before the download manager is,
  // so they must read it through the getter, at run time.
  // eslint-disable-next-line prefer-const -- assigned below, after the deps
  let downloadManager: DownloadManagerStub | undefined
  const integrityDeps = {
    ...localIntegrityDeps({
      store,
      coldStorageService,
      getDownloadManager: () => downloadManager,
      getFfprobePath: () => (spec.ffmpeg === false ? '' : ffprobe),
      probeDuration,
      sanitizeFilename,
      getDisplayName: (a) => a.titles?.romaji || a.titles?.ru || a.title
    }),
    // Detail lines in entry order; production runs 2 at a time.
    concurrency: 1
  }
  const steps = {
    // Steps 1 and 2: hand-written deps, as `prepare-offline.test.ts` builds them.
    // `ensureFfmpeg` answers as the real one does without a download: the
    // path when both files are there, '' offline; this world has no network.
    binaries: createBinariesStep({
      ensureFfmpeg: async () => {
        if (fs.existsSync(ffmpegBin) && fs.existsSync(ffprobe)) return ffmpegBin
        if (isOffline()) return ''
        throw new Error('this world has no network to download ffmpeg')
      },
      ensureFpcalc: async () => fpcalc,
      paths: () => ({ ffmpeg: ffmpegBin, ffprobe, fpcalc }),
      exists: (p) => fs.existsSync(p),
      verify: async () => ({ ok: true, version: 'stub' }),
      remove: (p) => fs.promises.rm(p, { force: true }),
      clearFfmpegPaths: () => {},
      refreshFfmpegStatus: async () => {},
      ffmpegUser: () => null,
      isPlayerOpen: () => false,
      isSkipAnalysisRunning: () => false
    }),
    // A stand-in for the sync service: the drain sends the whole queue, and
    // the refresh writes the server's (empty) list.
    'shikimori-rates': createShikimoriRatesStep({
      isLoggedIn: () => store.get('shikimoriUser') !== null,
      drain: async () => store.set('shikimoriUpdateQueue', []),
      refreshRates: async () => {
        store.set('shikimoriUserRates', [])
        return { entries: [], waitingMalIds: [] }
      },
      prefetchShikimoriDetails: async () => {},
      abortPrefetch: () => {}
    }),
    'local-integrity': createLocalIntegrityStep(integrityDeps),
    metadata: createMetadataStep({
      ...metadataDeps({ store, isCachable: scope.isCachable, smotretApi, animeCacheService }),
      concurrency: 1
    }),
    // Steps 5 and 6: hand-written deps, as `index.ts`'s inline ones. Step 5
    // gets the service itself, as there; no row runs a sync yet.
    'attached-integrity': createAttachedIntegrityStep(attachedLibraryService),
    'library-sync': createLibrarySyncStep({
      list: () => attachedLibraryService.list(),
      runAll: async () => {
        throw new Error('this world has no sync runner')
      }
    })
  }

  type DownloadManagerStub = ReturnType<typeof makeDownloadManager>
  function makeDownloadManager() {
    const active = (i: QueueItem): boolean => i.status !== 'cancelled'
    const matches = (i: QueueItem, animeName: string, label?: string): boolean =>
      active(i) && i.animeName === animeName && (label === undefined || i.episodeLabel === label)
    return {
      getActiveDownloadByPath: (p: string) =>
        DownloadManager.prototype.getActiveDownloadByPath.call(
          { queue, downloadDir: hot } as unknown as DownloadManager,
          p
        ),
      getMergeStatus: () => null,
      getPartialVideoPath: () => null,
      findCancellableItems: (animeName: string, label?: string) =>
        queue.filter((i) => matches(i, animeName, label)),
      cancelByEpisode: (animeName: string, label?: string) => {
        for (const i of queue) if (matches(i, animeName, label)) i.status = 'cancelled'
      },
      getEpisodeGroups: () =>
        queue.filter(active).map((i) => ({
          animeId: i.animeId,
          animeName: i.animeName,
          episodeInt: i.episodeInt,
          translationId: i.translationId
        }))
    }
  }
  downloadManager = makeDownloadManager()

  const exportService = need.has('export')
    ? createSharedLibraryExportService({
        userDataDir: userData,
        store,
        scanEpisodeFiles: createEpisodeFileScanner({
          getDirsToScan: () => coldStorageService.dirsForScan(),
          sanitizeFilename,
          onEpisodesChanged: () => {}
        }).scanEpisodeFilesAsync,
        sanitizeFilename,
        mergeStatus: () => null,
        presence: { isOpen: () => false, onRelease: () => () => {} },
        actor: () => ({
          installId: 'pc-a',
          appVersion: '0.0.0',
          shikimoriUserId: null,
          claim: null
        }),
        broadcast: () => {},
        candidates: async () => [],
        fsTypeProbe: async () => ({ fsType: 'unknown', mountPoint: null }),
        throttleMs: 0,
        checkpointEvery: 2
      })
    : null
  // Copy to this PC, with `index.ts`'s library and roots rules.
  const importService = need.has('shared-library')
    ? createSharedLibraryImportService({
        userDataDir: userData,
        store,
        library: (libraryId) => attachedLibraryService.get(libraryId),
        localRoots: () => ({
          hot: coldStorageService.getDownloadDir(),
          cold: coldStorageService.isAdvanced()
            ? coldStorageService.getColdStorageDir() || null
            : null
        }),
        sanitizeFilename,
        mergeStatus: () => downloadManager!.getMergeStatus(),
        presence: fakePresence(),
        broadcast: () => {},
        candidates: async () => [],
        throttleMs: 0
      })
    : null

  const deps = {
    store,
    smotretApi,
    animeCacheService,
    coldStorageService,
    downloadManager,
    rememberAnimeMeta: () => {},
    // The routers answer as on the trip: offline, whatever the run was.
    offlineService: { isOffline: () => true },
    recentWatch: scope.recentWatch,
    mp4StatsService: { recordCheck: async () => {} },
    playerLockService: { open: () => {}, close: () => {} },
    playerPresenceService: { open: () => {}, close: () => {} },
    getFfmpegPath: () => '',
    getFfprobePath: () => '',
    attachedLibraryService,
    sharedLibraryExport: exportService,
    sharedLibraryImport: importService,
    skipAnalysisService: { pruneCacheForAnime: () => {}, dropDetectionsForAnime: () => {} },
    invalidateFileCache: () => {}
  } as unknown as AppDeps
  if (need.has('player')) registerPlayer(deps)
  if (need.has('anime')) registerAnime(deps)
  if (need.has('downloads')) registerDownloads(deps)
  if (need.has('downloaded-anime')) registerDownloadedAnime(deps)
  if (need.has('shared-library')) registerSharedLibrary(deps)
  buildHooks.afterRegister?.()
  __enableIpcLoop()

  const ctx = (): PrepareStepContext => ({
    signal: new AbortController().signal,
    isOffline,
    progress: () => {}
  })
  const run = async (step: {
    run(c: PrepareStepContext): Promise<PrepareStepResult>
  }): Promise<StepRun> => {
    try {
      return await step.run(ctx())
    } catch (err) {
      return { failed: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    }
  }
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args)
  const deleted = new Set<number>()
  const chmodded: string[] = []
  let readied = !spec.library
  const needReady = (what: string): void => {
    if (!readied) throw new Error(`${what}: this world attaches a library; await ready() first`)
  }

  const walk = (dir: string, out: Snapshot['files']): void => {
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of names) {
      const p = path.join(dir, d.name)
      if (d.isDirectory()) walk(p, out)
      else {
        const st = fs.statSync(p)
        out[path.relative(root, p)] = { mtimeMs: st.mtimeMs, size: st.size }
      }
    }
  }
  const videoFiles = (): string[] => {
    const out: Snapshot['files'] = {}
    walk(hot, out)
    walk(cold, out)
    return Object.keys(out)
      .filter((rel) => (VIDEO_EXTS as readonly string[]).includes(path.extname(rel).toLowerCase()))
      .map((rel) => path.join(root, rel))
  }

  const world: World = {
    spec,
    store,
    root,
    hot,
    cold,
    drive,
    files,
    deleted,
    async ready() {
      if (readied) return
      const lib = spec.library!
      const [candidate] = await attachedLibraryService.discover(drive!)
      const attached = await attachedLibraryService.attach(candidate?.libraryId ?? '')
      if (!attached.ok)
        throw new Error(`ready: the fixture library didn't attach: ${attached.error}`)
      for (const [key, how] of Object.entries(lib.damaged ?? {})) {
        const item = attachedLibraryService
          .items(FIXTURE_LIBRARY_ID)
          .find((i) => `${i.animeId}:${i.episodeInt}:${i.translationId}` === key)
        if (!item) throw new Error(`ready: the fixture library has no item ${key}`)
        const file = path.join(drive!, item.path)
        if (how === 'missing') fs.unlinkSync(file)
        else fs.truncateSync(file, 10)
      }
      if (lib.away) {
        const at = attachedLibraryService.get(FIXTURE_LIBRARY_ID)!.root
        fs.rmSync(drive!, { recursive: true, force: true })
        attachedLibraryService.markUnavailable(FIXTURE_LIBRARY_ID, at)
      }
      readied = true
    },
    invoke,
    async act(action) {
      needReady('act')
      const title = (id: number): TitleSpec => {
        const t = spec.titles.find((x) => x.id === id)
        if (!t) throw new Error(`act: no title ${id} in this world`)
        return t
      }
      const nameOf = (t: TitleSpec): string => {
        const n = t.downloaded ?? t.cache ?? t.recent ?? t.library
        return n ? first(n) : `#${t.id}`
      }
      switch (action.do) {
        case 'metadata': {
          const r = await run(steps.metadata)
          if ('failed' in r) throw new Error(`act: step 3 failed: ${r.failed}`)
          return
        }
        case 'delete': {
          const name = nameOf(title(action.id))
          const folders = [hot, cold]
            .map((r) => path.join(r, sanitizeFilename(name)))
            .filter((d) => fs.existsSync(d))
          if (action.locked) {
            for (const d of folders) {
              fs.chmodSync(d, 0o555)
              chmodded.push(d)
            }
          }
          try {
            await invoke(CHANNELS.DOWNLOADED_ANIME_DELETE, action.id, name)
          } finally {
            for (const d of chmodded.splice(0)) fs.chmodSync(d, 0o755)
          }
          deleted.add(action.id)
          return
        }
        case 'cancel-by-episode':
          await invoke(
            CHANNELS.DOWNLOAD_CANCEL_BY_EPISODE,
            nameOf(title(action.id)),
            `${action.ep} серия`
          )
          return
        case 'unlink-before-stat': {
          const real = fs.promises.stat
          vi.spyOn(fs.promises, 'stat').mockImplementation(((p: fs.PathLike, o?: unknown) => {
            if (String(p).includes(action.match) && fs.existsSync(p)) fs.unlinkSync(p)
            return (real as (p: fs.PathLike, o?: unknown) => Promise<fs.Stats>)(p, o)
          }) as never)
          return
        }
        case 'copy-to-pc': {
          if (!importService) throw new Error('act: this world has no shared-library router')
          const eps = (): Record<string, { author: string }> =>
            store.get('downloadedEpisodes') as Record<string, { author: string }>
          const hadKeys = new Set(Object.keys(eps()))
          const hadFiles = new Set(videoFiles())
          const r = (await invoke(CHANNELS.IMPORT_START, {
            libraryId: FIXTURE_LIBRARY_ID,
            selection: keys(...action.keys),
            destination: 'hot'
          })) as ImportStartResult
          if (!r.ok) throw new Error(`act: Copy to this PC refused: ${r.reason}`)
          await importService.settled(r.job.jobId)
          const jobs = (await invoke(CHANNELS.IMPORT_LIST_JOBS)) as ImportJobView[]
          const job = jobs.find((j) => j.jobId === r.job.jobId)
          if (job?.status !== 'completed') {
            throw new Error(`act: Copy to this PC ended ${job?.status}: ${JSON.stringify(job)}`)
          }
          // Each new entry and the one new video file tagged with its episode and author.
          const landed = videoFiles().filter((f) => !hadFiles.has(f))
          for (const [key, meta] of Object.entries(eps())) {
            if (hadKeys.has(key)) continue
            const tag = ` - ${key.split(':')[1].padStart(2, '0')} [${sanitizeFilename(meta.author)}].`
            const hit = landed.filter((f) => path.basename(f).includes(tag))
            if (hit.length !== 1) throw new Error(`act: ${key} landed as ${hit.length} files`)
            files.set(key, hit[0])
          }
          return
        }
      }
    },
    async runStep(id) {
      needReady('runStep')
      return run(steps[id])
    },
    async runPrepare() {
      needReady('runPrepare')
      const svc = createPrepareOfflineService({
        store,
        isOffline,
        broadcast: () => {},
        progressChannel: 'prepare-offline:progress'
      })
      for (const id of [
        'binaries',
        'shikimori-rates',
        'metadata',
        'local-integrity',
        'attached-integrity',
        'library-sync'
      ] as const) {
        svc.registerStep(steps[id])
      }
      svc.start()
      await svc.idle()
      return svc.getState().run!.steps.map((s) => ({
        id: s.id,
        status: s.status,
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
        details: s.details.map((d) => world.norm(d.text))
      }))
    },
    async itemOutcomes() {
      needReady('itemOutcomes')
      const out: ItemOutcome[] = []
      for (const lib of attachedLibraryService.list()) {
        if (!lib.available) continue
        for (const item of attachedLibraryService.items(lib.libraryId)) {
          const one = createAttachedIntegrityStep({
            list: () => [lib],
            items: () => [item],
            checkItem: (id, i) => attachedLibraryService.checkItem(id, i)
          })
          const r = await run(one)
          let outcome: Outcome
          if ('failed' in r) outcome = { kind: 'line', text: `failed: ${r.failed}` }
          else if (r.details.length === 1 && r.details[0].text === `${lib.name}: 1 items ok`) {
            outcome = { kind: 'ok' }
          } else {
            const line = r.details.find((d) => d.animeId !== undefined)
            outcome = line ? { kind: 'line', text: line.text } : { kind: 'skipped' }
          }
          out.push({
            key: `${item.animeId}:${item.episodeInt}:${item.translationId}`,
            file: path.join(lib.root, item.path),
            outcome
          })
        }
      }
      return out
    },
    libraries: () => attachedLibraryService.list(),
    async entryOutcomes() {
      needReady('entryOutcomes')
      const out = new Map<string, Outcome>()
      const all = integrityDeps.downloadedEpisodes()
      for (const [key, meta] of Object.entries(all)) {
        const one = createLocalIntegrityStep({
          ...integrityDeps,
          downloadedEpisodes: () => ({ [key]: meta })
        })
        const r = await run(one)
        if ('failed' in r) out.set(key, { kind: 'line', text: `failed: ${r.failed}` })
        else if (r.details[0].text === '1 of 1 episode ok') out.set(key, { kind: 'ok' })
        else if (r.details[0].text === '0 of 0 episodes ok') out.set(key, { kind: 'skipped' })
        else {
          const line = r.details.find((d) => d.animeId !== undefined)
          out.set(key, { kind: 'line', text: line ? line.text : r.details[0].text })
        }
      }
      return out
    },
    async playOffline(animeId, ep, trId) {
      let anime: AnimeDetail
      try {
        anime = ((await invoke(CHANNELS.GET_ANIME, animeId)) as { data: AnimeDetail }).data
      } catch (err) {
        return { opened: false, why: (err as Error).message }
      }
      const name = anime.titles?.romaji || anime.titles?.ru || anime.title
      const hit = (await invoke(CHANNELS.PLAYER_FIND_LOCAL_FILE, name, ep, trId, ep, animeId)) as {
        filePath: string
      } | null
      return { opened: true, name, file: hit?.filePath ?? null }
    },
    async opensOffline(animeId) {
      try {
        await invoke(CHANNELS.GET_ANIME, animeId)
        return true
      } catch (err) {
        return (err as Error).message
      }
    },
    async exportPlan() {
      if (!exportService) throw new Error('buildWorld: this world has no export service')
      const plan = await exportService.plan({ animeIds: null, target: null, name: '' })
      return plan.titles.map((t) => t.animeId)
    },
    restart() {
      const groups = downloadManager!.getEpisodeGroups()
      coldStorageService.reconcileDownloadedEpisodes(new Set(groups.map((g) => g.translationId)))
    },
    snapshot() {
      const files: Snapshot['files'] = {}
      walk(root, files)
      return { store: structuredClone(store.snapshot()), files }
    },
    norm(text) {
      return text.split(hot).join('<hot>').split(cold).join('<cold>').split(root).join('<root>')
    },
    dispose() {
      for (const d of chmodded.splice(0)) fs.chmodSync(d, 0o755)
      offlineService.dispose()
      fs.rmSync(root, { recursive: true, force: true })
      __reset()
      vi.restoreAllMocks()
      live = false
    }
  }
  // Live only once built, so a throw above doesn't fail every later test.
  unfinished = null
  live = true
  return world
}
