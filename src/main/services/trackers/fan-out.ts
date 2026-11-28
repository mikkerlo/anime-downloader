// The fan-out writer (#692, epic #688): every list change goes through
// `applyChange(malId, change, { target, cause })`. A user change to the
// primary takes that tracker's own primary branch (Shikimori: today's path,
// `shikimori-primary.ts`), and once it returned a write, every other connected
// tracker with its mirror toggle on gets a field-scoped `via: 'mirror'` entry
// built from that tracker's own projection. `docs/trackers.md` § The fan-out
// writer describes the rules.

import {
  RATE_FIELDS,
  intendedFields,
  revertAndRebase,
  type QueuedTrackerUpdate,
  type QueueVia,
  type StripSlot
} from '../../lib/shikimori-queue'
import {
  NO_RATE_BEFORE,
  nextWatchedRate,
  rateValues,
  type RateValues
} from '../../lib/shikimori-rate'
import { rateClockKey, stampRateClocks } from '../../store/sync-meta'
import type { StorageService } from '../../store/types'
import type { ShikiUserRate } from '../../shikimori'
import { resolvePrimary } from '../../trackers/primary'
import { TRACKER_LABELS } from '../../trackers/types'
import type { TrackerSyncService } from './sync'

/**
 * Why a change is written. Named `cause`, not `origin`, so it can't be read
 * as the queue entry's persisted `origin` field.
 */
export type ChangeCause = 'user' | 'merge' | 'mirror' | 'reconcile'

export type RateChange =
  | {
      kind: 'set'
      values: RateValues
      /** `'mirror'` / `'reconcile'` only: the fields of `values` to write. */
      fields?: readonly SyncRateField[]
      /** `'mirror'` only: a merge mirror's carried provenance (#716). */
      origin?: QueuedTrackerUpdate['origin']
    }
  | { kind: 'mark-watched'; episode: number }

/**
 * What a primary branch wrote: its own return value, the rate the change was
 * made against (the live rate when sent, the cached entry when queued), and
 * the rate it wrote.
 */
export interface PrimaryWrite<T = unknown> {
  result: T
  basis: RateValues
  after: RateValues
}

/** A tracker's primary branch: a write, null when there was nothing to write; throws on a refusal. */
export type PrimaryWriter<T = unknown> = (
  malId: number,
  change: RateChange
) => Promise<PrimaryWrite<T> | null>

/**
 * What each tracker's primary branch returns: Shikimori's is the rate its
 * handlers reply with; AniList's (#703) is the values it queued. MAL's is typed by T6.
 */
export interface PrimaryResults {
  shikimori: ShikiUserRate
  anilist: RateValues
  mal: unknown
}

/**
 * What `applyChange` did: the primary branch ran (`result` null when it wrote
 * nothing; `after`, the values it wrote or queued, when it wrote), or the change
 * was queued only (`entry` null when nothing differed).
 */
export type ApplyOutcome<T = unknown> =
  | { kind: 'primary'; result: T | null; after?: RateValues }
  | { kind: 'queued'; entry: QueuedTrackerUpdate | null }

export interface FanOutTracker {
  sync: TrackerSyncService<unknown, unknown>
  /** Set here or later through `setPrimaryWriter` (Shikimori's router sets its own). */
  writePrimary?: PrimaryWriter
}

export interface TrackerFanOutDeps {
  store: StorageService
  trackers: FanOutTracker[]
  /**
   * The primary, read at call time. `index.ts` passes `trackerLifecycle.primary`,
   * so the accounts state and the writes share one answer (#696 § 0). Defaults
   * to the same rule, `resolvePrimary`, over `store`.
   */
  primary?: () => TrackerId | null
  now?: () => number
  log?: Pick<Console, 'warn'>
}

