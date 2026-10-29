// One import job (#579): S6a (#574)'s export job in reverse. It copies its
// planned items from an attached Shared Library onto this PC, file by file,
// through the same copy and verify helpers, and registers each one as a
// download. Nothing is ever written to the drive.
//
// The job is keyed by the library's `libraryId`: every run first finds the
// library (`locateLibrary`), and before each file it checks the root still
// holds it. Before each file it also waits while the player is open, and on
// an episode this PC already has it asks first.

import * as path from 'path'
import { itemKey } from '../../lib/shared-library/format'
import {
  TMP_SUFFIX,
  VerifyError,
  copyVerified,
  errnoOf,
  unlinkQuiet,
  type ExportFs
} from '../../lib/shared-library/copy'
import type { MountCandidates } from '../../lib/shared-library/mount-candidates'
import { assertInsideRoot } from '../../lib/shared-library/local-name'
import { resolveItem } from '../../lib/shared-library/paths'
import { LIBRARY_DIR, MANIFEST, readLibrary } from '../../lib/shared-library/read'
import type { PlayerPresenceService } from '../player-presence'
import { locateLibrary } from '../shared-library-export/locate'
import type { ImportItem } from './plan'

/** How an item goes once its duplicate check is done; persisted so a resume never asks again. */
export type ImportDecision =
  | { kind: 'copy' }
  /** Delete these local files once the drive's copy is in place. */
  | { kind: 'replace'; remove: string[]; dropKeys: string[] }

/** `userData/import-jobs/<jobId>.json`. */
export interface ImportJobRecord {
  version: 1
  jobId: string
  libraryId: string
  libraryName: string
  /** The library root, last known. */
  root: string
  destination: ImportDestination
  /** The local root the items are named for. */
  destRoot: string
  createdAt: number
  status: ImportJobStatus
  items: ImportItem[]
  /** Finished local files by their path. */
  doneFiles: Record<string, { size: number; sha256: string }>
  /** Item keys that are copied and registered. */
  done: string[]
  failed: Record<string, string>
  /** Duplicates where this PC's file was kept. */
  kept: Record<string, string>
  decisions: Record<string, ImportDecision>
  /** "Apply to all remaining". */
  applyAll: ImportDuplicateChoice | null
  /** Titles whose `animeCache` entry this job created; later episodes are added only to these. */
  seeded?: number[]
  /** The file being copied, so a resume deletes its `.anime-dl-tmp`. */
  current: { key: string; dest: string } | null
  note: string | null
  error: string | null
}

export interface LocalFile {
  path: string
  /** The name without its extension (and `.part`). */
  stem: string
  ext: '.mkv' | '.mp4' | '.ass'
  part: boolean
  size: number
}

export interface ImportJobDeps {
  xfs: ExportFs
  presence: Pick<PlayerPresenceService, 'isOpen' | 'onRelease'>
  candidates: MountCandidates
  persist: (rec: ImportJobRecord) => Promise<void>
  update: () => void
  /** The local files of `item`'s episode, in the hot and cold roots. */
  localFiles: (item: ImportItem) => Promise<LocalFile[]>
  /** This PC's `downloadedEpisodes` keys for `animeId:episodeInt:*`, with their authors. */
  localEntries: (item: ImportItem) => { key: string; translationId: number; author: string }[]
  mergeStatus: (translationId: number) => string | null
  sanitizeFilename: (name: string) => string
  /** Writes the title (when this PC has none) and the episode; `dropKeys` leave the registry. */
  register: (item: ImportItem, dropKeys: string[]) => Promise<void>
  retryMs: number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

class DriveGoneError extends Error {}

const DRIVE_GONE_NOTE = 'The drive went away: '
export const KEPT_LOCAL = 'Kept this PC’s file'
export const STILL_BUSY = 'Kept this PC’s file: it is still downloading or merging'
export const SAME_NAME = 'Kept this PC’s file: both would have the same name'

const isTerminal = (s: ImportJobStatus): boolean =>
  s === 'completed' || s === 'cancelled' || s === 'failed'

const DRIVE_ERRNOS = new Set(['ENOENT', 'ENODEV', 'EIO', 'ENXIO', 'ENOTDIR'])

function stoppedError(): Error {
  const err = new Error('stopped')
  err.name = 'AbortError'
  return err
}

export function jobFiles(rec: ImportJobRecord): { dest: string; size: number; item: ImportItem }[] {
  const out: { dest: string; size: number; item: ImportItem }[] = []
  for (const item of rec.items) {
    out.push({ dest: item.dest, size: item.size, item })
    if (item.destSubtitle) out.push({ dest: item.destSubtitle, size: item.subtitleSize, item })
  }
  return out
}

export class ImportJob {
  private current: Promise<void> | null = null
  private stop: 'pause' | 'cancel' | null = null
  private copyAbort: AbortController | null = null
  private wake: (() => void) | null = null
  private answer: ((a: ImportDuplicateAnswer | null) => void) | null = null
  private question: ImportDuplicatePrompt | null = null
  private retryTimer: unknown = null
  private inFlight = 0
  private base: SharedLibraryManifest | null = null
  private signature: string | null = null

