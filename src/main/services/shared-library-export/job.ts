// One export job (#574): copies its planned items into a Shared Library, file
// by file, with the manifest checkpointed through S5's writer every N files
// and at the end, so a cancelled or crashed job leaves a valid library holding
// whatever finished.
//
// The job is keyed by `libraryId`, never by path: every run first finds the
// library (`locateLibrary`), and before each file it checks the root still
// holds that library, so a different drive at the old letter or path is never
// written. Before each file it also checks `presence.isOpen()` — the merge
// hold's signal (#516) — and waits for a release while the player is open; a
// file already copying finishes.

import * as path from 'path'
import type { MergeStatus } from '../../download-manager'
import { itemKey } from '../../lib/shared-library/format'
import { renderIndexHtml } from '../../lib/shared-library/index-html'
import type { MountCandidates } from '../../lib/shared-library/mount-candidates'
import { nameItems } from '../../lib/shared-library/naming'
import { resolveWriteTarget } from '../../lib/shared-library/paths'
import { LIBRARY_DIR, MANIFEST, readLibrary } from '../../lib/shared-library/read'
import {
  LibraryIdMismatchError,
  LibraryNotFoundError,
  LibraryReadOnlyError,
  StaleGenerationError,
  writeManifest
} from '../../lib/shared-library/write'
import { subtitleMeta } from '../../lib/subtitle-meta'
import type { PlayerPresenceService } from '../player-presence'
import {
  FAT32_MAX_FILE_SIZE,
  MERGE_TMP_SUFFIX,
  TMP_SUFFIX,
  TOO_LARGE_REASON,
  TooLargeError,
  VerifyError,
  adoptVerified,
  copyVerified,
  errnoOf,
  isTooLargeForFilesystem,
  unlinkQuiet,
  writeSmallFile,
  type ExportFs
} from './copy'
import { locateLibrary } from './locate'
import type { ResolvedItem } from './plan'
import {
  evaluatePrefetchItem,
  type PrefetchDecision,
  type PrefetchMemory,
  type PrefetchRow
} from './prefetch-readiness'
import { writeTitleSnapshot } from './snapshot'

/** No room left on the target for a pre-fetched file, measured at its copy (#577). */
export const NO_SPACE_ON_DRIVE = 'Not enough space on the drive'

/** One planned item: its names on the drive are fixed at start, so a resume never renames. */
export interface JobItem {
  key: string
  animeId: number
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  quality: number
  label: string
  path: string
  subtitlePath?: string
  renamed: boolean
  videoSize: number
  subtitleSize: number
  /** An unmerged pair merged into the `.mkv` at `path` (#576); `videoSize` is the pair's sum. */
  merge?: boolean
  /** Planned from a pre-fetched item (#577) when it became ready; `pair` when it came unmerged. */
  prefetch?: { pair: boolean }
}

/** A not-downloaded episode the job enqueued (#577); planned into `items` once it is ready. */
export interface PrefetchRecord {
  key: string
  animeId: number
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  /** The download folder's name (`romaji || ru || title`), as enqueued. */
  animeName: string
  label: string
  /** The estimate at start, or null when unknown. */
  sizeEstimate: number | null
  /** `planned`: in `items`, copied by the same step as a downloaded item. */
  state: 'waiting' | 'planned'
  /** When its downloads were first seen finished: the cancelled-merge grace counts from it. */
  doneAt?: number
  warning?: string
}

/** The download queue and merge state a pre-fetch waits on (#577). */
export interface PrefetchJobDeps {
  row: (id: string) => PrefetchRow | null
  mergeStatus: (translationId: number) => MergeStatus | null
  /** `isMergeExpected`, after `ffmpegReady`: re-read at every evaluation. */
  mergeExpected: () => Promise<boolean>
  /** `isMergeCycleActive() || hasHeldMerge()`; the job adds the player. */
  mergeInFlight: () => boolean
  /** Whether the item's `.mkv` and final `.mp4` are in the hot or cold root. */
  files: (p: PrefetchRecord) => Promise<{ mkv: boolean; video: boolean }>
  isOffline: () => boolean
  now: () => number
  /** Listener lists (#574): each returns its unsubscribe. */
  onVideoDownloaded: (cb: () => void) => () => void
  onMergeComplete: (cb: () => void) => () => void
  tickMs: number
}

/** One export merge, as the job asks for it (#576); `DownloadManager.mergeForExport` runs it. */
export interface ExportMergeRequest {
  jobId: string
  videoPath: string
  subtitlePath: string | null
  outputPath: string
  codec: string
  subMeta?: { language: string; title: string }
  onPercent?: (pct: number) => void
  onWaiting?: () => void
  onAcquired?: () => void
}

/** The download manager's ffmpeg, as the export uses it (#576). */
export interface ExportMerger {
  /** `'held'`: a player view is open; `'gone'`: the `.mp4` went while it waited. */
  merge: (req: ExportMergeRequest) => Promise<'done' | 'held' | 'gone'>
  /** Stops `jobId`'s merge, running or waiting. */
  cancel: (jobId: string) => void
}

