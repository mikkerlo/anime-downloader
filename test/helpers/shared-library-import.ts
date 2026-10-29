// A temp PC for the copy-to-this-PC tests (#579): hot and cold download roots,
// a userData, a copy of the checked-in fixture library as the attached
// "drive", a store, a fake player presence, and the import service wired to
// all of it.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sanitizeFilename } from '../../src/main/download-manager'
import {
  createSharedLibraryImportService,
  type SharedLibraryImportDeps,
  type SharedLibraryImportService
} from '../../src/main/services/shared-library-import'
import { FIXTURE_LIBRARY, FIXTURE_LIBRARY_ID } from './attached-library'
import { InMemoryStorage } from './in-memory-storage'
import { fakePresence, type FakePresence } from './shared-library-export'

export { FIXTURE_LIBRARY_ID }

/** Frieren 01 (`.mp4` + `.ass` under a shortened folder) and Dungeon Meshi 01 (`.mkv`). */
export const FRIEREN = '101:1:9001'
export const MESHI = '202:1:9101'
export const FRIEREN_MP4 = 'Frieren~3f2a1c/Frieren~3f2a1c - 01 [Crunchyroll].mp4'
export const FRIEREN_ASS = 'Frieren~3f2a1c/Frieren~3f2a1c - 01 [Crunchyroll].ass'
export const MESHI_MKV = 'Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv'

export interface ImportEnv {
  dir: string
  hot: string
  cold: string
  userData: string
  /** The attached library's root: a copy of the fixture library. */
  drive: string
  store: InMemoryStorage
  presence: FakePresence
  updates: ImportJobView[]
  imported: { animeId: number; dirName: string }[]
  /** Whether the drive counts as plugged in for `library()`. */
  available: { value: boolean }
  svc: SharedLibraryImportService
  restart: (overrides?: Partial<SharedLibraryImportDeps>) => SharedLibraryImportService
  cleanup: () => void
}

export function makeImportEnv(
  overrides: Partial<SharedLibraryImportDeps> = {},
  opts: { cold?: boolean; editDrive?: (drive: string) => void } = {}
): ImportEnv {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-import-')))
  const hot = path.join(dir, 'hot')
  const cold = path.join(dir, 'cold')
  const userData = path.join(dir, 'userData')
  const drive = path.join(dir, 'drive', 'Fixture library')
  for (const d of [hot, cold, userData]) fs.mkdirSync(d)
  fs.cpSync(FIXTURE_LIBRARY, drive, { recursive: true })
  opts.editDrive?.(drive)
  const store = new InMemoryStorage({
    downloadedEpisodes: {},
    downloadedAnime: {},
    animeCache: {},
    watchProgress: {}
  })
  const presence = fakePresence()
  const updates: ImportJobView[] = []
  const imported: { animeId: number; dirName: string }[] = []
  const available = { value: true }
  const make = (more: Partial<SharedLibraryImportDeps> = {}): SharedLibraryImportService =>
    createSharedLibraryImportService({
      userDataDir: userData,
      store,
      library: (libraryId) =>
        libraryId === FIXTURE_LIBRARY_ID
          ? { root: drive, name: 'Fixture library', available: available.value }
          : null,
      localRoots: () => ({ hot, cold: opts.cold === false ? null : cold }),
      sanitizeFilename,
      mergeStatus: () => null,
      presence,
      broadcast: (job) => updates.push(job),
      onImported: (info) => imported.push(info),
      candidates: async () => [],
      throttleMs: 0,
      ...overrides,
      ...more
    })
  return {
    dir,
    hot,
    cold,
    userData,
    drive,
    store,
    presence,
    updates,
    imported,
    available,
    svc: make(),
    restart: (more) => make(more),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The selection for a list of item keys. */
export function keys(...ks: string[]): ExportSelectionItem[] {
  return ks.map((k) => {
    const [animeId, episodeInt, translationId] = k.split(':')
    return { animeId: Number(animeId), episodeInt, translationId: Number(translationId) }
  })
}

/** Polls `cond` (a few seconds at most). */
export async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Sets a meta snapshot's titles (the drive's romaji, ru and search title). */
export function setMetaTitle(drive: string, animeId: number, title: string): void {
  const file = path.join(drive, '.anime-dl', 'meta', `${animeId}.json`)
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
  meta.titles = { romaji: title }
  meta.searchResult.title = title
  meta.searchResult.titles = { romaji: title }
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`)
}
