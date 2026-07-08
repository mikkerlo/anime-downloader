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
    // Dot-notation sub-key reads, mirroring the real StorageService (which
    // walks its snapshot): `get('animeCache.42')` returns the nested value.
    if (key.includes('.')) {
      const [root, ...rest] = key.split('.')
      let node: unknown = this.map.get(root)
      for (const part of rest) {
        if (node === null || typeof node !== 'object') return defaultValue
        node = (node as Record<string, unknown>)[part]
      }
      return node === undefined ? defaultValue : (node as T)
    }
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue
  }

  set(key: string, value: unknown): void {
    // Dot-notation sub-key writes, mirroring the real StorageService (which
    // applies them to its snapshot): missing/non-object intermediates are
    // replaced with fresh objects, dot-prop style.
    if (key.includes('.')) {
      const [root, ...rest] = key.split('.')
      let node = this.map.get(root) as Record<string, unknown>
      if (node === null || typeof node !== 'object') {
        node = {}
        this.map.set(root, node)
      }
      for (const part of rest.slice(0, -1)) {
        const next = node[part]
        if (next === null || typeof next !== 'object') {
          node[part] = {}
        }
        node = node[part] as Record<string, unknown>
      }
      node[rest[rest.length - 1]] = value
      return
    }
    this.map.set(key, value)
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  delete(key: string): void {
    if (key.includes('.')) {
      const [root, ...rest] = key.split('.')
      let node: unknown = this.map.get(root)
      for (const part of rest.slice(0, -1)) {
        if (node === null || typeof node !== 'object') return
        node = (node as Record<string, unknown>)[part]
      }
      if (node !== null && typeof node === 'object') {
        delete (node as Record<string, unknown>)[rest[rest.length - 1]]
      }
      return
    }
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
