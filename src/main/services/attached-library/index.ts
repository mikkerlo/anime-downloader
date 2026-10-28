// Attached Shared Libraries (#578, epic #563): the open flow, the identity
// check, the local claim, and play-time resolution of drive items.
//
// The service is the only thing that knows these roots. They are never added
// to `ROOT_KEYS`, handed to `coldStorageService`, scanned by
// `episode-file-scan.ts`, or added to the player's `dirsToCheck`, so cleanup and
// cold-storage moves can never touch the user's drive. Nothing here writes
// under a library root before S9 (#584): it reads with S5 (#573)'s reader, and
// the writability check is `access(W_OK)`.

import { promises as fsp } from 'fs'
import * as path from 'path'
import { itemKey, toAnimeSearchResult } from '../../lib/shared-library/format'
import { readLibrary, readMeta, LIBRARY_DIR } from '../../lib/shared-library/read'
import { discoverLibraries } from '../../lib/shared-library/discover'
import {
  absoluteOverflow,
  posterPath,
  resolveItem as resolveLibraryPath
} from '../../lib/shared-library/paths'
import type { StorageService } from '../../store/types'
import { ATTACHED_POSTER_MAX_BYTES } from '../../streaming/anime-poster-protocol'
import { checkWritable as defaultCheckWritable, type WritableVerdict } from './writable'
import { spawnPathFor as spawnPathForRoots, type SpawnPathImpl } from './spawn-path'

export { checkWritable } from './writable'

