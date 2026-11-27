// MyAnimeList's primary branch of #692's fan-out writer (#702), shaped after
// Shikimori's (`shikimori-primary.ts`): a user change to MAL as the primary is
// sent live through the MAL provider with one session, and patched into the
// MAL cache; a failure the queue would survive (any class whose policy keeps
// the entry: network, auth, rate-limit, server, config) queues it instead,
// against the cached row, as `queueRate` does. A change that reaches
// `completed` runs the cleanup prompt with the MAL row's own `smotretAnime`.
// `index.ts` sets it with `setPrimaryWriter('mal', …)`.

import { parkEntries, type ParkedQueues, type QueuedTrackerUpdate } from '../../lib/shikimori-queue'
import { NO_RATE_BEFORE, nextWatchedRate, type RateValues } from '../../lib/shikimori-rate'
import { rateClockKey, stampRateClocks } from '../../store/sync-meta'
import type { StorageService } from '../../store/types'
import { TRACKER_ERROR_POLICY } from '../../trackers/errors'
import {
  malRateCache,
  type MalCachedRow,
  type MalListStatus,
  type MalProvider,
  type MalSession
} from '../../trackers/mal/provider'
import type { TrackerEntry, TrackerRateField } from '../../trackers/types'
import type { PrimaryWrite, RateChange } from './fan-out'
import type { TrackerSyncService } from './sync'

const RATE_FIELDS: readonly TrackerRateField[] = ['episodes', 'status', 'score', 'rewatches']

export interface MalPrimaryDeps {
  store: StorageService
  sync: Pick<
    TrackerSyncService<MalListStatus, MalCachedRow>,
    | 'keys'
    | 'enqueue'
    | 'patchCachedRate'
    | 'broadcastQueueChanged'
    | 'broadcastSyncStatus'
    | 'startSyncTimer'
    | 'syncQueue'
    | 'refreshRates'
  >
  provider: Pick<
    MalProvider,
    'auth' | 'getEntry' | 'readEntry' | 'upsertEntry' | 'classifyError' | 'isSessionGone'
  >
  maybeBroadcastCleanupPrompt: (
    smotretAnime: unknown,
    malId: number,
    status: RateValues['status'],
    prevStatus?: RateValues['status']
  ) => Promise<void>
  now?: () => number
  log?: Pick<Console, 'warn'>
}

/** What MAL's primary branch returns: the values written or queued. */
export type MalPrimaryResult = RateValues

export interface MalPrimary {
  write(malId: number, change: RateChange): Promise<PrimaryWrite<MalPrimaryResult> | null>
}

/**
 * The episode a mark of `epNum` records on MAL (#744), or null for none. MAL
 * stores at most the title's total, so a mark past a known total marks the
 * total; on a `completed` title that is a no-op, since `nextWatchedRate`
 * would start a rewatch. With no total (none cached, or MAL's 0, which
 * `readEntry` and `totalOf` both read as null) `epNum` stands.
 */
function markTarget(before: RateValues, epNum: number, total: number | null): number | null {
  if (total === null || epNum <= total) return epNum
  return before.status === 'completed' ? null : total
}

/** A cached row's total: positive only, as `num_episodes: 0` is MAL's "unknown". */
function totalOf(row: MalCachedRow | undefined): number | null {
  const n = row?.node?.num_episodes
  return typeof n === 'number' && n > 0 ? n : null
}

