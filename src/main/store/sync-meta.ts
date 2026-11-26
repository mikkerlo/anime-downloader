import { randomUUID } from 'node:crypto'
import type { StorageService } from './types'
import { pruneExpiredTombstones } from '../lib/sync-state/gc'
import { advanceClock } from '../lib/sync-state/clock'

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

/** Stamps the `priorityOrder` clock. */
export function stampPriorityOrder(meta: SyncMeta, clock: SyncClock): void {
  meta.priorityOrder = advanceClock(clock, meta.priorityOrder)
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
  const { at, origin } = advanceClock(clock, title[field])
  title[field] = present ? { at, origin } : { deleted: true, at, origin }
}

/**
 * The `syncMeta.rates` key for one tracker account's rate of one title.
 * Shikimori keeps its 6.x key, `"<userId>:<malId>"`; AniList and MAL use
 * `"<provider>:<userId>:<malId>"`. The two can't collide, because a Shikimori
 * key always starts with a digit (#690).
 */
export function rateClockKey(
  trackerId: TrackerId,
  userId: number | string,
  malId: number | string
): string {
  return trackerId === 'shikimori' ? `${userId}:${malId}` : `${trackerId}:${userId}:${malId}`
}

/**
 * Stamps a rate clock for each field whose `after` differs from `before`,
 * under `rateKey` (`rateClockKey`). The caller builds the key from the user it
 * captured with its request, never the store's user at stamp time: an account
 * switch during the request's awaits must not move the clock to the new
 * account. With nothing changed it writes nothing.
 */
export function stampRateClocks(
  store: StorageService,
  rateKey: string,
  before: RateFieldValues,
  after: RateFieldValues,
  now = Date.now()
): void {
  const changed = RATE_FIELDS.filter((field) => before[field] !== after[field])
  if (changed.length === 0) return
  const clock = localClock(store, now)
  updateSyncMeta(
    store,
    (meta) => {
      const clocks = (meta.rates[rateKey] ??= {})
      for (const field of changed) {
        const { at, origin } = advanceClock(clock, clocks[field])
        clocks[field] = { value: after[field], at, origin }
      }
    },
    now
  )
}
