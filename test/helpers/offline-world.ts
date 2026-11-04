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
 * registered on the mocked `ipcMain`.
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
import { createLocalIntegrityStep } from '../../src/main/services/prepare-offline/steps/local-integrity'
import { createMetadataStep } from '../../src/main/services/prepare-offline/steps/metadata'
import { localIntegrityDeps, metadataDeps } from '../../src/main/services/prepare-offline/wiring'
import type { PrepareStepContext, PrepareStepResult } from '../../src/main/services/prepare-offline'
import { createSharedLibraryExportService } from '../../src/main/services/shared-library-export'
import { register as registerPlayer } from '../../src/main/ipc/player.ipc'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import { register as registerDownloads } from '../../src/main/ipc/downloads.ipc'
import { register as registerDownloadedAnime } from '../../src/main/ipc/downloaded-anime.ipc'
import type { AppDeps } from '../../src/main/ipc'
import type { AnimeDetail } from '../../src/main/smotret-api'

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

export interface WorldSpec {
  mode?: 'simple' | 'advanced'
  /** The configured cold root is not on disk (an unplugged drive). */
  coldAway?: boolean
  /** ffmpeg and ffprobe installed (default true). */
  ffmpeg?: boolean
  /** Work offline during the run (default true). */
  offline?: boolean
  titles: TitleSpec[]
  parts?: PartSpec[]
}

export type Router = 'player' | 'anime' | 'downloads' | 'downloaded-anime' | 'export'

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

export const ACTION_ROUTERS: Record<Action['do'], Router[]> = {
  metadata: [],
  delete: ['downloaded-anime'],
  'cancel-by-episode': ['downloads'],
  'unlink-before-stat': []
}

export type StepRun = PrepareStepResult | { failed: string }

/** What the step made of one entry, from a run over that entry alone. */
export type Outcome = { kind: 'ok' } | { kind: 'skipped' } | { kind: 'line'; text: string }

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
  /** Each entry key and the video file the world wrote for it (absent for `file: 'none'`). */
  readonly files: ReadonlyMap<string, string>
  /** Titles a Library → Delete removed in this world. */
  readonly deleted: Set<number>
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  act(action: Action): Promise<void>
  runStep(id: 'local-integrity' | 'metadata'): Promise<StepRun>
  /** Step 4 over each entry alone, so a count in the summary is tied to its entry. */
  entryOutcomes(): Promise<Map<string, Outcome>>
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

export function buildWorld(spec: WorldSpec, routers: Iterable<Router> = []): World {
  if (live) throw new Error('buildWorld: another world is still live; dispose() it first')
  live = true
  const need = new Set(routers)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offline-world-')))
  const hot = path.join(root, 'hot')
  const cold = path.join(root, 'cold')
  const userData = path.join(root, 'userData')
  fs.mkdirSync(hot)
  fs.mkdirSync(userData)
  const advanced = spec.mode === 'advanced'
  if (advanced && !spec.coldAway) fs.mkdirSync(cold)

  const downloadedEpisodes: Record<string, unknown> = {}
  const downloadedAnime: Record<string, unknown> = {}
  const library: Record<string, unknown> = {}
  const animeCache: Record<string, unknown> = {}
  const recentAnimeMeta: Record<string, unknown> = {}
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
    watchProgress,
    priorityAnimeIds: [],
    autoCleanupSnoozedAnimeIds: {},
    shikimoriUser: null
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
      return {
        data: details(
          id,
          n,
          t.entries.map((e) => e.ep)
        )
      }
    },
    getEpisodesBatch: async () => ({ data: [] })
  }

  // ffprobe: a real file at the path `getFfprobePath` returns, so the shipped
  // `existsSync` guard in `localIntegrityDeps` passes; the probe itself is a
  // stub that reads what the world wrote.
  const ffprobe = path.join(root, 'bin', 'ffprobe')
  if (spec.ffmpeg !== false) {
    fs.mkdirSync(path.dirname(ffprobe))
    fs.writeFileSync(ffprobe, '')
  }
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
    'local-integrity': createLocalIntegrityStep(integrityDeps),
    metadata: createMetadataStep({
      ...metadataDeps({ store, isCachable: scope.isCachable, smotretApi, animeCacheService }),
      concurrency: 1
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

  const deps = {
    store,
    smotretApi,
    animeCacheService,
    coldStorageService,
    downloadManager,
    rememberAnimeMeta: () => {},
    offlineService: { isOffline: () => true },
    recentWatch: scope.recentWatch,
    mp4StatsService: { recordCheck: async () => {} },
    playerLockService: { open: () => {}, close: () => {} },
    playerPresenceService: { open: () => {}, close: () => {} },
    getFfmpegPath: () => '',
    getFfprobePath: () => '',
    attachedLibraryService: {
      resolveItem: async () => null,
      availableSnapshots: () => [],
      classifyMissing: async () => null
    },
    skipAnalysisService: { pruneCacheForAnime: () => {}, dropDetectionsForAnime: () => {} },
    invalidateFileCache: () => {}
  } as unknown as AppDeps
  if (need.has('player')) registerPlayer(deps)
  if (need.has('anime')) registerAnime(deps)
  if (need.has('downloads')) registerDownloads(deps)
  if (need.has('downloaded-anime')) registerDownloadedAnime(deps)
  __enableIpcLoop()

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

  const ctx = (): PrepareStepContext => ({
    signal: new AbortController().signal,
    isOffline: () => spec.offline !== false,
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

  const world: World = {
    spec,
    store,
    root,
    hot,
    cold,
    files,
    deleted,
    invoke,
    async act(action) {
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
      }
    },
    runStep: (id) => run(steps[id]),
    async entryOutcomes() {
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
      fs.rmSync(root, { recursive: true, force: true })
      __reset()
      vi.restoreAllMocks()
      live = false
    }
  }
  return world
}
