// The reads and writes behind the `tracker:*` rate, sync-status and queue
// channels (#694, epic #688), shared with their `shikimori:*` aliases. Each pair
// of handlers calls the same function here, the `tracker:*` one with the
// tracker it was asked about and the alias with `'shikimori'`, and each maps
// the answer onto its own reply. `docs/trackers.md` § The IPC surface
// describes the rules.
//
// An instance is a tracker's sync service, and it exists for every tracker
// whose provider has landed, signed in or not: a signed-out or expired
// tracker answers through its instance's own checks. Only a tracker with no
// instance yet takes the no-instance answers below. The parked queues, the
// queue length and the default status read the tracker's store keys, so they
// need no instance.

import { OfflineError } from '../../lib/net'
import {
  takeParked,
  UNKNOWN_OWNER,
  type ParkedQueues,
  type QueuedTrackerUpdate
} from '../../lib/shikimori-queue'
import { rateValues, type RateValues } from '../../lib/shikimori-rate'
import type { StorageService } from '../../store/types'
import { storedAnilistScoreFormat } from '../../trackers/anilist/provider'
import { TRACKER_KEYS } from '../../trackers/keys'
import { rateDiff } from '../../trackers/rate-diff'
import { TRACKER_LABELS, type TrackerEntry, type TrackerRateEntry } from '../../trackers/types'
import type { ApplyOutcome, PrimaryResults, TrackerFanOut } from './fan-out'
import type { TrackerDrainStatus, TrackerSyncService } from './sync'

// From `TRACKER_KEYS`, a `Record<TrackerId, …>`: an id missing there fails typecheck.
export const TRACKER_IDS = Object.keys(TRACKER_KEYS) as readonly TrackerId[]

export function isTrackerId(value: unknown): value is TrackerId {
  return typeof value === 'string' && (TRACKER_IDS as readonly string[]).includes(value)
}

type Instance = TrackerSyncService<unknown, unknown>
type CachedRate = NonNullable<ReturnType<Instance['cachedRate']>>

const RATE_FIELDS = ['episodes', 'status', 'score', 'rewatches'] as const

function sameValues(a: RateValues, b: RateValues): boolean {
  return RATE_FIELDS.every((f) => a[f] === b[f])
}

/** The same `remoteId` and the same four values. */
function sameCachedRate(a: CachedRate | null, b: CachedRate | null): boolean {
  if (a === null || b === null) return a === b
  return a.remoteId === b.remoteId && sameValues(a.values, b.values)
}

/**
 * What `readRate` answered: the live entry (null when the user has none), or,
 * offline or after a failure a queued write survives, the cached row (null
 * when the title isn't on a non-empty list).
 */
export type RateRead =
  | { stale: false; entry: TrackerEntry<unknown> | null }
  | { stale: true; row: unknown | null }

/** One kept bucket. `ownerId` is its key, null for the unknown-account bucket. */
export interface ParkedBucketSummary {
  ownerId: string | null
  nickname: string
  count: number
  parkedAt: number
}

/** A tracker's status with its "Needs setup". */
export type TrackerStatus = TrackerDrainStatus & { needsSetup: boolean }

/** `tracker:get-rate`'s per-title fields (#705), from main's own state: no network. */
export interface TitleSignals {
  /** That tracker's live queue holds an entry for the title. */
  queued: boolean
  /** A fresh negative id-map entry: the tracker can't hold the title (AniList's only). */
  unmapped: boolean
  /**
   * Where its projection differs from the primary's (`rateDiff`); [] for the
   * primary. A projection's cached row includes the last live read (#752).
   */
  differs: SyncRateField[]
}

/** The tail a tracker adds to the shared rate refreshes (Shikimori's router sets its own). */
export interface TrackerRefreshHooks {
  /** After a background refresh wrote a result. Without it, the instance's drain runs. */
  afterBackgroundRefresh?(): void
  /** After `getRates` fetched the whole list because none was cached. */
  afterFetch?(): void
}

export interface TrackerRatesDeps {
  store: StorageService
  trackers: TrackerFanOut
  /** While offline (#567) get-rate answers from the cache and no refresh starts. */
  isOffline?: () => boolean
  log?: Pick<Console, 'warn'>
}

