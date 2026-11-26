// The generic tracker sync service (#691, epic #688): the offline queue, its
// drain, the sync timer, the error policy, parking and the rate cache, for one
// tracker. There is one instance per tracker whose provider has landed, each
// with its own keys (`trackers/keys.ts`) and its own closure state, so a
// failure on one tracker never blocks another. `docs/trackers.md` § The sync
// service describes it; Shikimori's instance is built by
// `services/shikimori-sync`, which adds the Shikimori-only extras.

import { createListenerSet } from '../../lib/listener-set'
import {
  consolidateQueue,
  dropFromParked,
  intendedFields,
  isConsumedEntry,
  recordServerError,
  recordServerErrorInParked,
  type ConsolidatedWorkItem,
  type ParkedQueues,
  type QueuedTrackerUpdate,
  type QueueVia
} from '../../lib/shikimori-queue'
import { keepQueuedRows } from '../../lib/shikimori-rate-cache'
import { STATUS_ORDER, type RateValues } from '../../lib/shikimori-rate'
import type { StorageService } from '../../store/types'
import { TRACKER_ERROR_POLICY } from '../../trackers/errors'
import type { TrackerStoreKeys } from '../../trackers/keys'
import {
  TRACKER_LABELS,
  type TrackerEntry,
  type TrackerRateField,
  type TrackerSyncProvider
} from '../../trackers/types'

const SYNC_TIMER_MS = 60_000
const SYNC_ITEM_DELAY_MS = 250

/** The status every tracker's instance reports: Shikimori's `ShikiSyncStatus`. */
export interface TrackerDrainStatus {
  state: 'idle' | 'syncing'
  queueLength: number
  lastSyncAt: number
  lastSyncError: string | null
  /** The stored refresh token was rejected; the user must sign in again. */
  sessionExpired: boolean
}

/**
 * One consumed drain item (#584). `fieldsApplied` hold the entry's value on
 * the server now; `fieldsKeptByServer` kept the server's. `dropped` is an
 * `item`-class error (or a `server` one past its window): nothing applied.
 * `ownerId` is the tracker's numeric user id; `rate` is the provider's own.
 */
export interface TrackerItemSettled<TRate> {
  ownerId: number
  malId: number
  consumedQueuedAts: number[]
  outcome: 'applied' | 'created' | 'partial' | 'server-won' | 'dropped'
  rate: TRate | null
  fieldsApplied: SyncRateField[]
  fieldsKeptByServer: SyncRateField[]
  after: QueuedTrackerUpdate['after']
  provenance?: Partial<Record<SyncRateField, SyncProvenance>>
  /** The item's `via` (#692), when its entries carry one. */
  via?: QueueVia
  error?: string
}

export interface TrackerRatesResult<TRow> {
  entries: TRow[]
  /** MAL ids whose cached entry was kept for a queued edit (`keepQueued`). */
  waitingMalIds: number[]
}

export interface TrackerSyncServiceDeps {
  store: StorageService
  broadcast: (channel: string, ...args: unknown[]) => void
  syncStatusChannel: string
  offlineQueueChangedChannel: string
  rateUpdatedChannel: string
  ratesRefreshedChannel: string
  /** While offline (#567) the drain returns before touching the network. */
  isOffline?: () => boolean
  /**
   * Called once per entry written into this instance's rate cache, after the
   * `store.set` and before the `rateUpdatedChannel` broadcast. Shikimori's
   * wrapper invalidates its calendar here.
   */
  onRateUpdated?: (trackerId: TrackerId, malId: number) => void
  /**
   * Called when `refreshRates` wrote a result, after the cache write and before
   * the `ratesRefreshedChannel` broadcast; never for a null result.
   */
  onRatesRefreshed?: (trackerId: TrackerId) => void
  /** Called on each "Needs setup" transition, after the flag changed. */
  onNeedsSetupChanged?: (trackerId: TrackerId) => void
}

