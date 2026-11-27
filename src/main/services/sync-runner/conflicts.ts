// Held conflicts on disk (#584 §5): one record per `(ownerScope, animeId,
// fieldPath)`, in one file per owner tracker (#715). A Shikimori owner's are in
// `userData/sync-state/conflicts.json`, exactly as before; another tracker's in
// `conflicts-<provider>.json`, which a v6 never reads. The file is picked by
// the library owner's provider, whichever leg writes it, and a record always
// goes back to the file it came from. The identity, dedupe and convergence are
// pure (`lib/sync-merge/conflicts.ts`); this file only persists them.

import { promises as fsp } from 'fs'
import * as path from 'path'

interface ConflictsFile {
  version: 1
  records: SyncConflictRecord[]
}

/** Every tracker with a conflicts file, in the order `readAll` lists them. */
export const CONFLICT_PROVIDERS: readonly TrackerId[] = ['shikimori', 'anilist', 'mal']

export interface ConflictStore {
  read(provider: TrackerId): Promise<SyncConflictRecord[]>
  write(provider: TrackerId, records: SyncConflictRecord[]): Promise<void>
  /** Each file's records; a file that can't be read rejects, unless `lenient` lists it as none. */
  readAll(opts?: {
    lenient?: boolean
  }): Promise<{ provider: TrackerId; records: SyncConflictRecord[] }[]>
}

export const conflictsFileOf = (provider: TrackerId): string =>
  provider === 'shikimori' ? 'conflicts.json' : `conflicts-${provider}.json`

export function createConflictStore(dir: string): ConflictStore {
  const fileOf = (provider: TrackerId): string => path.join(dir, conflictsFileOf(provider))
  const store: ConflictStore = {
    async read(provider) {
      try {
        const body = JSON.parse(await fsp.readFile(fileOf(provider), 'utf8')) as ConflictsFile
        return body?.version === 1 && Array.isArray(body.records) ? body.records : []
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },
    async write(provider, records) {
      const file = fileOf(provider)
      await fsp.mkdir(dir, { recursive: true })
      const body: ConflictsFile = { version: 1, records }
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(body), 'utf8')
      await fsp.rename(`${file}.tmp`, file)
    },
    async readAll(opts = {}) {
      const out: { provider: TrackerId; records: SyncConflictRecord[] }[] = []
      for (const provider of CONFLICT_PROVIDERS) {
        const read = store.read(provider)
        out.push({
          provider,
          records: opts.lenient ? await read.catch(() => [] as SyncConflictRecord[]) : await read
        })
      }
      return out
    }
  }
  return store
}
