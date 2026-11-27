// AniList's primary branch of #692's fan-out writer (#703). Shikimori's
// (`shikimori-primary.ts`) sends live and queues on a queueable error; this one
// is queue-first: every user change to an AniList primary is queued through the
// AniList instance's `enqueue` (the append, the cache patch, the broadcasts in
// one step) and the drain sends it. AniList allows 30 requests a minute, and a
// live send would spend two of them on every edit (the `MediaList` read and
// the write); the drain sends through the host limiter, only the fields that
// changed, and its drift check keeps a progress the server has moved past, so
// a mark-watched never lowers it.
//
// The entry is field-scoped (`fields`, no `via`): what differs from AniList's
// own projection (its cached row with its queue laid over it). With no row the
// branch reads the live entry once (a cold cache), and with none there either
// it takes the create rule, all four fields. The returned `basis` and `after`
// feed the mirrors exactly as Shikimori's do.

import {
  RATE_FIELDS,
  intendedFields,
  parkEntries,
  type ParkedQueues,
  type QueuedTrackerUpdate
} from '../../lib/shikimori-queue'
import { AniListUnmappedError } from '../../trackers/anilist/errors'
import {
  NO_RATE_BEFORE,
  nextWatchedRate,
  rateValues,
  type RateValues
} from '../../lib/shikimori-rate'
import { rateClockKey, stampRateClocks } from '../../store/sync-meta'
import type { StorageService } from '../../store/types'
import type { PrimaryWrite, RateChange } from './fan-out'
import type { TrackerSyncService } from './sync'

export interface AniListPrimaryDeps {
  store: StorageService
  sync: Pick<
    TrackerSyncService<unknown, unknown>,
    | 'keys'
    | 'rateCache'
    | 'cachedRate'
    | 'hasTitle'
    | 'enqueue'
    | 'startSyncTimer'
    | 'syncQueue'
    | 'fetchEntry'
    | 'isQueueableError'
    | 'broadcastQueueChanged'
  >
  maybeBroadcastCleanupPrompt: (
    smotretAnime: unknown,
    malId: number,
    status: RateValues['status'],
    prevStatus?: RateValues['status']
  ) => Promise<void>
  now?: () => number
}

export interface AniListPrimary {
  /** The primary branch for `applyChange`: a queued write, or null (nothing to do). */
  write(malId: number, change: RateChange): Promise<PrimaryWrite<RateValues> | null>
}

type Values = Record<SyncRateField, number | string>

export function createAniListPrimary(deps: AniListPrimaryDeps): AniListPrimary {
  const { store, sync } = deps
  const now = deps.now ?? Date.now

  const liveQueue = (): QueuedTrackerUpdate[] =>
    (store.get(sync.keys.updateQueue) as QueuedTrackerUpdate[] | undefined) ?? []

  // The fan-out's projection (§ 3): the cached row with each live queued entry
  // laid over it in queue order, `intendedFields` only.
  function projection(malId: number): { rateId: number | null; values: RateValues } | null {
    const cached = sync.cachedRate(malId)
    const queued = liveQueue().filter((q) => q.malId === malId)
    if (!cached && queued.length === 0) return null
    const values = { ...(cached ? cached.values : rateValues(queued[0].before)) } as Values
    for (const q of queued) {
      for (const f of intendedFields(q)) {
        values[f] = f === 'rewatches' ? (q.after[f] ?? 0) : q.after[f]
      }
    }
    const rateId = cached?.remoteId ?? queued.find((q) => q.rateId !== null)?.rateId ?? null
    return { rateId, values: values as unknown as RateValues }
  }

  function cachedSmotret(malId: number): unknown {
    const rows = (store.get(sync.keys.userRates) as unknown[] | undefined) ?? []
    const row = rows.find((r) => sync.rateCache.malIdOf(r) === malId) as
      | { smotretAnime?: unknown }
      | undefined
    return row?.smotretAnime ?? null
  }

  async function write(
    malId: number,
    change: RateChange
  ): Promise<PrimaryWrite<RateValues> | null> {
    const user = store.get(sync.keys.user) as { id: number } | null | undefined
    const isSet = change.kind === 'set'
    if (!user) {
      if (isSet) throw new Error('Not logged in to AniList')
      return null
    }
    if (!sync.hasTitle(malId)) {
      if (isSet) throw new Error('This title isn’t on AniList')
      return null
    }
    if (!isSet && (!Number.isInteger(change.episode) || change.episode <= 0)) return null

    let proj = projection(malId)
    let live = false
    if (!proj) {
      // No row, cached or queued: a cold cache can't tell "not on the list"
      // from "not loaded yet", and a create-rule entry against a row the
      // server has would drain as drift and send nothing. One live read
      // settles it; a failure a queued write survives (offline, the session
      // gone) falls back to the create rule.
      try {
        const entry = await sync.fetchEntry(malId)
        if (entry) proj = { rateId: entry.remoteId, values: entry.values }
        live = true
      } catch (err) {
        if (err instanceof AniListUnmappedError) {
          if (isSet) throw new Error('This title isn’t on AniList')
          return null
        }
        if (!sync.isQueueableError(err)) throw err
      }
    }
    const basis = proj ? proj.values : { ...NO_RATE_BEFORE }
    const after = isSet ? rateValues(change.values) : nextWatchedRate(basis, change.episode)
    if (!after) return null
    // No row: the create rule, every field.
    const fields = proj ? RATE_FIELDS.filter((f) => after[f] !== basis[f]) : [...RATE_FIELDS]
    if (fields.length === 0) return { result: after, basis, after }

    const entry: QueuedTrackerUpdate = {
      malId,
      rateId: proj?.rateId ?? null,
      before: basis,
      after,
      queuedAt: Math.max(now(), ...liveQueue().map((q) => q.queuedAt + 1)),
      fields
    }
    stampRateClocks(store, rateClockKey('anilist', user.id, malId), basis, after)
    const current = store.get(sync.keys.user) as { id: number } | null | undefined
    if (live && current?.id !== user.id) {
      // Signed out or switched during the live read: the change is kept for
      // the account it was made on, as Shikimori's branch does (#588).
      const parked = (store.get(sync.keys.parkedQueues) as ParkedQueues | undefined) ?? {}
      const owner = {
        id: String(user.id),
        nickname: (user as { nickname?: string }).nickname ?? ''
      }
      store.set(sync.keys.parkedQueues, parkEntries(parked, owner, [entry], now()))
      sync.broadcastQueueChanged()
      return { result: after, basis, after }
    }
    sync.enqueue(entry)
    sync.startSyncTimer()
    void sync.syncQueue()
    void deps.maybeBroadcastCleanupPrompt(
      cachedSmotret(malId),
      malId,
      after.status,
      proj ? basis.status : undefined
    )
    return { result: after, basis, after }
  }

  return { write }
}
