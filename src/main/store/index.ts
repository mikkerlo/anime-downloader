import Store from 'electron-store'
import type { StorageService } from './types'
import { migrateWatchProgressV2 } from './migrate'

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
 */
export function createStorageService<S extends Record<string, unknown>>(
  defaults: S
): MainStorageService<S> {
  const store = new Store<S>({ defaults })
  const svc: MainStorageService<S> = {
    get: ((key: string) => store.get(key as keyof S)) as MainStorageService<S>['get'],
    set: ((key: string, value: unknown) =>
      store.set(key as keyof S, value as S[keyof S])) as MainStorageService<S>['set'],
    has: (key: string) => store.has(key as keyof S),
    delete: (key: string) => store.delete(key as keyof S),
    migrateWatchProgressV2: () => migrateWatchProgressV2(svc)
  }
  return svc
}
