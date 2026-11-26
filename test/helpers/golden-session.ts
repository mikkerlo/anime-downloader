/**
 * The 6.0.21 golden session (#689, epic #688): one scripted Shikimori-only
 * session on one PC, captured as the files and results every later slice of
 * the epic must reproduce (`test/golden/shikimori-6.0.21.test.ts`).
 *
 * The PC is the real `createStorageService` over `STORE_DEFAULTS` in a temp
 * `cwd` (so `config.json` is the real file), the real Shikimori sync service,
 * IPC router, Shared Library export, attached-library service, merge runner,
 * Prepare for offline (all six production steps, plus #693's per-tracker
 * rates registration over a disconnected AniList and MyAnimeList) and
 * auto-downloader, wired as `src/main/index.ts` wires them. The network is `golden-shikimori.ts` and a
 * stub smotret; the test file installs the Shikimori mock and blocks `fetch`.
 *
 * The script: sign in as A, mark an episode watched online, subscribe to
 * auto-download, export With metadata, attach the drive, Prepare for offline,
 * one auto-download tick, Work offline and edit a rate and mark another
 * episode (both queue), the owner's other PC edits the drive, a merge run
 * (one pending raise, one conflict), then back online and sign in as B through
 * `SHIKIMORI_EXCHANGE_CODE` (A's queue parks).
 *
 * Determinism: `Date` is faked and set at each step (`STEP_TIMES`); every id
 * generator is fixed (`installId`, the library and job ids, run ids, the
 * Prepare run id). Real timers still run, so the drain's and prefetch's sleeps
 * happen; the driver waits for each step's background work before moving on.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcRenderer } from 'electron'
import { vi } from 'vitest'
import { __enableIpcLoop, __reset } from '../setup/electron-mock'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { createStorageService } from '../../src/main/store'
import { ensureInstallId } from '../../src/main/store/sync-meta'
import { sanitizeFilename } from '../../src/main/download-manager'
import { parseEpisodeFromFilename } from '../../src/main/lib/filename'
import { createEpisodeFileScanner } from '../../src/main/lib/episode-file-scan'
import { createSyncBaseStore } from '../../src/main/lib/sync-state/bases'
import { LIBRARY_DIR, MANIFEST, STATE, readLibrary } from '../../src/main/lib/shared-library/read'
import { writeState } from '../../src/main/lib/shared-library/write'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { createAnimeCacheService } from '../../src/main/services/anime-cache'
import { createCacheScope } from '../../src/main/services/anime-cache/scope'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { createOfflineService } from '../../src/main/services/offline'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { shikimoriOnlyFanOut } from './tracker-fan-out'
import { createSyncRunner } from '../../src/main/services/sync-runner'
import { createSharedLibraryExportService } from '../../src/main/services/shared-library-export'
import { createPrepareOfflineService } from '../../src/main/services/prepare-offline'
import { createBinariesStep } from '../../src/main/services/prepare-offline/steps/binaries'
import { createShikimoriRatesStep } from '../../src/main/services/prepare-offline/steps/shikimori-rates'
import { createMetadataStep } from '../../src/main/services/prepare-offline/steps/metadata'
import { createLocalIntegrityStep } from '../../src/main/services/prepare-offline/steps/local-integrity'
import { createAttachedIntegrityStep } from '../../src/main/services/prepare-offline/steps/attached-integrity'
import {
  createLibrarySyncStep,
  needReviewFrom
} from '../../src/main/services/prepare-offline/steps/library-sync'
import {
  localIntegrityDeps,
  metadataDeps,
  registerTrackerRatesSteps
} from '../../src/main/services/prepare-offline/wiring'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createGenericTracker } from './generic-tracker'
import * as autoDownloader from '../../src/main/auto-downloader'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc'
import type { AnimeDetail } from '../../src/main/smotret-api'
import { fakePresence } from './shared-library-export'
import { USER_A, USER_B, details, net, resetGolden, server } from './golden-shikimori'

/** The session's clock: each step runs at its own fixed time. */
export const STEP_TIMES = {
  boot: Date.UTC(2026, 10, 1, 9, 0, 0),
  signInA: Date.UTC(2026, 10, 1, 9, 1, 0),
  rates: Date.UTC(2026, 10, 1, 9, 2, 0),
  markOnline: Date.UTC(2026, 10, 1, 9, 3, 0),
  subscribe: Date.UTC(2026, 10, 1, 9, 4, 0),
  export: Date.UTC(2026, 10, 1, 9, 5, 0),
  attach: Date.UTC(2026, 10, 1, 9, 6, 0),
  prepare: Date.UTC(2026, 10, 1, 9, 7, 0),
  // Past the auto-downloader's 6 h details freshness, so the tick refreshes.
  tick: Date.UTC(2026, 10, 1, 16, 0, 0),
  offlineEdit: Date.UTC(2026, 10, 1, 16, 1, 0),
  offlineMark: Date.UTC(2026, 10, 1, 16, 2, 0),
  otherPc: Date.UTC(2026, 10, 1, 16, 3, 0),
  merge: Date.UTC(2026, 10, 1, 16, 4, 0),
  signInB: Date.UTC(2026, 10, 1, 16, 5, 0)
} as const

