import Store from 'electron-store'
import type { StorageService } from './types'
import { migrateWatchProgressV2 } from './migrate'
import { markSlow, SLOW_STORE_OP_MS } from '../lib/perf'

export type { StorageService } from './types'
export { PERSISTED_STORE_KEYS, type PersistedStoreKey } from './keys'

/**
 * `StorageService` plus the persisted-schema migrations that must run before
 * the rest of the app reads the store. Kept on the service (not free
 * functions) so call sites depend only on the injected instance.
 */
export interface MainStorageService<S extends Record<string, unknown>> extends StorageService<S> {
  migrateWatchProgressV2(): void
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
 *   what they got without corrupting later reads).
 * - `set`/`delete` update the snapshot, then persist through the `store.store`
 *   setter, which writes the file once without conf's redundant pre-read.
 * - Dot-notation paths (never used by our flat schema, but reachable through
 *   the dynamic settings IPC) bypass the snapshot and re-sync it afterwards.
 */
export function createStorageService<S extends Record<string, unknown>>(
  defaults: S,
  /** Test-only injection: config-dir override so unit tests never touch the real store file. */
  options?: { cwd?: string }
): MainStorageService<S> {
  const store = new Store<S>({ defaults, cwd: options?.cwd })
  // One full read+parse. The constructor already merged `defaults` into the
  // file, so the snapshot is complete.
  const snapshot: Record<string, unknown> = { ...(store.store as Record<string, unknown>) }

  function persist(): void {
    const t0 = performance.now()
    ;(store as { store: unknown }).store = snapshot
    markSlow('store.persist', t0, SLOW_STORE_OP_MS)
  }

  function resyncSnapshot(): void {
    const fresh = store.store as Record<string, unknown>
    for (const key of Object.keys(snapshot)) delete snapshot[key]
    Object.assign(snapshot, fresh)
  }

  const svc: MainStorageService<S> = {
    get: ((key: string) => {
      if (key.includes('.')) return store.get(key as keyof S)
      const t0 = performance.now()
      const value = structuredClone(snapshot[key])
      markSlow(`store.get(${key})`, t0, SLOW_STORE_OP_MS)
      return value
    }) as MainStorageService<S>['get'],
    set: ((key: string, value: unknown) => {
      if (key.includes('.')) {
        store.set(key as keyof S, value as S[keyof S])
        resyncSnapshot()
        return
      }
      snapshot[key] = structuredClone(value)
      persist()
    }) as MainStorageService<S>['set'],
    has: (key: string) => (key.includes('.') ? store.has(key as keyof S) : key in snapshot),
    delete: (key: string) => {
      if (key.includes('.')) {
        store.delete(key as keyof S)
        resyncSnapshot()
        return
      }
      delete snapshot[key]
      persist()
    },
    migrateWatchProgressV2: () => migrateWatchProgressV2(svc)
  }
  return svc
}
