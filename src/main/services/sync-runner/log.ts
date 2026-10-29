// The sync log (#584 §7): one JSON record per line in
// `userData/sync-log/<yyyy-mm>.jsonl`, each month's file bounded by size.
// S10 (#585)'s history reads it; it is read-only (no undo).

import { promises as fsp } from 'fs'
import * as path from 'path'

export const LOG_MAX_BYTES = 4 * 1024 * 1024

export type SyncLogRecord =
  | {
      kind: 'run'
      runId: string
      trigger: SyncTrigger
      at: number
      libraries: string[]
      counts: { applied: number; conflicts: number; clamped: number }
      changes: string[]
      conflicts: { animeId: string; fieldPath: string; reason: string }[]
      clamps: { path: string; at: number; clampedTo: number }[]
      skippedMalIds: number[]
      raises: {
        libraryId: string
        animeId: string
        malId: number
        kind: string
        episodes: number
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

export const REWATCH_SUPERSEDED_REASON =
  "your rewatch didn't count because Shikimori changed after it"

function monthOf(at: number): string {
  const d = new Date(at)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface SyncLog {
  append(record: SyncLogRecord): Promise<void>
  /** One month's records, oldest first. */
  read(month: string): Promise<SyncLogRecord[]>
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
      try {
        const text = await fsp.readFile(path.join(dir, `${month}.jsonl`), 'utf8')
        return text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as SyncLogRecord)
      } catch {
        return []
      }
    }
  }
}

export { monthOf }
