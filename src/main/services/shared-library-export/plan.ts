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
  /** The cached episode data (`animeCache[animeId]`), for pre-fetch (#577). */
  cache?: (animeId: number) => PlanCacheEntry | null
}

/** What pre-fetch (#577) reads from `animeCache[animeId]`. */
export interface PlanCacheEntry {
  /** By episode id. */
  episodes: Record<number, EpisodeDetail>
  /** Probed video heights by translation id: never sizes. */
  qualityProbes: Record<number, number>
}

export const STALE_EPISODE_LIST = 'Open the title once online to refresh'

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
    const cache = src.cache?.(animeId) ?? null
    const siblings = [...resolved.values()].filter((r) => r.animeId === animeId)
    const durations = translationDurations(cache)
    const preferred = preferredTranslation(
      sels.map((s) => src.downloadedEpisodes()[itemKey(s)]).filter((e) => e !== undefined)
    )
    const notDownloaded = (detail?.episodes ?? [])
      .filter((e) => !downloaded.has(e.episodeInt))
      .map((e): ExportNotDownloaded => {
        const options = prefetchOptions(cache, e.id, preferred, siblings, durations)
        return {
          episodeInt: e.episodeInt,
          label: e.episodeFull || `Episode ${e.episodeInt}`,
          options,
          unavailable: options.length === 0 ? STALE_EPISODE_LIST : null
        }
      })
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

/** Seconds from a cached `Translation.duration`; null when it isn't a positive number. */
function seconds(duration: string | undefined): number | null {
  const n = Number(duration)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Every cached translation's duration, by translation id. */
function translationDurations(cache: PlanCacheEntry | null): Map<number, number> {
  const out = new Map<number, number>()
  for (const ep of Object.values(cache?.episodes ?? {})) {
    for (const tr of ep.translations ?? []) {
      const s = seconds(tr.duration)
      if (s !== null) out.set(tr.id, s)
    }
  }
  return out
}

/** The title's downloaded translation (`type` + author), the most common one. */
function preferredTranslation(
  entries: { translationType: string; author: string }[]
): { type: string; author: string } | null {
  const counts = new Map<string, { type: string; author: string; n: number }>()
  for (const e of entries) {
    const k = `${e.translationType}\u0000${e.author}`
    const c = counts.get(k) ?? { type: e.translationType, author: e.author, n: 0 }
    c.n++
    counts.set(k, c)
  }
  let best: { type: string; author: string; n: number } | null = null
  for (const c of counts.values()) if (!best || c.n > best.n) best = c
  return best ? { type: best.type, author: best.author } : null
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * A not-downloaded episode's size in `author`'s translation (#577), from the
 * title's downloaded episodes by the same author: their bytes per second times
 * this one's duration, else their median size, else unknown. `qualityProbes`
 * holds heights and is never read here.
 */
export function estimatePrefetchSize(
  author: string,
  duration: number | null,
  siblings: readonly ResolvedItem[],
  durations: ReadonlyMap<number, number>
): number | null {
  const same = siblings.filter((r) => r.author === author)
  if (same.length === 0) return null
  const timed = same.filter((r) => durations.has(r.translationId))
  if (duration !== null && timed.length > 0) {
    let bytes = 0
    let secs = 0
    for (const r of timed) {
      bytes += r.videoSize + r.subtitleSize
      secs += durations.get(r.translationId)!
    }
    return Math.round((bytes / secs) * duration)
  }
  return median(same.map((r) => r.videoSize + r.subtitleSize))
}

/**
 * The cached translations a not-downloaded episode can be pre-fetched in
 * (#577), one per type and author, at its best height; the title's downloaded
 * translation (by type and author, as the detail page picks) first.
 */
export function prefetchOptions(
  cache: PlanCacheEntry | null,
  episodeId: number,
  preferred: { type: string; author: string } | null,
  siblings: readonly ResolvedItem[],
  durations: ReadonlyMap<number, number>
): ExportPrefetchOption[] {
  const ep = cache?.episodes?.[episodeId]
  if (!ep) return []
  const height = (tr: Translation): number => cache?.qualityProbes?.[tr.id] ?? tr.height
  const best = new Map<string, Translation>()
  for (const tr of ep.translations ?? []) {
    if (tr.isActive !== 1) continue
    const k = `${tr.type}\u0000${tr.authorsSummary}`
    const had = best.get(k)
    if (!had || height(tr) > height(had)) best.set(k, tr)
  }
  const rank = (tr: Translation): number => {
    if (!preferred) return 2
    if (tr.type === preferred.type && tr.authorsSummary === preferred.author) return 0
    return tr.type === preferred.type ? 1 : 2
  }
  return [...best.values()]
    .sort((a, b) => rank(a) - rank(b) || height(b) - height(a))
    .map((tr) => ({
      translationId: tr.id,
      translationType: tr.type,
      author: tr.authorsSummary,
      height: height(tr),
      sizeBytes: estimatePrefetchSize(tr.authorsSummary, seconds(tr.duration), siblings, durations)
    }))
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

/**
 * Whether `item` is the `.mkv` an export merged from `local`'s pair (#623).
 * Its `source` counts only while it describes this very file: an older PC's
 * rewrite carries it back by `itemKey` onto whatever that PC wrote.
 */
function mergedFrom(item: SharedLibraryItem, local: ResolvedItem): boolean {
  const s = item.source
  return (
    s !== undefined &&
    s.outputSize === item.size &&
    local.subtitlePath !== null &&
    s.size === local.videoSize &&
    s.subtitleSize === local.subtitleSize
  )
}

/**
 * The keys the library already has, each as `'same'` (the same size as the
 * local video) or `'merged'` (the `.mkv` an export merged from the local pair).
 * It doesn't depend on the merge choice or the codec.
 */
export function presence(
  manifest: SharedLibraryManifest | null,
  resolved: ReadonlyMap<string, ResolvedItem>
): Map<string, 'same' | 'merged'> {
  const out = new Map<string, 'same' | 'merged'>()
  if (!manifest) return out
  for (const item of manifest.items) {
    const key = itemKey(item)
    const local = resolved.get(key)
    if (!local) continue
    if (local.videoSize === item.size) out.set(key, 'same')
    else if (mergedFrom(item, local)) out.set(key, 'merged')
  }
  return out
}

/** Keys the library already has: the same size as the local video, or merged from the local pair. */
export function presentKeys(
  manifest: SharedLibraryManifest | null,
  resolved: ReadonlyMap<string, ResolvedItem>
): string[] {
  return [...presence(manifest, resolved).keys()]
}