export interface TrackerFanOut {
  /**
   * Writes one change. A `'user'` change to the primary runs the primary
   * branch (`kind: 'primary'`); every other change is queued only
   * (`kind: 'queued'`). A caller replying to a request owns the reply's shape
   * for both kinds. `mirrors: false` writes the primary alone, with no fan-out
   * (#694's `tracker:update-rate` with `only`).
   */
  applyChange<K extends TrackerId>(
    malId: number,
    change: RateChange,
    opts: { target: K; cause: ChangeCause; mirrors?: boolean }
  ): Promise<ApplyOutcome<PrimaryResults[K]>>
  setPrimaryWriter<K extends TrackerId>(
    trackerId: K,
    writer: PrimaryWriter<PrimaryResults[K]>
  ): void
  /** Whether a primary writer is set for the tracker: `applyChange` throws for a primary without one. */
  hasPrimaryWriter(trackerId: TrackerId): boolean
  /** The primary (#696 § 0): `deps.primary`, else `resolvePrimary` over the store. */
  primary(): TrackerId | null
  /**
   * Mirror toggle off (T3c, T5b call it after the user confirms): drops every
   * live `via: 'mirror'` entry of that tracker, reverts their fields in its
   * cache locally and rebases the later `via` survivors. Returns the count.
   */
  discardQueue(trackerId: TrackerId): Promise<number>
  /** The live `via: 'mirror'` entries of that tracker: T3c's "N changes won't be sent". */
  mirrorQueueCount(trackerId: TrackerId): number
  /**
   * That tracker's own view of a title (§ 3): its cached row with its live
   * queue laid over it, the values every builder here diffs against. Null
   * with no row, cached or queued. #705's `differs` and its copy read it.
   */
  projection(trackerId: TrackerId, malId: number): RateValues | null
  /** Every tracker's sync instance, in `shikimori`, `anilist`, `mal` order. */
  syncServices(): TrackerSyncService<unknown, unknown>[]
}

const ORDER: readonly TrackerId[] = ['shikimori', 'anilist', 'mal']

type Values = Record<SyncRateField, number | string>

