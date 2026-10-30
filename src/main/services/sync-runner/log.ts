// The sync log (#584 §7): one JSON record per line in
// `userData/sync-log/<yyyy-mm>.jsonl`, each month's file bounded by size.
// S10 (#585)'s history reads it; it is read-only (no undo).

import { promises as fsp } from 'fs'
import * as path from 'path'

export const LOG_MAX_BYTES = 4 * 1024 * 1024

/**
 * One silent change with its values (#585's history): `to` is the side that
 * changed, `from` the side its value came from. Newer run records carry these
 * beside `changes`; an older record has the paths only.
 */
export interface SyncLogDetail {
  path: string
  to: 'local' | 'library' | 'shikimori'
  from: 'local' | 'library' | 'shikimori'
  libraryId?: string
  before: unknown
  after: unknown
}

export type SyncLogRecord =
  | {
      kind: 'run'
      runId: string
      trigger: SyncTrigger
      at: number
      libraries: string[]
      counts: { applied: number; conflicts: number; clamped: number }
      changes: string[]
      details?: SyncLogDetail[]
      conflicts: { animeId: string; fieldPath: string; reason: string }[]
      clamps: { path: string; at: number; clampedTo: number }[]
      skippedMalIds: number[]
      raises: {
        libraryId: string
        animeId: string
        malId: number
        kind: string
        episodes: number
        from?: number
      }[]
      resolvedElsewhere: { animeId: string; fieldPath: string }[]
      result: SyncRunResult
    }
  | {
      kind: 'rewatch-superseded'
      runId: string
      at: number
      animeId: string
      malId: number
      episodes: number
      flipAt: number
      shikimoriUpdatedAt: string
      libraryId: string | null
      reason: string
    }
  | {
      kind: 'shikimori-rejected'
      at: number
      malId: number
      fields: SyncRateField[]
      error: string
    }
  | {
      // A review-sheet choice (#585), applied as forward edits.
      kind: 'resolution'
      at: number
      conflictId: string
      animeId: string
      fieldPath: SyncConflictFieldPath
      choice: string
      value: unknown
      // The libraries that were parties to the conflict.
      libraryIds: string[]
      wrote: { local: boolean; libraries: string[]; shikimori: 'queued' | 'already' | 'none' }
      notes: string[]
    }

export const REWATCH_SUPERSEDED_REASON =
  "your rewatch didn't count because Shikimori changed after it"

/** The cap on details per run record, so one big first merge can't fill a month's file. */
export const LOG_MAX_DETAILS = 200

function monthOf(at: number): string {
  const d = new Date(at)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/

export interface SyncLog {
  append(record: SyncLogRecord): Promise<void>
  /** One month's records, oldest first. */
  read(month: string): Promise<SyncLogRecord[]>
  /** The months with a log file, newest first. */
  months(): Promise<string[]>
}

export function createSyncLog(dir: string, maxBytes = LOG_MAX_BYTES): SyncLog {
  return {
    async append(record) {
      const file = path.join(dir, `${monthOf(record.at)}.jsonl`)
      const line = `${JSON.stringify(record)}\n`
      await fsp.mkdir(dir, { recursive: true })
      const size = await fsp.stat(file).then(
        (s) => s.size,
        () => 0
      )
      if (size + Buffer.byteLength(line) <= maxBytes) {
        await fsp.appendFile(file, line, 'utf8')
        return
      }
      // Over the bound: the newer half of the file is kept, then the record.
      const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean)
      const kept = lines.slice(Math.floor(lines.length / 2))
      await fsp.writeFile(`${file}.tmp`, `${[...kept, line.trimEnd()].join('\n')}\n`, 'utf8')
      await fsp.rename(`${file}.tmp`, file)
    },
    async read(month) {
      // Size-bounded: a file somehow past the bound is read from its newest `maxBytes`.
      const file = path.join(dir, `${month}.jsonl`)
      let text: string
      try {
        const handle = await fsp.open(file, 'r')
        try {
          const { size } = await handle.stat()
          const start = Math.max(0, size - maxBytes)
          const buf = Buffer.alloc(size - start)
          await handle.read(buf, 0, buf.length, start)
          text = buf.toString('utf8')
          if (start > 0) text = text.slice(text.indexOf('\n') + 1)
        } finally {
          await handle.close()
        }
      } catch {
        return []
      }
      const out: SyncLogRecord[] = []
      for (const l of text.split('\n')) {
        if (!l) continue
        try {
          out.push(JSON.parse(l) as SyncLogRecord)
        } catch {
          // A torn last line (a crash mid-append) is skipped.
        }
      }
      return out
    },
    async months() {
      try {
        return (await fsp.readdir(dir))
          .map((n) => MONTH_FILE.exec(n)?.[1])
          .filter((m): m is string => !!m)
          .sort()
          .reverse()
      } catch {
        return []
      }
    }
  }
}

export { monthOf }
