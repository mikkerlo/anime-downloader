import { describe, it, expect } from 'vitest'
import { migrateWatchProgressV2 } from '../../src/main/store/migrate'
import { InMemoryStorage } from '../helpers/in-memory-storage'

function entry(updatedAt: number, watched: boolean, watchedAt?: number) {
  return { position: 0, duration: 100, updatedAt, watched, ...(watchedAt ? { watchedAt } : {}) }
}

describe('migrateWatchProgressV2', () => {
  it('backfills watchedAt from updatedAt for watched entries lacking it', () => {
    const store = new InMemoryStorage({
      watchProgressMigrationV2: false,
      watchProgress: {
        '1:1': entry(1000, true),
        '1:2': entry(2000, true, 1500),
        '1:3': entry(3000, false)
      }
    })
    migrateWatchProgressV2(store)
    const after = store.get<Record<string, { watchedAt?: number }>>('watchProgress')!
    expect(after['1:1'].watchedAt).toBe(1000)
    expect(after['1:2'].watchedAt).toBe(1500) // unchanged
    expect(after['1:3'].watchedAt).toBeUndefined() // not watched, untouched
    expect(store.get('watchProgressMigrationV2')).toBe(true)
  })

  it('is a no-op when the migration flag is already set', () => {
    const seed = { '1:1': entry(1000, true) } // missing watchedAt; would have been backfilled
    const store = new InMemoryStorage({
      watchProgressMigrationV2: true,
      watchProgress: seed
    })
    migrateWatchProgressV2(store)
    const after = store.get<Record<string, { watchedAt?: number }>>('watchProgress')!
    expect(after['1:1'].watchedAt).toBeUndefined()
  })

  it('still sets the flag even when nothing needed backfill', () => {
    const store = new InMemoryStorage({
      watchProgressMigrationV2: false,
      watchProgress: { '1:1': entry(1000, false) }
    })
    migrateWatchProgressV2(store)
    expect(store.get('watchProgressMigrationV2')).toBe(true)
  })
})
