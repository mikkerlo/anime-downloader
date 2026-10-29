// Copy titles from an attached Shared Library onto this PC (S7b #579): Copy to
// this PC per title and Import all per library. One job runs at a time; jobs
// persist under `userData/import-jobs/<jobId>.json`, keyed by the library's
// `libraryId`, and an unfinished one shows as paused at boot. A copy is
// registered like a download, with `arrivedAt` so watched cleanup ages it from
// its arrival. Nothing is written to the drive. docs/shared-library.md
// ("Copy to this PC") describes the flow.

import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { fitsFreeSpace, requiredBytes } from '@shared/shared-library-export'
import { persistDownloadedEpisode } from '../../lib/downloaded-episodes'
import { parseEpisodeFromFilename } from '../../lib/filename'
import { nodeFs, writeSmallFile, type ExportFs } from '../../lib/shared-library/copy'
import { itemKey } from '../../lib/shared-library/format'
import {
  createMountCandidates,
  type MountCandidates
} from '../../lib/shared-library/mount-candidates'
import { posterPath, resolveItem } from '../../lib/shared-library/paths'
import { LIBRARY_DIR, readLibrary, readMeta } from '../../lib/shared-library/read'
import { ATTACHED_POSTER_MAX_BYTES } from '../../streaming/anime-poster-protocol'
import type { PlayerPresenceService } from '../player-presence'
import { ImportJob, jobFiles, type ImportJobRecord, type LocalFile } from './job'
import {
  buildImportTree,
  detailFromSnapshot,
  titleInfo,
  translationOf,
  type ImportItem,
  type ImportTitleInfo
} from './plan'

/** The `animeCache` entry fields the import writes. */
interface AnimeCacheLike {
  animeDetail: AnimeDetail | null
  episodes: Record<number, EpisodeDetail>
  qualityProbes: Record<number, number>
  cachedAt: number
  posterCached: boolean
}

export const IMPORT_JOBS_DIR = 'import-jobs'