export interface AttachedLibraryServiceDeps {
  store: Pick<StorageService, 'get' | 'set'>
  /** `ffmpeg -version` (`checkFfmpeg` in `index.ts`). */
  checkFfmpeg: () => Promise<{ available: boolean }>
  /** Called after the attached set or a library's role changes. */
  onChanged?: () => void
  checkWritable?: (root: string) => Promise<WritableVerdict>
  /** S5's `absoluteOverflow`; injectable so a test can stand in a Windows mount point. */
  overflow?: typeof absoluteOverflow
  /** `path` for `spawnPathFor`; injectable so a test can stand in Windows' `\\?\` form. */
  spawnPath?: SpawnPathImpl
  now?: () => number
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface AttachedLibraryService {
  /** Re-reads every persisted library. Never throws. */
  init(): Promise<void>
  discover(dir: string): Promise<SharedLibraryCandidate[]>
  attach(libraryId: string, choice?: SharedLibraryAttachChoice): Promise<SharedLibraryAttachResult>
  list(): AttachedLibraryInfo[]
  get(libraryId: string): AttachedLibraryInfo | null
  getTitle(libraryId: string, animeId: number): Promise<AttachedTitleDetail | null>
  /** A drive file for this episode, `realpath`-checked on every call. */
  resolveItem(
    animeId: number,
    episodeInt: string,
    translationId: number
  ): Promise<AttachedResolvedItem | null>
  /** S12 (#592)'s integrity step: the same play-time check, plus the size. */
  checkItem(
    libraryId: string,
    item: Pick<SharedLibraryItem, 'path' | 'subtitlePath' | 'size'>
  ): Promise<AttachedItemCheck>
  /** The metadata snapshots of every available library (S3b #583). */
  availableSnapshots(): {
    libraryId: string
    name: string
    titles: { animeId: number; name: string; meta: SharedLibraryMeta | null }[]
  }[]
  /** `.anime-dl/posters/<animeId>.jpg` from the first library holding one. */
  posterFor(animeId: number): Promise<string | null>
  /** The attached roots, as picked and as `realpath`ed. */
  roots(): string[]
  spawnPathFor(abs: string): string
}

/** What one open of a root holds in memory. */
interface Opened {
  root: string
  realRoot: string
  manifest: SharedLibraryManifest | null
  message?: string
  metas: Map<number, SharedLibraryMeta>
  posters: Set<number>
  pathOverflow: number
}

const STORE_KEY = 'attachedLibraries'

/** The one poster cap, shared with `anime-poster://`'s capped read. */
export const POSTER_MAX_BYTES = ATTACHED_POSTER_MAX_BYTES

const containerOf = (p: string): 'mkv' | 'mp4' => (p.toLowerCase().endsWith('.mkv') ? 'mkv' : 'mp4')

const episodeOrder = (a: string, b: string): number => {
  const d = parseFloat(a) - parseFloat(b)
  return Number.isNaN(d) || d === 0 ? a.localeCompare(b) : d
}

function roleOf(rec: AttachedLibraryRecord, userId: number | null): AttachedLibraryRole {
  if (rec.mode === 'videos' || !rec.owner) return 'videos'
  if (userId !== null) return userId === rec.owner.shikimoriId ? 'owner' : 'foreign'
  return rec.claim?.ownerId === rec.owner.shikimoriId ? 'claim' : 'videos'
}

function identityOf(
  manifest: SharedLibraryManifest,
  userId: number | null
): SharedLibraryCandidate['identity'] {
  if (manifest.mode === 'videos' || !manifest.owner) return 'videos'
  if (userId === null) return 'choose'
  return userId === manifest.owner.shikimoriId ? 'owner' : 'foreign'
}

function snapshotAnime(
  animeId: number,
  name: string,
  meta: SharedLibraryMeta | undefined,
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
  // The drive's poster URL is untrusted and would load from any host; the card
  // reads `anime-poster://`, which serves the local cache, then the drive.
  return { ...base, id: animeId, posterUrlSmall: `anime-poster://${animeId}` }
}

export function createAttachedLibraryService(
  deps: AttachedLibraryServiceDeps
): AttachedLibraryService {
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const checkWritable = deps.checkWritable ?? defaultCheckWritable
  const overflow = deps.overflow ?? absoluteOverflow
  const opened = new Map<string, Opened>()
  // The last discovery's libraries, by id, so `attach` takes an id, not a path.
  const discovered = new Map<string, string>()

  const records = (): Record<string, AttachedLibraryRecord> =>
    (deps.store.get(STORE_KEY) as Record<string, AttachedLibraryRecord> | undefined) ?? {}
  const save = (next: Record<string, AttachedLibraryRecord>): void =>
    deps.store.set(STORE_KEY, next)
  const userId = (): number | null =>
    (deps.store.get('shikimoriUser') as { id?: number } | null | undefined)?.id ?? null

  /**
   * A claim lasts while the PC has no account. A login as the same id makes it
   * plain ownership, as a different id the library turns foreign; either way
   * the claim is dropped. The library base (`sync-bases/`) is S9's and is kept.
   */
  function reconcileClaims(): void {
    const id = userId()
    if (id === null) return
    const recs = records()
    let changed = false
    for (const rec of Object.values(recs)) {
      if (rec.claim) {
        delete rec.claim
        changed = true
      }
    }
    if (changed) {
      save(recs)
      deps.onChanged?.()
    }
  }

  async function open(root: string): Promise<{ read: SharedLibraryRead; opened: Opened }> {
    const read = await readLibrary(root)
    const manifest =
      read.status === 'ok' ? read.manifest : read.status === 'read-only' ? read.manifest : null
    let realRoot = root
    try {
      realRoot = await fsp.realpath(root)
    } catch {
      // Unreadable: the reader has already said so.
    }
    const metas = new Map<number, SharedLibraryMeta>()
    const posters = new Set<number>()
    if (manifest) {
      const ids = new Set<number>([
        ...manifest.titles.map((t) => t.animeId),
        ...manifest.items.map((i) => i.animeId)
      ])
      await Promise.all(
        [...ids].map(async (id) => {
          const m = await readMeta(root, id)
          if (m.status === 'ok') metas.set(id, m.meta)
          const poster = posterPath(id)
          if (!poster) return
          try {
            const st = await fsp.stat(path.join(root, LIBRARY_DIR, poster))
            if (st.isFile() && st.size <= POSTER_MAX_BYTES) posters.add(id)
          } catch {
            // No poster.
          }
        })
      )
    }
    return {
      read,
      opened: {
        root,
        realRoot,
        manifest,
        ...(read.status === 'read-only' ? { message: read.message } : {}),
        metas,
        posters,
        pathOverflow: manifest ? overflow(root, manifest.items).length : 0
      }
    }
  }

  function titlesOf(o: Opened): AttachedLibraryTitle[] {
    const m = o.manifest
    if (!m) return []
    const downloaded =
      (deps.store.get('downloadedAnime') as Record<string, unknown> | undefined) ?? {}
    const names = new Map<number, string>()
    for (const t of m.titles) names.set(t.animeId, t.name)
    for (const i of m.items) if (!names.has(i.animeId)) names.set(i.animeId, `#${i.animeId}`)
    return [...names].map(([animeId, name]) => {
      const items = m.items
        .filter((i) => i.animeId === animeId)
        .sort((a, b) => episodeOrder(a.episodeInt, b.episodeInt))
      const target = (i: SharedLibraryItem): AttachedPlayTarget => ({
        episodeInt: i.episodeInt,
        translationId: i.translationId,
        container: containerOf(i.path)
      })
      const first = items[0]
      const firstMp4 = items.find((i) => containerOf(i.path) === 'mp4')
      return {
        animeId,
        name,
        anime: snapshotAnime(
          animeId,
          name,
          o.metas.get(animeId),
          new Set(items.map((i) => i.episodeInt)).size
        ),
        hasPoster: o.posters.has(animeId),
        onThisPc: !!downloaded[String(animeId)],
        itemCount: items.length,
        mkvCount: items.filter((i) => containerOf(i.path) === 'mkv').length,
        play: {
          any: first ? target(first) : null,
          withoutFfmpeg: firstMp4 ? target(firstMp4) : null
        }
      }
    })
  }

  function infoOf(libraryId: string, rec: AttachedLibraryRecord): AttachedLibraryInfo {
    const o = opened.get(libraryId)
    return {
      libraryId,
      root: rec.root,
      name: rec.name,
      mode: rec.mode,
      ownerNickname: rec.owner?.nickname ?? null,
      role: roleOf(rec, userId()),
      access: rec.access,
      ...(rec.accessReason ? { accessReason: rec.accessReason } : {}),
      ...(o?.message ? { message: o.message } : {}),
      available: !!o?.manifest,
      pathOverflow: o?.pathOverflow ?? 0,
      mkvCount: o?.manifest?.items.filter((i) => containerOf(i.path) === 'mkv').length ?? 0,
      titles: o ? titlesOf(o) : []
    }
  }

  /** `read-write` unless the reader made it read-only; the writability check can only demote. */
  async function accessOf(
    root: string,
    read: SharedLibraryRead
  ): Promise<Pick<AttachedLibraryRecord, 'access' | 'accessReason'>> {
    if (read.status === 'read-only') return { access: 'read-only', accessReason: read.reason }
    const verdict = await checkWritable(root)
    if (verdict.kind === 'read-only') return { access: 'read-only', accessReason: 'mount' }
    if (verdict.kind === 'unknown') {
      log.warn(
        `[shared-library] writability check failed for ${root}; access unchanged`,
        verdict.error
      )
    }
    return { access: 'read-write' }
  }

  function logRead(root: string, read: SharedLibraryRead): void {
    if (read.status === 'ok' && read.torn) {
      log.log(
        `[shared-library] ${root}: torn pair, opened on (${read.pair.manifest}, ${read.pair.state ?? 'no state'}); the next sync write repairs it`
      )
    } else if (read.status === 'read-only') {
      log.log(`[shared-library] ${root}: read-only (${read.reason})`)
    }
  }

  async function init(): Promise<void> {
    reconcileClaims()
    const recs = records()
    let changed = false
    await Promise.all(
      Object.entries(recs).map(async ([libraryId, rec]) => {
        try {
          const { read, opened: o } = await open(rec.root)
          if (!o.manifest || o.manifest.libraryId !== libraryId) return
          logRead(rec.root, read)
          opened.set(libraryId, o)
          Object.assign(rec, await accessOf(rec.root, read), { lastSeenAt: now() })
          if (!rec.accessReason) delete rec.accessReason
          changed = true
        } catch (err) {
          log.warn(`[shared-library] could not reopen ${rec.root}`, err)
        }
      })
    )
    if (changed) save(recs)
  }

  async function discover(dir: string): Promise<SharedLibraryCandidate[]> {
    const id = userId()
    const out: SharedLibraryCandidate[] = []
    for (const root of await discoverLibraries(dir)) {
      const read = await readLibrary(root)
      if (read.status === 'none') continue
      const manifest = read.manifest
      const readOnly =
        read.status === 'read-only' ? { reason: read.reason, message: read.message } : undefined
      if (manifest) discovered.set(manifest.libraryId, root)
      out.push({
        root,
        libraryId: manifest?.libraryId ?? null,
        name: manifest?.name ?? path.basename(root),
        ownerNickname: manifest?.owner?.nickname ?? null,
        mode: manifest?.mode ?? null,
        titleCount: manifest?.titles.length ?? 0,
        identity: manifest ? identityOf(manifest, id) : 'videos',
        ...(readOnly ? { readOnly } : {})
      })
    }
    return out
  }

  async function attach(
    libraryId: string,
    choice?: SharedLibraryAttachChoice
  ): Promise<SharedLibraryAttachResult> {
    const root = discovered.get(libraryId)
    if (!root) return { ok: false, error: 'Open the folder again: this library was not found.' }
    const { read, opened: o } = await open(root)
    const manifest = o.manifest
    if (!manifest || manifest.libraryId !== libraryId) {
      return { ok: false, error: 'This library changed on disk. Open the folder again.' }
    }
    logRead(root, read)
    const id = userId()
    let claim: AttachedLibraryRecord['claim']
    if (choice === 'claim') {
      if (id !== null || manifest.mode !== 'metadata' || !manifest.owner) {
        return { ok: false, error: 'Only a PC without a Shikimori account can claim a library.' }
      }
      claim = { ownerId: manifest.owner.shikimoriId, at: now() }
    }
    const rec: AttachedLibraryRecord = {
      root,
      name: manifest.name ?? path.basename(root),
      mode: manifest.mode,
      owner: manifest.owner,
      ...(await accessOf(root, read)),
      ...(claim ? { claim } : {}),
      lastSeenAt: now(),
      lastSyncAt: records()[libraryId]?.lastSyncAt ?? null
    }
    const recs = records()
    recs[libraryId] = rec
    save(recs)
    opened.set(libraryId, o)
    const library = infoOf(libraryId, rec)
    let ffmpegMissing: { mkvCount: number } | undefined
    if (library.mkvCount > 0) {
      const ff = await deps.checkFfmpeg().catch(() => ({ available: false }))
      if (!ff.available) ffmpegMissing = { mkvCount: library.mkvCount }
    }
    deps.onChanged?.()
    return { ok: true, library, ...(ffmpegMissing ? { ffmpegMissing } : {}) }
  }

  function list(): AttachedLibraryInfo[] {
    reconcileClaims()
    return Object.entries(records()).map(([libraryId, rec]) => infoOf(libraryId, rec))
  }

  function get(libraryId: string): AttachedLibraryInfo | null {
    reconcileClaims()
    const rec = records()[libraryId]
    return rec ? infoOf(libraryId, rec) : null
  }

  async function getTitle(libraryId: string, animeId: number): Promise<AttachedTitleDetail | null> {
    const rec = records()[libraryId]
    const o = opened.get(libraryId)
    if (!rec || !o?.manifest) return null
    const items = o.manifest.items.filter((i) => i.animeId === animeId)
    const titleName = o.manifest.titles.find((t) => t.animeId === animeId)?.name
    if (items.length === 0 && titleName === undefined) return null
    const meta = o.metas.get(animeId) ?? null
    const fullOf = new Map((meta?.episodes ?? []).map((e) => [e.episodeInt, e.episodeFull]))
    const byEpisode = new Map<string, AttachedTitleItem[]>()
    for (const i of items) {
      const list = byEpisode.get(i.episodeInt) ?? []
      list.push({
        translationId: i.translationId,
        translationType: i.translationType,
        author: i.author,
        quality: i.quality,
        container: containerOf(i.path),
        hasSubtitle: i.subtitlePath !== undefined
      })
      byEpisode.set(i.episodeInt, list)
    }
    const episodes = [...byEpisode]
      .sort(([a], [b]) => episodeOrder(a, b))
      .map(([episodeInt, list]) => ({
        episodeInt,
        episodeFull: fullOf.get(episodeInt) ?? `${episodeInt} episode`,
        items: list
      }))
    const name = titleName ?? `#${animeId}`
    return {
      libraryId,
      libraryName: rec.name,
      animeId,
      anime: snapshotAnime(animeId, name, meta ?? undefined, episodes.length),
      meta,
      hasPoster: o.posters.has(animeId),
      episodes
    }
  }

  async function resolveItem(
    animeId: number,
    episodeInt: string,
    translationId: number
  ): Promise<AttachedResolvedItem | null> {
    const key = itemKey({ animeId, episodeInt, translationId })
    for (const [libraryId, o] of opened) {
      const item = o.manifest?.items.find((i) => itemKey(i) === key)
      if (!item) continue
      let r: Awaited<ReturnType<typeof resolveLibraryPath>>
      try {
        r = await resolveLibraryPath(o.root, item)
      } catch (err) {
        log.warn(`[shared-library] ${key} could not be resolved in ${o.root}`, err)
        continue
      }
      if (r.path === 'escapes') {
        log.warn(`[shared-library] refused ${key}: its path leads outside ${o.root}`)
        continue
      }
      if (r.path === 'missing') continue
      const subtitlePath =
        r.subtitlePath && r.subtitlePath !== 'missing' && r.subtitlePath !== 'escapes'
          ? r.subtitlePath
          : undefined
      if (r.subtitlePath === 'escapes') {
        log.warn(`[shared-library] refused the subtitle of ${key}: it leads outside ${o.root}`)
      }
      return { libraryId, path: r.path, ...(subtitlePath ? { subtitlePath } : {}) }
    }
    return null
  }

  async function checkItem(
    libraryId: string,
    item: Pick<SharedLibraryItem, 'path' | 'subtitlePath' | 'size'>
  ): Promise<AttachedItemCheck> {
    const o = opened.get(libraryId)
    if (!o) return 'missing'
    const r = await resolveLibraryPath(o.root, item)
    if (r.path === 'escapes' || r.subtitlePath === 'escapes') return 'escapes'
    if (r.path === 'missing') return 'missing'
    const st = await fsp.stat(r.path).catch(() => null)
    if (!st) return 'missing'
    return st.size === item.size ? 'ok' : 'wrong-size'
  }

  function availableSnapshots(): ReturnType<AttachedLibraryService['availableSnapshots']> {
    const recs = records()
    const out: ReturnType<AttachedLibraryService['availableSnapshots']> = []
    for (const [libraryId, o] of opened) {
      const rec = recs[libraryId]
      if (!rec || !o.manifest) continue
      out.push({
        libraryId,
        name: rec.name,
        titles: o.manifest.titles.map((t) => ({
          animeId: t.animeId,
          name: t.name,
          meta: o.metas.get(t.animeId) ?? null
        }))
      })
    }
    return out
  }

  async function posterFor(animeId: number): Promise<string | null> {
    const rel = posterPath(animeId)
    if (!rel) return null
    for (const o of opened.values()) {
      if (!o.posters.has(animeId)) continue
      try {
        const r = await resolveLibraryPath(path.join(o.root, LIBRARY_DIR), { path: rel })
        if (r.path === 'missing' || r.path === 'escapes') continue
        // Re-checked at serve time: the drive can change the file after `open()`.
        const st = await fsp.stat(r.path)
        if (st.isFile() && st.size <= POSTER_MAX_BYTES) return r.path
      } catch {
        // Next library.
      }
    }
    return null
  }

  function roots(): string[] {
    const out = new Set<string>()
    for (const o of opened.values()) {
      out.add(o.root)
      out.add(o.realRoot)
    }
    return [...out]
  }

  return {
    init,
    discover,
    attach,
    list,
    get,
    getTitle,
    resolveItem,
    checkItem,
    availableSnapshots,
    posterFor,
    roots,
    spawnPathFor: (abs) => spawnPathForRoots(abs, roots(), deps.spawnPath)
  }
}