export const APP_VERSION = '6.0.21'
export const INSTALL_ID = 'golden-pc-0000-4000-8000-000000000001'
export const LIBRARY_ID = '00000000-0000-4000-8000-0000000000a1'

/** The two titles: Alpha is exported and merged, Beta is the auto-download subscription. */
export const ALPHA = { animeId: 101, malId: 9101, title: 'Alpha Show', translationId: 11 }
export const BETA = { animeId: 202, malId: 9202, title: 'Beta Show', translationId: 21 }

export interface GoldenCapture {
  /** `config.json`, parsed. */
  config: Record<string, unknown>
  /** userData files by relative path: JSON parsed, `.jsonl` as an array of parsed lines. */
  userData: Record<string, unknown>
  /** The drive's v1 pair, as the bytes on disk. */
  drive: Record<string, string>
  /** The Prepare for offline run: the step list and each step's result. */
  prepare: unknown
  /** The auto-download tick's result, the broadcasts it made and the downloads it queued. */
  tick: {
    result: unknown
    broadcasts: { channel: string; args: unknown[] }[]
    requests: unknown[]
  }
}

/** The userData files the goldens cover. */
export const USER_DATA_FILES = ['sync-pending', 'sync-state/conflicts.json', 'sync-log']

function sequence(prefix: string): () => string {
  let n = 0
  return () => `${prefix}${String(++n).padStart(12, '0')}`
}

const animeRecord = (a: { animeId: number; title: string }) =>
  ({
    id: a.animeId,
    title: a.title,
    titles: { romaji: a.title },
    posterUrlSmall: `https://poster.invalid/${a.animeId}.jpg`,
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2026,
    season: 'fall'
  }) as AnimeSearchResult

const animeDetail = (a: { animeId: number; title: string }, eps: string[]): AnimeDetail =>
  ({
    ...animeRecord(a),
    posterUrl: `https://poster.invalid/${a.animeId}.jpg`,
    descriptions: [],
    genres: [],
    episodes: eps.map((e, i) => ({
      id: a.animeId * 100 + i,
      episodeInt: e,
      episodeFull: `${e} серия`,
      episodeType: 'tv',
      isActive: 1
    }))
  }) as unknown as AnimeDetail

const watchedRow = (at: number) => ({
  position: 1400,
  duration: 1440,
  updatedAt: at,
  watched: true,
  watchedAt: at,
  sync: { position: { at, origin: INSTALL_ID }, watched: { at, origin: INSTALL_ID } }
})

async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r))
}

/**
 * Polls on real timers. Not `vi.waitFor`: under fake timers it advances the
 * faked clock by its interval on every retry, which would move timestamps by
 * however many retries a run happened to need.
 */
