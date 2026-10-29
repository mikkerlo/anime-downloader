// Planning a copy from an attached Shared Library onto this PC (#579): the
// title → translation → episode tree of what the drive holds, each item named
// by this PC's own download naming, and the items whose names are unsafe.

import { promises as fsp } from 'fs'
import * as path from 'path'
import { VIDEO_EXTS } from '@shared/episode-files'
import { itemKey, toAnimeSearchResult } from '../../lib/shared-library/format'
import { buildLocalEpisodePath, UNSAFE_NAME } from '../../lib/shared-library/local-name'
import { resolveItem } from '../../lib/shared-library/paths'

/** One drive item as the job copies it, named for this PC. */
export interface ImportItem {
  key: string
  animeId: number
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  quality: number
  label: string
  /** The local title name (`romaji || ru || title`), whose folder the file lands in. */
  title: string
  /** `sanitizeFilename(title)`: the folder under the destination root. */
  dirName: string
  /** The video's local path, and the `.ass` sidecar's when the drive has one. */
  dest: string
  destSubtitle?: string
  /** The drive's `items[].size` for the video; the sidecar's when it was found. */
  size: number
  subtitleSize: number
}

/** What planning reads from this PC. */
export interface ImportSource {
  /** `downloadedAnime[animeId]`: this PC's own record, which wins over the drive's. */
  localAnime: (animeId: number) => AnimeSearchResult | null
}

/** The names `getAnimeName` tries: romaji, ru, then title. */
export function localTitle(anime: AnimeSearchResult | null): string | null {
  return anime?.titles?.romaji || anime?.titles?.ru || anime?.title || null
}

/**
 * The title record a copy registers when this PC has none, from the drive's
 * metadata snapshot (else the manifest's name), as the Shared Libraries tab
 * shows it. The poster URL is `anime-poster://`, never the drive's.
 */
export function snapshotRecord(
  animeId: number,
  name: string,
  meta: SharedLibraryMeta | null,
  episodeCount: number
): AnimeSearchResult {
  const base: AnimeSearchResult = meta?.searchResult
    ? toAnimeSearchResult(meta.searchResult)
    : {
        id: animeId,
        title: name,
        titles: {},
        posterUrlSmall: '',
        numberOfEpisodes: episodeCount,
        type: meta?.type ?? '',
        typeTitle: '',
        year: meta?.year ?? 0,
        season: ''
      }
  if (!meta?.searchResult && meta?.titles) {
    const { ru, romaji, ja } = meta.titles
    base.titles = {
      ...(ru !== undefined ? { ru } : {}),
      ...(romaji !== undefined ? { romaji } : {}),
      ...(ja !== undefined ? { ja } : {})
    }
  }
  return { ...base, id: animeId, posterUrlSmall: `anime-poster://${animeId}` }
}

/**
 * The cached details a copy registers when this PC has none (#579): from
 * `meta/`, or the title record alone when the drive has no `meta/`, with every
 * episode the job copies listed, so the detail page shows them offline.
 */
export function detailFromSnapshot(
  record: AnimeSearchResult,
  meta: SharedLibraryMeta | null,
  episodeInts: readonly string[]
): AnimeDetail {
  const listed = (meta?.episodes ?? []).map((e) => ({
    episodeInt: e.episodeInt,
    episodeFull: e.episodeFull
  }))
  for (const ep of [...new Set(episodeInts)].sort(episodeOrder)) {
    if (!listed.some((e) => e.episodeInt === ep))
      listed.push({ episodeInt: ep, episodeFull: undefined })
  }
  return {
    ...record,
    posterUrl: '',
    descriptions: [],
    genres: (meta?.genres ?? []).map((g) => ({ id: g.id, title: g.title })),
    // The API's episode ids aren't on the drive: negative stand-ins, unique per
    // title, until the online refresh replaces the entry.
    episodes: listed.map((e, i) => ({
      id: -(i + 1),
      episodeFull: e.episodeFull || `${e.episodeInt} episode`,
      episodeInt: e.episodeInt,
      episodeType: '',
      isActive: 1
    })),
    ...(typeof meta?.malId === 'number' ? { myAnimeListId: meta.malId } : {})
  }
}

/** The copied translation as the episode list shows it offline. */
export function translationOf(item: ImportItem): Translation {
  return {
    id: item.translationId,
    type: item.translationType,
    typeKind: '',
    typeLang: '',
    authorsSummary: item.author,
    isActive: 1,
    width: 0,
    height: item.quality,
    duration: ''
  }
}

const episodeOrder = (a: string, b: string): number => {
  const d = Number(a) - Number(b)
  return Number.isNaN(d) || d === 0 ? a.localeCompare(b) : d
}

function episodeLabel(meta: SharedLibraryMeta | null, episodeInt: string): string {
  const full = meta?.episodes?.find((e) => e.episodeInt === episodeInt)?.episodeFull
  return full || `Episode ${episodeInt}`
}

export interface ImportTitleInfo {
  animeId: number
  /** The drive's record, from its snapshot: `downloadedAnime` gets it only when this PC has none. */
  snapshot: AnimeSearchResult
  /** The record the local name comes from: this PC's own `downloadedAnime` entry, else `snapshot`. */
  record: AnimeSearchResult
  name: string
}

