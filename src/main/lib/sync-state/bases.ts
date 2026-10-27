// `SyncBaseStore` (#572 §5): this PC's merge base per party, one file each
// under `userData/sync-bases/`, outside `config.json` (which every store write
// re-serializes). A party is `library-<libraryId>` or `shikimori-<ownerId>`.
// Writes are atomic: a temp file, then a rename over the old base, so a crash
// in between leaves the old base intact. The file system is injected, which
// keeps `lib/sync-state/` free of `fs`; S9 (#584) wires `fs/promises`.

import { join } from 'node:path'

export const BASE_VERSION = 1 as const

export interface SyncBase {
  baseVersion: typeof BASE_VERSION
  party: string
  /** The drive state's `generation` this base was taken at (null for the Shikimori leg). */
  stateGeneration: number | null
  doc: SyncDoc
}

export interface SyncBaseFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>
  rm(path: string, opts: { force: true }): Promise<void>
}

export interface SyncBaseStore {
  read(party: string): Promise<SyncBase | null>
  write(party: string, base: Omit<SyncBase, 'baseVersion' | 'party'>): Promise<void>
  remove(party: string): Promise<void>
}

const PARTY = /^(library|shikimori)-[A-Za-z0-9_-]{1,128}$/

export function isSyncBaseParty(party: string): boolean {
  return PARTY.test(party)
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export function createSyncBaseStore(dir: string, fs: SyncBaseFs): SyncBaseStore {
  const fileOf = (party: string): string => {
    if (!isSyncBaseParty(party)) throw new Error(`invalid sync base party: ${party}`)
    return join(dir, `${party}.json`)
  }
  return {
    async read(party) {
      let text: string
      try {
        text = await fs.readFile(fileOf(party), 'utf8')
      } catch (err) {
        if (isMissing(err)) return null
        throw err
      }
      const base = JSON.parse(text) as SyncBase
      if (base.baseVersion !== BASE_VERSION || base.party !== party) {
        throw new Error(`sync base ${party} has an unexpected header`)
      }
      return base
    },
    async write(party, base) {
      const file = fileOf(party)
      const tmp = `${file}.tmp`
      const body: SyncBase = { baseVersion: BASE_VERSION, party, ...base }
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(body), 'utf8')
      await fs.rename(tmp, file)
    },
    async remove(party) {
      const file = fileOf(party)
      await fs.rm(file, { force: true })
      await fs.rm(`${file}.tmp`, { force: true })
    }
  }
}