/** `userData/export-jobs/<jobId>.json`. */
export interface JobRecord {
  version: 1
  jobId: string
  libraryId: string
  libraryName: string
  root: string
  createdAt: number
  status: ExportJobStatus
  items: JobItem[]
  titles: SharedLibraryTitle[]
  /** Finished files by their relative path. */
  doneFiles: Record<string, { size: number; sha256: string }>
  /** Item keys whose files are all done; these are the ones in the manifest. */
  done: string[]
  failed: Record<string, string>
  /** Items too large for the drive (#575): by preflight (not in `items`) or at run time. */
  skipped?: Record<string, { animeId: number; label: string; reason: string }>
  /** The target's filesystem at start (#575), for the run-time size rule. */
  fsType?: ExportFsType
  /** How unmerged pairs go (#576); `merge` items carry `merge: true`. */
  unmerged?: ExportUnmergedMode
  /** The merge's video codec (#576): `copy` unless a re-encode was chosen. */
  codec?: string
  /** By item key, the pair each finished merge read and the `.mkv` it wrote (#623): the item's `source`. */
  sources?: Record<string, SharedLibraryItemSource>
  /** The file being copied, so a resume deletes its `.anime-dl-tmp`. */
  current: { key: string; rel: string } | null
  missing: number
  /** Not-downloaded episodes this job enqueued (#577). */
  prefetch?: PrefetchRecord[]
  /** Titles whose `meta` and poster this job already wrote. */
  snapshotted: number[]
  note: string | null
  /** The note a drive-gone note replaced (the foreign-sibling one), restored when the drive is back. */
  noteBeforeDriveGone?: string | null
  /** The "Found at" / "Resumed at" line last appended to the note, so the next one replaces exactly it. */
  noteWhere?: string
  error: string | null
}

export interface JobDeps {
  xfs: ExportFs
  presence: Pick<PlayerPresenceService, 'isOpen' | 'onRelease'>
  actor: () => SharedLibraryActor
  /** Re-resolves an item's source just before its copy (an auto-move may have moved it). */
  resolve: (item: ExportSelectionItem) => Promise<ResolvedItem | 'missing' | 'busy'>
  snapshot: (animeId: number) => { meta: SharedLibraryMeta; posterFile: string | null }
  candidates: MountCandidates
  persist: (rec: JobRecord) => Promise<void>
  /** `bytesDone` includes the file in flight. */
  update: (rec: JobRecord, bytesDone: number) => void
  checkpointEvery: number
  /** After each manifest write, fire-and-forget: it can never fail or stall the job (#616). */
  onLibraryWritten?: (libraryId: string, root: string) => void | Promise<void>
  retryMs: number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Runs `merge` items (#576); without it they fail. */
  merger?: ExportMerger
  /** Pre-fetch (#577); without it, waiting items stay waiting. */
  prefetch?: PrefetchJobDeps
}

class DriveGoneError extends Error {}

/** The note a lost drive leaves on the job; cleared once a run finds the library again. */
const DRIVE_GONE_NOTE = 'The drive went away: '

const isTerminal = (s: ExportJobStatus): boolean =>
  s === 'completed' || s === 'cancelled' || s === 'failed'

export function jobFiles(rec: JobRecord): { rel: string; size: number; item: JobItem }[] {
  const out: { rel: string; size: number; item: JobItem }[] = []
  for (const item of rec.items) {
    out.push({ rel: item.path, size: item.videoSize, item })
    if (item.subtitlePath) out.push({ rel: item.subtitlePath, size: item.subtitleSize, item })
  }
  return out
}

export class ExportJob {
  private current: Promise<void> | null = null
  private stop: 'pause' | 'cancel' | null = null
  private copyAbort: AbortController | null = null
  private wake: (() => void) | null = null
  private retryTimer: unknown = null
  private inFlight = 0
  private generation = 0
  private base: SharedLibraryManifest | null = null
  private signature: string | null = null
  private sinceCheckpoint = 0
  private mergeNow: ExportMergeState | null = null
  // Pre-fetch (#577): what each waiting item carries between evaluations, and
  // its last decision (for the card).
  private prefetchMemo = new Map<string, PrefetchMemory>()
  private prefetchLast = new Map<string, PrefetchDecision>()

  constructor(
    readonly rec: JobRecord,
    private readonly deps: JobDeps
  ) {}

  get status(): ExportJobStatus {
    return this.rec.status
  }

  isActive(): boolean {
    return this.current !== null || this.rec.status === 'waiting-drive'
  }

  /** The run in progress, or null. */
  running(): Promise<void> | null {
    return this.current
  }

  /** The merge in flight (#576): waiting for the ffmpeg mutex, or merging; null while copying. */
  mergeState(): ExportMergeState | null {
    return this.mergeNow
  }

  bytesDone(): number {
    let n = this.inFlight
    for (const f of Object.values(this.rec.doneFiles)) n += f.size
    return n
  }

  /** Starts (or resumes) the run; resolves when it stops, for any reason. */
  run(): Promise<void> {
    if (isTerminal(this.rec.status)) return Promise.resolve()
    if (!this.current) {
      this.stop = null
      this.current = this.loop().finally(() => {
        this.current = null
      })
    }
    return this.current
  }

  /** Stops after aborting the file in flight; the job shows as paused. */
  pause(): Promise<void> {
    return this.halt('pause')
  }

  /** Stops, checkpoints what finished, and ends the job. */
  cancel(): Promise<void> {
    return this.halt('cancel')
  }

