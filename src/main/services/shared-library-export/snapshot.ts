// The metadata and poster snapshot an export writes per title (#574):
// `meta/<animeId>.json` from the cached details and the title's record, and
// `posters/<animeId>.jpg` from `poster-cache/`.
//
// `meta` has no writer walk (docs/shared-library.md), so a re-export merges
// the local snapshot's known fields over a file that reads at a known major
// and carries that file's unknown fields with `carryUnknown`, at every record
// level: a newer minor's fields survive this PC's re-export. A file over its
// 1 MB cap is left alone.

import * as path from 'path'
import { META_SCHEMA, carryUnknown, serializeMeta } from '../../lib/shared-library/format'
import { posterPath } from '../../lib/shared-library/paths'
import { LIBRARY_DIR, check, readMeta } from '../../lib/shared-library/read'
import { errnoOf, writeSmallFile, type ExportFs } from './copy'

/** The local snapshot, checked against the v1 schema: a field a reader would drop is left out. */
export function buildMeta(
  animeId: number,
  detail: AnimeDetail | null,
  record: AnimeSearchResult | null
): SharedLibraryMeta {
  const sr = record ?? detail
  // Only the allow-listed fields, at every level: nothing else from this PC reaches the drive.
  const titles: Record<string, string> = {}
  for (const k of ['ru', 'romaji', 'ja'] as const) {
    if (sr?.titles?.[k]) titles[k] = sr.titles[k] as string
  }
  const raw: Record<string, unknown> = { animeId }
  if (detail?.myAnimeListId !== undefined) raw.malId = detail.myAnimeListId
  if (sr?.titles) raw.titles = { ...titles }
  if (detail?.genres) raw.genres = detail.genres.map((g) => ({ id: g.id, title: g.title }))
  if (sr?.year !== undefined) raw.year = sr.year
  if (sr?.type !== undefined) raw.type = sr.type
  if (detail?.episodes) {
    raw.episodes = detail.episodes.map((e) => ({
      episodeInt: e.episodeInt,
      ...(e.episodeFull ? { episodeFull: e.episodeFull } : {})
    }))
  }
  if (sr) {
    raw.searchResult = {
      id: sr.id,
      title: sr.title,
      titles: { ...titles },
      posterUrlSmall: sr.posterUrlSmall,
      numberOfEpisodes: sr.numberOfEpisodes,
      type: sr.type,
      typeTitle: sr.typeTitle,
      year: sr.year,
      season: sr.season
    }
  }
  const c = check(META_SCHEMA, raw, 'meta', [])
  return (c.ok ? c.value : { animeId }) as SharedLibraryMeta
}

function mergeRecord<T extends object>(
  existing: T | undefined,
  local: T | undefined
): T | undefined {
  if (local === undefined) return existing
  if (existing === undefined) return local
  return carryUnknown(existing, { ...existing, ...local })
}

function mergeKeyed<T extends object>(
  existing: T[] | undefined,
  local: T[] | undefined,
  keyOf: (e: T) => string
): T[] | undefined {
  if (local === undefined) return existing
  const before = new Map((existing ?? []).map((e) => [keyOf(e), e]))
  return local.map((e) => {
    const old = before.get(keyOf(e))
    return old ? carryUnknown(old, { ...old, ...e }) : e
  })
}

/** `local`'s known fields over `existing`, keeping `existing`'s unknown fields at every level. */
export function mergeMeta(
  existing: SharedLibraryMeta,
  local: SharedLibraryMeta
): SharedLibraryMeta {
  const out: SharedLibraryMeta = { ...existing }
  for (const [k, v] of Object.entries(local)) {
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v
  }
  out.titles = mergeRecord(existing.titles, local.titles)
  out.genres = mergeKeyed(existing.genres, local.genres, (g) => String(g.id))
  out.episodes = mergeKeyed(existing.episodes, local.episodes, (e) => e.episodeInt)
  if (local.searchResult && existing.searchResult) {
    const sr = carryUnknown(existing.searchResult, {
      ...existing.searchResult,
      ...local.searchResult
    })
    sr.titles = mergeRecord(existing.searchResult.titles, local.searchResult.titles)!
    out.searchResult = sr
  }
  return carryUnknown(existing, out)
}

async function mkdirQuiet(xfs: ExportFs, dir: string): Promise<void> {
  try {
    await xfs.mkdir(dir)
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err
  }
}

export type SnapshotOutcome = 'written' | 'merged' | 'kept-over-cap'

/** Writes (or merges) `meta/<animeId>.json`, and copies the poster when there is one. */
export async function writeTitleSnapshot(
  xfs: ExportFs,
  root: string,
  local: SharedLibraryMeta,
  posterFile: string | null
): Promise<SnapshotOutcome> {
  const lib = path.join(root, LIBRARY_DIR)
  await mkdirQuiet(xfs, path.join(lib, 'meta'))
  const existing = await readMeta(root, local.animeId)
  let outcome: SnapshotOutcome = 'kept-over-cap'
  if (existing.status !== 'size') {
    const meta = existing.status === 'ok' ? mergeMeta(existing.meta, local) : local
    await writeSmallFile(xfs, path.join(lib, 'meta', `${local.animeId}.json`), serializeMeta(meta))
    outcome = existing.status === 'ok' ? 'merged' : 'written'
  }
  const rel = posterPath(local.animeId)
  if (posterFile && rel) {
    let bytes: Buffer | null = null
    try {
      bytes = await xfs.readFile(posterFile)
    } catch (err) {
      if (errnoOf(err) !== 'ENOENT') throw err
    }
    if (bytes) {
      await mkdirQuiet(xfs, path.join(lib, 'posters'))
      await writeSmallFile(xfs, path.join(lib, ...rel.split('/')), bytes)
    }
  }
  return outcome
}