export interface ImportStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export interface SharedLibraryImportDeps {
  userDataDir: string
  store: ImportStore
  /** The attached library (`attachedLibraryService.get`): its root and whether its drive is there. */
  library: (libraryId: string) => { root: string; name: string; available: boolean } | null
  /** The download root, and the cold root when cold storage is set up. */
  localRoots: () => { hot: string; cold: string | null }
  sanitizeFilename: (name: string) => string
  mergeStatus: (translationId: number) => string | null
  presence: Pick<PlayerPresenceService, 'isOpen' | 'onRelease'>
  broadcast: (job: ImportJobView) => void
  /** After an episode is registered: the episode list's cache, Library and the tab's badge. */
  onImported?: (info: { animeId: number; dirName: string }) => void
  candidates?: MountCandidates
  xfs?: Partial<ExportFs>
  retryMs?: number
  throttleMs?: number
  newId?: () => string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface SharedLibraryImportService {
  init(): Promise<void>
  plan(req: ImportPlanRequest): Promise<ImportPlan>
  start(req: ImportStartRequest): Promise<ImportStartResult>
  pause(jobId: string): Promise<ImportJobView | null>
  resume(jobId: string): Promise<ImportJobView | null>
  /** Cancels a running job; on a finished one, dismisses it. */
  cancel(jobId: string): Promise<ImportJobView | null>
  resolveDuplicate(jobId: string, answer: ImportDuplicateAnswer): Promise<ImportJobView | null>
  list(): ImportJobView[]
  /** Resolves when the job's current run stops (tests). */
  settled(jobId: string): Promise<void>
}

const TERMINAL: ReadonlySet<ImportJobStatus> = new Set(['completed', 'cancelled', 'failed'])
const CHOICES: ReadonlySet<string> = new Set(['keep', 'replace', 'keep-both'])

const NO_COLD = 'Cold storage isn’t set up (Settings → Storage).'
const COLD_MISSING = 'The cold storage folder isn’t there right now.'

export function createSharedLibraryImportService(
  deps: SharedLibraryImportDeps
): SharedLibraryImportService {
  const xfs: ExportFs = { ...nodeFs, ...deps.xfs }
  const candidates = deps.candidates ?? createMountCandidates()
  const now = deps.now ?? Date.now
  const throttleMs = deps.throttleMs ?? 250
  const jobsDir = path.join(deps.userDataDir, IMPORT_JOBS_DIR)
  const posterDir = path.join(deps.userDataDir, 'poster-cache')
  const jobs = new Map<string, ImportJob>()
  const lastEmit = new Map<string, { at: number; status: ImportJobStatus }>()
  const trailing = new Map<string, ReturnType<typeof setTimeout>>()
  const writes = new Map<string, Promise<void>>()

  const get = <T>(key: string): T => deps.store.get(key) as T
  const isDir = async (p: string): Promise<boolean> =>
    fsp.stat(p).then(
      (s) => s.isDirectory(),
      () => false
    )
  async function freeBytes(dir: string): Promise<number | null> {
    try {
      const s = await xfs.statfs(dir)
      return s.bavail * s.bsize
    } catch {
      return null
    }
  }

  /** The destinations: hot always (created when missing), cold only when its folder is there. */
  async function destinations(): Promise<{
    hot: string
    cold: string | null
    coldUnavailable: string | null
  }> {
    const { hot, cold } = deps.localRoots()
    if (!cold) return { hot, cold: null, coldUnavailable: NO_COLD }
    return (await isDir(cold))
      ? { hot, cold, coldUnavailable: null }
      : { hot, cold: null, coldUnavailable: COLD_MISSING }
  }

  /** The library as it is on the drive now, with its `meta/` snapshots. */
  async function readSource(libraryId: string): Promise<
    | {
        ok: true
        root: string
        name: string
        manifest: SharedLibraryManifest
        metas: Map<number, SharedLibraryMeta>
      }
    | { ok: false; error: string }
  > {
    const lib = deps.library(libraryId)
    if (!lib) return { ok: false, error: 'This library is no longer open on this PC.' }
    if (!lib.available) return { ok: false, error: `Connect the drive with '${lib.name}' first.` }
    const r = await readLibrary(lib.root).catch(() => null)
    // Copying only reads, so a read-only library (a newer state, interrupted) copies too.
    const manifest = r && r.status !== 'none' ? r.manifest : null
    if (!manifest || manifest.libraryId !== libraryId) {
      return { ok: false, error: `'${lib.name}' can’t be read right now.` }
    }
    const metas = new Map<number, SharedLibraryMeta>()
    const ids = new Set([...manifest.titles, ...manifest.items].map((x) => x.animeId))
    for (const id of ids) {
      const m = await readMeta(lib.root, id).catch(() => null)
      if (m?.status === 'ok') metas.set(id, m.meta)
    }
    return { ok: true, root: lib.root, name: lib.name, manifest, metas }
  }

  const source = {
    localAnime: (animeId: number): AnimeSearchResult | null =>
      get<Record<string, AnimeSearchResult> | undefined>('downloadedAnime')?.[animeId] ?? null
  }

  async function plan(req: ImportPlanRequest): Promise<ImportPlan> {
    const dest = await destinations()
    const empty: ImportPlan = {
      libraryId: req.libraryId,
      libraryName: deps.library(req.libraryId)?.name ?? '',
      titles: [],
      rejected: [],
      hot: { dir: dest.hot, free: await freeBytes(dest.hot) },
      cold: dest.cold ? { dir: dest.cold, free: await freeBytes(dest.cold) } : null,
      coldUnavailable: dest.coldUnavailable,
      error: null
    }
    const src = await readSource(req.libraryId)
    if (!src.ok) return { ...empty, error: src.error }
    const tree = await buildImportTree(
      source,
      src.root,
      src.manifest,
      src.metas,
      req.animeIds ? [...req.animeIds] : null,
      dest.hot
    )
    return { ...empty, libraryName: src.name, titles: tree.titles, rejected: tree.rejected }
  }

  // --- jobs

  async function persist(rec: ImportJobRecord): Promise<void> {
    const prev = writes.get(rec.jobId) ?? Promise.resolve()
    const next = prev.then(async () => {
      await fsp.mkdir(jobsDir, { recursive: true })
      const file = path.join(jobsDir, `${rec.jobId}.json`)
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(rec, null, 2))
      await fsp.rename(`${file}.tmp`, file)
    })
    const settled = next.catch((err) => console.error('[import] could not save the job:', err))
    writes.set(rec.jobId, settled)
    return settled
  }

  function view(job: ImportJob): ImportJobView {
    const rec = job.rec
    const files = jobFiles(rec)
    const label = (key: string): string => {
      const item = rec.items.find((i) => i.key === key)
      return item ? job.labelOf(item) : key
    }
    const list = (m: Record<string, string>): ImportJobView['failed'] =>
      Object.entries(m).map(([key, reason]) => ({ key, label: label(key), reason }))
    return {
      jobId: rec.jobId,
      libraryId: rec.libraryId,
      libraryName: rec.libraryName,
      destination: rec.destination,
      status: rec.status,
      itemsDone: rec.done.length,
      itemsTotal: rec.items.length,
      bytesDone: job.bytesDone(),
      bytesTotal: files.reduce((n, f) => n + (rec.doneFiles[f.dest]?.size ?? f.size), 0),
      current: rec.current ? label(rec.current.key) : null,
      duplicate: job.duplicate(),
      failed: list(rec.failed),
      kept: list(rec.kept),
      note: rec.note,
      error: rec.error,
      createdAt: rec.createdAt
    }
  }

