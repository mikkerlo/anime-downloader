import type { StorageService } from './types'

/**
 * One-shot backfill of `watchProgress[*].watchedAt` for entries that were
 * marked watched before `watchedAt` existed. Idempotent: guarded by the
 * `watchProgressMigrationV2` flag. Pure with respect to the injected store —
 * unit-tested against the in-memory fake.
 */
export function migrateWatchProgressV2<S extends Record<string, unknown>>(
  store: StorageService<S>
): void {
  if (store.get('watchProgressMigrationV2') as boolean) return
  const all = store.get('watchProgress') as Record<
    string,
    { updatedAt: number; watched?: boolean; watchedAt?: number; position: number; duration: number }
  >
  let changed = false
  for (const entry of Object.values(all)) {
    if (entry.watched && !entry.watchedAt) {
      entry.watchedAt = entry.updatedAt
      changed = true
    }
  }
  if (changed) store.set('watchProgress', all)
  store.set('watchProgressMigrationV2', true)
}
