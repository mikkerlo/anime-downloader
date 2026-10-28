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
import { itemKey } from '../../lib/shared-library/format'
import { renderIndexHtml } from '../../lib/shared-library/index-html'
import type { MountCandidates } from '../../lib/shared-library/mount-candidates'
import { resolveWriteTarget } from '../../lib/shared-library/paths'
import { LIBRARY_DIR, MANIFEST, readLibrary } from '../../lib/shared-library/read'
import {
  LibraryIdMismatchError,
  LibraryNotFoundError,
  LibraryReadOnlyError,
  StaleGenerationError,
  writeManifest
} from '../../lib/shared-library/write'
import type { PlayerPresenceService } from '../player-presence'
import {
  TMP_SUFFIX,
  VerifyError,
  copyVerified,
  errnoOf,
  unlinkQuiet,
  writeSmallFile,
  type ExportFs
} from './copy'
import { locateLibrary } from './locate'
import type { ResolvedItem } from './plan'
import { writeTitleSnapshot } from './snapshot'

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
  /** The file being copied, so a resume deletes its `.anime-dl-tmp`. */
  current: { key: string; rel: string } | null
  missing: number
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
  resolve: (item: JobItem) => Promise<ResolvedItem | 'missing' | 'busy'>
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

  /** Deletes the `.anime-dl-tmp` a crash or a kill left behind. */
  private async dropLeftoverTmp(): Promise<void> {
    const cur = this.rec.current
    if (!cur) return
    const dest = await resolveWriteTarget(this.rec.root, cur.rel).catch(() => 'escapes' as const)
    if (dest !== 'escapes') {
      try {
        await unlinkQuiet(this.deps.xfs, `${dest}${TMP_SUFFIX}`)
      } catch (err) {
        // A plain file where the folder was: no tmp can be under it.
        if (errnoOf(err) !== 'ENOTDIR') throw err
      }
    }
    this.rec.current = null
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

      const done = new Set(this.rec.done)
      for (const item of this.rec.items) {
        if (done.has(item.key) || this.rec.failed[item.key]) continue
        await this.holdWhilePlayerOpen()
        if (this.stop) break
        if (this.rec.status !== 'running') await this.setStatus('running')
        if (!(await this.identityOk())) throw new DriveGoneError('the library is not at its root')
        const source = await this.deps.resolve(item)
        if (source === 'missing' || source === 'busy') {
          this.rec.failed[item.key] =
            source === 'busy' ? 'busy merging or downloading' : 'the source file is gone'
          continue
        }
        await this.snapshotTitle(item.animeId)
        try {
          await this.copyItem(item, source)
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            this.inFlight = 0
            this.copyAbort = null
            break
          }
          if (err instanceof EscapeError) {
            console.warn(`[export] skipped ${item.key}: ${err.message}`)
            this.rec.failed[item.key] = err.message
            continue
          }
          if (!(await this.identityOk())) throw new DriveGoneError((err as Error).message)
          this.rec.failed[item.key] =
            err instanceof VerifyError ? `verify failed: ${err.message}` : (err as Error).message
          this.rec.current = null
          continue
        }
        this.rec.done.push(item.key)
        done.add(item.key)
        this.sinceCheckpoint++
        if (this.sinceCheckpoint >= this.deps.checkpointEvery) await this.checkpoint()
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

class EscapeError extends Error {
  constructor(rel: string) {
    super(`${rel} leads outside the library (a symlink)`)
  }
}

const DRIVE_ERRNOS = new Set(['ENOENT', 'ENODEV', 'EIO', 'ENXIO', 'ENOTDIR'])

function isDriveError(err: unknown): boolean {
  return DRIVE_ERRNOS.has((err as NodeJS.ErrnoException | null)?.code ?? '')
}