  function emit(job: ImportJob): void {
    const id = job.rec.jobId
    const t = trailing.get(id)
    if (t) clearTimeout(t)
    trailing.delete(id)
    lastEmit.set(id, { at: now(), status: job.rec.status })
    deps.broadcast(view(job))
  }

  function update(job: ImportJob): void {
    const id = job.rec.jobId
    const last = lastEmit.get(id)
    if (!last || last.status !== job.rec.status || now() - last.at >= throttleMs) {
      emit(job)
      return
    }
    if (!trailing.has(id)) {
      trailing.set(
        id,
        setTimeout(() => emit(job), throttleMs)
      )
    }
  }

  /** The local files of an item's episode, in the hot and cold roots, by name. */
  async function localFiles(item: ImportItem): Promise<LocalFile[]> {
    const { hot, cold } = deps.localRoots()
    const base = deps.sanitizeFilename(`${item.title} - ${item.episodeInt.padStart(2, '0')}`)
    const out: LocalFile[] = []
    for (const root of cold ? [hot, cold] : [hot]) {
      const dir = path.join(root, item.dirName)
      let names: string[]
      try {
        names = await fsp.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.startsWith(base)) continue
        const part = name.endsWith('.part')
        const file = part ? name.slice(0, -'.part'.length) : name
        const parsed = parseEpisodeFromFilename(file)
        if (!parsed || parsed.episodeInt !== item.episodeInt) continue
        const ext = `.${parsed.ext}` as LocalFile['ext']
        const stem = file.slice(0, -ext.length)
        // `<base>` or `<base> [<tag>]`: never another episode that shares the prefix.
        if (stem !== base && !stem.startsWith(`${base} [`)) continue
        const p = path.join(dir, name)
        const size = await fsp.stat(p).then(
          (s) => s.size,
          () => 0
        )
        out.push({ path: p, stem, ext, part, size })
      }
    }
    return out
  }

  function localEntries(
    item: ImportItem
  ): { key: string; translationId: number; author: string }[] {
    const eps =
      get<Record<string, { author: string; translationId: number }> | undefined>(
        'downloadedEpisodes'
      ) ?? {}
    const prefix = `${item.animeId}:${item.episodeInt}:`
    return Object.entries(eps)
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, e]) => ({ key, translationId: e.translationId, author: e.author ?? '' }))
  }

  /**
   * Registers one copied episode, through the single writers: the title's
   * `downloadedAnime` entry, cached details and poster only when this PC has
   * none (an existing entry is never overwritten), then the episode with
   * `arrivedAt`.
   */
  async function register(
    rec: ImportJobRecord,
    infos: ReadonlyMap<number, ImportTitleInfo>,
    metas: ReadonlyMap<number, SharedLibraryMeta>,
    item: ImportItem,
    dropKeys: string[]
  ): Promise<void> {
    const info = infos.get(item.animeId)
    const id = String(item.animeId)
    const downloaded = get<Record<string, AnimeSearchResult> | undefined>('downloadedAnime') ?? {}
    if (!downloaded[id] && info) {
      deps.store.set('downloadedAnime', { ...downloaded, [id]: info.snapshot })
    }
    const poster = path.join(posterDir, `${item.animeId}.jpg`)
    const posterCopied =
      !(await fsp.stat(poster).then(
        () => true,
        () => false
      )) && (await copyPoster(rec.root, item.animeId, poster))
    await seedCache(rec, info, metas.get(item.animeId) ?? null, item, posterCopied)
    if (dropKeys.length > 0) {
      const eps = get<Record<string, unknown>>('downloadedEpisodes') ?? {}
      for (const k of dropKeys) delete eps[k]
      deps.store.set('downloadedEpisodes', eps)
    }
    persistDownloadedEpisode(deps.store as Parameters<typeof persistDownloadedEpisode>[0], {
      animeId: item.animeId,
      episodeInt: item.episodeInt,
      translationId: item.translationId,
      translationType: item.translationType,
      author: item.author,
      quality: item.quality,
      arrivedAt: now()
    })
    deps.onImported?.({ animeId: item.animeId, dirName: item.dirName })
  }

  /**
   * The title's cached details, only when this PC has no entry: from the
   * drive's snapshot, with each copied episode's translation, so the detail
   * page lists and plays the copy offline. The job records the titles it
   * seeded (saved before the store write), and adds later episodes only to
   * those; an entry this PC had is never touched.
   */
  async function seedCache(
    rec: ImportJobRecord,
    info: ImportTitleInfo | undefined,
    meta: SharedLibraryMeta | null,
    item: ImportItem,
    posterCopied: boolean
  ): Promise<void> {
    const id = String(item.animeId)
    const cache = get<Record<string, AnimeCacheLike> | undefined>('animeCache') ?? {}
    const seeded = rec.seeded ?? []
    if (cache[id] && !seeded.includes(item.animeId)) return
    if (!info) return
    if (!seeded.includes(item.animeId)) {
      rec.seeded = [...seeded, item.animeId]
      await persist(rec)
    }
    const entry: AnimeCacheLike = cache[id] ?? {
      animeDetail: detailFromSnapshot(
        info.record,
        meta,
        rec.items.filter((i) => i.animeId === item.animeId).map((i) => i.episodeInt)
      ),
      episodes: {},
      qualityProbes: {},
      // Stale at once, so the next online open replaces it.
      cachedAt: 0,
      posterCached: posterCopied
    }
    const ep = entry.animeDetail?.episodes.find((e) => e.episodeInt === item.episodeInt)
    if (ep) {
      const detail = entry.episodes[ep.id] ?? {
        id: ep.id,
        episodeFull: ep.episodeFull,
        episodeInt: ep.episodeInt,
        episodeType: ep.episodeType,
        translations: []
      }
      entry.episodes = {
        ...entry.episodes,
        [ep.id]: {
          ...detail,
          translations: [
            ...detail.translations.filter((t) => t.id !== item.translationId),
            translationOf(item)
          ]
        }
      }
    }
    deps.store.set('animeCache', { ...cache, [id]: entry })
  }

  /** The drive's `posters/<animeId>.jpg` into the poster cache, `realpath`- and size-checked. */
  async function copyPoster(root: string, animeId: number, dest: string): Promise<boolean> {
    const rel = posterPath(animeId)
    if (!rel) return false
    try {
      const r = await resolveItem(path.join(root, LIBRARY_DIR), { path: rel })
      if (r.path === 'missing' || r.path === 'escapes') return false
      const st = await fsp.stat(r.path)
      if (!st.isFile() || st.size > ATTACHED_POSTER_MAX_BYTES) return false
      const bytes = await fsp.readFile(r.path)
      if (bytes.length > ATTACHED_POSTER_MAX_BYTES) return false
      await fsp.mkdir(posterDir, { recursive: true })
      await writeSmallFile(xfs, dest, bytes)
      return true
    } catch (err) {
      console.warn(`[import] the poster of ${animeId} wasn't copied:`, err)
      return false
    }
  }

  function makeJob(rec: ImportJobRecord): ImportJob {
    // The title records and snapshots are read again per run: they come from the drive.
    let snapshot: Promise<{
      infos: Map<number, ImportTitleInfo>
      metas: Map<number, SharedLibraryMeta>
    }> | null = null
    const titles = async (): Promise<{
      infos: Map<number, ImportTitleInfo>
      metas: Map<number, SharedLibraryMeta>
    }> => {
      snapshot ??= (async () => {
        const r = await readLibrary(rec.root).catch(() => null)
        const manifest = r && r.status !== 'none' ? r.manifest : null
        const metas = new Map<number, SharedLibraryMeta>()
        const infos = new Map<number, ImportTitleInfo>()
        if (!manifest) return { infos, metas }
        for (const id of new Set(rec.items.map((i) => i.animeId))) {
          const m = await readMeta(rec.root, id).catch(() => null)
          if (m?.status === 'ok') metas.set(id, m.meta)
          infos.set(id, titleInfo(source, manifest, metas, id))
        }
        return { infos, metas }
      })()
      return snapshot
    }
    const job: ImportJob = new ImportJob(rec, {
      xfs,
      presence: deps.presence,
      candidates,
      persist,
      update: () => update(job),
      localFiles,
      localEntries,
      mergeStatus: deps.mergeStatus,
      sanitizeFilename: deps.sanitizeFilename,
      register: async (item, dropKeys) => {
        const { infos, metas } = await titles()
        await register(job.rec, infos, metas, item, dropKeys)
      },
      retryMs: deps.retryMs ?? 10_000,
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    })
    jobs.set(rec.jobId, job)
    return job
  }

  function busyJob(except?: string): ImportJob | null {
    for (const job of jobs.values()) {
      if (job.rec.jobId !== except && job.isActive()) return job
    }
    return null
  }

  async function start(req: ImportStartRequest): Promise<ImportStartResult> {
    const other = busyJob()
    if (other) return { ok: false, reason: `Another copy is running (${other.rec.libraryName}).` }
    const destination: ImportDestination = req.destination === 'cold' ? 'cold' : 'hot'
    const dest = await destinations()
    const destRoot = destination === 'cold' ? dest.cold : dest.hot
    if (!destRoot) return { ok: false, reason: dest.coldUnavailable ?? NO_COLD }
    const src = await readSource(req.libraryId)
    if (!src.ok) return { ok: false, reason: src.error }
    const keys = new Set((req.selection ?? []).map((s) => itemKey(s)))
    const ids = [...new Set((req.selection ?? []).map((s) => s.animeId))]
    const tree = await buildImportTree(source, src.root, src.manifest, src.metas, ids, destRoot)
    const items = [...tree.items.values()].filter((i) => keys.has(i.key))
    if (items.length === 0) return { ok: false, reason: 'Nothing to copy.' }
    if (destination === 'hot') await fsp.mkdir(destRoot, { recursive: true })
    const bytes = items.reduce((n, i) => n + i.size + i.subtitleSize, 0)
    const free = await freeBytes(destRoot)
    if (!fitsFreeSpace(bytes, free)) {
      return {
        ok: false,
        reason: `Not enough free space: the copy needs ${requiredBytes(bytes)} bytes, ${destRoot} has ${free}.`
      }
    }
    const rec: ImportJobRecord = {
      version: 1,
      jobId: (deps.newId ?? randomUUID)(),
      libraryId: req.libraryId,
      libraryName: src.name,
      root: src.root,
      destination,
      destRoot,
      createdAt: now(),
      status: 'running',
      items,
      doneFiles: {},
      done: [],
      failed: {},
      kept: {},
      decisions: {},
      applyAll: null,
      current: null,
      note: null,
      error: null
    }
    await persist(rec)
    const job = makeJob(rec)
    void job.run()
    emit(job)
    return { ok: true, job: view(job) }
  }

  async function init(): Promise<void> {
    let names: string[]
    try {
      names = await fsp.readdir(jobsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const rec = JSON.parse(
          await fsp.readFile(path.join(jobsDir, name), 'utf8')
        ) as ImportJobRecord
        if (rec.version !== 1 || typeof rec.jobId !== 'string' || jobs.has(rec.jobId)) continue
        if (!TERMINAL.has(rec.status)) {
          rec.status = 'paused'
          await persist(rec)
        }
        emit(makeJob(rec))
      } catch (err) {
        console.warn(`[import] skipped an unreadable job file ${name}:`, err)
      }
    }
  }

  async function pause(jobId: string): Promise<ImportJobView | null> {
    const job = jobs.get(jobId)
    if (!job) return null
    await job.pause()
    return view(job)
  }

  async function resume(jobId: string): Promise<ImportJobView | null> {
    const job = jobs.get(jobId)
    if (!job || TERMINAL.has(job.rec.status)) return job ? view(job) : null
    if (busyJob(jobId)) return view(job)
    if (job.rec.status === 'waiting-drive') void job.retryNow()
    else void job.run()
    return view(job)
  }

  async function cancel(jobId: string): Promise<ImportJobView | null> {
    const job = jobs.get(jobId)
    if (!job) return null
    if (TERMINAL.has(job.rec.status)) {
      jobs.delete(jobId)
      await writes.get(jobId)
      await fsp.rm(path.join(jobsDir, `${jobId}.json`), { force: true })
      return null
    }
    await job.cancel()
    return view(job)
  }

  async function resolveDuplicate(
    jobId: string,
    answer: ImportDuplicateAnswer
  ): Promise<ImportJobView | null> {
    const job = jobs.get(jobId)
    if (!job) return null
    if (answer && CHOICES.has(answer.choice)) {
      job.resolveDuplicate({ choice: answer.choice, applyToAll: answer.applyToAll === true })
    }
    return view(job)
  }

  return {
    init,
    plan,
    start,
    pause,
    resume,
    cancel,
    resolveDuplicate,
    list: () => [...jobs.values()].map((j) => view(j)).sort((a, b) => b.createdAt - a.createdAt),
    settled: async (jobId) => {
      const job = jobs.get(jobId)
      if (!job) return
      while (job.running()) await job.running()
      await writes.get(jobId)
    }
  }
}