  private async halt(kind: 'pause' | 'cancel'): Promise<void> {
    this.disarmRetry()
    if (this.current) {
      this.stop = kind
      this.copyAbort?.abort()
      this.wake?.()
      await this.current
      return
    }
    if (isTerminal(this.rec.status)) return
    await this.setStatus(kind === 'pause' ? 'paused' : 'cancelled')
  }

  /** "Locate…": the caller checked that `root` holds this job's library; `run()` resumes there. */
  async relocate(root: string): Promise<void> {
    this.disarmRetry()
    this.rec.root = root
    const before = this.rec.note?.startsWith(DRIVE_GONE_NOTE)
      ? this.takeNoteBeforeDriveGone()
      : this.rec.note
    this.rec.note = this.withWhere(before, `Found at ${root}`)
    await this.deps.persist(this.rec)
  }

  /**
   * `line` after `before`. An earlier "Found at" / "Resumed at" line is
   * dropped first, so re-plugs don't stack, but only the exact line this job
   * appended (`noteWhere`): text inside the base note, such as a foreign
   * owner's nickname, is never matched.
   */
  private withWhere(before: string | null, line: string): string {
    const last = this.rec.noteWhere
    let base = before ?? ''
    if (last !== undefined && base.endsWith(last)) base = base.slice(0, -last.length).trimEnd()
    this.rec.noteWhere = line
    return base ? `${base} ${line}` : line
  }

  /** The note a drive-gone note replaced, now taken off the record. */
  private takeNoteBeforeDriveGone(): string | null {
    const note = this.rec.noteBeforeDriveGone ?? null
    delete this.rec.noteBeforeDriveGone
    return note
  }

  private async setStatus(status: ExportJobStatus): Promise<void> {
    this.rec.status = status
    await this.deps.persist(this.rec)
    this.deps.update(this.rec, this.bytesDone())
  }

