// Export to a Shared Library, Videos only (S6a #574). One job runs at a time;
// jobs persist under `userData/export-jobs/<jobId>.json`, keyed by the
// library's `libraryId`, and an unfinished job shows as paused at boot.
// docs/shared-library.md ("Export") describes the flow.

import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { fitsFreeSpace, requiredBytes } from '@shared/shared-library-export'
import type { FileCheckResult } from '../../lib/episode-file-scan'
import type { DownloadedEpisodesMap } from '../../lib/downloaded-episodes'
import { CAPS, itemKey } from '../../lib/shared-library/format'
import {
  createMountCandidates,
  type MountCandidates
} from '../../lib/shared-library/mount-candidates'
import { nameItems } from '../../lib/shared-library/naming'
import { createLibrary } from '../../lib/shared-library/write'
import type { PlayerPresenceService } from '../player-presence'
import { nodeFs, type ExportFs } from './copy'
import { ExportJob, jobFiles, type JobItem, type JobRecord } from './job'
import { rootsWithId } from './locate'
import {
  buildTree,
  classifyTarget,
  createResolver,
  displayName,
  presentKeys,
  type PlanSource
} from './plan'
import { buildMeta } from './snapshot'

export const JOBS_DIR = 'export-jobs'

export interface ExportStore {
  get(key: string): unknown
}