  constructor(
    readonly rec: ImportJobRecord,
    private readonly deps: ImportJobDeps
  ) {}

  isActive(): boolean {
    return this.current !== null || this.rec.status === 'waiting-drive'
  }

  running(): Promise<void> | null {
    return this.current
  }

  /** The open duplicate question, or null. */
  duplicate(): ImportDuplicatePrompt | null {
    return this.question
  }

  bytesDone(): number {
    let n = this.inFlight
    for (const f of Object.values(this.rec.doneFiles)) n += f.size
    return n
  }

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

  pause(): Promise<void> {
    return this.halt('pause')
  }

  cancel(): Promise<void> {
    return this.halt('cancel')
  }

  /** The user's answer to the open duplicate question; false when none is open. */
  resolveDuplicate(a: ImportDuplicateAnswer): boolean {
    if (!this.answer) return false
    this.answer(a)
    return true
  }

  retryNow(): Promise<void> {
    this.disarmRetry()
    return this.run()
  }

  private async halt(kind: 'pause' | 'cancel'): Promise<void> {
    this.disarmRetry()
    if (this.current) {
      this.stop = kind
      this.copyAbort?.abort()
      this.wake?.()
      this.answer?.(null)
      await this.current
      return
    }
    if (isTerminal(this.rec.status)) return
    await this.setStatus(kind === 'pause' ? 'paused' : 'cancelled')
  }