  private armRetry(): void {
    if (this.retryTimer !== null) return
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null
      void this.run()
    }, this.deps.retryMs)
  }

  private disarmRetry(): void {
    if (this.retryTimer === null) return
    this.deps.clearTimer(this.retryTimer)
    this.retryTimer = null
  }

  /** Re-arms the 10 s retry while waiting for the drive. */
  retryNow(): Promise<void> {
    this.disarmRetry()
    return this.run()
  }

  private async manifestSignature(): Promise<string | null> {
    try {
      const st = await this.deps.xfs.stat(path.join(this.rec.root, LIBRARY_DIR, MANIFEST))
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
    } catch {
      return null
    }
  }

  /**
   * Whether the root still holds this job's library. A `stat` of the manifest
   * when it is the file the job last read or wrote; a full read when it changed.
   */
  private async identityOk(): Promise<boolean> {
    const sig = await this.manifestSignature()
    if (sig === null) return false
    if (sig === this.signature) return true
    const r = await readLibrary(this.rec.root).catch(() => null)
    if (!r || r.status === 'none' || r.manifest?.libraryId !== this.rec.libraryId) return false
    if (r.status === 'ok') {
      this.base = r.manifest
      this.generation = r.manifest.generation
    }
    this.signature = sig
    return true
  }

  private async loadBase(): Promise<void> {
    const r = await readLibrary(this.rec.root)
    if (r.status === 'none' || r.manifest?.libraryId !== this.rec.libraryId) {
      throw new DriveGoneError('the library is not at its root')
    }
    if (r.status === 'read-only') throw new LibraryReadOnlyError(r.reason, r.message)
    this.base = r.manifest
    this.generation = r.manifest.generation
    this.signature = await this.manifestSignature()
  }

  private nextManifest(): SharedLibraryManifestInput {
    const base = this.base!
    const done = new Set(this.rec.done)
    const ours = new Map<string, SharedLibraryItem>()
    for (const item of this.rec.items) {
      if (!done.has(item.key)) continue
      const video = this.rec.doneFiles[item.path]
      const out: SharedLibraryItem = {
        animeId: item.animeId,
        episodeInt: item.episodeInt,
        translationId: item.translationId,
        translationType: item.translationType,
        author: item.author,
        quality: item.quality,
        path: item.path,
        size: video.size,
        sha256: video.sha256
      }
      if (item.subtitlePath) out.subtitlePath = item.subtitlePath
      const source = this.rec.sources?.[item.key]
      if (source) out.source = source
      ours.set(item.key, out)
    }
    const items: SharedLibraryItem[] = []
    for (const item of base.items) {
      const key = itemKey(item)
      items.push(ours.get(key) ?? item)
      ours.delete(key)
    }
    items.push(...ours.values())

    const titles = [...base.titles]
    const inScope = new Set(titles.map((t) => t.animeId))
    const doneTitles = new Set(this.rec.items.filter((i) => done.has(i.key)).map((i) => i.animeId))
    for (const t of this.rec.titles) {
      if (doneTitles.has(t.animeId) && !inScope.has(t.animeId)) titles.push(t)
    }

    const ourKeys = new Set(this.rec.items.filter((i) => done.has(i.key)).map((i) => i.key))
    const renamed = (base.naming?.renamed ?? []).filter((k) => !ourKeys.has(k))
    for (const i of this.rec.items) if (ourKeys.has(i.key) && i.renamed) renamed.push(i.key)

    return {
      libraryId: base.libraryId,
      name: base.name ?? this.rec.libraryName,
      owner: base.owner,
      mode: base.mode,
      titles,
      items,
      naming: { rule: 'v1', renamed }
    }
  }

  /** Writes the manifest with every finished item, plus `index.html` when a name changed. */
  private async checkpoint(): Promise<void> {
    if (!this.base) return
    for (let attempt = 0; ; attempt++) {
      const next = this.nextManifest()
      try {
        const r = await writeManifest(this.rec.root, next, this.deps.actor(), this.generation)
        this.generation = r.generation
        this.base = {
          ...this.base,
          ...next,
          generation: r.generation,
          stateGeneration: r.stateGeneration,
          layoutMinor: this.base.layoutMinor,
          layoutVersion: 1
        }
        this.libraryWritten()
        this.signature = await this.manifestSignature()
        this.sinceCheckpoint = 0
        const html = renderIndexHtml(this.base)
        if (html !== null) {
          await writeSmallFile(this.deps.xfs, path.join(this.rec.root, 'index.html'), html)
        }
        return
      } catch (err) {
        if (err instanceof StaleGenerationError && attempt === 0) {
          await this.loadBase()
          continue
        }
        if (err instanceof LibraryIdMismatchError || err instanceof LibraryNotFoundError) {
          throw new DriveGoneError(err.message)
        }
        throw err
      }
    }
  }

  private libraryWritten(): void {
    const hook = this.deps.onLibraryWritten
    if (!hook) return
    const { libraryId, root } = this.rec
    void Promise.resolve()
      .then(() => hook(libraryId, root))
      .catch((err) => console.warn(`[export] refreshing ${libraryId} failed:`, err))
  }

  private async holdWhilePlayerOpen(): Promise<void> {
    while (this.deps.presence.isOpen() && !this.stop) {
      if (this.rec.status !== 'held') {
        // A release or a pause can land while this persists, before `wake`
        // exists: re-check both before waiting.
        await this.setStatus('held')
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = null
    }
  }

  private async snapshotTitle(animeId: number): Promise<void> {
    if (this.rec.snapshotted.includes(animeId)) return
    const { meta, posterFile } = this.deps.snapshot(animeId)
    try {
      await writeTitleSnapshot(this.deps.xfs, this.rec.root, meta, posterFile)
    } catch (err) {
      // A pulled drive isn't a snapshot failure: the title stays unmarked and
      // the resume retries it. Decided as `copyItem`'s failures are, by whether
      // the root still holds this library, not by errno: a plain file at
      // `.anime-dl/meta` gives ENOTDIR with the drive plugged in.
      if (!(await this.identityOk())) throw new DriveGoneError((err as Error).message)
      console.warn(`[export] snapshot of ${animeId} failed:`, err)
    }
    this.rec.snapshotted.push(animeId)
  }

  private async copyItem(item: JobItem, source: ResolvedItem): Promise<void> {
    const files: { rel: string; src: string }[] = [{ rel: item.path, src: source.videoPath }]
    if (item.subtitlePath) {
      if (!source.subtitlePath) throw new Error('the subtitle sidecar is gone')
      files.push({ rel: item.subtitlePath, src: source.subtitlePath })
    }
    for (const f of files) {
      if (this.rec.doneFiles[f.rel]) continue
      // A pause or cancel that came in after the last check doesn't wait out a whole file.
      if (this.stop) {
        const stopped = new Error('stopped')
        stopped.name = 'AbortError'
        throw stopped
      }
      const dest = await resolveWriteTarget(this.rec.root, f.rel)
      if (dest === 'escapes') throw new EscapeError(f.rel)
      this.rec.current = { key: item.key, rel: f.rel }
      await this.deps.persist(this.rec)
      this.copyAbort = new AbortController()
      this.inFlight = 0
      const result = await copyVerified(this.deps.xfs, f.src, dest, {
        signal: this.copyAbort.signal,
        fsType: this.rec.fsType,
        onBytes: (n) => {
          this.inFlight += n
          this.deps.update(this.rec, this.bytesDone())
        }
      })
      this.inFlight = 0
      this.copyAbort = null
      this.rec.doneFiles[f.rel] = result
      this.rec.current = null
      await this.deps.persist(this.rec)
    }
  }

  /**
   * A merge item (#576): the `.mp4` + `.ass` pair goes through the download
   * manager's ffmpeg into `<dest>.anime-dl-tmp.mkv` on the target, then gets
   * the same rename and verify as a copy. The local files are never touched.
   * Waits for the ffmpeg mutex, and for the player while it is open.
   */
  private async mergeItem(item: JobItem, first: ResolvedItem): Promise<void> {
    if (this.rec.doneFiles[item.path]) return
    let source = first
    for (let gone = 0; ; ) {
      // A download merge turned the pair into an `.mkv` meanwhile: copy that.
      if (source.ext === '.mkv') return this.copyItem(item, source)
      if (this.stop) throw stoppedError()
      const merger = this.deps.merger
      if (!merger) throw new Error('merging needs ffmpeg, which this PC doesn’t have')
      const dest = await resolveWriteTarget(this.rec.root, item.path)
      if (dest === 'escapes') throw new EscapeError(item.path)
      this.rec.current = { key: item.key, rel: item.path }
      await this.deps.persist(this.rec)
      try {
        await this.deps.xfs.mkdir(path.dirname(dest))
      } catch (err) {
        if (errnoOf(err) !== 'EEXIST') throw err
      }
      const tmp = `${dest}${MERGE_TMP_SUFFIX}`
      await unlinkQuiet(this.deps.xfs, tmp)

      // The awaits above are a window a Pause or Cancel can land in before
      // `copyAbort` exists: checked again here, synchronously up to the merger's wait.
      if (this.stop) throw stoppedError()
      const abort = new AbortController()
      this.copyAbort = abort
      const onAbort = (): void => merger.cancel(this.rec.jobId)
      abort.signal.addEventListener('abort', onAbort)
      const show = (state: ExportMergeState | null): void => {
        this.mergeNow = state
        this.inFlight = state ? Math.round((state.percent / 100) * item.videoSize) : 0
        this.deps.update(this.rec, this.bytesDone())
      }
      let outcome: 'done' | 'held' | 'gone'
      try {
        outcome = await merger.merge({
          jobId: this.rec.jobId,
          videoPath: source.videoPath,
          subtitlePath: source.subtitlePath,
          outputPath: tmp,
          codec: this.rec.codec ?? 'copy',
          ...(source.subtitlePath !== null
            ? { subMeta: subtitleMeta(item.translationType, item.author) }
            : {}),
          onWaiting: () => show({ phase: 'waiting', percent: 0 }),
          onAcquired: () => show({ phase: 'merging', percent: 0 }),
          onPercent: (percent) => show({ phase: 'merging', percent })
        })
      } catch (err) {
        if ((err as Error).name === 'MergeQuitError') throw err
        const partial = abort.signal.aborted
          ? null
          : await this.deps.xfs.stat(tmp).then(
              (s) => s.size,
              () => null
            )
        await unlinkQuiet(this.deps.xfs, tmp).catch(() => {})
        if (abort.signal.aborted) throw stoppedError()
        // #575's run-time rule: a re-encode that still outgrew FAT32 is skipped.
        if (isTooLargeForFilesystem(err, this.rec.fsType ?? 'unknown', partial)) {
          throw new TooLargeError(err instanceof Error ? err.message : String(err))
        }
        throw err
      } finally {
        abort.signal.removeEventListener('abort', onAbort)
        this.copyAbort = null
        show(null)
      }

      if (outcome === 'held') {
        await this.holdWhilePlayerOpen()
        if (this.stop) throw stoppedError()
        if (this.rec.status !== 'running') await this.setStatus('running')
        continue
      }
      if (outcome === 'gone') {
        const again = await this.deps.resolve(item)
        if (typeof again !== 'object' || ++gone > 2) throw new Error('the source file is gone')
        source = again
        continue
      }
      if (abort.signal.aborted) {
        await unlinkQuiet(this.deps.xfs, tmp).catch(() => {})
        throw stoppedError()
      }
      const written = await adoptVerified(this.deps.xfs, tmp, dest)
      this.rec.doneFiles[item.path] = written
      // What this merge read, not what the job planned at start (#623).
      this.rec.sources = {
        ...this.rec.sources,
        [item.key]: {
          size: source.videoSize,
          subtitleSize: source.subtitleSize,
          codec: this.rec.codec ?? 'copy',
          outputSize: written.size
        }
      }
      this.rec.current = null
      await this.deps.persist(this.rec)
      return
    }
  }

  /** Pre-fetched items still waiting for their downloads or a merge (#577). */
  private waitingPrefetch(): PrefetchRecord[] {
    return (this.rec.prefetch ?? []).filter(
      (p) => p.state === 'waiting' && !this.rec.failed[p.key] && !this.rec.skipped?.[p.key]
    )
  }

  private prefetchOf(item: JobItem): PrefetchRecord | undefined {
    return item.prefetch ? this.rec.prefetch?.find((p) => p.key === item.key) : undefined
  }

  /**
   * `evaluatePrefetchItem` on the state read now: the awaited reads first (the
   * merge predicate, after `ffmpegReady`, and the files), then the queue and
   * merge state synchronously, so a status that changed meanwhile wins.
   */
  private async evaluate(p: PrefetchRecord): Promise<PrefetchDecision> {
    const pf = this.deps.prefetch!
    const mergeExpected = await pf.mergeExpected()
    const files = await pf.files(p)
    const memo =
      this.prefetchMemo.get(p.key) ?? (p.doneAt !== undefined ? { doneAt: p.doneAt } : {})
    const { decision, memory } = evaluatePrefetchItem(
      {
        video: pf.row(`video-${p.translationId}`),
        subtitle: pf.row(`sub-${p.translationId}`),
        mergeStatus: pf.mergeStatus(p.translationId),
        mergeExpected,
        mergeInFlight: pf.mergeInFlight() || this.deps.presence.isOpen(),
        files,
        offline: pf.isOffline(),
        now: pf.now()
      },
      memo
    )
    this.prefetchMemo.set(p.key, memory)
    if (memory.doneAt !== undefined) p.doneAt = memory.doneAt
    this.prefetchLast.set(p.key, decision)
    return decision
  }

  /**
   * A ready item, planned exactly like a downloaded one: resolved on disk,
   * named by S5's rule against the library and this job's other items, and
   * appended to `items` for the same per-item step (#577).
   */
  private async planPrefetch(
    p: PrefetchRecord,
    d: Extract<PrefetchDecision, { kind: 'ready' }>
  ): Promise<boolean> {
    const r = await this.deps.resolve(p)
    // A merge started since the decision: the next evaluation waits for it.
    if (r === 'busy') return false
    if (r === 'missing') {
      this.rec.failed[p.key] = 'the source file is gone'
      return false
    }
    if ((d.as === 'mkv') !== (r.ext === '.mkv')) return false
    const merge = this.rec.unmerged === 'merge' && r.subtitlePath !== null
    const reencode = merge && (this.rec.codec ?? 'copy') !== 'copy'
    const size = merge ? r.videoSize + r.subtitleSize : Math.max(r.videoSize, r.subtitleSize)
    if (this.rec.fsType === 'fat32' && size > FAT32_MAX_FILE_SIZE && !reencode) {
      this.rec.skipped = {
        ...this.rec.skipped,
        [p.key]: { animeId: p.animeId, label: p.label, reason: TOO_LARGE_REASON }
      }
      return false
    }
    const taken = [
      ...(this.base?.items ?? []).filter((i) => itemKey(i) !== p.key),
      ...this.rec.items.filter((i) => i.key !== p.key)
    ]
    const [named] = nameItems(
      [
        {
          animeId: p.animeId,
          episodeInt: p.episodeInt,
          translationId: p.translationId,
          title: r.title,
          author: r.author,
          ext: merge ? '.mkv' : r.ext,
          subtitle: !merge && r.subtitlePath !== null
        }
      ],
      taken
    )
    this.rec.items.push({
      key: p.key,
      animeId: p.animeId,
      episodeInt: p.episodeInt,
      translationId: p.translationId,
      translationType: r.translationType,
      author: r.author,
      quality: r.quality,
      label: p.label,
      path: named.path,
      ...(named.subtitlePath !== undefined ? { subtitlePath: named.subtitlePath } : {}),
      renamed: named.renamed,
      ...(merge
        ? { videoSize: r.videoSize + r.subtitleSize, subtitleSize: 0, merge: true }
        : { videoSize: r.videoSize, subtitleSize: r.subtitleSize }),
      prefetch: { pair: d.as === 'pair' }
    })
    p.state = 'planned'
    if (d.warning) p.warning = d.warning
    return true
  }

  /** Puts a planned item back to waiting, deleting what it copied (#577): a merge started under it. */
  private async unplan(item: JobItem): Promise<void> {
    for (const rel of [item.path, item.subtitlePath]) {
      if (rel === undefined) continue
      delete this.rec.doneFiles[rel]
      const dest = await resolveWriteTarget(this.rec.root, rel).catch(() => 'escapes' as const)
      if (dest !== 'escapes') await unlinkQuiet(this.deps.xfs, dest).catch(() => {})
    }
    if (this.rec.sources?.[item.key]) {
      const rest = { ...this.rec.sources }
      delete rest[item.key]
      this.rec.sources = rest
    }
    this.rec.items = this.rec.items.filter((i) => i !== item)
    const p = this.prefetchOf(item)
    if (p) p.state = 'waiting'
    this.prefetchMemo.set(item.key, { doneAt: p?.doneAt })
    this.rec.current = null
    await this.deps.persist(this.rec)
  }

  /**
   * Evaluates every waiting pre-fetch item and plans the ready ones (#577).
   * Waits one tick when nothing became ready; false once nothing waits.
   */
  private async prefetchStep(): Promise<boolean> {
    const waiting = this.waitingPrefetch()
    if (waiting.length === 0 || !this.deps.prefetch) return false
    let planned = false
    // Saved only when something changed: an item waiting for hours is evaluated every tick.
    let dirty = false
    for (const p of waiting) {
      if (this.stop) return true
      const doneAt = p.doneAt
      const d = await this.evaluate(p)
      if (d.kind !== 'wait' || p.doneAt !== doneAt) dirty = true
      if (d.kind === 'failed') this.rec.failed[p.key] = d.reason
      else if (d.kind === 'ready' && (await this.planPrefetch(p, d))) planned = true
    }
    if (dirty) await this.deps.persist(this.rec)
    this.deps.update(this.rec, this.bytesDone())
    if (planned) return true
    if (this.waitingPrefetch().length === 0) return false
    await this.prefetchTick()
    return true
  }

  /** One tick: `tickMs`, cut short by a download or merge event, the player's release, or a stop. */
  private prefetchTick(): Promise<void> {
    if (this.stop) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = this.deps.setTimer(() => {
        this.wake = null
        resolve()
      }, this.deps.prefetch!.tickMs)
      this.wake = () => {
        this.wake = null
        this.deps.clearTimer(timer)
        resolve()
      }
    })
  }

  /** The events only make the next evaluation sooner: they wake the tick (#577). */
  private subscribePrefetch(): () => void {
    const pf = this.deps.prefetch
    if (!pf || !this.rec.prefetch?.some((p) => !this.rec.done.includes(p.key))) return () => {}
    const wake = (): void => this.wake?.()
    const offs = [pf.onVideoDownloaded(wake), pf.onMergeComplete(wake)]
    return () => offs.forEach((off) => off())
  }

  /**
   * At boot (#577): the same evaluation for every waiting item, so the card
   * shows where each one is and a download that failed or left the queue fails
   * its item. Plans nothing, and stops if a run started meanwhile.
   */
  async refreshPrefetch(): Promise<void> {
    if (!this.deps.prefetch || this.current) return
    const decisions: [PrefetchRecord, PrefetchDecision][] = []
    for (const p of this.waitingPrefetch()) {
      const d = await this.evaluate(p)
      if (this.current) return
      decisions.push([p, d])
    }
    for (const [p, d] of decisions) if (d.kind === 'failed') this.rec.failed[p.key] = d.reason
    await this.deps.persist(this.rec)
    this.deps.update(this.rec, this.bytesDone())
  }

  /** The pre-fetched items as the card shows them (#577). */
  prefetchView(): ExportPrefetchView[] {
    const done = new Set(this.rec.done)
    return (this.rec.prefetch ?? []).map((p) => {
      const base = { key: p.key, label: p.label, percent: 0, warning: p.warning ?? null }
      if (done.has(p.key)) return { ...base, state: 'done' as const }
      if (this.rec.failed[p.key] || this.rec.skipped?.[p.key]) {
        return { ...base, state: 'failed' as const }
      }
      if (p.state === 'planned') return { ...base, state: 'copying' as const }
      const d = this.prefetchLast.get(p.key)
      if (d?.kind !== 'wait' || d.on === 'download') {
        const row = this.deps.prefetch?.row(`video-${p.translationId}`)
        if (row?.status === 'downloading') {
          const percent =
            row.totalBytes > 0 ? Math.floor((row.bytesReceived / row.totalBytes) * 100) : 0
          return { ...base, state: 'downloading' as const, percent }
        }
        return { ...base, state: 'waiting-download' as const }
      }
      return {
        ...base,
        state: d.on === 'connection' ? ('waiting-connection' as const) : ('waiting-merge' as const)
      }
    })
  }

  /** Deletes the `.anime-dl-tmp` (or a merge's `.anime-dl-tmp.mkv`) a crash or a kill left behind. */
  private async dropLeftoverTmp(): Promise<void> {
    const cur = this.rec.current
    if (!cur) return
    const dest = await resolveWriteTarget(this.rec.root, cur.rel).catch(() => 'escapes' as const)
    if (dest !== 'escapes') {
      try {
        await unlinkQuiet(this.deps.xfs, `${dest}${TMP_SUFFIX}`)
        await unlinkQuiet(this.deps.xfs, `${dest}${MERGE_TMP_SUFFIX}`)
      } catch (err) {
        // A plain file where the folder was: no tmp can be under it.
        if (errnoOf(err) !== 'ENOTDIR') throw err
      }
    }
    this.rec.current = null
  }

  /** Copies (or merges) every planned item not yet done; `quit` when the app quit under a merge. */
  private async copyPlanned(): Promise<'quit' | 'stopped' | 'done'> {
    const done = new Set(this.rec.done)
    for (const item of [...this.rec.items]) {
      // Only a pre-fetched item can leave `items` (`unplan`).
      if (item.prefetch && !this.rec.items.includes(item)) continue
      if (done.has(item.key) || this.rec.failed[item.key] || this.rec.skipped?.[item.key]) continue
      await this.holdWhilePlayerOpen()
      if (this.stop) return 'stopped'
      if (this.rec.status !== 'running') await this.setStatus('running')
      if (!(await this.identityOk())) throw new DriveGoneError('the library is not at its root')
      const pre = this.prefetchOf(item)
      // A pre-fetched pair is checked again just before its copy: a merge may
      // have started on it since it was planned (#577).
      if (pre && item.prefetch?.pair && this.deps.prefetch) {
        const d = await this.evaluate(pre)
        if (this.stop) return 'stopped'
        if (d.kind !== 'ready' || d.as !== 'pair') {
          await this.unplan(item)
          continue
        }
      }
      let source = await this.deps.resolve(item)
      if (source === 'busy' && pre) {
        await this.unplan(item)
        continue
      }
      if (source === 'missing' || source === 'busy') {
        this.rec.failed[item.key] =
          source === 'busy' ? 'busy merging or downloading' : 'the source file is gone'
        continue
      }
      if (pre && !(await this.roomFor(item, source))) {
        this.rec.failed[item.key] = NO_SPACE_ON_DRIVE
        continue
      }
      await this.snapshotTitle(item.animeId)
      try {
        try {
          if (item.merge) await this.mergeItem(item, source)
          else await this.copyItem(item, source)
        } catch (err) {
          // A pre-fetched source an auto-move took to cold mid-copy: found
          // again and copied once more (#577).
          if (!pre || errnoOf(err) !== 'ENOENT' || (await this.sourceThere(source))) throw err
          const again = await this.deps.resolve(item)
          if (typeof again !== 'object') throw err
          source = again
          if (item.merge) await this.mergeItem(item, source)
          else await this.copyItem(item, source)
        }
      } catch (err) {
        // Quit (#576): `destroy()` killed the merge and deleted its output.
        // Nothing is recorded; the next boot shows the job paused.
        if ((err as Error).name === 'MergeQuitError') return 'quit'
        if ((err as Error).name === 'AbortError') {
          this.inFlight = 0
          this.copyAbort = null
          return 'stopped'
        }
        if (err instanceof EscapeError) {
          console.warn(`[export] skipped ${item.key}: ${err.message}`)
          this.rec.failed[item.key] = err.message
          continue
        }
        if (err instanceof TooLargeError) {
          console.warn(`[export] skipped ${item.key}, too large for the drive: ${err.message}`)
          this.rec.skipped = {
            ...this.rec.skipped,
            [item.key]: { animeId: item.animeId, label: item.label, reason: TOO_LARGE_REASON }
          }
          this.rec.current = null
          continue
        }
        if (!(await this.identityOk())) throw new DriveGoneError((err as Error).message)
        this.rec.failed[item.key] =
          err instanceof VerifyError ? `verify failed: ${err.message}` : (err as Error).message
        this.rec.current = null
        continue
      }
      // After a pre-fetched pair's copy and before the manifest has it: a merge
      // that started meanwhile unlinks the pair, so its files leave the target
      // and the item waits for the `.mkv` (#577).
      if (pre && item.prefetch?.pair && this.deps.prefetch) {
        const status = this.deps.prefetch.mergeStatus(item.translationId)
        if (status === 'merging' || status === 'completed' || !(await this.sourceThere(source))) {
          await this.unplan(item)
          continue
        }
      }
      this.rec.done.push(item.key)
      done.add(item.key)
      this.sinceCheckpoint++
      if (this.sinceCheckpoint >= this.deps.checkpointEvery) await this.checkpoint()
    }
    return 'done'
  }

  /** Whether the source's files are all still on this PC. */
  private async sourceThere(source: ResolvedItem): Promise<boolean> {
    for (const p of [source.videoPath, source.subtitlePath]) {
      if (p === null) continue
      try {
        await this.deps.xfs.stat(p)
      } catch {
        return false
      }
    }
    return true
  }

  /** A pre-fetched item's real size against the target's free space, just before its copy (#577). */
  private async roomFor(item: JobItem, source: ResolvedItem): Promise<boolean> {
    let need = 0
    if (!this.rec.doneFiles[item.path]) {
      need += item.merge ? source.videoSize + source.subtitleSize : source.videoSize
    }
    if (item.subtitlePath && !this.rec.doneFiles[item.subtitlePath]) need += source.subtitleSize
    try {
      const s = await this.deps.xfs.statfs(this.rec.root)
      return need <= s.bavail * s.bsize
    } catch {
      return true
    }
  }

  private async loop(): Promise<void> {
    const off = this.deps.presence.onRelease(() => this.wake?.())
    try {
      const found = await locateLibrary(this.rec.libraryId, this.rec.root, this.deps.candidates)
      if (!found) {
        if (this.stop) return
        await this.setStatus('waiting-drive')
        this.armRetry()
        return
      }
      this.disarmRetry()
      // The drive is back: a note saying it went away is no longer true, and
      // the note it replaced (the foreign-sibling one) comes back.
      if (this.rec.note?.startsWith(DRIVE_GONE_NOTE)) this.rec.note = this.takeNoteBeforeDriveGone()
      if (found.moved) {
        this.rec.root = found.root
        this.rec.note = this.withWhere(
          this.rec.note,
          `Resumed at ${found.root}` +
            (found.duplicates.length > 0
              ? `; the same library is also at ${found.duplicates.join(', ')}`
              : '')
        )
      }
      await this.loadBase()
      await this.dropLeftoverTmp()
      await this.setStatus('running')

      // Downloaded items first; then, while pre-fetched ones (#577) wait, each
      // one that becomes ready is planned and goes through the same step.
      const offPrefetch = this.subscribePrefetch()
      try {
        for (;;) {
          if ((await this.copyPlanned()) === 'quit') return
          if (this.stop) break
          if (!(await this.prefetchStep())) break
          if (this.stop) break
        }
      } finally {
        offPrefetch()
      }
      await this.dropLeftoverTmp()
      await this.checkpoint()
      if (this.stop === 'pause') await this.setStatus('paused')
      else if (this.stop === 'cancel') await this.setStatus('cancelled')
      else await this.setStatus('completed')
    } catch (err) {
      this.inFlight = 0
      this.copyAbort = null
      // An errno alone isn't a lost drive (ENOTDIR from a plain file in the
      // library, ENOENT from a vanished source): the root must have lost it too.
      if (err instanceof DriveGoneError || (isDriveError(err) && !(await this.identityOk()))) {
        if (this.stop) {
          await this.setStatus(this.stop === 'pause' ? 'paused' : 'cancelled')
          return
        }
        // Keep the note this replaces (persisted with the job), unless it is
        // already a drive-gone note from an earlier pull.
        if (!this.rec.note?.startsWith(DRIVE_GONE_NOTE))
          this.rec.noteBeforeDriveGone = this.rec.note
        this.rec.note = `${DRIVE_GONE_NOTE}${(err as Error).message}`
        await this.setStatus('waiting-drive')
        this.armRetry()
        return
      }
      this.rec.error = err instanceof Error ? err.message : String(err)
      await this.setStatus('failed')
    } finally {
      off()
    }
  }
}

function stoppedError(): Error {
  const err = new Error('stopped')
  err.name = 'AbortError'
  return err
}

class EscapeError extends Error {
  constructor(rel: string) {
    super(`${rel} leads outside the library (a symlink)`)
  }
}

const DRIVE_ERRNOS = new Set(['ENOENT', 'ENODEV', 'EIO', 'ENXIO', 'ENOTDIR'])

function isDriveError(err: unknown): boolean {
  return DRIVE_ERRNOS.has((err as NodeJS.ErrnoException | null)?.code ?? '')
}
