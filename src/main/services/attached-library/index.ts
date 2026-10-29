// Attached Shared Libraries (#578, epic #563): the open flow, the identity
// check, the local claim, and play-time resolution of drive items.
//
// The service is the only thing that knows these roots. They are never added
// to `ROOT_KEYS`, handed to `coldStorageService`, scanned by
// `episode-file-scan.ts`, or added to the player's `dirsToCheck`, so cleanup and
// cold-storage moves can never touch the user's drive. Nothing here writes
// under a library root before S9 (#584): it reads with S5 (#573)'s reader, and
// the writability check is `access(W_OK)`.
//
// The lifecycle (#582): every availability transition re-checks writability,
// `reportWriteFailure` demotes a library whose real write failed, and an
// unplugged library renders from the snapshot cache (`snapshot-cache.ts`).

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
import { createListenerSet } from '../../lib/listener-set'
import type { SyncBaseStore } from '../../lib/sync-state/bases'
import {
  checkWritable as defaultCheckWritable,
  READ_ONLY_CODES,
  type WritableVerdict
} from './writable'
import { isUnder, spawnPathFor as spawnPathForRoots, type SpawnPathImpl } from './spawn-path'
import type { KnownLibrary } from './poller'
import type { SnapshotCache } from './snapshot-cache'

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
  /** Forget's step 1: resolves once no S9 (#584) sync run on this library is in flight. */
  syncIdle?: (libraryId: string) => Promise<void>
  /** `userData/shared-library-cache` (#582); without it nothing is cached. */
  snapshotCache?: SnapshotCache
  /** `userData/sync-bases`: a claim PC's rates come from the library base (#582). */
  syncBases?: Pick<SyncBaseStore, 'read'>
  /** Fills `stat` for `classifyMissing`; injectable for a test. */
  stat?: (p: string) => Promise<unknown>
}

/** The errors that mean "the drive went away" when the path is under an attached root (#582). */
export const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EIO',
  'ENXIO',
  'ENODEV',
  'EBUSY'
])

/**
 * The forget-hook contract (#581). S8 (#582) and S9 (#584) register one each.
 * `pendingCount` reads no drive and makes no network call; its two numbers
 * never overlap. `onForgotten` deletes the per-library data its slice owns,
 * is idempotent, and never touches the drive.
 */
export interface ForgetHook {
  pendingCount?(libraryId: string): SharedLibraryPendingCount | Promise<SharedLibraryPendingCount>
  onForgotten(libraryId: string): Promise<void>
}

export interface AttachedLibraryService {
  /** Re-reads every persisted library. Never throws. */
  init(): Promise<void>
  /**
   * Re-reads one attached library after a write to `root`, as `init` does,
   * and fires `onChanged`. A no-op unless `root` is the attached copy.
   * Serialized per library. Never throws.
   */
  refresh(libraryId: string, root: string): Promise<void>
  discover(dir: string): Promise<SharedLibraryCandidate[]>
  /** `from: 'found'` attaches the root the poller found, not the last hand-opened one. */
  attach(
    libraryId: string,
    choice?: SharedLibraryAttachChoice,
    from?: SharedLibraryAttachSource
  ): Promise<SharedLibraryAttachResult>
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

  // --- Availability (#581): the poller's side, see `poller.ts`.
  known(): KnownLibrary[]
  /** Re-reads `root` as this library's (`reopen`); on a match it becomes its root, available. */
  reopenAt(libraryId: string, root: string): Promise<boolean>
  /** Unavailable, `lastSeenAt` kept; a no-op unless `root` is still its root. */
  markUnavailable(libraryId: string, root: string): void
  markSeen(libraryId: string): void
  /** The library at `root` as the open flow lists it, attachable by id with `from: 'found'`. */
  identify(root: string): Promise<SharedLibraryCandidate | null>
  isDismissed(libraryId: string): boolean
  /** "Don't ask for this drive": remembered in `sharedLibraryPromptDismissed`. */
  dismissPrompt(libraryIds: string[]): void
  /** Persists the time each available library was last seen (quit). */
  saveLastSeen(): void

