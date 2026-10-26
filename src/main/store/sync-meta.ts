import { randomUUID } from 'node:crypto'
import type { StorageService } from './types'
import { pruneExpiredTombstones } from '../lib/sync-state/gc'

const RATE_FIELDS: readonly SyncRateField[] = ['episodes', 'status', 'score', 'rewatches']

type RateFieldValues = Record<SyncRateField, number | string>

/**
 * This install's id, generated and persisted the first time it is asked for.
 * Boot asks once, so the first boot after an upgrade writes it and later boots
 * write nothing.
 */
export function ensureInstallId(
  store: StorageService,
  generate: () => string = randomUUID
): string {
  const existing = store.get<string | undefined>('installId')
  if (existing) return existing
  const id = generate()
  store.set('installId', id)
  return id
}

/** A clock for a change made on this install now. */
export function localClock(store: StorageService, now = Date.now()): SyncClock {
  return { at: now, origin: ensureInstallId(store) }
}

export function readSyncMeta(store: StorageService): SyncMeta {
  const raw = store.get<Partial<SyncMeta> | undefined>('syncMeta')
  return { ...raw, titles: raw?.titles ?? {}, rates: raw?.rates ?? {} }
}

/**
 * The one writer of `syncMeta`. Tombstones older than a year are dropped here,
 * on the next write, and never at boot.
 */
export function updateSyncMeta(
  store: StorageService,
  mutate: (meta: SyncMeta) => void,
  now = Date.now()
): void {
  const meta = readSyncMeta(store)
  mutate(meta)
  store.set('syncMeta', pruneExpiredTombstones(meta, now))
}

/** Stamps a `starred` / `priority` clock, or its tombstone when `present` is false. */
export function stampMembership(
  meta: SyncMeta,
  animeId: number | string,
  field: 'starred' | 'priority',
  present: boolean,
  clock: SyncClock
): void {
  const title = (meta.titles[String(animeId)] ??= {})
  title[field] = present ? { ...clock } : { deleted: true, ...clock }
}

/**
 * Stamps a rate clock for each field whose `after` differs from `before`, keyed
 * `"<ownerId>:<malId>"`. `ownerId` defaults to the signed-in Shikimori user; a
 * caller that captured its owner earlier passes it. With no owner, or nothing
 * changed, it writes nothing.
 */
export function stampRateClocks(
  store: StorageService,
  malId: number,
  before: RateFieldValues,
  after: RateFieldValues,
  ownerId?: number,
  now = Date.now()
): void {
  const owner = ownerId ?? store.get<{ id: number } | null | undefined>('shikimoriUser')?.id
  if (owner === undefined) return
  const changed = RATE_FIELDS.filter((field) => before[field] !== after[field])
  if (changed.length === 0) return
  const { at, origin } = localClock(store, now)
  updateSyncMeta(
    store,
    (meta) => {
      const clocks = (meta.rates[`${owner}:${malId}`] ??= {})
      for (const field of changed) clocks[field] = { value: after[field], at, origin }
    },
    now
  )
}
