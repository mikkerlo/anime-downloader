/**
 * In-memory StorageService fake for unit tests.
 *
 * Phase 0 ships this ahead of the real `StorageService` interface (introduced
 * in Phase 2 of the structure refactor, #84) so services extracted later are
 * mockable from day one. It mirrors the subset of the `electron-store` surface
 * the codebase relies on: typed `get`/`set`/`delete`/`has`/`clear`.
 *
 * Phase 2 should re-home the `StorageService` interface into
 * `src/shared` / `src/main/store` and make this fake implement it.
 */
export interface StorageService {
  get<T = unknown>(key: string, defaultValue?: T): T | undefined
  set(key: string, value: unknown): void
  has(key: string): boolean
  delete(key: string): void
  clear(): void
}

export class InMemoryStorage implements StorageService {
  private readonly map = new Map<string, unknown>()

  constructor(initial: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v)
  }

  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue
  }

  set(key: string, value: unknown): void {
    this.map.set(key, value)
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  /** Snapshot of all stored entries — handy for assertions. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.map.entries())
  }
}
