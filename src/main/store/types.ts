/**
 * Injected persistence boundary for the main process.
 *
 * `StorageService` is the contract every service depends on instead of the
 * `electron-store` singleton (refactor epic #84, Phase 2 slice 2c). It is the
 * re-homed counterpart of the Phase 0 in-memory fake — see
 * `test/helpers/in-memory-storage.ts`, which implements this interface.
 *
 * The schema-typed overloads preserve `electron-store`'s precise return types
 * for literal keys (so existing call sites keep their typing with no churn),
 * while the `string`-key overloads cover the dynamic `get-setting` /
 * `set-setting` IPC paths.
 */
export interface StorageService<S extends Record<string, unknown> = Record<string, unknown>> {
  get<K extends keyof S & string>(key: K): S[K]
  get<T = unknown>(key: string): T
  set<K extends keyof S & string>(key: K, value: S[K]): void
  set(key: string, value: unknown): void
  has(key: string): boolean
  delete(key: string): void
}