export interface TrackerSyncService<TRate, TRow> {
  readonly trackerId: TrackerId
  /** This tracker's store keys: #692's fan-out reads its user, queue and parked queues. */
  readonly keys: TrackerStoreKeys
  getQueueLength(): number
  getSyncStatus(): TrackerDrainStatus
  broadcastSyncStatus(): void
  startSyncTimer(): void
  stopSyncTimer(): void
  adjustSyncTimer(): void
  /**
   * One drain run. Returns at once while a run is in flight, while offline,
   * while "Needs setup" is set, or (deferred) while `withQueueLock` holds.
   */
  syncQueue(): Promise<void>
  /** Waits for a drain in flight, then drains once (#584). Never rejects. */
  drainNow(): Promise<void>
  /**
   * Runs `fn` with no drain in flight: waits for one already running, and keeps
   * any new drain from starting until `fn` settles (#584's Forget).
   */
  withQueueLock<T>(fn: () => T | Promise<T>): Promise<T>
  /** Every consumed work item's outcome (#584). Multi-listener; returns an unsubscribe. */
  onItemSettled(listener: (e: TrackerItemSettled<TRate>) => void): () => void
  /**
   * Fetches the signed-in user's list (#592). Without `status` it replaces the
   * rate cache; with `keepQueued`, every MAL id with a live queue entry at the
   * moment of that write keeps its cached entry. Null when the account changed
   * while the list was in flight (#588).
   */
  fetchAndCacheRates(opts?: {
    status?: RateValues['status']
    keepQueued?: boolean
  }): Promise<TrackerRatesResult<TRow> | null>
  /** `fetchAndCacheRates` plus `onRatesRefreshed` and the `ratesRefreshedChannel` broadcast. */
  refreshRates(opts: { keepQueued: boolean }): Promise<TrackerRatesResult<TRow> | null>
  /**
   * Lays `values` over the cached row for `malId`: the cache `store.set`, then
   * `onRateUpdated`, then the `rateUpdatedChannel` broadcast. `remoteId`, when
   * given, becomes the row's id (a settled rate); an enqueue patch leaves it
   * out. Writes nothing, and calls neither, when `ownerId` isn't the signed-in
   * user (#588) or no row matches. Returns the written row. The caller sends
   * the queue broadcast.
   */
  patchCachedRate(
    ownerId: number,
    malId: number,
    values: RateValues,
    remoteId?: number
  ): TRow | null
  /** The cached row for `malId` as the codec reads it, or null. */
  cachedRate(malId: number): { remoteId: number | null; values: RateValues } | null
  /** False when the provider says the title isn't on this tracker (#692). */
  hasTitle(malId: number): boolean
  /**
   * #692's enqueue: appends `entry` to the live queue, then patches the
   * signed-in user's cached row with `entry.after` (`patchCachedRate`: the
   * cache `store.set`, `onRateUpdated`, `rateUpdatedChannel`), then broadcasts
   * `offlineQueueChangedChannel`, all in one synchronous step. No row, no patch.
   */
  enqueue(entry: QueuedTrackerUpdate): void
  /** `offlineQueueChangedChannel` with the live queue's length. */
  broadcastQueueChanged(): void
  /** The tracker's "Needs setup": a `config`-class error was seen; no drain runs while set. */
  needsSetup(): boolean
  /** Clears "Needs setup" (a client-config change, a successful Test) and kicks one drain. */
  clearNeedsSetup(): void
}

const RATE_FIELDS: readonly TrackerRateField[] = ['episodes', 'status', 'score', 'rewatches']

type RateFieldValues = QueuedTrackerUpdate['after']

// An entry queued before `rewatches` was recorded has none: it means 0.
function beforeOf(item: Pick<ConsolidatedWorkItem, 'before'>, f: SyncRateField): number | string {
  return f === 'rewatches' ? (item.before.rewatches ?? 0) : item.before[f]
}

/**
 * What a drifted item sends (#584 §3). A scoped entry writes `after[f]` only
 * where the server still has `before[f]`; `resolvedFields` always take
 * `after`; everything else keeps the server's value. An unscoped (user) entry
 * keeps today's whole-rate policy, with its `resolvedFields` forced.
 */