export interface TrackerRates {
  /** The tracker's sync instance, or null when its provider hasn't landed. */
  instance(trackerId: TrackerId): Instance | null
  /** The fan-out's primary: the stored one if connected, else the first connected, else null. */
  primary(): TrackerId | null
  /**
   * The primary's rate cache as read-side entries (#698): each row through
   * its codec's `entryOf`, with the row itself as `native`. Writes nothing.
   * `[]` with no primary, or for a primary whose instance hasn't landed.
   */
  primaryEntries(): TrackerRateEntry<unknown>[]
  /**
   * Null with no instance. Rejects as today's `shikimori:get-rate` does. A
   * live entry that differs from the cached row is written into it
   * (`patchCachedRateFromRead`) unless the row changed while the read was in
   * flight or the title is queued; a live entry with no row, or a null one
   * over a row, kicks one background refresh per tracker, account and title
   * per session (#752).
   */
  readRate(trackerId: TrackerId, malId: number): Promise<RateRead | null>
  /**
   * The rate cache's rows, cache-first: a cached list answers at once and
   * refreshes in the background; otherwise one fetch. With `status`, that
   * status's listed rows. Null with no instance.
   */
  getRates(trackerId: TrackerId, status?: RateValues['status']): Promise<unknown[] | null>
  /** `refreshRates` off the request path: nothing while offline, a warning on a failure. */
  refreshInBackground(trackerId: TrackerId): void
  /** The last queued `after` per MAL id in that tracker's live queue. */
  queuedAfter(trackerId: TrackerId): Record<number, RateValues>
  /**
   * Where a `tracker:update-rate` goes: `only`, else the primary, else the
   * first tracker with an instance, whose own primary branch refuses the
   * signed-out edit.
   */
  writeTarget(only?: TrackerId): TrackerId
  /**
   * A user's set through `applyChange` with `cause: 'user'`. `mirrors: false`
   * writes the target alone. Throws `Not logged in to <Tracker>` for a tracker
   * with no instance.
   */
  updateRate<K extends TrackerId>(
    malId: number,
    values: RateValues,
    target: K,
    mirrors?: boolean
  ): Promise<ApplyOutcome<PrimaryResults[K]>>
  /**
   * A mark-watched through `applyChange`, to `target`; with no target (no
   * primary) or no instance it resolves null and calls no provider.
   */
  markEpisodeWatched<K extends TrackerId>(
    malId: number,
    epNum: number,
    target: K | null
  ): Promise<ApplyOutcome<PrimaryResults[K]> | null>
  /**
   * The title's signals on that tracker (#705 § 1). `differs` is [] for the
   * primary, with no primary, for an unmapped title, and when the primary has
   * no row, cached or queued.
   */
  titleSignals(trackerId: TrackerId, malId: number): TitleSignals
  /**
   * "Copy from primary" (#705 § 3): the primary's projection (its cached row
   * includes the last live read, #752), as a `'user'`
   * set to that tracker alone (`applyChange`'s non-primary branch, queued
   * with `via: 'copy'`). Refuses the primary, a tracker that isn't connected,
   * an unmapped title and a primary with no row; calls nothing when nothing
   * differs. Resolves the target's projection afterwards.
   */
  copyFromPrimary(trackerId: TrackerId, malId: number): Promise<RateValues | null>
  /** The instance's status, or with no instance the default idle one from the store keys. */
  getSyncStatus(trackerId: TrackerId): TrackerStatus
  /** The tracker's queue store key's length. */
  getOfflineQueueLength(trackerId: TrackerId): number
  /** One drain of that tracker, or of every connected one when omitted. Fire-and-forget. */
  triggerSync(trackerId?: TrackerId): void
  /** The tracker's parked-queue store key, signed in or not. */
  getParkedQueues(trackerId: TrackerId): ParkedBucketSummary[]
  /** Drops one kept bucket from the tracker's parked-queue store key. */
  discardParkedQueue(trackerId: TrackerId, ownerId: string | null): void
  setRefreshHooks(trackerId: TrackerId, hooks: TrackerRefreshHooks): void
}

/** The last `after` per MAL id, in queue order (the drain's consolidation takes the last). */
export function queuedAfterOf(
  queue: readonly QueuedTrackerUpdate[] | undefined
): Record<number, RateValues> {
  const out: Record<number, RateValues> = {}
  for (const q of queue ?? []) out[q.malId] = rateValues(q.after)
  return out
}

