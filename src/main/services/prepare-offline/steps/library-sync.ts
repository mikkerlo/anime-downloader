// Step 6 (#592): S9 (#584)'s `runAll('prepare')` over every available owned
// or claimed library, read from its `SyncRunResult`. Runs offline too: the
// drive leg needs no network, and `runAll` skips the Shikimori leg itself.

import { type PrepareStep, type PrepareStepResult, worstStatus } from '../index'
import { NO_LIBRARY_REASON } from './attached-integrity'

export interface LibrarySyncStepDeps {
  list(): AttachedLibraryInfo[]
  runAll(trigger: SyncTrigger): Promise<SyncRunResult>
  /**
   * The held conflicts after the run, per library: the review sheet's own
   * rows (#585), so a field both legs hold counts once, as in the toast.
   * Without it, the run's per-leg `counts.conflicts`.
   */
  needReview?(): Promise<Map<string, number>>
}

type Part = { text: string; status: PrepareOfflineStatus }

/** The review sheet's rows per library: each held conflict once for every library it touches. */
export function conflictsPerLibrary(items: SyncConflictItem[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of items) {
    for (const id of new Set(c.libraries.map((l) => l.libraryId))) {
      out.set(id, (out.get(id) ?? 0) + 1)
    }
  }
  return out
}

/**
 * The step's `needReview` over the runner's held conflicts. The list is
 * strict: an unreadable `conflicts.json` rejects, so the step keeps the run's
 * own count rather than reading "Drive synced" for a run that held conflicts.
 */
export function needReviewFrom(runner: {
  listConflicts(opts: { strict: true }): Promise<SyncConflictItem[]>
}): () => Promise<Map<string, number>> {
  return async () => conflictsPerLibrary(await runner.listConflicts({ strict: true }))
}

/** Not this PC's to sync: no line, only a count. */
const NOT_YOURS = new Set(['videos-only', 'foreign'])

export function drivePart(r: SyncLibraryResult, needReview?: number): Part {
  if (r.drive === 'ok') {
    const n = needReview ?? r.counts.conflicts
    return n > 0
      ? { text: `Drive synced, ${n} need review`, status: 'warning' }
      : { text: 'Drive synced', status: 'ok' }
  }
  switch (`${r.drive}:${r.driveReason ?? ''}`) {
    case 'skipped:unavailable':
      return { text: 'Drive not connected', status: 'skipped' }
    case 'skipped:read-only':
      return { text: 'Read-only on this computer; changes kept here', status: 'skipped' }
    case 'error:write-failed-read-only':
      return {
        text: 'The drive refused the write; now read-only, changes kept here',
        status: 'warning'
      }
    case 'error:io':
      return {
        text: "Couldn't write to the drive (full or I/O error); changes kept here",
        status: 'failed'
      }
    case 'error:unreadable':
      return {
        text: 'Library state is unreadable; plug it into the PC that last wrote it',
        status: 'failed'
      }
  }
  return { text: `Drive: ${r.driveReason ?? r.drive}`, status: 'warning' }
}

export function shikimoriPart(r: SyncLibraryResult): Part {
  if (r.shikimori === 'ok') {
    const k = r.waitingMalIds.length
    return {
      text:
        k > 0
          ? `Shikimori updated, ${k} ${k === 1 ? 'title waits' : 'titles wait'} for your queued edits`
          : 'Shikimori updated',
      status: 'ok'
    }
  }
  switch (`${r.shikimori}:${r.shikimoriReason ?? ''}`) {
    case 'skipped:offline':
      return { text: 'Shikimori push waits until online', status: 'ok' }
    case 'skipped:logged-out':
    case 'skipped:claim':
      return { text: 'Shikimori push needs a logged-in owner', status: 'ok' }
    case 'error:auth':
      return { text: 'Shikimori session expired; log in to push', status: 'warning' }
    case 'error:network':
      return { text: 'Shikimori push was interrupted; it resumes when online', status: 'warning' }
    case 'error:api':
      return { text: 'Shikimori rejected the update', status: 'warning' }
  }
  return { text: `Shikimori: ${r.shikimoriReason ?? r.shikimori}`, status: 'warning' }
}

/** One summary line per owned or claimed library; null for one that isn't. */
export function syncLine(r: SyncLibraryResult, name: string, needReview?: number): Part | null {
  if (NOT_YOURS.has(r.driveReason ?? '')) return null
  const d = drivePart(r, needReview)
  const s = shikimoriPart(r)
  return { text: `${name}: ${d.text}; ${s.text}`, status: worstStatus([d.status, s.status]) }
}

export function syncDetails(
  result: SyncRunResult,
  names: Map<string, string>,
  needReview?: Map<string, number>
): Part[] {
  const out: Part[] = []
  let notYours = 0
  for (const r of result.libraries) {
    const line = syncLine(
      r,
      names.get(r.libraryId) ?? r.libraryId,
      needReview ? (needReview.get(r.libraryId) ?? 0) : undefined
    )
    if (!line) {
      notYours++
      continue
    }
    out.push(line)
    if (r.rewatchesSuperseded > 0) {
      const n = r.rewatchesSuperseded
      out.push({
        text: `${n} rewatch ${n === 1 ? 'raise' : 'raises'} superseded by Shikimori`,
        status: 'ok'
      })
    }
  }
  if (notYours > 0) {
    out.push({
      text: `${notYours} ${notYours === 1 ? 'library' : 'libraries'} skipped: not yours`,
      status: 'ok'
    })
  }
  return out
}

export function createLibrarySyncStep(deps: LibrarySyncStepDeps): PrepareStep {
  return {
    id: 'library-sync',
    label: 'Sync owned or claimed libraries',
    requiresNetwork: false,
    isAvailable: () =>
      deps.list().length > 0
        ? { available: true }
        : { available: false, reason: NO_LIBRARY_REASON },
    async run(ctx): Promise<PrepareStepResult> {
      ctx.progress({ done: 0, total: 1, message: 'Syncing' })
      const names = new Map(deps.list().map((l) => [l.libraryId, l.name]))
      const result = await deps.runAll('prepare')
      const needReview = await deps.needReview?.().catch(() => undefined)
      const details = syncDetails(result, names, needReview)
      ctx.progress({ done: 1, total: 1 })
      return { status: worstStatus(details.map((d) => d.status)), details }
    }
  }
}