  // --- Forget and Re-locate (#581)
  registerForgetHook(hook: ForgetHook): () => void
  /** Never touches the drive. Resolves after every hook's `onForgotten` settled. */
  forget(
    libraryId: string,
    opts?: { confirmDropPending?: boolean }
  ): Promise<SharedLibraryForgetResult>
  /** Accepts `dir` (or a folder one level below) only when it holds this `libraryId`. */
  relocate(libraryId: string, dir: string): Promise<SharedLibraryRelocateResult>

  // --- Lifecycle (#582)
  /**
   * S9 (#584)'s contract: a write under the root failed. `EROFS`, `EACCES` and
   * `EPERM` make the library `read-only` (`write-failed`) until its next
   * availability transition re-checks it; true when it demoted. Other errors
   * don't demote. Never throws.
   */
  reportWriteFailure(libraryId: string, err: unknown): boolean
  /** Every availability transition, and `access` turning writable. Returns an unsubscribe. */
  onAvailabilityChanged(listener: (t: AttachedLibraryTransition) => void): () => void
  /**
   * `'drive-disconnected'` when `p` is under an attached root and can't be
   * `stat`ed now; logged once per library until it is seen again. Never throws.
   */
  classifyMissing(p: string): Promise<PlayerFailureReason | null>
  /** The same from an error already in hand (the `anime-video://` handler); logs only. */
  reportUnreadable(p: string, err: unknown): boolean
  /** `list()`, with a claim PC's rates from each library base. */
  listWithRates(): Promise<AttachedLibraryInfo[]>
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
const DISMISSED_KEY = 'sharedLibraryPromptDismissed'

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
  // The same, for libraries the availability poller found on a drive (#581).
  const found = new Map<string, string>()
  // How many times each library was attached, so a startup read that began earlier never replaces an attach's.
  const attaches = new Map<string, number>()
  // Opened, then found gone by the poller (#581); the in-memory copy is kept for S8 (#582).
  const unavailable = new Set<string>()
  // When the poller last saw each available library; persisted when it goes, and on quit.
  const seenAt = new Map<string, number>()
  const forgetHooks = createListenerSet<[(hook: ForgetHook) => void]>('forget-hook')
  // Read from the snapshot cache because the root couldn't be read at startup (#582).
  const cached = new Map<string, Opened>()
  const transitions = createListenerSet<[AttachedLibraryTransition]>('availability')
  // Libraries whose disconnect was logged, until they are seen again.
  const disconnectLogged = new Set<string>()
  const stat = deps.stat ?? ((p: string) => fsp.stat(p))
  const cache = deps.snapshotCache

