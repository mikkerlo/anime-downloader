// Planning a Shared Library export (#574): the title → translation → episode
// tree of what is on this PC, each selected item resolved to its files, and
// how the chosen folder is treated (the target table in docs/shared-library.md).

import * as path from 'path'
import type { FileCheckResult } from '../../lib/episode-file-scan'
import type { DownloadedEpisodesMap } from '../../lib/downloaded-episodes'
import { discoverLibraries } from '../../lib/shared-library/discover'
import { itemKey } from '../../lib/shared-library/format'
import { libraryFolderName } from '../../lib/shared-library/naming'
import { readLibrary } from '../../lib/shared-library/read'

export const DEFAULT_LIBRARY_NAME = 'Anime Library'

/** What planning reads from this PC. */
export interface PlanSource {
  downloadedEpisodes: () => DownloadedEpisodesMap
  /** The title's record: `downloadedAnime`, then `library`, then the cached details. */
  anime: (animeId: number) => AnimeSearchResult | null
  /** The cached details (`animeCache`), for the episode list and the meta snapshot. */
  detail: (animeId: number) => AnimeDetail | null
  /** The hot + cold scan the episode list uses (`scanEpisodeFilesAsync`). */
  scanEpisodeFiles: (animeName: string) => Promise<FileCheckResult>
  sanitizeFilename: (name: string) => string
  /** The translation's merge status; `merging` and `deferred` are skipped. */
  mergeStatus: (translationId: number) => string | null
  /** A file's size, or null when it isn't there. */
  fileSize: (p: string) => Promise<number | null>
}

/** One selected item, resolved on disk. */
export interface ResolvedItem {
  key: string
  animeId: number
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  quality: number
  /** The local title name the files were found under (the naming rule's title). */
  title: string
  label: string
  videoPath: string
  /** `.mkv` or `.mp4`. */
  ext: string
  videoSize: number
  /** The `.ass` of an unmerged `.mp4` + `.ass` pair. */
  subtitlePath: string | null
  subtitleSize: number
}

const BUSY = new Set(['merging', 'deferred'])