export function createTrackerRates(deps: TrackerRatesDeps): TrackerRates {
  const { store, trackers } = deps
  const log = deps.log ?? console
  const isOffline = (): boolean => deps.isOffline?.() ?? false
  const hooks = new Map<TrackerId, TrackerRefreshHooks>()
  // `${tracker}:${user}:${malId}` keys whose presence mismatch already kicked a
  // refresh this session. Never cleared: the key carries the account (#752).
  const presenceKicked = new Set<string>()

  function instance(id: TrackerId): Instance | null {
    return trackers.syncServices().find((t) => t.trackerId === id) ?? null
  }

  function userIdOf(id: TrackerId): number | undefined {
    return (store.get(TRACKER_KEYS[id].user) as { id: number } | null | undefined)?.id
  }

  function liveQueue(id: TrackerId): QueuedTrackerUpdate[] {
    return (store.get(TRACKER_KEYS[id].updateQueue) as QueuedTrackerUpdate[] | undefined) ?? []
  }

  function cachedRows(id: TrackerId): unknown[] {
    return (store.get(TRACKER_KEYS[id].userRates) as unknown[] | undefined) ?? []
  }

  function parked(id: TrackerId): ParkedQueues {
    return (store.get(TRACKER_KEYS[id].parkedQueues) as ParkedQueues | undefined) ?? {}
  }

  // The list is the whole list as of its last refresh, so a title missing from
  // a non-empty list has no rate; an empty list was never loaded, and the error
  // stands (#570).
  function fromCache(t: Instance, malId: number, err: unknown): unknown | null {
    const rows = cachedRows(t.trackerId)
    if (rows.length === 0) throw err
    return rows.find((r) => t.rateCache.malIdOf(r) === malId) ?? null
  }

  async function readRate(id: TrackerId, malId: number): Promise<RateRead | null> {
    const t = instance(id)
    if (!t) return null
    const userAtStart = userIdOf(id)
    if (isOffline()) {
      if (userAtStart === undefined) throw new Error(`Not logged in to ${TRACKER_LABELS[id]}`)
      return { stale: true, row: fromCache(t, malId, new OfflineError()) }
    }
    const before = t.cachedRate(malId)
    let entry: TrackerEntry<unknown> | null
    try {
      entry = await t.fetchEntry(malId)
    } catch (err) {
      // After an account switch the cache is the new account's list.
      if (!t.isQueueableError(err) || userIdOf(id) !== userAtStart) throw err
      return { stale: true, row: fromCache(t, malId, err) }
    }
    if (userAtStart !== undefined) settleLiveRead(t, malId, userAtStart, before, entry)
    return { stale: false, entry }
  }

  // #752: a live read lands in the cache, so the projection, `differs` and the
  // copy read what the panel shows. Every write that can trip the in-flight
  // check broadcasts `rate-updated` or `rates-refreshed`, and the store then
  // refetches a held title, so a stand-down heals on the next read.
  function settleLiveRead(
    t: Instance,
    malId: number,
    owner: number,
    before: CachedRate | null,
    entry: TrackerEntry<unknown> | null
  ): void {
    const id = t.trackerId
    const row = t.cachedRate(malId)
    if ((entry === null) !== (row === null) && userIdOf(id) === owner) {
      // A single read can't create a row or announce a removal: the list refresh does both.
      const key = `${id}:${owner}:${malId}`
      if (!presenceKicked.has(key)) {
        presenceKicked.add(key)
        refreshInBackground(id)
      }
    }
    if (!entry || !row) return
    // The row moved while the read was in flight: a drain, an enqueue or another read wrote it.
    if (!sameCachedRate(row, before)) return
    // A queued title's projection overlays the queue, and its drain settles the row itself.
    if (liveQueue(id).some((q) => q.malId === malId)) return
    // Equal values never patch: that is what ends the `rate-updated` → refetch chain.
    if (sameValues(row.values, entry.values)) return
    t.patchCachedRateFromRead(owner, malId, entry)
  }

  function refreshInBackground(id: TrackerId): void {
    const t = instance(id)
    if (!t || isOffline()) return
    t.refreshRates({ keepQueued: false })
      .then((result) => {
        if (!result) return
        const after = hooks.get(id)?.afterBackgroundRefresh
        if (after) after()
        else void t.syncQueue()
      })
      .catch((err) => log.warn(`[${id}] background refresh failed:`, err))
  }

  async function getRates(id: TrackerId, status?: RateValues['status']): Promise<unknown[] | null> {
    const t = instance(id)
    if (!t) return null
    if (!status) {
      const cached = cachedRows(id)
      if (cached.length > 0) {
        refreshInBackground(id)
        return cached
      }
    }
    // Null when the account changed while the list was in flight (#588).
    const result = await t.fetchAndCacheRates({ status })
    if (!result) return status ? [] : cachedRows(id)
    if (!status) hooks.get(id)?.afterFetch?.()
    return result.entries as unknown[]
  }

  function primaryEntries(): TrackerRateEntry<unknown>[] {
    const id = trackers.primary()
    const t = id ? instance(id) : null
    if (!id || !t) return []
    return cachedRows(id).map((row) => ({ ...t.rateCache.entryOf(row), native: row }))
  }

  function writeTarget(only?: TrackerId): TrackerId {
    return only ?? trackers.primary() ?? trackers.syncServices()[0]?.trackerId ?? 'shikimori'
  }

  async function updateRate<K extends TrackerId>(
    malId: number,
    values: RateValues,
    target: K,
    mirrors = true
  ): Promise<ApplyOutcome<PrimaryResults[K]>> {
    if (!instance(target)) throw new Error(`Not logged in to ${TRACKER_LABELS[target]}`)
    return trackers.applyChange(
      malId,
      { kind: 'set', values },
      mirrors ? { target, cause: 'user' } : { target, cause: 'user', mirrors: false }
    )
  }

  async function markEpisodeWatched<K extends TrackerId>(
    malId: number,
    epNum: number,
    target: K | null
  ): Promise<ApplyOutcome<PrimaryResults[K]> | null> {
    if (target === null || !instance(target)) return null
    return trackers.applyChange(
      malId,
      { kind: 'mark-watched', episode: epNum },
      { target, cause: 'user' }
    )
  }

  // The one evaluation point of the difference rule for the chips and the
  // copy, so the chip never offers a copy the handler then skips.
  function differsFromPrimary(id: TrackerId, malId: number, p: TrackerId | null): SyncRateField[] {
    if (p === null || p === id || !instance(p)) return []
    return rateDiff(
      { trackerId: p, values: trackers.projection(p, malId) },
      { trackerId: id, values: trackers.projection(id, malId) },
      storedAnilistScoreFormat(store)
    )
  }

  function titleSignals(id: TrackerId, malId: number): TitleSignals {
    const t = instance(id)
    const queued = liveQueue(id).some((q) => q.malId === malId)
    // The provider's `hasTitle` is false only for a fresh negative entry: a
    // cold map is mappable.
    const unmapped = t ? !t.hasTitle(malId) : false
    const differs = !t || unmapped ? [] : differsFromPrimary(id, malId, trackers.primary())
    return { queued, unmapped, differs }
  }

  async function copyFromPrimary(id: TrackerId, malId: number): Promise<RateValues | null> {
    const t = instance(id)
    if (!t || userIdOf(id) === undefined) throw new Error(`Not logged in to ${TRACKER_LABELS[id]}`)
    const p = trackers.primary()
    if (p === null) throw new Error('No tracker is the primary')
    if (p === id) throw new Error(`${TRACKER_LABELS[id]} is the primary`)
    if (!t.hasTitle(malId)) throw new Error(`This title is not on ${TRACKER_LABELS[id]}`)
    const source = trackers.projection(p, malId)
    // Copying "nothing" would be a delete, which only the reconcile offers.
    if (!source) throw new Error(`${TRACKER_LABELS[p]} has no entry for this title`)
    if (differsFromPrimary(id, malId, p).length > 0) {
      await trackers.applyChange(
        malId,
        { kind: 'set', values: rateValues(source) },
        { target: id, cause: 'user' }
      )
    }
    return trackers.projection(id, malId)
  }

  function getSyncStatus(id: TrackerId): TrackerStatus {
    const t = instance(id)
    if (t) return { ...t.getSyncStatus(), needsSetup: t.needsSetup() }
    return {
      state: 'idle',
      queueLength: liveQueue(id).length,
      lastSyncAt: 0,
      lastSyncError: null,
      sessionExpired: Boolean(store.get(TRACKER_KEYS[id].sessionExpired)),
      needsSetup: false
    }
  }

  function triggerSync(id?: TrackerId): void {
    if (id !== undefined) {
      // A signed-out instance returns at its drain's own guard.
      void instance(id)?.syncQueue()
      return
    }
    for (const t of trackers.syncServices()) {
      if (userIdOf(t.trackerId) !== undefined) void t.syncQueue()
    }
  }

  function getParkedQueues(id: TrackerId): ParkedBucketSummary[] {
    return Object.entries(parked(id)).map(([key, bucket]) => ({
      ownerId: key === UNKNOWN_OWNER ? null : key,
      nickname: bucket.nickname,
      count: bucket.entries.length,
      parkedAt: bucket.parkedAt
    }))
  }

  function discardParkedQueue(id: TrackerId, ownerId: string | null): void {
    const key = ownerId === null ? UNKNOWN_OWNER : ownerId
    store.set(TRACKER_KEYS[id].parkedQueues, takeParked(parked(id), key).parked)
  }

  return {
    instance,
    primary: () => trackers.primary(),
    primaryEntries,
    readRate,
    getRates,
    refreshInBackground,
    queuedAfter: (id) => queuedAfterOf(liveQueue(id)),
    writeTarget,
    updateRate,
    markEpisodeWatched,
    titleSignals,
    copyFromPrimary,
    getSyncStatus,
    getOfflineQueueLength: (id) => liveQueue(id).length,
    triggerSync,
    getParkedQueues,
    discardParkedQueue,
    setRefreshHooks: (id, h) => void hooks.set(id, h)
  }
}
