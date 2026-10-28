// A temp PC for the Shared Library export tests (#574): hot and cold download
// roots with fake episodes, a store holding their `downloadedEpisodes`
// entries, a fake player presence over a `createListenerSet` the test holds,
// and the export service wired to all of it.

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sanitizeFilename } from '../../src/main/download-manager'
import { createEpisodeFileScanner } from '../../src/main/lib/episode-file-scan'
import { createListenerSet, type ListenerSet } from '../../src/main/lib/listener-set'
import { createLibrary } from '../../src/main/lib/shared-library/write'
import {
  createSharedLibraryExportService,
  type SharedLibraryExportDeps,
  type SharedLibraryExportService
} from '../../src/main/services/shared-library-export'
import { InMemoryStorage } from './in-memory-storage'

export interface FakePresence {
  open: boolean
  release: ListenerSet<[]>
  isOpen: () => boolean
  onRelease: (cb: () => void) => () => void
}

export function fakePresence(): FakePresence {
  const release = createListenerSet<[]>('test-presence')
  const p: FakePresence = {
    open: false,
    release,
    isOpen: () => p.open,
    onRelease: (cb) => release.add(cb)
  }
  return p
}

export interface EpisodeSpec {
  animeId: number
  title: string
  episodeInt: string
  translationId: number
  author?: string
  ext?: 'mkv' | 'mp4'
  /** An unmerged `.mp4` + `.ass` pair. */
  subtitle?: boolean
  where?: 'hot' | 'cold'
  bytes?: number
}

export interface ExportEnv {
  dir: string
  hot: string
  cold: string
  userData: string
  /** A temp "drive" to export to. */
  drive: string
  store: InMemoryStorage
  presence: FakePresence
  updates: ExportJobView[]
  svc: SharedLibraryExportService
  /** Writes the episode's file(s) and records its `downloadedEpisodes` entry; returns its key and source paths. */
  addEpisode: (spec: EpisodeSpec) => { key: string; video: string; subtitle: string | null }
  /** A new service on the same userData (a restart). */
  restart: (overrides?: Partial<SharedLibraryExportDeps>) => SharedLibraryExportService
  actor: SharedLibraryActor
  cleanup: () => void
}

export const PC_ACTOR: SharedLibraryActor = {
  installId: 'pc-export',
  appVersion: '5.0.26',
  shikimoriUserId: null,
  claim: null
}

/** Deterministic, distinct bytes per episode, so byte-identity checks mean something. */
export function bytesFor(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size)
  let block = createHash('sha256').update(seed).digest()
  for (let off = 0; off < size; off += block.length) {
    block.copy(out, off)
    block = createHash('sha256').update(block).digest()
  }
  return out
}