  const isAvailable = (libraryId: string): boolean =>
    !!opened.get(libraryId)?.manifest && !unavailable.has(libraryId)
  /** What a library renders from: this run's read, else the snapshot cache. */
  const view = (libraryId: string): Opened | undefined =>
    opened.get(libraryId) ?? cached.get(libraryId)

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
    const o = view(libraryId)
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
      available: isAvailable(libraryId),
      lastSeenAt: (isAvailable(libraryId) ? seenAt.get(libraryId) : undefined) ?? rec.lastSeenAt,
      lastSyncAt: rec.lastSyncAt ?? null,
      pathOverflow: o?.pathOverflow ?? 0,
      mkvCount: o?.manifest?.items.filter((i) => containerOf(i.path) === 'mkv').length ?? 0,
      titles: o ? titlesOf(o) : []
    }
  }

  /**
   * `read-write` unless the reader made it read-only; the writability check can
   * only demote. An inconclusive check keeps `prev`'s `mount` / `write-failed`.
   */
  async function accessOf(
    root: string,
    read: SharedLibraryRead,
    prev?: Pick<AttachedLibraryRecord, 'access' | 'accessReason'>
  ): Promise<Pick<AttachedLibraryRecord, 'access' | 'accessReason'>> {
    if (read.status === 'read-only') return { access: 'read-only', accessReason: read.reason }
    const verdict = await checkWritable(root)
    if (verdict.kind === 'read-only') return { access: 'read-only', accessReason: 'mount' }
    if (verdict.kind === 'unknown') {
      log.warn(
        `[shared-library] writability check failed for ${root}; access unchanged`,
        verdict.error
      )
      if (
        prev?.access === 'read-only' &&
        (prev.accessReason === 'mount' || prev.accessReason === 'write-failed')
      ) {
        return { access: 'read-only', accessReason: prev.accessReason }
      }
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

  type Reopened = { o: Opened } & Pick<AttachedLibraryRecord, 'access' | 'accessReason'>

  /** One persisted root re-read, or null when it no longer holds `libraryId`. */
  async function reopen(libraryId: string, rec: AttachedLibraryRecord): Promise<Reopened | null> {
    const { read, opened: o } = await open(rec.root)
    if (!o.manifest || o.manifest.libraryId !== libraryId) return null
    logRead(rec.root, read)
    return { o, ...(await accessOf(rec.root, read, rec)) }
  }

  /**
   * Makes `r` the library's read. On an availability transition the access
   * check's result stands; otherwise a `write-failed` demotion is kept, since
   * only a transition re-checks it. Returns the transition to emit once the
   * record is saved, or null.
   */
  function commit(
    libraryId: string,
    rec: AttachedLibraryRecord,
    r: Reopened
  ): AttachedLibraryTransition | null {
    const transition = !isAvailable(libraryId)
    const wasReadOnly = rec.access === 'read-only'
    let { access, accessReason } = r
    if (!transition && rec.accessReason === 'write-failed' && access === 'read-write') {
      access = 'read-only'
      accessReason = 'write-failed'
    }
    opened.set(libraryId, r.o)
    cached.delete(libraryId)
    rec.access = access
    if (accessReason) rec.accessReason = accessReason
    else delete rec.accessReason
    rec.lastSeenAt = now()
    unavailable.delete(libraryId)
    seenAt.set(libraryId, rec.lastSeenAt)
    disconnectLogged.delete(libraryId)
    persistSnapshot(libraryId, r.o)
    const becameWritable = wasReadOnly && access === 'read-write'
    if (!transition && !becameWritable) return null
    return {
      libraryId,
      available: true,
      access,
      ...(accessReason ? { accessReason } : {}),
      becameWritable
    }
  }

  function emitTransition(t: AttachedLibraryTransition | null): void {
    if (t) transitions.emit(t)
  }

  function capEntries(): { libraryId: string; available: boolean; lastSeenAt: number }[] {
    return Object.entries(records()).map(([libraryId, rec]) => ({
      libraryId,
      available: isAvailable(libraryId),
      lastSeenAt: (isAvailable(libraryId) ? seenAt.get(libraryId) : undefined) ?? rec.lastSeenAt
    }))
  }

  /** Refreshes the snapshot cache from a fresh read, then checks the poster cap. Never throws. */
  function persistSnapshot(libraryId: string, o: Opened): void {
    if (!cache || !o.manifest) return
    const input = {
      manifest: o.manifest,
      metas: o.metas,
      posters: o.posters,
      posterSource: async (animeId: number): Promise<string | null> => {
        const rel = posterPath(animeId)
        if (!rel) return null
        const r = await resolveLibraryPath(path.join(o.root, LIBRARY_DIR), { path: rel })
        return r.path === 'missing' || r.path === 'escapes' ? null : r.path
      }
    }
    void cache
      .save(libraryId, input, () => !!records()[libraryId])
      .then(() => cache.enforceCap(capEntries()))
      .catch((err) => log.warn(`[shared-library] could not cache ${libraryId}`, err))
  }

  /** An unreadable library at startup: its titles from the snapshot cache, if any. */
  async function loadCached(libraryId: string): Promise<void> {
    if (!cache) return
    const snap = await cache.load(libraryId)
    const rec = records()[libraryId]
    if (!snap || !rec || opened.has(libraryId)) return
    cached.set(libraryId, {
      root: rec.root,
      realRoot: rec.root,
      manifest: snap.manifest,
      metas: snap.metas,
      posters: snap.posters,
      pathOverflow: 0
    })
  }

  // The startup reopen; a `refresh` waits for it, so its older read never lands last.
  let ready: Promise<void> = Promise.resolve()

  function init(): Promise<void> {
    ready = reopenAll()
    return ready
  }

  async function reopenAll(): Promise<void> {
    reconcileClaims()
    await Promise.all(
      Object.entries(records()).map(async ([libraryId, rec]) => {
        const before = attaches.get(libraryId)
        try {
          const r = await reopen(libraryId, rec)
          if (!r) return await loadCached(libraryId)
          // Fetched after the read, so an `attach` that landed meanwhile is
          // kept; one that opened this library itself has the newer read.
          const recs = records()
          const current = recs[libraryId]
          if (!current || current.root !== rec.root || attaches.get(libraryId) !== before) return
          const t = commit(libraryId, current, r)
          save(recs)
          emitTransition(t)
        } catch (err) {
          log.warn(`[shared-library] could not reopen ${rec.root}`, err)
          await loadCached(libraryId).catch(() => {})
        }
      })
    )
  }

  async function refreshOnce(libraryId: string, root: string): Promise<void> {
    await ready.catch(() => {})
    const rec = records()[libraryId]
    if (!rec) return
    try {
      const attachedReal = opened.get(libraryId)?.realRoot ?? (await fsp.realpath(rec.root))
      if ((await fsp.realpath(root)) !== attachedReal) return
      const r = await reopen(libraryId, rec)
      if (!r) return
      // Fetched after the read, so an `attach` that landed meanwhile is kept.
      const recs = records()
      const current = recs[libraryId]
      if (!current || current.root !== rec.root) return
      const t = commit(libraryId, current, r)
      save(recs)
      deps.onChanged?.()
      emitTransition(t)
    } catch (err) {
      log.warn(`[shared-library] could not refresh ${root}`, err)
    }
  }

  const refreshing = new Map<string, { root: string; dirty: boolean; done: Promise<void> }>()

  function refresh(libraryId: string, root: string): Promise<void> {
    const running = refreshing.get(libraryId)
    if (running) {
      running.root = root
      running.dirty = true
      return running.done
    }
    const entry = { root, dirty: true, done: Promise.resolve() }
    refreshing.set(libraryId, entry)
    entry.done = (async () => {
      try {
        while (entry.dirty) {
          entry.dirty = false
          await refreshOnce(libraryId, entry.root)
        }
      } finally {
        refreshing.delete(libraryId)
      }
    })()
    return entry.done
  }

  /** The library at `root`, remembered in `into` so `attach` can take its id. */
  async function candidateAt(
    root: string,
    into: Map<string, string>
  ): Promise<SharedLibraryCandidate | null> {
    const read = await readLibrary(root)
    if (read.status === 'none') return null
    const manifest = read.manifest
    const readOnly =
      read.status === 'read-only' ? { reason: read.reason, message: read.message } : undefined
    if (manifest) into.set(manifest.libraryId, root)
    return {
      root,
      libraryId: manifest?.libraryId ?? null,
      name: manifest?.name ?? path.basename(root),
      ownerNickname: manifest?.owner?.nickname ?? null,
      mode: manifest?.mode ?? null,
      titleCount: manifest?.titles.length ?? 0,
      identity: manifest ? identityOf(manifest, userId()) : 'videos',
      ...(readOnly ? { readOnly } : {})
    }
  }

  // The poller's own finds, apart from `discovered`: a background identify of a
  // replica on another drive must not redirect the Attach of a hand-opened one.
  const identify = (root: string): Promise<SharedLibraryCandidate | null> =>
    candidateAt(root, found)

  async function discover(dir: string): Promise<SharedLibraryCandidate[]> {
    const out: SharedLibraryCandidate[] = []
    for (const root of await discoverLibraries(dir)) {
      const c = await candidateAt(root, discovered)
      if (c) out.push(c)
    }
    return out
  }

  async function attach(
    libraryId: string,
    choice?: SharedLibraryAttachChoice,
    from: SharedLibraryAttachSource = 'opened'
  ): Promise<SharedLibraryAttachResult> {
    const root = (from === 'found' ? found : discovered).get(libraryId)
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
    const wasAvailable = isAvailable(libraryId)
    recs[libraryId] = rec
    save(recs)
    opened.set(libraryId, o)
    cached.delete(libraryId)
    unavailable.delete(libraryId)
    seenAt.set(libraryId, rec.lastSeenAt)
    disconnectLogged.delete(libraryId)
    attaches.set(libraryId, (attaches.get(libraryId) ?? 0) + 1)
    persistSnapshot(libraryId, o)
    if (!wasAvailable) {
      transitions.emit({
        libraryId,
        available: true,
        access: rec.access,
        ...(rec.accessReason ? { accessReason: rec.accessReason } : {}),
        becameWritable: false
      })
    }
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
    const o = view(libraryId)
    if (!rec || !o?.manifest) return null
    const rate = (await ratesFor(libraryId)).get(animeId)
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
      episodes,
      ...(rate ? { rate } : {})
    }
  }

  /**
   * A claim PC's rates (#582): it has no Shikimori session or rate cache, so
   * an attached title's rate is read from the library base S9 (#584) keeps,
   * plugged in or not. Empty for any other role, or with no base yet.
   */
  async function ratesFor(libraryId: string): Promise<Map<number, AttachedTitleRate>> {
    const out = new Map<number, AttachedTitleRate>()
    const rec = records()[libraryId]
    if (!deps.syncBases || !rec || roleOf(rec, userId()) !== 'claim') return out
    try {
      const base = await deps.syncBases.read(`library-${libraryId}`)
      for (const [key, title] of Object.entries(base?.doc?.titles ?? {})) {
        const id = Number(key)
        const r = title?.rate
        if (!Number.isSafeInteger(id) || id < 1 || !r) continue
        const score = r.score?.value
        const status = r.status?.value
        const episodes = r.episodes?.value
        if (typeof score !== 'number' || typeof status !== 'string') continue
        if (typeof episodes !== 'number') continue
        out.set(id, { score, status, episodes })
      }
    } catch (err) {
      log.warn(`[shared-library] could not read the base of ${libraryId}`, err)
    }
    return out
  }

  async function listWithRates(): Promise<AttachedLibraryInfo[]> {
    const libs = list()
    for (const lib of libs) {
      if (lib.role !== 'claim') continue
      const rates = await ratesFor(lib.libraryId)
      for (const t of lib.titles) {
        const rate = rates.get(t.animeId)
        if (rate) t.rate = rate
      }
    }
    return libs
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
      if (!rec || !o.manifest || unavailable.has(libraryId)) continue
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
    for (const [libraryId, o] of [...opened, ...cached]) {
      if (!o.posters.has(animeId)) continue
      // An unplugged library's poster comes from the snapshot cache (#582).
      if (!isAvailable(libraryId)) {
        const p = cache?.posterFile(libraryId, animeId)
        if (p) return p
        continue
      }
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

  function known(): KnownLibrary[] {
    return Object.entries(records()).map(([libraryId, rec]) => ({
      libraryId,
      root: rec.root,
      available: isAvailable(libraryId)
    }))
  }

  // Each library's poller re-read or Re-locate in flight, so Forget can wait for it.
  const reopening = new Map<string, Promise<boolean>>()

  async function reopenAtOnce(libraryId: string, root: string): Promise<boolean> {
    await ready.catch(() => {})
    await refreshing.get(libraryId)?.done
    const rec = records()[libraryId]
    if (!rec) return false
    const before = attaches.get(libraryId)
    const r = await reopen(libraryId, { ...rec, root })
    if (!r) return false
    // Fetched after the read: a Forget, a move or an attach meanwhile wins.
    const recs = records()
    const current = recs[libraryId]
    if (!current || current.root !== rec.root || attaches.get(libraryId) !== before) {
      return isAvailable(libraryId) && current?.root === root
    }
    current.root = root
    const t = commit(libraryId, current, r)
    save(recs)
    deps.onChanged?.()
    emitTransition(t)
    return true
  }

  function reopenAt(libraryId: string, root: string): Promise<boolean> {
    const run = (async () => {
      await reopening.get(libraryId)?.catch(() => false)
      try {
        return await reopenAtOnce(libraryId, root)
      } catch (err) {
        log.warn(`[shared-library] could not re-read ${root}`, err)
        return false
      }
    })()
    reopening.set(libraryId, run)
    void run.finally(() => {
      if (reopening.get(libraryId) === run) reopening.delete(libraryId)
    })
    return run
  }

  function markUnavailable(libraryId: string, root: string): void {
    const recs = records()
    const rec = recs[libraryId]
    if (!rec || rec.root !== root || !isAvailable(libraryId)) return
    unavailable.add(libraryId)
    rec.lastSeenAt = seenAt.get(libraryId) ?? rec.lastSeenAt
    save(recs)
    deps.onChanged?.()
    transitions.emit({
      libraryId,
      available: false,
      access: rec.access,
      ...(rec.accessReason ? { accessReason: rec.accessReason } : {}),
      becameWritable: false
    })
  }

  function markSeen(libraryId: string): void {
    if (isAvailable(libraryId)) seenAt.set(libraryId, now())
  }

  function dismissed(): string[] {
    const v = deps.store.get(DISMISSED_KEY)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  }

  function dismissPrompt(libraryIds: string[]): void {
    const next = new Set(dismissed())
    for (const id of libraryIds) if (typeof id === 'string' && id) next.add(id)
    deps.store.set(DISMISSED_KEY, [...next])
  }

  function saveLastSeen(): void {
    const recs = records()
    let changed = false
    for (const [libraryId, rec] of Object.entries(recs)) {
      const t = seenAt.get(libraryId)
      if (isAvailable(libraryId) && t !== undefined && t !== rec.lastSeenAt) {
        rec.lastSeenAt = t
        changed = true
      }
    }
    if (changed) save(recs)
  }

  function registerForgetHook(hook: ForgetHook): () => void {
    return forgetHooks.add((visit) => visit(hook))
  }

  function currentHooks(): ForgetHook[] {
    const out: ForgetHook[] = []
    forgetHooks.emit((hook) => out.push(hook))
    return out
  }

  async function forget(
    libraryId: string,
    opts: { confirmDropPending?: boolean } = {}
  ): Promise<SharedLibraryForgetResult> {
    // 1. No sync run, re-read or refresh of this library is in flight.
    await deps.syncIdle?.(libraryId).catch(() => {})
    await reopening.get(libraryId)?.catch(() => false)
    await refreshing.get(libraryId)?.done
    const hooks = currentHooks()
    // 2. What the hooks would discard, summed separately.
    const pendingCount = { libraryChanges: 0, resolutions: 0 }
    for (const hook of hooks) {
      if (!hook.pendingCount) continue
      try {
        const n = await hook.pendingCount(libraryId)
        pendingCount.libraryChanges += Math.max(0, Number(n?.libraryChanges) || 0)
        pendingCount.resolutions += Math.max(0, Number(n?.resolutions) || 0)
      } catch (err) {
        log.warn(`[shared-library] a forget hook could not count pending changes`, err)
      }
    }
    // 3. Ask first.
    if (
      (pendingCount.libraryChanges > 0 || pendingCount.resolutions > 0) &&
      !opts.confirmDropPending
    ) {
      return { needsConfirm: true, pendingCount }
    }
    // 4. The entry (and its claim) and "Don't ask for this drive".
    const recs = records()
    if (recs[libraryId]) {
      delete recs[libraryId]
      save(recs)
    }
    const kept = dismissed()
    if (kept.includes(libraryId)) {
      deps.store.set(
        DISMISSED_KEY,
        kept.filter((id) => id !== libraryId)
      )
    }
    opened.delete(libraryId)
    cached.delete(libraryId)
    discovered.delete(libraryId)
    found.delete(libraryId)
    unavailable.delete(libraryId)
    seenAt.delete(libraryId)
    disconnectLogged.delete(libraryId)
    deps.onChanged?.()
    // 5. Every hook's own per-library data; one that rejects doesn't stop the rest.
    const results = await Promise.allSettled(hooks.map(async (hook) => hook.onForgotten(libraryId)))
    for (const r of results) {
      if (r.status === 'rejected') {
        log.error(`[shared-library] a forget hook failed for ${libraryId}`, r.reason)
      }
    }
    return { needsConfirm: false }
  }

  async function relocate(libraryId: string, dir: string): Promise<SharedLibraryRelocateResult> {
    const rec = records()[libraryId]
    if (!rec) return { ok: false, error: 'This library is no longer open on this PC.' }
    let other = false
    for (const root of await discoverLibraries(dir)) {
      const read = await readLibrary(root)
      const id = read.status === 'none' ? null : read.manifest?.libraryId
      if (id !== libraryId) {
        other ||= !!id
        continue
      }
      if (await reopenAt(libraryId, root)) {
        const library = get(libraryId)
        if (library) return { ok: true, library }
      }
      return { ok: false, error: `${rec.name} could not be read in this folder.` }
    }
    return {
      ok: false,
      error: other
        ? `This folder holds a different Shared Library, not ${rec.name}.`
        : 'This folder has no Shared Library, and neither do the folders directly inside it.'
    }
  }

  function reportWriteFailure(libraryId: string, err: unknown): boolean {
    try {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (!code || !READ_ONLY_CODES.has(code)) return false
      const recs = records()
      const rec = recs[libraryId]
      // Already read-only: a `version` (or any other) reason is never replaced.
      if (!rec || rec.access === 'read-only') return false
      rec.access = 'read-only'
      rec.accessReason = 'write-failed'
      save(recs)
      log.warn(
        `[shared-library] ${rec.name}: a write failed (${code}); read-only until it is re-detected`
      )
      deps.onChanged?.()
      return true
    } catch (err2) {
      log.warn(`[shared-library] could not record a write failure for ${libraryId}`, err2)
      return false
    }
  }

  /** The attached library `p` is under, by this run's roots. */
  function libraryOf(p: string): string | null {
    const impl = deps.spawnPath ?? path
    for (const [libraryId, o] of opened) {
      if (isUnder(impl, o.root, p) || isUnder(impl, o.realRoot, p)) return libraryId
    }
    return null
  }

  function noteDisconnect(libraryId: string, p: string, err: unknown): void {
    if (disconnectLogged.has(libraryId)) return
    disconnectLogged.add(libraryId)
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'unknown'
    const name = records()[libraryId]?.name ?? libraryId
    log.warn(`[shared-library] drive-disconnected: ${name} (${libraryId}), ${code} on ${p}`)
  }

  async function classifyMissing(p: string): Promise<PlayerFailureReason | null> {
    try {
      const libraryId = libraryOf(p)
      if (!libraryId) return null
      try {
        await stat(p)
        return null
      } catch (err) {
        noteDisconnect(libraryId, p, err)
        return 'drive-disconnected'
      }
    } catch {
      return null
    }
  }

  function reportUnreadable(p: string, err: unknown): boolean {
    try {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (!code || !DISCONNECT_CODES.has(code)) return false
      const libraryId = libraryOf(p)
      if (!libraryId) return false
      noteDisconnect(libraryId, p, err)
      return true
    } catch {
      return false
    }
  }

  // Forget deletes the library's snapshot cache (#581's hook contract).
  if (cache) registerForgetHook({ onForgotten: (libraryId) => cache.remove(libraryId) })

  return {
    init,
    refresh,
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
    spawnPathFor: (abs) => spawnPathForRoots(abs, roots(), deps.spawnPath),
    known,
    reopenAt,
    markUnavailable,
    markSeen,
    identify,
    isDismissed: (libraryId) => dismissed().includes(libraryId),
    dismissPrompt,
    saveLastSeen,
    registerForgetHook,
    forget,
    relocate,
    reportWriteFailure,
    onAvailabilityChanged: (listener) => transitions.add(listener),
    classifyMissing,
    reportUnreadable,
    listWithRates
  }
}