/** The local name of each title: this PC's own record when it has one, else the drive's. */
export function titleInfo(
  src: ImportSource,
  manifest: SharedLibraryManifest,
  metas: ReadonlyMap<number, SharedLibraryMeta>,
  animeId: number
): ImportTitleInfo {
  const manifestName =
    manifest.titles.find((t) => t.animeId === animeId)?.name ?? `Anime ${animeId}`
  const episodes = new Set(
    manifest.items.filter((i) => i.animeId === animeId).map((i) => i.episodeInt)
  )
  const snapshot = snapshotRecord(animeId, manifestName, metas.get(animeId) ?? null, episodes.size)
  const record = src.localAnime(animeId) ?? snapshot
  return { animeId, snapshot, record, name: localTitle(record) ?? manifestName }
}

export interface ImportTree {
  titles: ExportTreeTitle[]
  rejected: ImportRejected[]
  /** Every copyable item by key, named for `root`. */
  items: Map<string, ImportItem>
  infos: Map<number, ImportTitleInfo>
}

/**
 * The tree of `animeIds` (every title in the library when null), named for
 * the destination `root`. Items whose local name is unsafe are left out of
 * the tree and listed in `rejected`; an item whose drive file is gone shows
 * as `missing`.
 */
export async function buildImportTree(
  src: ImportSource,
  libraryRoot: string,
  manifest: SharedLibraryManifest,
  metas: ReadonlyMap<number, SharedLibraryMeta>,
  animeIds: number[] | null,
  root: string
): Promise<ImportTree> {
  const order: number[] = []
  for (const id of [
    ...manifest.titles.map((t) => t.animeId),
    ...manifest.items.map((i) => i.animeId)
  ]) {
    if (!order.includes(id) && (animeIds === null || animeIds.includes(id))) order.push(id)
  }
  const titles: ExportTreeTitle[] = []
  const rejected: ImportRejected[] = []
  const items = new Map<string, ImportItem>()
  const infos = new Map<number, ImportTitleInfo>()
  for (const animeId of order) {
    const info = titleInfo(src, manifest, metas, animeId)
    infos.set(animeId, info)
    const meta = metas.get(animeId) ?? null
    const translations = new Map<number, ExportTreeTranslation>()
    const driveItems = manifest.items
      .filter((i) => i.animeId === animeId)
      .sort((a, b) => episodeOrder(a.episodeInt, b.episodeInt))
    for (const it of driveItems) {
      const key = itemKey(it)
      const label = episodeLabel(meta, it.episodeInt)
      const named = nameItem(root, info.name, it)
      if (!named.ok) {
        rejected.push({ key, label: `${info.name} — ${label}`, reason: UNSAFE_NAME })
        continue
      }
      let resolved: Awaited<ReturnType<typeof resolveItem>>
      try {
        resolved = await resolveItem(libraryRoot, it)
      } catch {
        resolved = { path: 'missing' }
      }
      if (resolved.path === 'escapes' || resolved.subtitlePath === 'escapes') {
        rejected.push({
          key,
          label: `${info.name} — ${label}`,
          reason: 'Can’t copy: the file leads outside the library'
        })
        continue
      }
      const sub = resolved.subtitlePath
      const subtitleSize =
        sub !== undefined && sub !== 'missing' && sub !== 'escapes'
          ? await fsp.stat(sub).then(
              (s) => s.size,
              () => 0
            )
          : 0
      const ready = resolved.path !== 'missing'
      let tr = translations.get(it.translationId)
      if (!tr) {
        tr = {
          translationId: it.translationId,
          author: it.author,
          translationType: it.translationType,
          quality: it.quality,
          episodes: []
        }
        translations.set(it.translationId, tr)
      }
      tr.episodes.push({
        key,
        episodeInt: it.episodeInt,
        label,
        state: ready ? 'ready' : 'missing',
        size: ready ? it.size + subtitleSize : 0,
        unmerged: it.subtitlePath !== undefined
      })
      if (!ready) continue
      items.set(key, {
        key,
        animeId,
        episodeInt: it.episodeInt,
        translationId: it.translationId,
        translationType: it.translationType,
        author: it.author,
        quality: it.quality,
        label,
        title: info.name,
        dirName: named.dirName,
        dest: named.dest,
        ...(named.destSubtitle ? { destSubtitle: named.destSubtitle } : {}),
        size: it.size,
        subtitleSize
      })
    }
    if (translations.size === 0) continue
    titles.push({
      animeId,
      name: info.name,
      translations: [...translations.values()].sort((a, b) => a.author.localeCompare(b.author)),
      notDownloaded: []
    })
  }
  return { titles, rejected, items, infos }
}

/** The local paths of one drive item, or why it can't be copied. */
export function nameItem(
  root: string,
  title: string,
  it: Pick<
    SharedLibraryItem,
    'animeId' | 'episodeInt' | 'translationId' | 'author' | 'path' | 'subtitlePath'
  >
): { ok: true; dirName: string; dest: string; destSubtitle?: string } | { ok: false } {
  const ext = path.posix.extname(it.path).toLowerCase()
  if (!(VIDEO_EXTS as readonly string[]).includes(ext)) return { ok: false }
  const base = {
    animeId: it.animeId,
    translationId: it.translationId,
    title,
    episodeInt: it.episodeInt,
    author: it.author
  }
  const video = buildLocalEpisodePath(root, { ...base, ext })
  if (!video.ok) return { ok: false }
  if (it.subtitlePath === undefined) return { ok: true, dirName: video.dirName, dest: video.path }
  if (path.posix.extname(it.subtitlePath).toLowerCase() !== '.ass') return { ok: false }
  const sub = buildLocalEpisodePath(root, { ...base, ext: '.ass' })
  if (!sub.ok) return { ok: false }
  return { ok: true, dirName: video.dirName, dest: video.path, destSubtitle: sub.path }
}
