// Export to a Shared Library, Videos only (S6a #574). One job runs at a time;
// jobs persist under `userData/export-jobs/<jobId>.json`, keyed by the
// library's `libraryId`, and an unfinished job shows as paused at boot.
// docs/shared-library.md ("Export") describes the flow.

import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import * as path from 'path'
import {
  fitsFreeSpace,
  mergedBytes,
  requiredBytes,
  type ExportMergeChoice
} from '@shared/shared-library-export'
import type { FileCheckResult } from '../../lib/episode-file-scan'
import type { DownloadedEpisodesMap } from '../../lib/downloaded-episodes'
import { CAPS, itemKey } from '../../lib/shared-library/format'
import {
  createMountCandidates,
  type MountCandidates
} from '../../lib/shared-library/mount-candidates'
import type { absoluteOverflow } from '../../lib/shared-library/paths'
import { createLibrary } from '../../lib/shared-library/write'
import type { PlayerPresenceService } from '../player-presence'
import { TOO_LARGE_REASON, nodeFs, type ExportFs } from './copy'
import { createFsTypeProbe, type FsTypeProbe } from './fs-type-probe'
import { ExportJob, jobFiles, type ExportMerger, type JobItem, type JobRecord } from './job'
import {
  createWriteProbe,
  preflight,
  type FolderProbe,
  type PreflightDeps,
  type PreflightResult
} from './preflight'
import { rootsWithId } from './locate'
import {
  buildTree,
  classifyTarget,
  createResolver,
  displayName,
  presence,
  presentKeys,
  type PlanSource,
  type ResolvedItem
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
  /** This PC's ffmpeg (`checkFfmpeg`, #576); without it, Merge into MKV is off. */
  ffmpegCheck?: () => Promise<{ available: boolean; encoders: string[] }>
  /** The download manager's merge (#576); without it, Merge into MKV is off. */
  merger?: ExportMerger
  candidates?: MountCandidates
  xfs?: Partial<ExportFs>
  /** The target's filesystem type (#575); the per-OS commands by default. */
  fsTypeProbe?: FsTypeProbe
  /** The preflight's write probe (#575); a `wx` probe file by default. */
  writeProbe?: (dir: string) => Promise<void>
  /** Whether a path is an existing folder (preflight's nearest existing ancestor). */
  isDirectory?: (p: string) => Promise<boolean>
  /** S5's `absoluteOverflow`; injectable so a test can spy on the call. */
  overflow?: typeof absoluteOverflow
  platform?: NodeJS.Platform
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

  const preflightDeps: PreflightDeps = {
    xfs,
    isDirectory:
      deps.isDirectory ??
      (async (p) => {
        try {
          return (await fsp.stat(p)).isDirectory()
        } catch {
          return false
        }
      }),
    fsTypeProbe: deps.fsTypeProbe ?? createFsTypeProbe({ platform: deps.platform }),
    writeProbe: deps.writeProbe ?? createWriteProbe(xfs),
    platform: deps.platform ?? process.platform,
    now,
    ...(deps.overflow ? { overflow: deps.overflow } : {})
  }
  // The dialog's probes, one per folder while it is open (its `session`). Start never reads it.
  let probes: { session: string; cache: Map<string, Promise<FolderProbe>> } | null = null
  const probeCache = (
    session: string | undefined
  ): Map<string, Promise<FolderProbe>> | undefined => {
    if (session === undefined) return undefined
    if (probes?.session !== session) probes = { session, cache: new Map() }
    return probes.cache
  }

  /** This PC's merge support (#576): ffmpeg found, and a merger wired. */
  async function mergeSupport(): Promise<ExportMergeSupport> {
    const off: ExportMergeSupport = { available: false, encoders: [] }
    if (!deps.ffmpegCheck || !deps.merger) return off
    try {
      const info = await deps.ffmpegCheck()
      return info.available ? { available: true, encoders: [...info.encoders] } : off
    } catch {
      return off
    }
  }

  /** The merge choice a request makes on this PC: Merge needs ffmpeg, else pairs are copied as-is. */
  function mergeChoice(
    unmerged: ExportUnmergedMode | undefined,
    codec: string | undefined,
    support: ExportMergeSupport
  ): ExportMergeChoice & { codec: string } {
    const merge = unmerged === 'merge' && support.available
    const c = merge ? (codec ?? 'copy') : 'copy'
    return { merge, reencode: c !== 'copy', codec: c }
  }

  /** Whether `r` is merged into an MKV under `choice`: an unmerged pair, with Merge on. */
  const merges = (r: ResolvedItem, choice: ExportMergeChoice): boolean =>
    choice.merge && r.subtitlePath !== null

  /** The preflight of copying `items` into `root`, where `existing` are the library's other items. */
  function runPreflight(
    items: readonly ResolvedItem[],
    root: string,
    existing: readonly Pick<SharedLibraryItem, 'path' | 'subtitlePath'>[],
    choice: ExportMergeChoice,
    cache?: Map<string, Promise<FolderProbe>>
  ): Promise<PreflightResult> {
    return preflight(
      {
        items: items.map((r) => {
          // A merged pair is one `.mkv` of about the pair's size (#576); a
          // re-encode's size is unknown until it is written.
          const merged = merges(r, choice)
          return {
            key: r.key,
            size: merged ? r.videoSize + r.subtitleSize : Math.max(r.videoSize, r.subtitleSize),
            ...(merged && choice.reencode ? { reencode: true } : {}),
            naming: {
              animeId: r.animeId,
              episodeInt: r.episodeInt,
              translationId: r.translationId,
              title: r.title,
              author: r.author,
              ext: merged ? '.mkv' : r.ext,
              subtitle: !merged && r.subtitlePath !== null
            }
          }
        }),
        existing
      },
      { root },
      cache ? { ...preflightDeps, probeCache: cache } : preflightDeps
    )
  }

  function publicPreflight(p: PreflightResult): ExportPreflight {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { named, ...rest } = p
    return rest
  }

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
      // A merged file's size is known only once it's written (#576): done files count as written.
      bytesTotal: files.reduce((n, f) => n + (rec.doneFiles[f.rel]?.size ?? f.size), 0),
      current: rec.current ? label(rec.current.key) : null,
      merge: job.mergeState(),
      failed: Object.entries(rec.failed).map(([key, reason]) => ({
        key,
        label: label(key),
        reason
      })),
      skipped: Object.entries(rec.skipped ?? {}).map(([key, s]) => ({
        key,
        label: `${titleName.get(s.animeId) ?? s.animeId} — ${s.label}`,
        reason: s.reason
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
      merger: deps.merger,
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
    const merge = await mergeSupport()
    if (!req.target) return { titles, target: null, preflight: null, merge }
    const t = await classifyTarget(req.target, req.name, userId(), pathExists)
    const there = presence(t.manifest, resolved)
    const present = [...there.keys()]
    let pf: ExportPreflight | null = null
    if (!t.blocked) {
      // Every ready item the target doesn't have; the dialog narrows it to the selection.
      const candidates = [...resolved.values()].filter((r) => !there.has(r.key))
      const keys = new Set(candidates.map((r) => r.key))
      const existing = (t.manifest?.items ?? []).filter((i) => !keys.has(itemKey(i)))
      pf = publicPreflight(
        await runPreflight(
          candidates,
          t.root,
          existing,
          mergeChoice(req.unmerged, req.codec, merge),
          probeCache(req.session)
        )
      )
    }
    return {
      titles,
      merge,
      preflight: pf,
      target: {
        dir: req.target,
        root: t.root,
        kind: t.kind,
        libraryName: t.libraryName,
        ...(t.ownerNickname !== undefined ? { ownerNickname: t.ownerNickname } : {}),
        blocked: t.blocked,
        free: await freeBytes(req.target),
        present,
        presentMerged: present.filter((k) => there.get(k) === 'merged')
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
    const notThere = ready.filter((r) => !present.has(r.key))
    if (notThere.length === 0) {
      return { ok: false, reason: 'Nothing to copy: the library already has every selected item.' }
    }
    const notThereKeys = new Set(notThere.map((r) => r.key))
    const existing = (t.manifest?.items ?? []).filter((i) => !notThereKeys.has(itemKey(i)))

    // Merge into MKV (#576) needs this PC's ffmpeg; without it pairs are
    // copied as they are. The codec is `copy` unless the request names one.
    const support = await mergeSupport()
    const choice = mergeChoice(req.unmerged, req.codec, support)
    if (choice.merge && choice.reencode && !support.encoders.includes(choice.codec)) {
      return { ok: false, reason: `This PC’s ffmpeg can’t encode with ${choice.codec}.` }
    }

    // Probed again here, never from the dialog's cache: the stick may have
    // been swapped or write-protected since the plan.
    const pf = await runPreflight(notThere, t.root, existing, choice)
    if (!pf.ok) return { ok: false, reason: pf.blockers.join(' ') }
    const skippedKeys = new Set(pf.skipped)
    const toCopy = notThere.filter((r) => !skippedKeys.has(r.key))
    if (toCopy.length === 0) {
      return {
        ok: false,
        reason:
          'Nothing to copy: every selected file is over 4 GB, which this FAT32 drive can’t hold.'
      }
    }
    const bytes = toCopy.reduce(
      (n, r) =>
        n +
        (merges(r, choice)
          ? mergedBytes(r.videoSize + r.subtitleSize, choice.reencode)
          : r.videoSize + r.subtitleSize),
      0
    )
    const free = await freeBytes(req.target)
    if (!fitsFreeSpace(bytes, free)) {
      return {
        ok: false,
        reason: `Not enough free space: the export needs ${requiredBytes(bytes)} bytes, the drive has ${free}.`
      }
    }
    if (existing.length + toCopy.length > CAPS.items) {
      return { ok: false, reason: `A library holds at most ${CAPS.items} items.` }
    }

    // Preflight named the items it kept, by S5's rule, in this order.
    const named = pf.named
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
      ...(merges(r, choice)
        ? { videoSize: r.videoSize + r.subtitleSize, subtitleSize: 0, merge: true }
        : { videoSize: r.videoSize, subtitleSize: r.subtitleSize })
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
      skipped: Object.fromEntries(
        notThere
          .filter((r) => skippedKeys.has(r.key))
          .map((r) => [r.key, { animeId: r.animeId, label: r.label, reason: TOO_LARGE_REASON }])
      ),
      fsType: pf.fsType,
      unmerged: choice.merge ? 'merge' : 'copy-as-is',
      ...(choice.merge ? { codec: choice.codec } : {}),
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