async function until(ready: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const started = performance.now()
  while (!ready()) {
    if (performance.now() - started > timeoutMs) throw new Error(`golden: timed out on ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Replaces the session's temp root in every string, so paths compare across runs. */
function withoutRoot<T>(value: T, root: string): T {
  // The root as it appears inside JSON text (backslashes escaped on Windows).
  const escaped = JSON.stringify(root).slice(1, -1)
  return JSON.parse(JSON.stringify(value).split(escaped).join('<root>'))
}

function readTree(dir: string, rel = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const full = path.join(dir, rel)
  if (!fs.existsSync(full)) return out
  if (fs.statSync(full).isFile()) {
    const text = fs.readFileSync(full, 'utf8')
    out[rel] = rel.endsWith('.jsonl')
      ? text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : JSON.parse(text)
    return out
  }
  for (const name of fs.readdirSync(full).sort()) {
    Object.assign(out, readTree(dir, path.posix.join(rel, name)))
  }
  return out
}

export async function runGoldenSession(): Promise<GoldenCapture> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golden-6.0.21-')))
  const userData = path.join(root, 'userData')
  const hot = path.join(root, 'hot')
  const driveParent = path.join(root, 'drive')
  const bin = path.join(root, 'bin')
  for (const d of [userData, hot, driveParent, bin]) fs.mkdirSync(d)
  const at = (step: keyof typeof STEP_TIMES): void => {
    vi.setSystemTime(STEP_TIMES[step])
  }

  resetGolden()
  __reset()
  __enableIpcLoop()
  const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const allBroadcasts: { channel: string; args: unknown[] }[] = []
  const broadcast = (channel: string, ...args: unknown[]): void => {
    allBroadcasts.push({ channel, args: structuredClone(args) })
  }

  try {
    // ---- Boot -------------------------------------------------------------
    at('boot')
    const store = createStorageService(STORE_DEFAULTS, {
      cwd: userData,
      writeThroughKeys: [
        'shikimoriUpdateQueue',
        'shikimoriParkedQueues',
        'token',
        'shikimoriCredentials'
      ]
    })
    // The store's own `ensureInstallId`, with a fixed generator.
    ensureInstallId(store, () => INSTALL_ID)

    // A PC with three downloaded episodes of Alpha and one of Beta.
    store.set('downloadDir', hot)
    const downloadedAnime: Record<string, AnimeSearchResult> = {}
    const downloadedEpisodes: Record<string, unknown> = {}
    const add = (a: typeof ALPHA, ep: string): void => {
      const folder = path.join(hot, sanitizeFilename(a.title))
      fs.mkdirSync(folder, { recursive: true })
      const base = `${sanitizeFilename(`${a.title} - ${ep.padStart(2, '0')}`)} [Studio]`
      fs.writeFileSync(path.join(folder, `${base}.mkv`), `video ${a.animeId}:${ep}`)
      downloadedEpisodes[`${a.animeId}:${ep}:${a.translationId}`] = {
        translationType: 'subRu',
        author: 'Studio',
        quality: 720,
        translationId: a.translationId
      }
      downloadedAnime[a.animeId] = animeRecord(a)
    }
    for (const ep of ['1', '2', '3']) add(ALPHA, ep)
    add(BETA, '1')
    store.set('downloadedAnime', downloadedAnime)
    store.set('downloadedEpisodes', downloadedEpisodes)
    store.set('watchProgress', {
      [`${ALPHA.animeId}:1`]: watchedRow(STEP_TIMES.boot),
      [`${ALPHA.animeId}:2`]: watchedRow(STEP_TIMES.boot)
    })

    // A's list on shikimori.one.
    server.set(ALPHA.malId, { episodes: 2, status: 'watching', score: 6 }, STEP_TIMES.boot)
    server.set(BETA.malId, { episodes: 1, status: 'watching', score: 0 }, STEP_TIMES.boot)
    details.set(ALPHA.malId, { name: ALPHA.title, episodes: 12, episodes_aired: 12 })
    details.set(BETA.malId, { name: BETA.title, episodes: 12, episodes_aired: 2 })
    net.codes = { 'code-a': USER_A, 'code-b': USER_B }

    // ---- Services, as `src/main/index.ts` wires them ------------------------
    const smotretApi = {
      getAnime: vi.fn(async (id: number) => {
        const a = [ALPHA, BETA].find((x) => x.animeId === id)
        if (!a) throw new Error(`stub smotret: no title ${id}`)
        return { data: animeDetail(a, ['1', '2', '3']) }
      }),
      getEpisode: vi.fn(async (episodeId: number) => ({
        data: {
          id: episodeId,
          episodeFull: `${(episodeId % 100) + 1} серия`,
          translations: [
            {
              id: 2100 + (episodeId % 100),
              type: 'subRu',
              isActive: 1,
              height: 720,
              authorsSummary: 'Studio'
            }
          ]
        }
      })),
      getEmbed: vi.fn(async () => ({ stream: [{ height: 720, urls: ['https://stub.invalid'] }] })),
      getEpisodesBatch: vi.fn(async () => ({ data: [] }))
    }
    const lookupByMalIds = async (malIds: number[]): Promise<Record<number, AnimeSearchResult>> =>
      Object.fromEntries(
        [ALPHA, BETA].filter((a) => malIds.includes(a.malId)).map((a) => [a.malId, animeRecord(a)])
      )
    const enqueued: unknown[] = []
    const downloadManager = {
      enqueue: vi.fn(async (requests: unknown[]) => void enqueued.push(...requests)),
      getEpisodeGroups: vi.fn(() => []),
      getActiveDownloadByPath: () => null,
      getMergeStatus: () => null
    }

    const offlineService = createOfflineService({
      store,
      probeUrls: () => [],
      onOnline: () => {},
      onOffline: () => {},
      probe: async () => true
    })
    const isOffline = (): boolean => offlineService.isOffline()

    const scanner = createEpisodeFileScanner({
      getDirsToScan: () => [hot],
      sanitizeFilename,
      onEpisodesChanged: () => {}
    })
    const coldStorageService = createColdStorageService({
      store,
      downloadsFallbackDir: hot,
      sanitizeFilename,
      parseEpisodeFromFilename,
      scanEpisodeFiles: scanner.scanEpisodeFiles,
      invalidateFileCache: scanner.invalidate,
      broadcast,
      usageProgressChannel: EVENT_CHANNELS.STORAGE_USAGE_PROGRESS,
      cleanupPendingChannel: EVENT_CHANNELS.STORAGE_CLEANUP_PENDING,
      cleanupFinishedChannel: EVENT_CHANNELS.STORAGE_CLEANUP_FINISHED,
      fileEpisodesChangedChannel: EVENT_CHANNELS.FILE_EPISODES_CHANGED
    })
    const scope = createCacheScope(store)
    const animeCacheService = createAnimeCacheService({
      store,
      userDataDir: userData,
      fetchPoster: async () => Buffer.from('jpeg'),
      isCachable: scope.isCachable
    })

    let syncRunner: ReturnType<typeof createSyncRunner> | null = null
    const attached = createAttachedLibraryService({
      store,
      checkFfmpeg: async () => ({ available: true }),
      syncIdle: (libraryId) => syncRunner?.idle(libraryId) ?? Promise.resolve(),
      syncBases: createSyncBaseStore(path.join(userData, 'sync-bases'), fs.promises),
      now: () => Date.now(),
      log: quiet
    })
    await attached.init()

    const sync = createShikimoriSyncService({
      store,
      broadcast,
      syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
      offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
      rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
      animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
      isOffline,
      lookupByMalIds,
      ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
    })
    const runner = createSyncRunner({
      store,
      userDataDir: userData,
      attached,
      sync,
      isOffline,
      broadcast,
      runFinishedChannel: EVENT_CHANNELS.SYNC_RUN_FINISHED,
      appVersion: APP_VERSION,
      makeId: sequence('golden-run-'),
      log: quiet
    })
    syncRunner = runner
    runner.start({ triggers: false })

    const exportService = createSharedLibraryExportService({
      userDataDir: userData,
      store,
      scanEpisodeFiles: scanner.scanEpisodeFilesAsync,
      sanitizeFilename,
      mergeStatus: () => null,
      presence: fakePresence(),
      actor: () => ({
        installId: store.ensureInstallId(),
        appVersion: APP_VERSION,
        shikimoriUserId: (store.get('shikimoriUser') as { id: number } | null)?.id ?? null,
        claim: null,
        trackerAccounts: []
      }),
      broadcast: (job) => broadcast(EVENT_CHANNELS.EXPORT_JOB_UPDATED, job),
      onLibraryWritten: (libraryId, libRoot) => attached.refresh(libraryId, libRoot),
      writeLibraryState: (target) => runner.runExport(target),
      isOffline,
      downloadRoots: () => [hot],
      candidates: async () => [],
      fsTypeProbe: async () => ({ fsType: 'unknown', mountPoint: null }),
      throttleMs: 0,
      newId: (() => {
        const ids = [LIBRARY_ID, '00000000-0000-4000-8000-0000000000b1']
        return () => ids.shift() ?? 'golden-unexpected-id'
      })()
    })
    await exportService.init()

    autoDownloader.initAutoDownloader({
      store,
      smotretApi: smotretApi as never,
      downloadManager: downloadManager as never,
      broadcast,
      isShikimoriLoggedIn: () => Boolean(store.get('shikimoriCredentials')),
      refreshShikimoriDetails: (malId) => sync.refreshShikimoriDetailsForMalId(malId),
      isOffline
    })

    registerShikimori({
      store,
      shikimoriSyncService: sync,
      trackers: shikimoriOnlyFanOut(store as never, sync),
      lookupByMalIds,
      maybeBroadcastCleanupPrompt: async () => {},
      // The router's `rates-refreshed` tick is left out: the session runs its one tick by hand.
      runAutoDownloadTick: async () => ({}),
      broadcast,
      offlineService
    } as unknown as AppDeps)
    const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke(channel, ...args)

    const idle = async (): Promise<void> => {
      await settle()
      await until(() => sync.getSyncStatus().state === 'idle', 'the drain')
      await settle()
    }

    // ---- 1. Sign in as A ----------------------------------------------------
    at('signInA')
    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code-a')
    await idle()

    // ---- 2. The Shikimori list, and its details prefetch ---------------------
    at('rates')
    await invoke(CHANNELS.SHIKIMORI_GET_ANIME_RATES)
    await until(
      () => Object.keys(store.get('shikimoriAnimeDetails') as object).length === 2,
      'the details prefetch'
    )
    await idle()

    // ---- 3. Mark episode 3 watched, online ----------------------------------
    at('markOnline')
    store.set('watchProgress', {
      ...(store.get('watchProgress') as object),
      [`${ALPHA.animeId}:3`]: watchedRow(STEP_TIMES.markOnline)
    })
    await invoke(CHANNELS.SHIKIMORI_MARK_EPISODE_WATCHED, ALPHA.malId, 3)
    await idle()

    // ---- 4. Subscribe Beta to auto-download ---------------------------------
    at('subscribe')
    await autoDownloader.setSubscription(BETA.animeId, true, {
      malId: BETA.malId,
      animeName: BETA.title
    })

    // ---- 5. Export Alpha With metadata --------------------------------------
    at('export')
    const started = await exportService.start({
      selection: ['1', '2', '3'].map((ep) => ({
        animeId: ALPHA.animeId,
        episodeInt: ep,
        translationId: ALPHA.translationId
      })),
      target: driveParent,
      name: 'Trip',
      mode: 'metadata'
    })
    if (!started.ok) throw new Error(`export refused: ${started.reason}`)
    await exportService.settled(started.job.jobId)
    const libRoot = path.join(driveParent, 'Trip')

    // ---- 6. Attach the drive ------------------------------------------------
    at('attach')
    await attached.discover(driveParent)
    const attachResult = await attached.attach(LIBRARY_ID)
    if (!attachResult.ok) throw new Error(`attach failed: ${attachResult.error}`)
    await idle()

    // ---- 7. Prepare for offline ---------------------------------------------
    at('prepare')
    const ffmpeg = path.join(bin, 'ffmpeg')
    const ffprobe = path.join(bin, 'ffprobe')
    const fpcalc = path.join(bin, 'fpcalc')
    for (const p of [ffmpeg, ffprobe, fpcalc]) fs.writeFileSync(p, '')
    const prepare = createPrepareOfflineService({
      store,
      isOffline,
      broadcast,
      progressChannel: EVENT_CHANNELS.PREPARE_OFFLINE_PROGRESS,
      makeId: sequence('golden-prepare-')
    })
    prepare.registerStep(
      createBinariesStep({
        ensureFfmpeg: async () => ffmpeg,
        ensureFpcalc: async () => fpcalc,
        paths: () => ({ ffmpeg, ffprobe, fpcalc }),
        exists: (p) => fs.existsSync(p),
        verify: async () => ({ ok: true, version: 'stub' }),
        remove: (p) => fs.promises.rm(p, { force: true }),
        clearFfmpegPaths: () => {},
        refreshFfmpegStatus: async () => {},
        ffmpegUser: () => null,
        isPlayerOpen: () => false,
        isSkipAnalysisRunning: () => false
      })
    )
    prepare.registerStep(
      createShikimoriRatesStep({
        isLoggedIn: () => store.get('shikimoriUser') !== null,
        drain: () => sync.drainNow(),
        refreshRates: (opts) => sync.refreshRates(opts),
        prefetchShikimoriDetails: () => sync.prefetchShikimoriDetails(),
        abortPrefetch: () => sync.abortPrefetch()
      })
    )
    // #693: `index.ts`'s registration, with an AniList and a MyAnimeList
    // instance as T6/T7 add them, both disconnected: neither run gains a row.
    const anilist = createGenericTracker('anilist', store as never)
    const mal = createGenericTracker('mal', store as never)
    registerTrackerRatesSteps(prepare, {
      store,
      trackers: () => [sync.tracker as TrackerSyncService<unknown, unknown>, anilist.sync, mal.sync]
    })
    prepare.registerStep(
      createMetadataStep({
        ...metadataDeps({
          store,
          isCachable: scope.isCachable,
          smotretApi: smotretApi as never,
          animeCacheService
        }),
        concurrency: 1
      })
    )
    prepare.registerStep(
      createLocalIntegrityStep({
        ...localIntegrityDeps({
          store,
          coldStorageService,
          getDownloadManager: () => downloadManager as never,
          getFfprobePath: () => ffprobe,
          probeDuration: async () => ({ duration: 1420 }),
          sanitizeFilename,
          getDisplayName: (a) => a.titles?.romaji || a.titles?.ru || a.title
        }),
        concurrency: 1
      })
    )
    prepare.registerStep(createAttachedIntegrityStep(attached))
    prepare.registerStep(
      createLibrarySyncStep({
        list: () => attached.list(),
        runAll: (trigger) => runner.runAll(trigger),
        needReview: () => needReviewFrom(runner)()
      })
    )
    prepare.start()
    await prepare.idle()
    const prepareRun = structuredClone(prepare.getState().run)
    await idle()

    // ---- 8. One auto-download tick ------------------------------------------
    at('tick')
    // Beta's episode 3 aired since the subscription.
    details.set(BETA.malId, { name: BETA.title, episodes: 12, episodes_aired: 3 })
    const before = allBroadcasts.length
    const tickResult = structuredClone(await autoDownloader.runAutoDownloadTick('manual'))
    const tickBroadcasts = allBroadcasts.slice(before)
    await idle()

    // ---- 9. Work offline: edit a rate and mark another episode (both queue) --
    at('offlineEdit')
    offlineService.setManual(true)
    net.offline = true
    await invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, ALPHA.malId, 3, 'watching', 7, 0)
    await idle()
    at('offlineMark')
    await invoke(CHANNELS.SHIKIMORI_MARK_EPISODE_WATCHED, BETA.malId, 2)
    await idle()

    // ---- 10. The owner's other PC watches 4–6 and scores Alpha 8 -------------
    at('otherPc')
    const read = await readLibrary(libRoot)
    if (read.status !== 'ok' || !read.state) throw new Error('the drive is unreadable')
    const doc = structuredClone(read.state.doc) as SyncDoc
    const title = doc.titles[String(ALPHA.animeId)]
    const other = { at: STEP_TIMES.otherPc, origin: 'golden-other-pc' }
    for (const ep of ['4', '5', '6']) {
      title.watch = {
        ...title.watch,
        [ep]: {
          position: { value: { position: 1400, duration: 1440 }, ...other },
          watched: { value: true, ...other },
          watchedAt: STEP_TIMES.otherPc
        }
      }
    }
    title.rate!.score = { value: 8, ...other }
    await writeState(
      libRoot,
      doc as SharedSyncDoc,
      {
        installId: 'golden-other-pc',
        appVersion: APP_VERSION,
        shikimoriUserId: USER_A.id,
        claim: null,
        trackerAccounts: []
      },
      read.manifest.stateGeneration
    )

    // ---- 11. The merge run, offline: one pending raise, one conflict ---------
    at('merge')
    await attached.refresh(LIBRARY_ID, libRoot)
    await runner.runAll('manual')
    await idle()

    // ---- 12. Back online, and sign in as B (A's queue parks) -----------------
    at('signInB')
    offlineService.setManual(false)
    net.offline = false
    await invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code-b')
    await idle()
    await runner.idle(LIBRARY_ID)
    await idle()
    sync.stopSyncTimer()

    // ---- Capture ------------------------------------------------------------
    store.flush()
    const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'))
    const userDataFiles: Record<string, unknown> = {}
    for (const rel of USER_DATA_FILES) Object.assign(userDataFiles, readTree(userData, rel))
    const lib = path.join(libRoot, LIBRARY_DIR)
    const drive = Object.fromEntries(
      [MANIFEST, STATE].map((f) => [f, fs.readFileSync(path.join(lib, f), 'utf8')])
    )
    return withoutRoot(
      {
        config,
        userData: userDataFiles,
        drive,
        prepare: prepareRun,
        tick: { result: tickResult, broadcasts: tickBroadcasts, requests: enqueued }
      },
      root
    )
  } finally {
    __reset()
    fs.rmSync(root, { recursive: true, force: true })
  }
}
