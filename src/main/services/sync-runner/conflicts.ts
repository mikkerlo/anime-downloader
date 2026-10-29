// `userData/sync-state/conflicts.json` (#584 §5): one record per
// `(ownerScope, animeId, fieldPath)`. The identity, dedupe and convergence are
// pure (`lib/sync-merge/conflicts.ts`); this file only persists them.

import { promises as fsp } from 'fs'
import * as path from 'path'

interface ConflictsFile {
  version: 1
  records: SyncConflictRecord[]
}

export interface ConflictStore {
  read(): Promise<SyncConflictRecord[]>
  write(records: SyncConflictRecord[]): Promise<void>
}

export function createConflictStore(dir: string): ConflictStore {
  const file = path.join(dir, 'conflicts.json')
  return {
    async read() {
      try {
        const body = JSON.parse(await fsp.readFile(file, 'utf8')) as ConflictsFile
        return body?.version === 1 && Array.isArray(body.records) ? body.records : []
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },
    async write(records) {
      await fsp.mkdir(dir, { recursive: true })
      const body: ConflictsFile = { version: 1, records }
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(body), 'utf8')
      await fsp.rename(`${file}.tmp`, file)
    }
  }
}
