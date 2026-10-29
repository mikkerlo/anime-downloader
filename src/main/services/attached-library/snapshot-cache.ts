// The snapshot cache of attached Shared Libraries (#582): each library's
// manifest, metadata and posters under `userData/shared-library-cache/<id>/`,
// so an unplugged library still lists its titles after a restart. It holds no
// rate values: a claim PC reads those from the library base (S9 #584).
//
// - `snapshot.json`: the manifest and the `meta/*.json` of every title (each
//   capped at 1 MB by S5's reader), always kept.
// - `posters/<animeId>.jpg`: a poster over 2 MB isn't cached. All libraries'
//   posters together are capped at 100 MB; above that, the posters of the
//   unavailable library seen longest ago are evicted, a whole library at a
//   time, never those of an available one.
// - `index.json`: the generation the snapshot was taken at and the posters'
//   total, so the cap needs no directory walk. `evicted` marks posters that
//   are missing (evicted, or a save the drive left incomplete), so the next
//   fresh read saves that generation again.
//
// A save stages the new posters in `posters.next/`. A poster the read listed
// that can't be read now means the drive went away mid-save: the last
// complete cache is kept as it was.
//
// Every operation runs on one queue, so a Forget's delete never interleaves
// with a write, and none of them throws: a failure is logged.

import { promises as fsp } from 'fs'
import * as path from 'path'
import { ATTACHED_POSTER_MAX_BYTES } from '../../streaming/anime-poster-protocol'
import { DISCONNECT_CODES } from './writable'

export const SNAPSHOT_DIR = 'shared-library-cache'
export const SNAPSHOT_POSTER_MAX_BYTES = ATTACHED_POSTER_MAX_BYTES
export const SNAPSHOT_POSTERS_TOTAL_MAX_BYTES = 100 * 1024 * 1024

const SNAPSHOT_FILE = 'snapshot.json'
const INDEX_FILE = 'index.json'
const POSTERS_DIR = 'posters'
const POSTERS_STAGING = 'posters.next'
// `libraryId` comes from the drive: S5's reader checks it is a UUID, and it is
// checked again here, where it becomes a folder name.
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

export interface LibrarySnapshot {
  manifest: SharedLibraryManifest
  metas: Map<number, SharedLibraryMeta>
  posters: Set<number>
}

export interface SnapshotInput {
  manifest: SharedLibraryManifest
  metas: Map<number, SharedLibraryMeta>
  /** The poster ids to copy. */
  posters: Iterable<number>
  /**
   * The checked drive path of one poster; `'skip'` when it is bad for good
   * (it leads outside the root), null when it is gone (the drive went away).
   */
  posterSource: (animeId: number) => Promise<string | 'skip' | null>
}

export interface SnapshotCacheEntry {
  libraryId: string
  available: boolean
  lastSeenAt: number
}

export interface SnapshotCache {
  /**
   * Writes `libraryId`'s snapshot unless the cached one has the same
   * `generation` and its posters weren't evicted. `wanted` is asked when the
   * write starts, so a library forgotten meanwhile isn't written back.
   */
  save(libraryId: string, input: SnapshotInput, wanted: () => boolean): Promise<void>
  load(libraryId: string): Promise<LibrarySnapshot | null>
  /** The cached poster file, or null when it isn't cached (or was evicted). */
  posterFile(libraryId: string, animeId: number): string | null
  /** Evicts posters until the total is under the cap. */
  enforceCap(libraries: SnapshotCacheEntry[]): Promise<void>
  /** Deletes the library's cache dir (Forget). */
  remove(libraryId: string): Promise<void>
  /** Resolves once every queued operation has settled. */
  idle(): Promise<void>
}

export interface SnapshotCacheDeps {
  /** `userData/shared-library-cache`. */
  dir: string
  posterMaxBytes?: number
  totalMaxBytes?: number
  log?: Pick<Console, 'warn'>
}

interface SnapshotIndex {
  version: 1
  generation: number
  posters: number[]
  posterBytes: number
  evicted?: true
}