export interface SharedLibraryExportDeps {
  userDataDir: string
  store: ExportStore
  /** The hot + cold scan the episode list uses (`scanEpisodeFilesAsync`). */
  scanEpisodeFiles: (animeName: string) => Promise<FileCheckResult>
  sanitizeFilename: (name: string) => string
  mergeStatus: (translationId: number) => string | null
  presence: Pick<PlayerPresenceService, 'isOpen' | 'onRelease'>
  actor: () => SharedLibraryActor
  broadcast: (job: ExportJobView) => void
  /** After each manifest write into `root` (#616); never awaited. */
  onLibraryWritten?: (libraryId: string, root: string) => void | Promise<void>
  candidates?: MountCandidates
  xfs?: Partial<ExportFs>
  checkpointEvery?: number
  retryMs?: number
  throttleMs?: number
  newId?: () => string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface SharedLibraryExportService {
  /** Loads persisted jobs; an unfinished one shows as paused. */
  init(): Promise<void>
  plan(req: ExportPlanRequest): Promise<ExportPlan>
  start(req: ExportStartRequest): Promise<ExportStartResult>
  pause(jobId: string): Promise<ExportJobView | null>
  resume(jobId: string): Promise<ExportJobView | null>
  /** Cancels a running job; on a finished one, dismisses it. */
  cancel(jobId: string): Promise<ExportJobView | null>
  list(): ExportJobView[]
  /** "Locate…": accepts `dir` only when it (or a folder one level below) holds the job's library. */
  locate(jobId: string, dir: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Resolves when the job's current run stops (tests). */
  settled(jobId: string): Promise<void>
}

const TERMINAL: ReadonlySet<ExportJobStatus> = new Set(['completed', 'cancelled', 'failed'])

export function createSharedLibraryExportService(
  deps: SharedLibraryExportDeps
): SharedLibraryExportService {
  const xfs: ExportFs = { ...nodeFs, ...deps.xfs }
  const candidates = deps.candidates ?? createMountCandidates()
  const now = deps.now ?? Date.now
  const throttleMs = deps.throttleMs ?? 250
  const jobsDir = path.join(deps.userDataDir, JOBS_DIR)
  const jobs = new Map<string, ExportJob>()
  const lastEmit = new Map<string, { at: number; status: ExportJobStatus }>()
  const trailing = new Map<string, ReturnType<typeof setTimeout>>()
  const writes = new Map<string, Promise<void>>()

  const get = <T>(key: string): T => deps.store.get(key) as T
  const animeRecord = (id: number): AnimeSearchResult | null =>
    get<Record<string, AnimeSearchResult>>('downloadedAnime')?.[id] ??
    get<Record<string, AnimeSearchResult>>('library')?.[id] ??
    detail(id)
  const detail = (id: number): AnimeDetail | null =>
    get<Record<string, { animeDetail?: AnimeDetail | null }>>('animeCache')?.[id]?.animeDetail ??
    null
  const fileSize = async (p: string): Promise<number | null> => {
    try {
      return (await xfs.stat(p)).size
    } catch {
      return null
    }
  }
  const source: PlanSource = {
    downloadedEpisodes: () => get<DownloadedEpisodesMap>('downloadedEpisodes') ?? {},
    anime: animeRecord,
    detail,
    scanEpisodeFiles: deps.scanEpisodeFiles,
    sanitizeFilename: deps.sanitizeFilename,
    mergeStatus: deps.mergeStatus,
    fileSize
  }
  const pathExists = async (p: string): Promise<boolean> => (await fileSize(p)) !== null
  const userId = (): number | null =>
    get<{ id?: number } | null>('shikimoriUser')?.id ?? deps.actor().shikimoriUserId

  async function freeBytes(dir: string): Promise<number | null> {
    try {
      const s = await xfs.statfs(dir)
      return s.bavail * s.bsize
    } catch {
      return null
    }
  }

  async function persist(rec: JobRecord): Promise<void> {
    const prev = writes.get(rec.jobId) ?? Promise.resolve()
    const next = prev.then(async () => {
      await fsp.mkdir(jobsDir, { recursive: true })
      const file = path.join(jobsDir, `${rec.jobId}.json`)
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(rec, null, 2))
      await fsp.rename(`${file}.tmp`, file)
    })
    writes.set(
      rec.jobId,
      next.catch((err) => console.error('[export] could not save the job:', err))
    )
    return next.catch((err) => console.error('[export] could not save the job:', err))
  }

  function view(job: ExportJob): ExportJobView {
    const rec = job.rec
    const files = jobFiles(rec)
    const titleName = new Map(rec.titles.map((t) => [t.animeId, t.name]))
    const label = (key: string): string => {
      const item = rec.items.find((i) => i.key === key)
      if (!item) return key
      return `${titleName.get(item.animeId) ?? item.animeId} — ${item.label}`
    }
    return {
      jobId: rec.jobId,
      libraryId: rec.libraryId,
      libraryName: rec.libraryName,
      root: rec.root,
      status: rec.status,
      filesDone: files.filter((f) => rec.doneFiles[f.rel]).length,
      filesTotal: files.length,
      bytesDone: job.bytesDone(),
      bytesTotal: files.reduce((n, f) => n + f.size, 0),
      current: rec.current ? label(rec.current.key) : null,
      failed: Object.entries(rec.failed).map(([key, reason]) => ({
        key,
        label: label(key),
        reason
      })),
      missing: rec.missing,
      note: rec.note,
      error: rec.error,
      createdAt: rec.createdAt
    }
  }

  function emit(job: ExportJob): void {
    const id = job.rec.jobId
    const t = trailing.get(id)
    if (t) clearTimeout(t)
    trailing.delete(id)
    lastEmit.set(id, { at: now(), status: job.rec.status })
    deps.broadcast(view(job))
  }

  function update(job: ExportJob): void {
    const id = job.rec.jobId
    const last = lastEmit.get(id)
    if (!last || last.status !== job.rec.status || now() - last.at >= throttleMs) {
      emit(job)
      return
    }
    if (!trailing.has(id))
      trailing.set(
        id,
        setTimeout(() => emit(job), throttleMs)
      )
  }

  // A fresh resolver (and scan) per file: the source is re-resolved just
  // before its copy, so a hot → cold auto-move during the job is followed.
  const resolve = (item: JobItem): ReturnType<ReturnType<typeof createResolver>> =>
    createResolver(source)(item)

  function makeJob(rec: JobRecord): ExportJob {
    const job: ExportJob = new ExportJob(rec, {
      xfs,
      presence: deps.presence,
      actor: deps.actor,
      resolve,
      snapshot: (animeId) => {
        const poster = path.join(deps.userDataDir, 'poster-cache', `${animeId}.jpg`)
        return {
          meta: buildMeta(animeId, detail(animeId), animeRecord(animeId)),
          posterFile: poster
        }
      },
      candidates,
      persist,
      update: () => update(job),
      checkpointEvery: deps.checkpointEvery ?? 10,
      onLibraryWritten: deps.onLibraryWritten,
      retryMs: deps.retryMs ?? 10_000,
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    })
    jobs.set(rec.jobId, job)
    return job
  }

  function runJob(job: ExportJob): void {
    void job.run()
  }

  function busyJob(except?: string): ExportJob | null {
    for (const job of jobs.values()) {
      if (job.rec.jobId === except) continue
      if (job.isActive()) return job
    }
    return null
  }

  async function plan(req: ExportPlanRequest): Promise<ExportPlan> {
    const { titles, resolved } = await buildTree(source, req.animeIds)
    if (!req.target) return { titles, target: null }
    const t = await classifyTarget(req.target, req.name, userId(), pathExists)
    return {
      titles,
      target: {
        dir: req.target,
        root: t.root,
        kind: t.kind,
        libraryName: t.libraryName,
        ...(t.ownerNickname !== undefined ? { ownerNickname: t.ownerNickname } : {}),
        blocked: t.blocked,
        free: await freeBytes(req.target),
        present: presentKeys(t.manifest, resolved)
      }
    }
  }

  async function start(req: ExportStartRequest): Promise<ExportStartResult> {
    const other = busyJob()
    if (other) return { ok: false, reason: `Another export is running (${other.rec.libraryName}).` }
    const ids = [...new Set(req.selection.map((s) => s.animeId))]
    const { resolved } = await buildTree(source, ids)
    const t = await classifyTarget(req.target, req.name, userId(), pathExists)
    if (t.blocked) return { ok: false, reason: t.blocked }

    const present = new Set(presentKeys(t.manifest, resolved))
    const keys = [...new Set(req.selection.map((s) => itemKey(s)))]
    const ready = keys.map((k) => resolved.get(k)).filter((r) => r !== undefined)
    const missing = keys.length - ready.length
    const toCopy = ready.filter((r) => !present.has(r.key))
    if (toCopy.length === 0) {
      return { ok: false, reason: 'Nothing to copy: the library already has every selected item.' }
    }
    const bytes = toCopy.reduce((n, r) => n + r.videoSize + r.subtitleSize, 0)
    const free = await freeBytes(req.target)
    if (!fitsFreeSpace(bytes, free)) {
      return {
        ok: false,
        reason: `Not enough free space: the export needs ${requiredBytes(bytes)} bytes, the drive has ${free}.`
      }
    }
    const copyKeys = new Set(toCopy.map((r) => r.key))
    const existing = (t.manifest?.items ?? []).filter((i) => !copyKeys.has(itemKey(i)))
    if (existing.length + toCopy.length > CAPS.items) {
      return { ok: false, reason: `A library holds at most ${CAPS.items} items.` }
    }

    const named = nameItems(
      toCopy.map((r) => ({
        animeId: r.animeId,
        episodeInt: r.episodeInt,
        translationId: r.translationId,
        title: r.title,
        author: r.author,
        ext: r.ext,
        subtitle: r.subtitlePath !== null
      })),
      existing
    )
    const actor = deps.actor()
    let libraryId: string
    if (t.kind === 'add') {
      libraryId = t.manifest!.libraryId
    } else {
      libraryId = (deps.newId ?? randomUUID)()
      // The identity is on the drive before the first file is copied.
      await createLibrary(
        t.root,
        {
          libraryId,
          name: t.libraryName,
          owner: null,
          mode: 'videos',
          titles: [],
          items: []
        },
        actor
      )
    }

    const items: JobItem[] = toCopy.map((r, i) => ({
      key: r.key,
      animeId: r.animeId,
      episodeInt: r.episodeInt,
      translationId: r.translationId,
      translationType: r.translationType,
      author: r.author,
      quality: r.quality,
      label: r.label,
      path: named[i].path,
      ...(named[i].subtitlePath !== undefined ? { subtitlePath: named[i].subtitlePath } : {}),
      renamed: named[i].renamed,
      videoSize: r.videoSize,
      subtitleSize: r.subtitleSize
    }))
    const rec: JobRecord = {
      version: 1,
      jobId: (deps.newId ?? randomUUID)(),
      libraryId,
      libraryName: t.libraryName,
      root: t.root,
      createdAt: now(),
      status: 'running',
      items,
      titles: ids.map((id) => ({ animeId: id, name: displayName(animeRecord(id), id) })),
      doneFiles: {},
      done: [],
      failed: {},
      current: null,
      missing,
      snapshotted: [],
      note:
        t.ownerNickname === undefined
          ? null
          : t.kind === 'foreign'
            ? `This drive has ${t.ownerNickname}'s library; this export went into a new library next to it.`
            : `This drive has ${t.ownerNickname}'s library; this export added to '${t.libraryName}' next to it.`,
      error: null
    }
    await persist(rec)
    const job = makeJob(rec)
    runJob(job)
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
        const rec = JSON.parse(await fsp.readFile(path.join(jobsDir, name), 'utf8')) as JobRecord
        if (rec.version !== 1 || typeof rec.jobId !== 'string' || jobs.has(rec.jobId)) continue
        if (!TERMINAL.has(rec.status)) {
          rec.status = 'paused'
          await persist(rec)
        }
        emit(makeJob(rec))
      } catch (err) {
        console.warn(`[export] skipped an unreadable job file ${name}:`, err)
      }
    }
  }

  async function pause(jobId: string): Promise<ExportJobView | null> {
    const job = jobs.get(jobId)
    if (!job) return null
    await job.pause()
    return view(job)
  }

  async function resume(jobId: string): Promise<ExportJobView | null> {
    const job = jobs.get(jobId)
    if (!job || TERMINAL.has(job.rec.status)) return job ? view(job) : null
    if (busyJob(jobId)) return view(job)
    if (job.rec.status === 'waiting-drive') void job.retryNow()
    else runJob(job)
    return view(job)
  }

  async function cancel(jobId: string): Promise<ExportJobView | null> {
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

  async function locate(
    jobId: string,
    dir: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const job = jobs.get(jobId)
    if (!job) return { ok: false, reason: 'No such export.' }
    const roots = await rootsWithId(dir, job.rec.libraryId)
    if (roots.length === 0) {
      return { ok: false, reason: `This folder doesn't hold the library '${job.rec.libraryName}'.` }
    }
    if (busyJob(jobId)) return { ok: false, reason: 'Another export is running.' }
    await job.relocate(roots[0])
    runJob(job)
    return { ok: true }
  }

  return {
    init,
    plan,
    start,
    pause,
    resume,
    cancel,
    list: () => [...jobs.values()].map((j) => view(j)).sort((a, b) => b.createdAt - a.createdAt),
    locate,
    settled: async (jobId) => {
      const job = jobs.get(jobId)
      if (!job) return
      while (job.running()) await job.running()
      await writes.get(jobId)
    }
  }
}