export function createTrackerFanOut(deps: TrackerFanOutDeps): TrackerFanOut {
  const { store } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const trackers = [...deps.trackers].sort(
    (a, b) => ORDER.indexOf(a.sync.trackerId) - ORDER.indexOf(b.sync.trackerId)
  )
  const writers = new Map<TrackerId, PrimaryWriter>()
  for (const t of trackers) if (t.writePrimary) writers.set(t.sync.trackerId, t.writePrimary)

  function byId(id: TrackerId): TrackerSyncService<unknown, unknown> {
    const t = trackers.find((x) => x.sync.trackerId === id)
    if (!t) throw new Error(`No ${TRACKER_LABELS[id]} sync service`)
    return t.sync
  }

  function userId(t: TrackerSyncService<unknown, unknown>): number | undefined {
    return (store.get(t.keys.user) as { id: number } | null | undefined)?.id
  }

  const connected = (t: TrackerSyncService<unknown, unknown>): boolean => userId(t) !== undefined

  const primary = deps.primary ?? ((): TrackerId | null => resolvePrimary(store))

  // A missing entry means on.
  function mirrorOn(id: TrackerId): boolean {
    const toggles = store.get('trackerMirror') as Partial<Record<TrackerId, boolean>> | undefined
    return toggles?.[id] !== false
  }

  function liveQueue(t: TrackerSyncService<unknown, unknown>): QueuedTrackerUpdate[] {
    return (store.get(t.keys.updateQueue) as QueuedTrackerUpdate[] | undefined) ?? []
  }

  /**
   * The tracker's own view of a title (§ 3): its cached row with each live
   * queued entry laid over it in queue order, each entry's `intendedFields`
   * only. Null when it has no row, cached or queued. A title that is only
   * queued starts from the first entry's `before`.
   */
  function projection(
    t: TrackerSyncService<unknown, unknown>,
    malId: number
  ): { rateId: number | null; values: RateValues } | null {
    const cached = t.cachedRate(malId)
    const queued = liveQueue(t).filter((q) => q.malId === malId)
    if (!cached && queued.length === 0) return null
    const values = { ...(cached ? cached.values : rateValues(queued[0].before)) } as Values
    for (const q of queued) {
      for (const f of intendedFields(q))
        values[f] = f === 'rewatches' ? (q.after[f] ?? 0) : q.after[f]
    }
    const rateId = cached?.remoteId ?? queued.find((q) => q.rateId !== null)?.rateId ?? null
    return { rateId, values: values as unknown as RateValues }
  }

  // Over the whole queue, as the conflict resolution does
  // (`sync-runner/index.ts`): the drain's drop match can't tell two same-`via`
  // entries for one title apart.
  function queuedAtFor(t: TrackerSyncService<unknown, unknown>): number {
    return Math.max(now(), ...liveQueue(t).map((q) => q.queuedAt + 1))
  }

  /**
   * Appends one entry and patches the cached row in the same synchronous step
   * (`enqueue`), stamps the clock for a user change, then starts the timer and
   * kicks the drain. Never sent live.
   */
  function queueEntry(
    t: TrackerSyncService<unknown, unknown>,
    malId: number,
    rateId: number | null,
    before: RateValues,
    after: RateValues,
    fields: SyncRateField[],
    via: QueueVia,
    opts: { stamp: boolean; origin?: QueuedTrackerUpdate['origin'] }
  ): QueuedTrackerUpdate {
    const entry: QueuedTrackerUpdate = {
      malId,
      rateId,
      before,
      after,
      queuedAt: queuedAtFor(t),
      fields,
      ...(opts.origin ? { origin: opts.origin } : {}),
      via
    }
    t.enqueue(entry)
    const owner = userId(t)
    if (opts.stamp && owner !== undefined) {
      stampRateClocks(store, rateClockKey(t.trackerId, owner, malId), before, after)
    }
    t.startSyncTimer()
    void t.syncQueue()
    return entry
  }

  /**
   * The builder for a change diffed against the target's own projection
   * (§ 3a, and `'mirror'` / `'reconcile'`): `fields` are those where `values`
   * differ from it, and with no row every allowed field (the create branch).
   */
  function queueDiffed(
    t: TrackerSyncService<unknown, unknown>,
    malId: number,
    change: Extract<RateChange, { kind: 'set' }>,
    via: QueueVia,
    stamp: boolean
  ): QueuedTrackerUpdate | null {
    if (!t.hasTitle(malId)) return null
    const proj = projection(t, malId)
    const before = proj ? proj.values : { ...NO_RATE_BEFORE }
    const allowed = RATE_FIELDS.filter((f) => !change.fields || change.fields.includes(f))
    const fields = proj ? allowed.filter((f) => change.values[f] !== before[f]) : allowed
    if (fields.length === 0) return null
    const after = { ...before } as unknown as Values
    for (const f of fields) after[f] = change.values[f]
    return queueEntry(
      t,
      malId,
      proj?.rateId ?? null,
      before,
      after as unknown as RateValues,
      fields,
      via,
      {
        stamp,
        ...(via === 'mirror' && change.origin ? { origin: change.origin } : {})
      }
    )
  }

  /** § 1-3: the user's change on every enabled mirror, once the primary wrote. */
  function fanOut(
    primaryId: TrackerId,
    malId: number,
    change: RateChange,
    wrote: PrimaryWrite
  ): void {
    for (const { sync: m } of trackers) {
      if (m.trackerId === primaryId) continue
      try {
        // Read here, after every await: a toggle switched off while the
        // primary's request was in flight gets no entry.
        if (!connected(m) || !mirrorOn(m.trackerId) || !m.hasTitle(malId)) continue
        const proj = projection(m, malId)
        let before: RateValues
        let after: RateValues
        let fields: SyncRateField[]
        if (change.kind === 'set') {
          if (!proj) {
            // The create rule: the primary's four post-change values.
            before = { ...NO_RATE_BEFORE }
            after = { ...wrote.after }
            fields = [...RATE_FIELDS]
          } else {
            before = proj.values
            const changed = RATE_FIELDS.filter((f) => wrote.after[f] !== wrote.basis[f])
            fields = changed.filter((f) => wrote.after[f] !== before[f])
            const v = { ...before } as unknown as Values
            for (const f of fields) v[f] = wrote.after[f]
            after = v as unknown as RateValues
          }
        } else {
          before = proj ? proj.values : { ...NO_RATE_BEFORE }
          const next = nextWatchedRate(before, change.episode)
          if (!next) continue
          after = next
          fields = RATE_FIELDS.filter((f) => after[f] !== before[f])
        }
        if (fields.length === 0) continue
        queueEntry(m, malId, proj?.rateId ?? null, before, after, fields, 'mirror', { stamp: true })
      } catch (err) {
        log.warn(`[fan-out] could not queue the ${m.trackerId} mirror of`, malId, err)
      }
    }
  }

  async function applyChange<K extends TrackerId>(
    malId: number,
    change: RateChange,
    opts: { target: K; cause: ChangeCause; mirrors?: boolean }
  ): Promise<ApplyOutcome<PrimaryResults[K]>> {
    const target = byId(opts.target)
    if (opts.cause === 'merge') {
      // The merge leg and the conflict resolution keep writing through
      // `mergeQueues` (§ 5); nothing routes a merge through here.
      throw new Error('A merge write goes through the merge leg, not applyChange')
    }
    if (opts.cause === 'user') {
      const p = primary()
      if (connected(target) && p !== opts.target) {
        // § 3a: queued to that tracker only, never live, no fan-out.
        if (change.kind !== 'set') return { kind: 'queued', entry: null }
        const entry = queueDiffed(
          target,
          malId,
          { kind: 'set', values: change.values },
          'copy',
          true
        )
        return { kind: 'queued', entry }
      }
      const writer = writers.get(opts.target)
      if (!writer) throw new Error(`${TRACKER_LABELS[opts.target]} has no primary write path`)
      const wrote = await writer(malId, change)
      if (!wrote) return { kind: 'primary', result: null }
      if (opts.mirrors !== false) fanOut(opts.target, malId, change, wrote)
      // `setPrimaryWriter` types each tracker's writer by `PrimaryResults`.
      return { kind: 'primary', result: wrote.result as PrimaryResults[K], after: wrote.after }
    }
    if (change.kind !== 'set') throw new Error(`A ${opts.cause} change is a set`)
    return { kind: 'queued', entry: queueDiffed(target, malId, change, opts.cause, false) }
  }

  async function discardQueue(trackerId: TrackerId): Promise<number> {
    const t = byId(trackerId)
    return t.withQueueLock(() => {
      const queue = liveQueue(t)
      const slots: StripSlot[] = queue.map((entry) =>
        entry.via === 'mirror'
          ? { entry, next: null, stripped: intendedFields(entry) }
          : { entry, next: entry, stripped: [] }
      )
      const dropped = slots.filter((s) => s.next === null).length
      if (dropped === 0) return 0
      const { queue: next, reverts } = revertAndRebase(slots, {
        cache: (malId) => (t.cachedRate(malId)?.values as unknown as Values | undefined) ?? null,
        revertCache: () => true
      })
      store.set(t.keys.updateQueue, next)
      const owner = userId(t)
      for (const [malId, fields] of reverts) {
        const cached = t.cachedRate(malId)
        if (!cached || owner === undefined) continue
        t.patchCachedRate(owner, malId, { ...cached.values, ...fields } as RateValues)
      }
      t.broadcastQueueChanged()
      t.adjustSyncTimer()
      return dropped
    })
  }

  return {
    applyChange,
    setPrimaryWriter: (id, writer) => void writers.set(id, writer as PrimaryWriter),
    hasPrimaryWriter: (id) => writers.has(id),
    primary,
    discardQueue,
    mirrorQueueCount: (id) => liveQueue(byId(id)).filter((q) => q.via === 'mirror').length,
    projection: (id, malId) => projection(byId(id), malId)?.values ?? null,
    syncServices: () => trackers.map((t) => t.sync)
  }
}
