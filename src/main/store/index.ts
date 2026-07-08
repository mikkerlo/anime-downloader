import Store from 'electron-store'
import type { StorageService } from './types'
import { migrateWatchProgressV2 } from './migrate'
import { timeSlowSync, SLOW_STORE_OP_MS } from '../lib/perf'

export type { StorageService } from './types'
export { PERSISTED_STORE_KEYS, type PersistedStoreKey } from './keys'

/**
 * Coalescing window for disk persistence: the first buffered write arms a
 * timer, later writes ride along, and the timer fires one full-file write.
 * This is also the crash-durability window — a hard crash loses at most this
 * many milliseconds of non-write-through writes (see `docs/storage.md`).
 */
export const PERSIST_DEBOUNCE_MS = 500

/**
 * `StorageService` plus the persisted-schema migrations that must run before
 * the rest of the app reads the store. Kept on the service (not free
 * functions) so call sites depend only on the injected instance.
 */
export interface MainStorageService<S extends Record<string, unknown>> extends StorageService<S> {
  migrateWatchProgressV2(): void
  /** Persists any writes still waiting on the coalescing timer. Wire into `before-quit`. */
  flush(): void
}

/**
 * Bind the single `electron-store`-backed implementation. The instance is
 * injected everywhere else (epic decision 7) so no other module imports the
 * `electron-store` singleton.
 *
 * Reads are served from an in-memory snapshot taken once at startup:
 * `electron-store` (via `conf`) re-reads and re-parses the entire config file
 * on EVERY `get` and rewrites it on every `set`, which at a multi-megabyte
 * store means tens of milliseconds of synchronous main-process stall per
 * operation — the root cause of the slow anime-detail page. The main process
 * is the store's only writer, so the snapshot is authoritative:
 * - `get` returns a `structuredClone` of the snapshot value, preserving the
 *   old semantics that every read is an isolated copy (callers may mutate
 *   what they got without corrupting later reads). Dot-notation paths walk
 *   the snapshot and clone only the addressed leaf, so hot readers of a
 *   single sub-entry (e.g. `animeCache.<id>`) don't pay for the whole map.
 * - `set`/`delete` update the snapshot immediately (reads stay consistent)
 *   and schedule one coalesced disk write `PERSIST_DEBOUNCE_MS` later, so a
 *   write burst costs a single full-file stringify+write instead of one per
 *   `set`. Dot-notation writes apply to the snapshot directly — delegating
 *   them to `electron-store` would re-read the (stale, mid-window) file and
 *   clobber pending writes on re-sync.
 * - Keys in `writeThroughKeys` skip the window and persist synchronously:
 *   losing their last write to a crash is worse than the ~30ms stall (e.g.
 *   `shikimoriUpdateQueue` — a queued offline edit must survive).
 */
export function createStorageService<S extends Record<string, unknown>>(
  defaults: S,
  options?: {
    /** Test-only injection: config-dir override so unit tests never touch the real store file. */
    cwd?: string
    /** Top-level keys persisted synchronously on every write instead of debounced. */
    writeThroughKeys?: readonly (keyof S & string)[]
  }
): MainStorageService<S> {
  const store = new Store<S>({ defaults, cwd: options?.cwd })
  const writeThrough = new Set<string>(options?.writeThroughKeys ?? [])
  // One full read+parse. The constructor already merged `defaults` into the
  // file, so the snapshot is complete.
  const snapshot: Record<string, unknown> = { ...(store.store as Record<string, unknown>) }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  function persistNow(): void {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    timeSlowSync('store.persist', SLOW_STORE_OP_MS, () => {
      ;(store as { store: unknown }).store = snapshot
    })
    // Cleared only after the write lands: a failed write (ENOSPC, EPERM/AV
    // lock) stays dirty so the next write or `flush()` retries it.
    dirty = false
  }

  function schedulePersist(key: string): void {
    if (writeThrough.has(key.split('.', 1)[0])) {
      persistNow()
      return
    }
    dirty = true
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        try {
          persistNow()
        } catch (err) {
          // Unlike the synchronous persist (which threw inside the `set()`
          // caller), a timer callback has no caller to reject — an uncaught
          // throw here would take down the main process.
          console.error('[store] debounced persist failed:', err)
        }
      }, PERSIST_DEBOUNCE_MS)
      persistTimer.unref?.()
    }
  }

  function readPath(key: string): unknown {
    let node: unknown = snapshot
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object') return undefined
      node = (node as Record<string, unknown>)[part]
    }
    return node
  }

  // dot-prop `setProperty` semantics (what electron-store used to do for us):
  // missing or non-object intermediate nodes are replaced with fresh objects.
  function writePath(key: string, value: unknown): void {
    const parts = key.split('.')
    let node = snapshot
    for (const part of parts.slice(0, -1)) {
      const next = node[part]
      if (next === null || typeof next !== 'object') {
        node[part] = {}
      }
      node = node[part] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
  }

  function deletePath(key: string): void {
    const parts = key.split('.')
    let node: unknown = snapshot
    for (const part of parts.slice(0, -1)) {
      if (node === null || typeof node !== 'object') return
      node = (node as Record<string, unknown>)[part]
    }
    if (node !== null && typeof node === 'object') {
      delete (node as Record<string, unknown>)[parts[parts.length - 1]]
    }
  }

  const svc: MainStorageService<S> = {
    get: ((key: string) =>
      timeSlowSync(`store.get(${key})`, SLOW_STORE_OP_MS, () =>
        structuredClone(key.includes('.') ? readPath(key) : snapshot[key])
      )) as MainStorageService<S>['get'],
    set: ((key: string, value: unknown) => {
      if (value === undefined) {
        // Match electron-store: JSON drops undefined on persist, so accepting
        // it would create in-session state that vanishes across restarts.
        throw new TypeError('Use `delete()` to clear values')
      }
      if (key.includes('.')) {
        writePath(key, structuredClone(value))
      } else {
        snapshot[key] = structuredClone(value)
      }
      schedulePersist(key)
    }) as MainStorageService<S>['set'],
    has: (key: string) => (key.includes('.') ? readPath(key) !== undefined : key in snapshot),
    delete: (key: string) => {
      if (key.includes('.')) {
        deletePath(key)
      } else {
        delete snapshot[key]
      }
      schedulePersist(key)
    },
    flush: () => {
      if (dirty) persistNow()
    },
    migrateWatchProgressV2: () => migrateWatchProgressV2(svc)
  }
  return svc
}