export function driftPayload(
  item: Pick<ConsolidatedWorkItem, 'before' | 'after' | 'fields' | 'resolvedFields'>,
  current: RateFieldValues
): RateFieldValues {
  const resolved = new Set(item.resolvedFields ?? [])
  if (!item.fields && shouldApplyOnDrift(current, item.after)) return { ...item.after }
  const out = { ...current }
  for (const f of RATE_FIELDS) {
    const scopedOk = !!item.fields?.includes(f) && current[f] === beforeOf(item, f)
    if (resolved.has(f) || scopedOk) (out as Record<string, unknown>)[f] = item.after[f]
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shouldApplyOnDrift(
  current: Pick<RateValues, 'episodes' | 'status'>,
  after: Pick<RateValues, 'episodes' | 'status' | 'score'>
): boolean {
  if (after.episodes <= current.episodes) return false
  const currentRank = STATUS_ORDER[current.status]
  const afterRank = STATUS_ORDER[after.status]
  if (currentRank > afterRank) return false
  // Same rank but different value (watching ↔ rewatching) is a user-meaningful
  // side-grade, not pure episode progress — treat as drift and let the server win.
  if (currentRank === afterRank && current.status !== after.status) return false
  return true
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createTrackerSyncService<TSession extends { userId: number }, TNative, TRate, TRow>(
  provider: TrackerSyncProvider<TSession, TNative, TRate, TRow>,
  keys: TrackerStoreKeys,
  deps: TrackerSyncServiceDeps
): TrackerSyncService<TRate, TRow> {
  const { store, broadcast } = deps
  const trackerId = provider.id
  const label = TRACKER_LABELS[trackerId]
  const log = `[${trackerId} sync]`
  const codec = provider.rateCache

  let syncInProgress = false
  let syncTimer: NodeJS.Timeout | null = null
  let lastSyncAt = 0
  let lastSyncError: string | null = null
  let needsSetupFlag = false

  function getQueueLength(): number {
    return (store.get(keys.updateQueue) as QueuedTrackerUpdate[]).length
  }

  function getSyncStatus(): TrackerDrainStatus {
    return {
      state: syncInProgress ? 'syncing' : 'idle',
      queueLength: getQueueLength(),
      lastSyncAt,
      lastSyncError,
      // Read from the store, not from closure state like every field above it:
      // expiry has to survive a restart. The reported case is an app *starting*
      // with two-month-dead credentials and showing "connected" (#244).
      // `Boolean(...)` because the test storage fake returns `undefined` for an
      // unset key rather than applying STORE_DEFAULTS.
      sessionExpired: Boolean(store.get(keys.sessionExpired))
    }
  }

  function broadcastSyncStatus(): void {
    broadcast(deps.syncStatusChannel, getSyncStatus())
  }

  function startSyncTimer(): void {
    if (syncTimer) return
    syncTimer = setInterval(() => {
      void syncQueue()
    }, SYNC_TIMER_MS)
  }

  function stopSyncTimer(): void {
    if (!syncTimer) return
    clearInterval(syncTimer)
    syncTimer = null
  }

  function adjustSyncTimer(): void {
    if (getQueueLength() > 0) startSyncTimer()
    else stopSyncTimer()
  }

  function currentUserId(): number | undefined {
    return (store.get(keys.user) as { id: number } | null)?.id
  }

  function setNeedsSetup(): void {
    if (needsSetupFlag) return
    needsSetupFlag = true
    deps.onNeedsSetupChanged?.(trackerId)
  }

  function clearNeedsSetup(): void {
    if (!needsSetupFlag) return
    needsSetupFlag = false
    deps.onNeedsSetupChanged?.(trackerId)
    void syncQueue()
  }

  // The drain's owner may have logged out or been switched away mid-item: its
  // entries are then parked, or gone after Discard, and never in the live queue
  // (#588). A missing bucket stays missing. Entries match on `(malId,
  // queuedAt, via)` (#692 § 4): items of two `via` values can share a `queuedAt`.
  function dropConsumedEntries(
    ownerId: number,
    malId: number,
    consumedQueuedAts: number[],
    via: QueueVia | undefined
  ): void {
    let queue = store.get(keys.updateQueue) as QueuedTrackerUpdate[]
    if (currentUserId() === ownerId) {
      const consumed = new Set(consumedQueuedAts)
      queue = queue.filter((q) => !isConsumedEntry(q, malId, consumed, via))
      store.set(keys.updateQueue, queue)
    } else {
      const parked = (store.get(keys.parkedQueues) as ParkedQueues | undefined) ?? {}
      const next = dropFromParked(parked, String(ownerId), malId, consumedQueuedAts, via)
      if (next !== parked) store.set(keys.parkedQueues, next)
    }
    broadcast(deps.offlineQueueChangedChannel, { length: queue.length })
  }

  // Routed like dropConsumedEntries, so a stamp never lands in the next owner's
  // queue. Returns whether the item's 5xx window has expired.
  function recordConsumedServerError(
    ownerId: number,
    malId: number,
    consumedQueuedAts: number[],
    via: QueueVia | undefined
  ): boolean {
    const now = Date.now()
    if (currentUserId() === ownerId) {
      const queue = store.get(keys.updateQueue) as QueuedTrackerUpdate[]
      const result = recordServerError(queue, malId, consumedQueuedAts, now, via)
      if (result.entries !== queue) store.set(keys.updateQueue, result.entries)
      return result.expired
    }
    const parked = (store.get(keys.parkedQueues) as ParkedQueues | undefined) ?? {}
    const result = recordServerErrorInParked(
      parked,
      String(ownerId),
      malId,
      consumedQueuedAts,
      now,
      via
    )
    if (result.parked !== parked) store.set(keys.parkedQueues, result.parked)
    return result.expired
  }

  // An item in flight across a switch lands on the old account; the cache is
  // the new one's by then (#588).
  function patchCachedRate(
    ownerId: number,
    malId: number,
    values: RateValues,
    remoteId?: number
  ): TRow | null {
    if (currentUserId() !== ownerId) return null
    const cached = store.get(keys.userRates) as TRow[]
    const idx = codec.indexOf(cached, malId)
    if (idx === -1) return null
    cached[idx] = codec.patch(cached[idx], values, remoteId)
    store.set(keys.userRates, cached)
    deps.onRateUpdated?.(trackerId, malId)
    broadcast(deps.rateUpdatedChannel, cached[idx])
    return cached[idx]
  }

  function reconcileCacheFromRate(ownerId: number, malId: number, rate: TrackerEntry<TRate>): void {
    patchCachedRate(ownerId, malId, rate.values, rate.remoteId ?? undefined)
  }

  function cachedRate(malId: number): { remoteId: number | null; values: RateValues } | null {
    const cached = (store.get(keys.userRates) as TRow[] | undefined) ?? []
    const idx = codec.indexOf(cached, malId)
    return idx === -1 ? null : codec.read(cached[idx])
  }

  function broadcastQueueChanged(): void {
    broadcast(deps.offlineQueueChangedChannel, { length: getQueueLength() })
  }

  function enqueue(entry: QueuedTrackerUpdate): void {
    const queue = store.get(keys.updateQueue) as QueuedTrackerUpdate[]
    queue.push(entry)
    store.set(keys.updateQueue, queue)
    const ownerId = currentUserId()
    if (ownerId !== undefined) patchCachedRate(ownerId, entry.malId, entry.after)
    broadcast(deps.offlineQueueChangedChannel, { length: queue.length })
  }

  const settled = createListenerSet<[TrackerItemSettled<TRate>]>(`${trackerId}-item-settled`)
  // The drain in flight, and Forget's queue lock (#584).
  let inFlight: Promise<void> | null = null
  let queueLock: Promise<void> | null = null
  let drainAfterLock = false

  function syncQueue(): Promise<void> {
    // "Needs setup": every run would fail the same way, so none starts (#702).
    if (syncInProgress || needsSetupFlag || deps.isOffline?.()) return Promise.resolve()
    if (queueLock) {
      drainAfterLock = true
      return Promise.resolve()
    }
    const run = drainOnce()
    inFlight = run
    void run
      .catch(() => {})
      .finally(() => {
        if (inFlight === run) inFlight = null
      })
    return run
  }

  async function drainNow(): Promise<void> {
    try {
      while (queueLock) await queueLock
      await inFlight?.catch(() => {})
      await syncQueue()
      // Another caller's drain started meanwhile: it covers every entry queued so far.
      await inFlight?.catch(() => {})
    } catch (err) {
      console.warn(`${log} drainNow failed:`, err)
    }
  }

  async function withQueueLock<T>(fn: () => T | Promise<T>): Promise<T> {
    while (queueLock) await queueLock
    let release!: () => void
    queueLock = new Promise<void>((resolve) => (release = resolve))
    try {
      await inFlight?.catch(() => {})
      return await fn()
    } finally {
      queueLock = null
      release()
      if (drainAfterLock) {
        drainAfterLock = false
        void syncQueue()
      }
    }
  }

  async function drainOnce(): Promise<void> {
    if (syncInProgress || deps.isOffline?.()) return
    const queue = store.get(keys.updateQueue) as QueuedTrackerUpdate[]
    if (queue.length === 0) {
      stopSyncTimer()
      return
    }
    // A blob's presence: the drain never reads the vault itself.
    const creds = store.get(keys.credentials)
    const user = store.get(keys.user) as { id: number } | null
    if (!creds || !user) return
    const ownerId = user.id

    syncInProgress = true
    broadcastSyncStatus()

    // One session for the whole run (#588): every data call below carries it,
    // so an item in flight across a switch stays on the old account.
    let session: TSession
    try {
      session = await provider.auth()
    } catch (err) {
      syncInProgress = false
      // The previous account's refresh failed after a switch: not this
      // session's error, and its timer is not this drain's to stop.
      if (currentUserId() !== ownerId) {
        broadcastSyncStatus()
        void syncQueue()
        return
      }
      const errorClass = provider.classifyError(err)
      if (errorClass !== 'network') {
        lastSyncError = messageOf(err)
        console.warn(`${log} auth refresh failed:`, err)
      }
      // The queue is kept: the token step never touches it.
      if (errorClass === 'config') setNeedsSetup()
      // A refresh that cleared the credentials leaves every later tick
      // returning at the `!creds` guard above without ever reaching
      // `adjustSyncTimer()` — a timer that can only spin. The queue is kept: it
      // replays once the user signs in again (#244).
      if (provider.isSessionGone(err)) stopSyncTimer()
      broadcastSyncStatus()
      return
    }
    // A session for another account is an owner change, as above.
    if (session.userId !== ownerId) {
      syncInProgress = false
      broadcastSyncStatus()
      if (currentUserId() !== ownerId) void syncQueue()
      return
    }

    const work = consolidateQueue(queue)
    let aborted = false
    let ownerChanged = false
    let hadServerError = false

    for (const item of work) {
      // A logout or account switch since the drain started: the rest of this
      // work list is someone else's now, and this session is the old owner's.
      if (currentUserId() !== ownerId) {
        ownerChanged = true
        break
      }
      const intended = intendedFields(item)
      const settle = (
        outcome: TrackerItemSettled<TRate>['outcome'],
        rate: TRate | null,
        sent: RateFieldValues | null,
        error?: string
      ): void => {
        const applied = sent ? intended.filter((f) => sent[f] === item.after[f]) : []
        settled.emit({
          ownerId,
          malId: item.malId,
          consumedQueuedAts: [...item.consumedQueuedAts],
          outcome,
          rate,
          fieldsApplied: applied,
          fieldsKeptByServer: sent ? intended.filter((f) => !applied.includes(f)) : [],
          after: { ...item.after },
          ...(item.origin ? { provenance: { ...item.origin.provenance } } : {}),
          ...(item.via ? { via: item.via } : {}),
          ...(error !== undefined ? { error } : {})
        })
      }
      try {
        const current = await provider.getEntry(session, {
          malId: item.malId,
          remoteId: item.rateId
        })

        if (!current) {
          const created = await provider.upsertEntry(
            session,
            { malId: item.malId, remoteId: null },
            item.after,
            intended
          )
          reconcileCacheFromRate(ownerId, item.malId, created)
          dropConsumedEntries(ownerId, item.malId, item.consumedQueuedAts, item.via)
          settle('created', created.native, item.after)
        } else {
          const now = current.values
          // `rewatches` is part of the drift check (#584): a rewatches-only drift is drift.
          const driftMatches = RATE_FIELDS.every((f) => now[f] === beforeOf(item, f))
          const sent = driftMatches ? item.after : driftPayload(item, now)
          const changedFields = RATE_FIELDS.filter((f) => sent[f] !== now[f])
          let rate = current
          // A `via` item (#692) with nothing to change makes no call; every
          // other item keeps 6.x's PATCH on a drift match.
          if (changedFields.length > 0 || (driftMatches && !item.via)) {
            rate = await provider.upsertEntry(
              session,
              { malId: item.malId, remoteId: current.remoteId },
              sent,
              changedFields
            )
          }
          reconcileCacheFromRate(ownerId, item.malId, rate)
          dropConsumedEntries(ownerId, item.malId, item.consumedQueuedAts, item.via)
          const applied = intended.filter((f) => sent[f] === item.after[f])
          settle(
            applied.length === intended.length
              ? 'applied'
              : applied.length === 0
                ? 'server-won'
                : 'partial',
            rate.native,
            sent
          )
        }
      } catch (err) {
        // The class decides, by T0's table (`TRACKER_ERROR_POLICY`).
        const errorClass = provider.classifyError(err)
        const policy = TRACKER_ERROR_POLICY[errorClass]
        // After a switch mid-item the error is the previous account's, so it
        // must not reach the session that signed in meanwhile.
        const ownerCurrent = currentUserId() === ownerId
        if (policy.drain === 'abort') {
          aborted = true
          if (errorClass === 'auth') {
            if (ownerCurrent) lastSyncError = messageOf(err)
            console.warn(`${log} auth error, stopping drain:`, err)
          } else if (errorClass === 'rate-limit') {
            if (ownerCurrent) lastSyncError = `${label} rate limit — will retry`
            console.warn(`${log} rate limited, stopping drain:`, err)
          } else if (errorClass === 'config') {
            if (ownerCurrent) lastSyncError = messageOf(err)
            console.warn(`${log} needs setup, stopping drain:`, err)
          }
          // The client config is the app's, not the account's: set whoever owns the item.
          if (policy.needsSetup) setNeedsSetup()
          break
        }
        // Often specific to one item, so the drain moves on instead of stopping.
        if (policy.entry === 'drop-after-24h') {
          if (recordConsumedServerError(ownerId, item.malId, item.consumedQueuedAts, item.via)) {
            console.warn(
              `${log} dropping item`,
              item.malId,
              'after 24 h of server errors:',
              messageOf(err)
            )
            dropConsumedEntries(ownerId, item.malId, item.consumedQueuedAts, item.via)
            settle('dropped', null, null, messageOf(err))
          } else {
            hadServerError = true
            if (ownerCurrent) lastSyncError = `${label} server error — will retry`
            console.warn(
              `${log} server error, keeping item`,
              item.malId,
              (err as { status?: unknown }).status
            )
          }
        } else if (policy.entry === 'drop') {
          console.warn(`${log} dropping item`, item.malId, err)
          dropConsumedEntries(ownerId, item.malId, item.consumedQueuedAts, item.via)
          settle('dropped', null, null, messageOf(err))
        }
      }

      if (work.indexOf(item) < work.length - 1) await sleep(SYNC_ITEM_DELAY_MS)
    }

    // The owner may have changed while the last item was awaiting the network.
    if (currentUserId() !== ownerId) ownerChanged = true
    syncInProgress = false
    // An owner change is not a sync result, so it leaves the last one standing.
    // A kept 5xx item is not synced, so it keeps its retry message.
    if (!aborted && !ownerChanged && !hadServerError) {
      lastSyncAt = Date.now()
      lastSyncError = null
    }
    adjustSyncTimer()
    broadcastSyncStatus()
    // A restore that landed while this drain was mid-loop kicked a drain that
    // returned at `syncInProgress`; without this it would wait for the timer.
    if (ownerChanged) void syncQueue()
  }

  async function fetchAndCacheRates(
    opts: { status?: RateValues['status']; keepQueued?: boolean } = {}
  ): Promise<TrackerRatesResult<TRow> | null> {
    // `auth()` throws `Not logged in to <tracker>` when no user is stored.
    const session = await provider.auth()
    const listed = await provider.listEntries(session, { status: opts.status })
    if (currentUserId() !== session.userId) return null
    let entries = codec.fromEntries(listed)
    let waitingMalIds: number[] = []
    if (!opts.status) {
      // Read now, at the write, not before the request: an edit queued while
      // the list was in flight is kept as well.
      if (opts.keepQueued) {
        const queue = store.get(keys.updateQueue) as QueuedTrackerUpdate[]
        const queued = new Set(queue.map((q) => q.malId))
        const cached = (store.get(keys.userRates) as TRow[] | undefined) ?? []
        entries = keepQueuedRows(entries, cached, queued, codec.malIdOf)
        waitingMalIds = [...queued]
      }
      store.set(keys.userRates, entries)
    }
    return { entries, waitingMalIds }
  }

  async function refreshRates(opts: {
    keepQueued: boolean
  }): Promise<TrackerRatesResult<TRow> | null> {
    const result = await fetchAndCacheRates({ keepQueued: opts.keepQueued })
    if (!result) return null
    deps.onRatesRefreshed?.(trackerId)
    broadcast(deps.ratesRefreshedChannel, result.entries)
    return result
  }

  return {
    trackerId,
    keys,
    getQueueLength,
    getSyncStatus,
    broadcastSyncStatus,
    startSyncTimer,
    stopSyncTimer,
    adjustSyncTimer,
    syncQueue,
    drainNow,
    withQueueLock,
    onItemSettled: (listener) => settled.add(listener),
    fetchAndCacheRates,
    refreshRates,
    patchCachedRate,
    cachedRate,
    hasTitle: (malId) => provider.hasTitle?.(malId) ?? true,
    enqueue,
    broadcastQueueChanged,
    needsSetup: () => needsSetupFlag,
    clearNeedsSetup
  }
}