/** The names a title's folder can have: `getAnimeName`'s order (romaji, ru, title). */
export function titleNames(anime: AnimeSearchResult | null): string[] {
  if (!anime) return []
  const out: string[] = []
  for (const n of [anime.titles?.romaji, anime.titles?.ru, anime.title]) {
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

export function displayName(anime: AnimeSearchResult | null, animeId: number): string {
  return titleNames(anime)[0] ?? `Anime ${animeId}`
}

function parseKey(key: string): ExportSelectionItem | null {
  const parts = key.split(':')
  if (parts.length !== 3) return null
  const animeId = Number(parts[0])
  const translationId = Number(parts[2])
  if (!Number.isSafeInteger(animeId) || animeId <= 0 || !Number.isSafeInteger(translationId)) {
    return null
  }
  if (!parts[1]) return null
  return { animeId, episodeInt: parts[1], translationId }
}

const episodeOrder = (a: string, b: string): number => {
  const d = Number(a) - Number(b)
  return Number.isNaN(d) || d === 0 ? a.localeCompare(b) : d
}

/** Resolves one `downloadedEpisodes` entry on disk, across hot and cold. */
export function createResolver(
  src: PlanSource
): (sel: ExportSelectionItem) => Promise<ResolvedItem | 'missing' | 'busy'> {
  // One plan call scans each title folder once.
  const scans = new Map<string, Promise<FileCheckResult>>()
  const scan = (name: string): Promise<FileCheckResult> => {
    let p = scans.get(name)
    if (!p) {
      p = src.scanEpisodeFiles(name).catch(() => ({}))
      scans.set(name, p)
    }
    return p
  }
  return async (sel) => {
    const key = itemKey(sel)
    const entry = src.downloadedEpisodes()[key]
    if (!entry) return 'missing'
    if (BUSY.has(src.mergeStatus(sel.translationId) ?? '')) return 'busy'
    const anime = src.anime(sel.animeId)
    const label = episodeLabel(src.detail(sel.animeId), sel.episodeInt)
    const author = src.sanitizeFilename(entry.author)
    for (const name of titleNames(anime)) {
      const base = src.sanitizeFilename(`${name} - ${sel.episodeInt.padStart(2, '0')}`)
      const files = (await scan(name))[base] ?? []
      const hit = files.find((f) => f.author === author) ?? files.find((f) => !f.author)
      if (!hit) continue
      const videoSize = await src.fileSize(hit.filePath)
      if (videoSize === null) continue
      let subtitlePath: string | null = null
      let subtitleSize = 0
      if (hit.type === 'mp4') {
        const ass = hit.filePath.replace(/\.mp4$/, '.ass')
        const size = await src.fileSize(ass)
        if (size !== null) {
          subtitlePath = ass
          subtitleSize = size
        }
      }
      return {
        key,
        animeId: sel.animeId,
        episodeInt: sel.episodeInt,
        translationId: sel.translationId,
        translationType: entry.translationType,
        author: entry.author,
        quality: entry.quality,
        title: name,
        label,
        videoPath: hit.filePath,
        ext: `.${hit.type}`,
        videoSize,
        subtitlePath,
        subtitleSize
      }
    }
    return 'missing'
  }
}

export function episodeLabel(detail: AnimeDetail | null, episodeInt: string): string {
  const ep = detail?.episodes?.find((e) => e.episodeInt === episodeInt)
  return ep?.episodeFull || `Episode ${episodeInt}`
}

/** The tree for `animeIds` (every title with a downloaded episode when null). */
export async function buildTree(
  src: PlanSource,
  animeIds: number[] | null
): Promise<{ titles: ExportTreeTitle[]; resolved: Map<string, ResolvedItem> }> {
  const byTitle = new Map<number, ExportSelectionItem[]>()
  for (const key of Object.keys(src.downloadedEpisodes())) {
    const sel = parseKey(key)
    if (!sel) continue
    if (animeIds && !animeIds.includes(sel.animeId)) continue
    const list = byTitle.get(sel.animeId) ?? []
    list.push(sel)
    byTitle.set(sel.animeId, list)
  }
  const ids = animeIds ?? [...byTitle.keys()]
  const resolve = createResolver(src)
  const resolved = new Map<string, ResolvedItem>()
  const titles: ExportTreeTitle[] = []
  for (const animeId of ids) {
    const anime = src.anime(animeId)
    const detail = src.detail(animeId)
    const translations = new Map<number, ExportTreeTranslation>()
    const sels = (byTitle.get(animeId) ?? []).sort((a, b) =>
      episodeOrder(a.episodeInt, b.episodeInt)
    )
    for (const sel of sels) {
      const entry = src.downloadedEpisodes()[itemKey(sel)]
      let tr = translations.get(sel.translationId)
      if (!tr) {
        tr = {
          translationId: sel.translationId,
          author: entry.author,
          translationType: entry.translationType,
          quality: entry.quality,
          episodes: []
        }
        translations.set(sel.translationId, tr)
      }
      const r = await resolve(sel)
      const key = itemKey(sel)
      if (typeof r === 'object') resolved.set(key, r)
      tr.episodes.push({
        key,
        episodeInt: sel.episodeInt,
        label: episodeLabel(detail, sel.episodeInt),
        state: typeof r === 'object' ? 'ready' : r,
        size: typeof r === 'object' ? r.videoSize + r.subtitleSize : 0,
        unmerged: typeof r === 'object' && r.subtitlePath !== null
      })
    }
    const downloaded = new Set(sels.map((s) => s.episodeInt))
    const notDownloaded = (detail?.episodes ?? [])
      .filter((e) => !downloaded.has(e.episodeInt))
      .map((e) => ({ episodeInt: e.episodeInt, label: e.episodeFull || `Episode ${e.episodeInt}` }))
    if (translations.size === 0 && notDownloaded.length === 0) continue
    titles.push({
      animeId,
      name: displayName(anime ?? detail, animeId),
      translations: [...translations.values()].sort((a, b) => a.author.localeCompare(b.author)),
      notDownloaded
    })
  }
  if (!animeIds) titles.sort((a, b) => a.name.localeCompare(b.name))
  return { titles, resolved }
}

/** The target classification, by the table in docs/shared-library.md. */
export interface ClassifiedTarget {
  kind: ExportTargetKind
  root: string
  libraryName: string
  ownerNickname?: string
  blocked: string | null
  /** The manifest at `root` (`add`), for the present items and the job's base. */
  manifest: SharedLibraryManifest | null
}

export const BLOCKED_OWN_METADATA =
  'This library carries watch state. Adding videos without it would widen titles[] with no state. Adding to it needs With metadata.'

/**
 * How exporting into `dir` with library name `name` works: the library root is
 * `dir` itself when it holds a library, otherwise `<dir>/<name>`.
 */
export async function classifyTarget(
  dir: string,
  name: string,
  shikimoriUserId: number | null,
  pathExists: (p: string) => Promise<boolean>
): Promise<ClassifiedTarget> {
  const libName = name.trim() || DEFAULT_LIBRARY_NAME
  const atDir = (await discoverLibraries(dir)).includes(dir)
  const root = atDir ? dir : path.join(dir, libraryFolderName(libName))
  const read = await readLibrary(root)
  if (read.status === 'none') {
    return { kind: 'new', root, libraryName: libName, blocked: null, manifest: null }
  }
  const m = read.manifest
  const foreign =
    m !== null &&
    m.mode === 'metadata' &&
    m.owner !== null &&
    (shikimoriUserId === null || m.owner.shikimoriId !== shikimoriUserId)
  if (foreign) {
    // The siblings `<name>`, `<name> (2)`, … in order. The first Videos-only
    // library among them is the one an earlier export made (anyone may add to
    // a library with no owner), so a re-export adds to it and `present`
    // applies. A free name ends the search with a new library; anything else
    // (another foreign, an own With metadata or a read-only library, or a
    // plain folder) is skipped.
    const ownerNickname = m.owner?.nickname || 'another user'
    const parent = atDir ? path.dirname(dir) : dir
    for (let n = 1; ; n++) {
      const sibling = path.join(parent, libraryFolderName(n === 1 ? libName : `${libName} (${n})`))
      if (!(await pathExists(sibling))) {
        return {
          kind: 'foreign',
          root: sibling,
          libraryName: libName,
          ownerNickname,
          blocked: null,
          manifest: null
        }
      }
      const s = await readLibrary(sibling)
      if (s.status === 'ok' && s.manifest.mode === 'videos' && s.manifest.owner === null) {
        return {
          kind: 'add',
          root: sibling,
          libraryName: s.manifest.name ?? path.basename(sibling),
          ownerNickname,
          blocked: null,
          manifest: s.manifest
        }
      }
    }
  }
  const existingName = m?.name ?? path.basename(root)
  if (read.status === 'read-only') {
    return {
      kind: 'read-only',
      root,
      libraryName: existingName,
      blocked: read.message,
      manifest: null
    }
  }
  if (read.manifest.mode === 'metadata') {
    return {
      kind: 'own-metadata',
      root,
      libraryName: existingName,
      blocked: BLOCKED_OWN_METADATA,
      manifest: read.manifest
    }
  }
  return { kind: 'add', root, libraryName: existingName, blocked: null, manifest: read.manifest }
}

/** Keys the library already has with the same size as the local video. */
export function presentKeys(
  manifest: SharedLibraryManifest | null,
  resolved: ReadonlyMap<string, ResolvedItem>
): string[] {
  if (!manifest) return []
  const out: string[] = []
  for (const item of manifest.items) {
    const key = itemKey(item)
    const local = resolved.get(key)
    if (local && local.videoSize === item.size) out.push(key)
  }
  return out
}