function isIndex(v: unknown): v is SnapshotIndex {
  const i = v as SnapshotIndex | null
  return (
    !!i &&
    i.version === 1 &&
    Number.isSafeInteger(i.generation) &&
    Array.isArray(i.posters) &&
    i.posters.every((p) => Number.isSafeInteger(p) && p > 0) &&
    typeof i.posterBytes === 'number' &&
    i.posterBytes >= 0
  )
}

/** Reads at most `max` bytes through one handle; null when the file is larger. */
async function readCapped(file: string, max: number): Promise<Buffer | null> {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    if (size > max) return null
    const buf = Buffer.alloc(size + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return total > max ? null : buf.subarray(0, total)
  } finally {
    await fh.close()
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

export function createSnapshotCache(deps: SnapshotCacheDeps): SnapshotCache {
  const posterMax = deps.posterMaxBytes ?? SNAPSHOT_POSTER_MAX_BYTES
  const totalMax = deps.totalMaxBytes ?? SNAPSHOT_POSTERS_TOTAL_MAX_BYTES
  const log = deps.log ?? console
  const indexes = new Map<string, SnapshotIndex>()
  let queue: Promise<void> = Promise.resolve()

  function run(what: string, op: () => Promise<void>): Promise<void> {
    const next = queue.then(op).catch((err) => {
      log.warn(`[shared-library] snapshot cache: ${what} failed`, err)
    })
    queue = next
    return next
  }

  const dirOf = (libraryId: string): string | null =>
    SAFE_ID.test(libraryId) ? path.join(deps.dir, libraryId) : null

  async function readIndex(libraryId: string): Promise<SnapshotIndex | null> {
    const known = indexes.get(libraryId)
    if (known) return known
    const dir = dirOf(libraryId)
    if (!dir) return null
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(path.join(dir, INDEX_FILE), 'utf8'))
      if (!isIndex(parsed)) return null
      indexes.set(libraryId, parsed)
      return parsed
    } catch {
      return null
    }
  }

  async function writeIndex(libraryId: string, dir: string, index: SnapshotIndex): Promise<void> {
    await writeAtomic(path.join(dir, INDEX_FILE), JSON.stringify(index))
    indexes.set(libraryId, index)
  }

  function save(libraryId: string, input: SnapshotInput, wanted: () => boolean): Promise<void> {
    return run(`saving ${libraryId}`, async () => {
      const dir = dirOf(libraryId)
      if (!dir || !wanted()) return
      const generation = input.manifest.generation
      const prev = await readIndex(libraryId)
      if (prev && prev.generation === generation && !prev.evicted) return
      await fsp.mkdir(dir, { recursive: true })
      // The new posters are staged; the old set keeps being served until the
      // new one is complete.
      const staging = path.join(dir, POSTERS_STAGING)
      await fsp.rm(staging, { recursive: true, force: true })
      await fsp.mkdir(staging, { recursive: true })
      const posters: number[] = []
      let posterBytes = 0
      // A poster the read listed that is gone now, or whose read fails the way
      // a removed device fails: the drive went away mid-save. A poster that is
      // bad for good (it leads outside the root, `EACCES`, a directory, over
      // the cap) is just not cached, and the save still completes.
      let incomplete = false
      for (const animeId of input.posters) {
        if (!Number.isSafeInteger(animeId) || animeId < 1) continue
        let data: Buffer | null
        try {
          const src = await input.posterSource(animeId)
          if (src === 'skip') continue
          if (!src) {
            incomplete = true
            continue
          }
          // The drive is untrusted: the cap is checked on the bytes read.
          data = await readCapped(src, posterMax)
        } catch (err) {
          if (DISCONNECT_CODES.has((err as NodeJS.ErrnoException | null)?.code ?? '')) {
            incomplete = true
          }
          continue
        }
        if (!data) continue
        await fsp.writeFile(path.join(staging, `${animeId}.jpg`), data)
        posters.push(animeId)
        posterBytes += data.length
      }
      if (incomplete && prev && !prev.evicted) {
        // Keep the complete cache; the next fresh read saves this generation.
        await fsp.rm(staging, { recursive: true, force: true })
        log.warn(
          `[shared-library] snapshot cache: ${libraryId} changed while saving; kept the last one`
        )
        return
      }
      const metas: Record<string, SharedLibraryMeta> = {}
      for (const [id, meta] of input.metas) metas[String(id)] = meta
      await writeAtomic(
        path.join(dir, SNAPSHOT_FILE),
        JSON.stringify({ version: 1, manifest: input.manifest, metas })
      )
      // No `posterFile` path points into the folder while it is swapped.
      indexes.delete(libraryId)
      const postersDir = path.join(dir, POSTERS_DIR)
      await fsp.rm(postersDir, { recursive: true, force: true })
      await fsp.rename(staging, postersDir)
      // With nothing complete to keep, the partial set is kept but marked, so
      // the next fresh read saves this generation again.
      await writeIndex(libraryId, dir, {
        version: 1,
        generation,
        posters,
        posterBytes,
        ...(incomplete ? { evicted: true as const } : {})
      })
    })
  }

  async function load(libraryId: string): Promise<LibrarySnapshot | null> {
    const dir = dirOf(libraryId)
    if (!dir) return null
    try {
      await queue
      const index = await readIndex(libraryId)
      if (!index) return null
      const raw = JSON.parse(await fsp.readFile(path.join(dir, SNAPSHOT_FILE), 'utf8')) as {
        version?: unknown
        manifest?: SharedLibraryManifest
        metas?: Record<string, SharedLibraryMeta>
      }
      const m = raw?.manifest
      if (
        raw?.version !== 1 ||
        !m ||
        m.libraryId !== libraryId ||
        !Array.isArray(m.titles) ||
        !Array.isArray(m.items)
      ) {
        return null
      }
      const metas = new Map<number, SharedLibraryMeta>()
      for (const [key, meta] of Object.entries(raw.metas ?? {})) {
        const id = Number(key)
        if (Number.isSafeInteger(id) && id > 0 && meta && typeof meta === 'object') {
          metas.set(id, meta)
        }
      }
      return { manifest: m, metas, posters: new Set(index.posters) }
    } catch (err) {
      log.warn(`[shared-library] snapshot cache: could not load ${libraryId}`, err)
      return null
    }
  }

  function posterFile(libraryId: string, animeId: number): string | null {
    const dir = dirOf(libraryId)
    const index = indexes.get(libraryId)
    if (!dir || !index || !index.posters.includes(animeId)) return null
    return path.join(dir, POSTERS_DIR, `${animeId}.jpg`)
  }

  function enforceCap(libraries: SnapshotCacheEntry[]): Promise<void> {
    return run('enforcing the poster cap', async () => {
      const entries: { lib: SnapshotCacheEntry; index: SnapshotIndex }[] = []
      for (const lib of libraries) {
        const index = await readIndex(lib.libraryId)
        if (index) entries.push({ lib, index })
      }
      let total = entries.reduce((n, e) => n + e.index.posterBytes, 0)
      const evictable = entries
        .filter((e) => !e.lib.available && e.index.posterBytes > 0)
        .sort((a, b) => a.lib.lastSeenAt - b.lib.lastSeenAt)
      for (const { lib, index } of evictable) {
        if (total <= totalMax) break
        const dir = dirOf(lib.libraryId)!
        await fsp.rm(path.join(dir, POSTERS_DIR), { recursive: true, force: true })
        total -= index.posterBytes
        await writeIndex(lib.libraryId, dir, {
          ...index,
          posters: [],
          posterBytes: 0,
          evicted: true
        })
      }
    })
  }

  function remove(libraryId: string): Promise<void> {
    return run(`removing ${libraryId}`, async () => {
      indexes.delete(libraryId)
      const dir = dirOf(libraryId)
      if (dir) await fsp.rm(dir, { recursive: true, force: true })
    })
  }

  async function idle(): Promise<void> {
    let seen: Promise<void>
    do {
      seen = queue
      await seen
    } while (seen !== queue)
  }

  return { save, load, posterFile, enforceCap, remove, idle }
}