export function makeExportEnv(
  overrides: Partial<SharedLibraryExportDeps> = {},
  opts: { shikimoriUser?: { id: number; nickname: string } | null } = {}
): ExportEnv {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-export-')))
  const hot = path.join(dir, 'hot')
  const cold = path.join(dir, 'cold')
  const userData = path.join(dir, 'userData')
  const drive = path.join(dir, 'drive')
  for (const d of [hot, cold, userData, drive]) fs.mkdirSync(d)
  const store = new InMemoryStorage({
    downloadedEpisodes: {},
    downloadedAnime: {},
    library: {},
    animeCache: {},
    shikimoriUser: opts.shikimoriUser ?? null
  })
  const presence = fakePresence()
  const updates: ExportJobView[] = []
  const scanner = createEpisodeFileScanner({
    getDirsToScan: () => [hot, cold],
    sanitizeFilename,
    onEpisodesChanged: () => {}
  })
  const actor: SharedLibraryActor = {
    ...PC_ACTOR,
    shikimoriUserId: opts.shikimoriUser?.id ?? null
  }
  const make = (more: Partial<SharedLibraryExportDeps> = {}): SharedLibraryExportService =>
    createSharedLibraryExportService({
      userDataDir: userData,
      store,
      scanEpisodeFiles: scanner.scanEpisodeFilesAsync,
      sanitizeFilename,
      mergeStatus: () => null,
      presence,
      actor: () => actor,
      broadcast: (job) => updates.push(job),
      candidates: async () => [],
      throttleMs: 0,
      checkpointEvery: 2,
      ...overrides,
      ...more
    })

  const addEpisode = (
    spec: EpisodeSpec
  ): { key: string; video: string; subtitle: string | null } => {
    const author = spec.author ?? 'Studio'
    const ext = spec.ext ?? 'mkv'
    const root = spec.where === 'cold' ? cold : hot
    const folder = path.join(root, sanitizeFilename(spec.title))
    fs.mkdirSync(folder, { recursive: true })
    const base = `${sanitizeFilename(`${spec.title} - ${spec.episodeInt.padStart(2, '0')}`)} [${sanitizeFilename(author)}]`
    const video = path.join(folder, `${base}.${ext}`)
    const key = `${spec.animeId}:${spec.episodeInt}:${spec.translationId}`
    fs.writeFileSync(video, bytesFor(`${key}:video`, spec.bytes ?? 4096 + spec.translationId))
    let subtitle: string | null = null
    if (spec.subtitle) {
      subtitle = path.join(folder, `${base}.ass`)
      fs.writeFileSync(subtitle, `[Script Info]\nTitle: ${key}\n`)
    }
    const episodes = store.get('downloadedEpisodes') as Record<string, unknown>
    episodes[key] = {
      translationType: 'subRu',
      author,
      quality: 720,
      translationId: spec.translationId
    }
    store.set('downloadedEpisodes', episodes)
    const anime = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    if (!anime[spec.animeId]) {
      anime[spec.animeId] = {
        id: spec.animeId,
        title: spec.title,
        titles: { romaji: spec.title },
        posterUrlSmall: `https://example.invalid/${spec.animeId}.jpg`,
        numberOfEpisodes: 12,
        type: 'tv',
        typeTitle: 'TV Series',
        year: 2024,
        season: 'spring'
      }
      store.set('downloadedAnime', anime)
    }
    return { key, video, subtitle }
  }

  return {
    dir,
    hot,
    cold,
    userData,
    drive,
    store,
    presence,
    updates,
    svc: make(),
    addEpisode,
    restart: (more) => make(more),
    actor,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** A Videos-only or With metadata library made by another PC. */
export async function seedLibrary(
  root: string,
  opts: {
    libraryId: string
    name: string
    owner?: SharedLibraryOwner | null
    items?: SharedLibraryItem[]
    titles?: SharedLibraryTitle[]
    actor?: SharedLibraryActor
  }
): Promise<void> {
  const owner = opts.owner ?? null
  await createLibrary(
    root,
    {
      libraryId: opts.libraryId,
      name: opts.name,
      owner,
      mode: owner ? 'metadata' : 'videos',
      titles: opts.titles ?? [],
      items: opts.items ?? []
    },
    opts.actor ?? {
      installId: 'pc-other',
      appVersion: '5.0.25',
      shikimoriUserId: owner?.shikimoriId ?? null,
      claim: null
    }
  )
}

/** Every file under `root` with its sha256 and mtime: a byte-for-byte snapshot. */
export function scan(root: string): Record<string, { sha: string; mtimeMs: number }> {
  const out: Record<string, { sha: string; mtimeMs: number }> = {}
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        out[path.relative(root, p)] = {
          sha: createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
          mtimeMs: fs.statSync(p).mtimeMs
        }
      }
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

export function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** The selection for a list of item keys. */
export function sel(...keys: string[]): ExportSelectionItem[] {
  return keys.map((k) => {
    const [animeId, episodeInt, translationId] = k.split(':')
    return { animeId: Number(animeId), episodeInt, translationId: Number(translationId) }
  })
}