  private async setStatus(status: ImportJobStatus): Promise<void> {
    this.rec.status = status
    await this.deps.persist(this.rec)
    this.deps.update()
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

  private async manifestSignature(): Promise<string | null> {
    try {
      const st = await this.deps.xfs.stat(path.join(this.rec.root, LIBRARY_DIR, MANIFEST))
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
    } catch {
      return null
    }
  }

  /** Whether the root still holds this job's library: a `stat`, or a read when it changed. */
  private async identityOk(): Promise<boolean> {
    const sig = await this.manifestSignature()
    if (sig === null) return false
    if (sig === this.signature) return true
    const r = await readLibrary(this.rec.root).catch(() => null)
    if (!r || r.status === 'none' || !r.manifest || r.manifest.libraryId !== this.rec.libraryId) {
      return false
    }
    this.base = r.manifest
    this.signature = sig
    return true
  }

  private async loadBase(): Promise<void> {
    if (!(await this.identityOk())) throw new DriveGoneError('the library is not at its root')
  }

  private async holdWhilePlayerOpen(): Promise<void> {
    while (this.deps.presence.isOpen() && !this.stop) {
      if (this.rec.status !== 'held') {
        await this.setStatus('held')
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = null
    }
  }

  /** Deletes the `.anime-dl-tmp` a crash, a kill or a pause left behind. */
  private async dropLeftoverTmp(): Promise<void> {
    const cur = this.rec.current
    if (!cur) return
    try {
      await unlinkQuiet(this.deps.xfs, `${cur.dest}${TMP_SUFFIX}`)
    } catch (err) {
      if (errnoOf(err) !== 'ENOTDIR') throw err
    }
    this.rec.current = null
  }

  /** Asks the user, unless "Apply to all remaining" already answered. */
  private async ask(prompt: ImportDuplicatePrompt): Promise<ImportDuplicateChoice | null> {
    if (this.rec.applyAll) return this.rec.applyAll
    this.question = prompt
    // Listening before the status shows: `list()` reads it while this persists,
    // so an answer can come in before the save does.
    const answered = new Promise<ImportDuplicateAnswer | null>((resolve) => {
      this.answer = resolve
    })
    await this.setStatus('waiting-duplicate')
    const a = this.stop ? null : await answered
    this.answer = null
    this.question = null
    if (!a) return null
    if (a.applyToAll) this.rec.applyAll = a.choice
    await this.setStatus('running')
    return a.choice
  }

  /**
   * The duplicate check, made once per item and then persisted: the same
   * translation's file under the same name, else another translation's file
   * of the episode, in either root. A file still downloading (`.part`) or
   * merging counts, and is never replaced.
   */
  private async decide(item: ImportItem): Promise<ImportDecision | 'keep' | 'stopped'> {
    const known = this.rec.decisions[item.key]
    if (known) return known
    const base = this.baseOf(item)
    const stem = path.basename(item.dest, path.extname(item.dest))
    const isVideo = (f: LocalFile): boolean => f.ext !== '.ass'
    const files = await this.deps.localFiles(item)
    const same = files.filter((f) => f.stem === stem)
    const others = files.filter((f) => f.stem !== stem)
    // The same translation's name first; else any other translation's file.
    const conflict = same.some(isVideo) ? same : others.some(isVideo) ? others : null
    if (!conflict) return this.remember(item, { kind: 'copy' })
    const entries = this.deps.localEntries(item)
    const busy =
      conflict.some((f) => f.part) ||
      [item.translationId, ...entries.map((e) => e.translationId)].some((tr) =>
        ['merging', 'deferred'].includes(this.deps.mergeStatus(tr) ?? '')
      )
    const canKeepBoth = !same.some(isVideo)
    const choice = await this.ask({
      key: item.key,
      label: this.labelOf(item),
      localSize: Math.max(0, ...conflict.filter(isVideo).map((f) => f.size)),
      driveSize: item.size,
      canKeepBoth,
      canReplace: !busy
    })
    if (choice === null) return 'stopped'
    if (choice === 'keep-both' && canKeepBoth) return this.remember(item, { kind: 'copy' })
    if (choice === 'replace' && !busy) {
      const ours = new Set([item.dest, item.destSubtitle])
      const stems = new Set(conflict.map((f) => f.stem))
      // The registry entries whose files go: by their author tag, and the
      // pre-translation-id key for an untagged legacy file.
      const dropKeys = entries
        .filter((e) => e.key !== item.key)
        .filter((e) => stems.has(`${base} [${this.deps.sanitizeFilename(e.author)}]`))
        .map((e) => e.key)
      if (stems.has(base)) dropKeys.push(`${item.animeId}:${item.episodeInt}`)
      return this.remember(item, {
        kind: 'replace',
        remove: conflict.map((f) => f.path).filter((p) => !ours.has(p)),
        dropKeys
      })
    }
    this.rec.kept[item.key] =
      choice === 'replace' ? STILL_BUSY : choice === 'keep-both' ? SAME_NAME : KEPT_LOCAL
    await this.deps.persist(this.rec)
    return 'keep'
  }

  /** `sanitizeFilename("<title> - NN")`: every local file of the episode starts with it. */
  private baseOf(item: ImportItem): string {
    return this.deps.sanitizeFilename(`${item.title} - ${item.episodeInt.padStart(2, '0')}`)
  }

  private async remember(item: ImportItem, d: ImportDecision): Promise<ImportDecision> {
    this.rec.decisions[item.key] = d
    await this.deps.persist(this.rec)
    return d
  }

  labelOf(item: ImportItem): string {
    return `${item.title} — ${item.label}`
  }

  private async copyFile(src: string, dest: string, item: ImportItem): Promise<void> {
    if (this.rec.doneFiles[dest]) return
    if (this.stop) throw stoppedError()
    // The backstop again, at the write: a job file is read back from disk.
    assertInsideRoot(this.rec.destRoot, dest)
    this.rec.current = { key: item.key, dest }
    await this.deps.persist(this.rec)
    this.copyAbort = new AbortController()
    this.inFlight = 0
    try {
      const result = await copyVerified(this.deps.xfs, src, dest, {
        signal: this.copyAbort.signal,
        fsType: 'other',
        onBytes: (n) => {
          this.inFlight += n
          this.deps.update()
        }
      })
      this.rec.doneFiles[dest] = result
    } finally {
      this.inFlight = 0
      this.copyAbort = null
    }
    this.rec.current = null
    await this.deps.persist(this.rec)
  }

  /** Copies one item's files, checked against the drive's manifest, then registers it. */
  private async copyItem(item: ImportItem, decision: ImportDecision): Promise<void> {
    const driveItem = this.base?.items.find((i) => itemKey(i) === item.key)
    if (!driveItem) throw new ItemError('no longer on the drive')
    const r = await resolveItem(this.rec.root, driveItem)
    if (r.path === 'escapes' || r.subtitlePath === 'escapes') {
      throw new ItemError('the file leads outside the library')
    }
    if (r.path === 'missing') throw new ItemError('the file is missing on the drive')
    if (item.destSubtitle && (r.subtitlePath === undefined || r.subtitlePath === 'missing')) {
      throw new ItemError('the subtitle file is missing on the drive')
    }
    await this.copyFile(r.path, item.dest, item)
    const video = this.rec.doneFiles[item.dest]
    if (video.size !== driveItem.size || (driveItem.sha256 && video.sha256 !== driveItem.sha256)) {
      // The drive's file doesn't match its own manifest: never registered.
      delete this.rec.doneFiles[item.dest]
      await unlinkQuiet(this.deps.xfs, item.dest).catch(() => {})
      throw new ItemError(
        video.size !== driveItem.size
          ? `the drive's file is ${video.size} bytes, its library says ${driveItem.size}`
          : 'the drive’s file does not match its library (hash mismatch)'
      )
    }
    if (item.destSubtitle && typeof r.subtitlePath === 'string') {
      await this.copyFile(r.subtitlePath, item.destSubtitle, item)
    }
    if (decision.kind === 'replace') {
      for (const p of decision.remove) await unlinkQuiet(this.deps.xfs, p)
    }
    await this.deps.register(item, decision.kind === 'replace' ? decision.dropKeys : [])
  }

  private async copyAll(): Promise<'stopped' | 'done'> {
    for (const item of this.rec.items) {
      const k = item.key
      if (this.rec.done.includes(k) || this.rec.failed[k] || this.rec.kept[k]) continue
      await this.holdWhilePlayerOpen()
      if (this.stop) return 'stopped'
      if (this.rec.status !== 'running') await this.setStatus('running')
      if (!(await this.identityOk())) throw new DriveGoneError('the library is not at its root')
      const decision = await this.decide(item)
      if (decision === 'stopped' || this.stop) return 'stopped'
      if (decision === 'keep') continue
      try {
        await this.copyItem(item, decision)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return 'stopped'
        if (err instanceof ItemError) {
          this.rec.failed[k] = err.message
          await this.deps.persist(this.rec)
          continue
        }
        // A read from the drive that failed because the drive is gone.
        if (!(await this.identityOk())) throw new DriveGoneError((err as Error).message)
        this.rec.failed[k] =
          err instanceof VerifyError ? `verify failed: ${err.message}` : (err as Error).message
        this.rec.current = null
        await this.deps.persist(this.rec)
        continue
      }
      this.rec.done.push(k)
      await this.deps.persist(this.rec)
      this.deps.update()
    }
    return 'done'
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
      if (this.rec.note?.startsWith(DRIVE_GONE_NOTE)) this.rec.note = null
      if (found.moved) {
        this.rec.root = found.root
        this.rec.note = `Resumed at ${found.root}`
      }
      this.signature = null
      await this.loadBase()
      await this.dropLeftoverTmp()
      await this.setStatus('running')
      await this.copyAll()
      await this.dropLeftoverTmp()
      if (this.stop === 'pause') await this.setStatus('paused')
      else if (this.stop === 'cancel') await this.setStatus('cancelled')
      else await this.setStatus('completed')
    } catch (err) {
      this.inFlight = 0
      this.copyAbort = null
      this.question = null
      const lost =
        err instanceof DriveGoneError ||
        (DRIVE_ERRNOS.has(errnoOf(err) ?? '') && !(await this.identityOk()))
      if (lost) {
        if (this.stop) {
          await this.setStatus(this.stop === 'pause' ? 'paused' : 'cancelled')
          return
        }
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

/** A failure of one item; the job goes on. */
class ItemError extends Error {}