export function createMalPrimary(deps: MalPrimaryDeps): MalPrimary {
  const { store, sync, provider, maybeBroadcastCleanupPrompt } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const keys = sync.keys

  const userOf = (): TrackerUser | null =>
    (store.get(keys.user) as TrackerUser | null | undefined) ?? null

  function rowOf(malId: number): MalCachedRow | undefined {
    const rows = (store.get(keys.userRates) as MalCachedRow[] | undefined) ?? []
    return rows.find((r) => r.node?.id === malId)
  }

  // The cache belongs to whoever is signed in now; after a switch during an
  // await, the owner's basis is the row read before it.
  function ownersRow(owner: TrackerUser, malId: number, atStart: MalCachedRow | undefined) {
    return userOf()?.id === owner.id ? rowOf(malId) : atStart
  }

  function queueable(err: unknown): boolean {
    return TRACKER_ERROR_POLICY[provider.classifyError(err)].entry !== 'drop'
  }

  function basisOf(row: MalCachedRow | undefined): { rateId: number | null; before: RateValues } {
    if (!row) return { rateId: null, before: { ...NO_RATE_BEFORE } }
    const { remoteId, values } = malRateCache.read(row)
    return { rateId: remoteId, before: values }
  }

  async function send(
    session: MalSession,
    owner: TrackerUser,
    malId: number,
    existing: TrackerEntry<MalListStatus> | null,
    after: RateValues
  ): Promise<RateValues> {
    const basis = existing ? existing.values : NO_RATE_BEFORE
    const fields = existing ? RATE_FIELDS.filter((f) => after[f] !== basis[f]) : [...RATE_FIELDS]
    const prevRow = rowOf(malId)
    const prevStatus = prevRow ? malRateCache.read(prevRow).values.status : undefined
    const written =
      existing && fields.length === 0
        ? existing
        : await provider.upsertEntry(
            session,
            { malId, remoteId: existing?.remoteId ?? null },
            after,
            fields
          )
    stampRateClocks(store, rateClockKey('mal', owner.id, malId), basis, after)
    // The write landed on the previous account; the cache is the new one's.
    if (userOf()?.id !== owner.id) return written.values

    const row = sync.patchCachedRate(owner.id, malId, written.values, malId)
    if (row) {
      void maybeBroadcastCleanupPrompt(row.smotretAnime, malId, written.values.status, prevStatus)
    } else {
      // A title new to the list: the refresh brings its row (and its smotret join).
      void sync
        .refreshRates({ keepQueued: true })
        .catch((err) => log.warn('[mal primary] rate refresh failed:', err))
      void maybeBroadcastCleanupPrompt(null, malId, written.values.status, undefined)
    }
    void sync.syncQueue()
    return written.values
  }

  function queuedAtFor(): number {
    const queue = (store.get(keys.updateQueue) as QueuedTrackerUpdate[] | undefined) ?? []
    return Math.max(now(), ...queue.map((q) => q.queuedAt + 1))
  }

  // `queueRate`'s MAL counterpart: the entry is the whole rate (no `fields`),
  // kept for the owner the change was made for, parked after a switch.
  function queue(
    owner: TrackerUser,
    malId: number,
    basis: { rateId: number | null; before: RateValues },
    after: RateValues,
    err: unknown
  ): RateValues {
    const entry: QueuedTrackerUpdate = {
      malId,
      rateId: basis.rateId,
      before: basis.before,
      after,
      queuedAt: queuedAtFor()
    }
    stampRateClocks(store, rateClockKey('mal', owner.id, malId), basis.before, after)
    if (userOf()?.id !== owner.id) {
      const parked = (store.get(keys.parkedQueues) as ParkedQueues | undefined) ?? {}
      store.set(
        keys.parkedQueues,
        parkEntries(parked, { id: String(owner.id), nickname: owner.nickname }, [entry], now())
      )
      sync.broadcastQueueChanged()
      return after
    }
    const row = rowOf(malId)
    const prevStatus = row ? malRateCache.read(row).values.status : undefined
    sync.enqueue(entry)
    sync.broadcastSyncStatus()
    if (!provider.isSessionGone(err)) sync.startSyncTimer()
    if (row) void maybeBroadcastCleanupPrompt(row.smotretAnime, malId, after.status, prevStatus)
    return after
  }

  async function updateRate(malId: number, values: RateValues): Promise<PrimaryWrite<RateValues>> {
    const user = userOf()
    if (!user) throw new Error('Not logged in to MyAnimeList')
    const after = { ...values }
    const atStart = rowOf(malId)
    try {
      const session = await provider.auth()
      const existing = await provider.getEntry(session, { malId, remoteId: malId })
      const result = await send(session, user, malId, existing, after)
      return { result, basis: existing ? existing.values : { ...NO_RATE_BEFORE }, after }
    } catch (err) {
      const row = ownersRow(user, malId, atStart)
      // As Shikimori's: a title with no cached row isn't queued blind.
      if (!queueable(err) || !row) throw err
      const basis = basisOf(row)
      return { result: queue(user, malId, basis, after, err), basis: basis.before, after }
    }
  }

  async function markEpisodeWatched(
    malId: number,
    epNum: number
  ): Promise<PrimaryWrite<RateValues> | null> {
    const user = userOf()
    if (!user || !Number.isInteger(epNum) || epNum <= 0) return null
    const atStart = rowOf(malId)

    let session: MalSession
    let existing: TrackerEntry<MalListStatus> | null
    let total: number | null
    try {
      session = await provider.auth()
      ;({ entry: existing, numEpisodes: total } = await provider.readEntry(session, {
        malId,
        remoteId: malId
      }))
    } catch (err) {
      if (!queueable(err)) throw err
      const row = ownersRow(user, malId, atStart)
      const basis = basisOf(row)
      // Offline the only total is the cached row's; with no row, nothing is clamped.
      const target = markTarget(basis.before, epNum, totalOf(row))
      const next = target === null ? null : nextWatchedRate(basis.before, target)
      return next
        ? { result: queue(user, malId, basis, next, err), basis: basis.before, after: next }
        : null
    }

    const before = existing ? existing.values : { ...NO_RATE_BEFORE }
    const target = markTarget(before, epNum, total)
    if (target === null) return null
    const next = nextWatchedRate(before, target)
    if (!next) return null
    try {
      const result = await send(session, user, malId, existing, next)
      return { result, basis: before, after: next }
    } catch (err) {
      if (!queueable(err)) throw err
      const basis = { rateId: existing ? malId : null, before }
      return { result: queue(user, malId, basis, next, err), basis: before, after: next }
    }
  }

  return {
    write: (malId, change) =>
      change.kind === 'set'
        ? updateRate(malId, change.values)
        : markEpisodeWatched(malId, change.episode)
  }
}
