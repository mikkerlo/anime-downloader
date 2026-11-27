// The Shared Library merge runner (#584, epic #563): local ↔ library first,
// then the result ↔ the owner's tracker. The only writer of state to a drive.
//
// - The library leg runs per available owned or claimed library: read the pair
//   (S5), load the base, the rollback check, `merge3`, the owner-decision-5
//   raise, apply locally (S4's `applySyncDoc`, rates into the pending store),
//   write the drive (S5's `writeState`), and only then store the new base.
// - The tracker leg runs per owner on the owner's tracker (#715), logged in as
//   that owner and online, after that tracker's drain: one list read, path F,
//   `merge3` against that tracker's base, and field-scoped queue entries for
//   what the tracker lacks. Shikimori's is the leg it always was: the same
//   read, the same files, `mergeQueues` into `shikimoriUpdateQueue`.
// - Libraries that are foreign, videos only or read-only are never written.
// - Runs are single-flight per library (a second caller joins); every leg,
//   the settle listener and Forget's own steps run one at a time.
//
// Owners are `(provider, userId)` (#715). Shikimori keeps numbers in every
// file it persists (`<id>.json`, `conflicts.json`'s `ownerScope`,
// `shikimori-<id>`); another tracker uses its string `userId` there. Ids are
// compared through the owner key, never with `===` on raw ids.

import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import * as shikimoriApi from '../../shikimori'
import { isNetworkError } from '../../lib/errors'
import { createMutex } from '../../lib/async-mutex'
import { inspectLibrary, readMeta } from '../../lib/shared-library/read'
import { isTrackerOwner, ownerKey, ownerOf, sameOwnerKey } from '../../lib/shared-library/owner'
import { writeState as defaultWriteState } from '../../lib/shared-library/write'
import { toAnimeSearchResult } from '../../lib/shared-library/format'
import { createSyncBaseStore, type SyncBase } from '../../lib/sync-state/bases'
import { applySyncDoc } from '../../lib/sync-state/apply'
import { FIELD_TABLE, sameValue, type SkipContext } from '../../lib/sync-state/field-table'
import { pruneDocTombstones } from '../../lib/sync-state/gc'
import {
  RATE_FIELDS,
  SHIKIMORI_ORIGIN,
  defaultMalIdOf,
  projectRate,
  projectSyncDoc,
  type RateTracker
} from '../../lib/sync-state/project'
import type { EpisodeFileIdentity } from '../../lib/sync-state/skip'
import { merge3 } from '../../lib/sync-merge/merge3'
import { normalizeDoc, ratesOnly, trackerNoBase } from '../../lib/sync-merge/no-base'
import { isRollback, rollbackAdjust } from '../../lib/sync-merge/rollback'
import { computeRaise, type WatchFlip } from '../../lib/sync-merge/raise'
import { reconcileLeg, sameScope, type LegConflict } from '../../lib/sync-merge/conflicts'
import {
  choiceName,
  choiceValue,
  conflictOptions,
  episodeOf,
  fieldOf,
  rewatchQuestionBase
} from '../../lib/sync-merge/resolve'
import { NO_RATE_BEFORE, rateValues, type RateValues } from '../../lib/shikimori-rate'
import {
  mergeQueues,
  revertAndRebase,
  stripFieldSlots,
  type ParkedQueues,
  type QueuedShikimoriUpdate
} from '../../lib/shikimori-queue'
import type { CachedRateEntry } from '../../lib/shikimori-rate-cache'
import type { StorageService } from '../../store/types'
import type { AttachedLibraryService } from '../attached-library'
import type { ShikimoriSyncService } from '../shikimori-sync'
import type { TrackerItemSettled, TrackerSyncService } from '../trackers/sync'
import { SHIKIMORI_KEYS, TRACKER_KEYS, type TrackerStoreKeys } from '../../trackers/keys'
import { TRACKER_LABELS, type TrackerProvider } from '../../trackers/types'
import { buildActor } from './actor'
import { createConflictStore } from './conflicts'
import {
  createSyncLog,
  LOG_MAX_DETAILS,
  REWATCH_SUPERSEDED_REASON,
  type SyncLog,
  type SyncLogDetail
} from './log'
import { listHistory, valueAt, type HistoryNames } from './history'
import {
  cacheEntry,
  createPendingStore,
  overlay,
  parseAt,
  type PendingField,
  type PendingOwner,
  type PendingRates
} from './pending'
import { createForgetHook } from './forget'

/** One tracker's queues, as Forget and `stripQueued` reach them (#692 § 6). */
export type RunnerTracker = Pick<
  TrackerSyncService<unknown, unknown>,
  'trackerId' | 'keys' | 'withQueueLock' | 'broadcastQueueChanged'
>

/**
 * A non-Shikimori tracker whose owners' libraries merge with it (#715): its
 * sync instance (queue, drain, settles, cache codec, refresh) and its
 * provider (the session and the one list read a leg makes).
 */
export interface RunnerLegTracker {
  sync: Pick<
    TrackerSyncService<unknown, unknown>,
    | 'trackerId'
    | 'keys'
    | 'rateCache'
    | 'drainNow'
    | 'syncQueue'
    | 'startSyncTimer'
    | 'onItemSettled'
    | 'refreshRates'
    | 'patchCachedRate'
    | 'broadcastQueueChanged'
    | 'hasTitle'
  >
  provider: Pick<
    TrackerProvider<{ userId: number }, unknown>,
    'auth' | 'listEntries' | 'classifyError'
  >
}

const READ_ONLY_CODES = new Set(['EROFS', 'EACCES', 'EPERM'])
export const DROPS_TO_CONFLICT = 3

export interface SyncRunnerDeps {
  store: StorageService
  userDataDir: string
  attached: Pick<
    AttachedLibraryService,
    | 'list'
    | 'get'
    | 'refresh'
    | 'reportWriteFailure'
    | 'markSynced'
    | 'registerForgetHook'
    | 'onAvailabilityChanged'
  >
  sync: Pick<
    ShikimoriSyncService,
    'drainNow' | 'withQueueLock' | 'onItemSettled' | 'syncShikimoriQueue' | 'startSyncTimer'
  >
  /**
   * Every tracker whose queues `stripQueued` and Forget strip, each under its
   * own `withQueueLock` (#692 § 6). Defaults to Shikimori's alone, through
   * `sync.withQueueLock`.
   */
  trackers?: RunnerTracker[]
  /** The non-Shikimori trackers a library owner's leg can run on (#715). */
  legs?: RunnerLegTracker[]
  isOffline(): boolean
  /** The online edge (S1a's `OFFLINE_STATE_CHANGED → online`). Returns an unsubscribe. */
  onOnline?(listener: () => void): () => void
  broadcast(channel: string, ...args: unknown[]): void
  /** `EVENT_CHANNELS.SYNC_RUN_FINISHED`, passed in by `index.ts` like the other services' channels. */
  runFinishedChannel?: string
  appVersion: string
  now?: () => number
  api?: Pick<typeof shikimoriApi, 'ensureFreshToken' | 'getUserAnimeRates'>
  /** This PC's file for an episode, which a drive skip entry must match (rule 12). */
  localEpisodeFile?(
    animeId: string,
    episodeInt: string
  ): { filePath: string; translationId: number; fileSize: number } | null
  resolveEpisodeFile?(
    animeId: string,
    episodeInt: string,
    filePath: string
  ): EpisodeFileIdentity | null
  skipAlgorithm?: ShowSkipDetections['algorithm']
  writeState?: typeof defaultWriteState
  /** Shikimori's background rate refresh, when a reverted field has nothing to revert to. */
  refreshRates?(): void
  makeId?: () => string
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface SyncRunner {
  runAll(trigger: SyncTrigger): Promise<SyncRunResult>
  runLibrary(libraryId: string, trigger: SyncTrigger): Promise<SyncRunResult>
  runTitle(animeId: number, trigger: SyncTrigger): Promise<SyncRunResult>
  /**
   * S6e's (#586) state step for a With metadata export into `target`, attached
   * here or not: the library leg as this PC's owner, writing the drive even
   * when nothing changed, so the job always ends with a state and its base.
   */
  runExport(target: { libraryId: string; root: string; name: string }): Promise<SyncLibraryResult>
  /** Resolves once no run of `libraryId` is in flight (S7c's `syncIdle`). */
  idle(libraryId: string): Promise<void>
  status(): Promise<SyncStatus>
  /** Resolves once every leg, settle and Forget step queued so far has run. */
  quiesce(): Promise<void>
  /**
   * Subscribes to the drains' settles and Forget, and with `triggers` (the
   * default) to availability and the online edge.
   */
  start(opts?: { triggers?: boolean }): void
  stop(): void
  /**
   * The held conflicts of every tracker's file, with what the review sheet
   * shows (#585). An unreadable file lists as none, or, with `strict`, rejects.
   */
  listConflicts(opts?: { strict?: boolean }): Promise<SyncConflictItem[]>
  /**
   * Review-sheet choices as forward edits (#585): this PC, every connected
   * writable library of the record's owner holding the title, and the owner's
   * tracker through its queue with `resolvedFields`. Each party's base
   * advances only once the value is there.
   */
  resolve(
    conflictIds: string[],
    choices: Record<string, SyncConflictChoice>
  ): Promise<SyncResolveResult>
  /** One page of the read-only history, newest first. */
  listHistory(req: SyncHistoryRequest): Promise<SyncHistoryPage>
  readonly syncLog: SyncLog
}

export const DEFAULT_SKIP_ALGORITHM: ShowSkipDetections['algorithm'] = {
  source: 'local',
  sampleRate: 11025,
  matchBitThreshold: 6,
  minRunSec: 18,
  windowSec: 6,
  refineBitThreshold: 4,
  refineSustainHashes: 5
}

type Outcome = Pick<SyncLibraryResult, 'drive' | 'driveReason' | 'counts'> & {
  changes: string[]
  details?: SyncLogDetail[]
  conflicts: { animeId: string; fieldPath: string; reason: string }[]
  clamps: { path: string; at: number; clampedTo: number }[]
  raises: {
    libraryId: string
    animeId: string
    malId: number
    kind: string
    episodes: number
    from?: number
    tracker?: TrackerId
  }[]
  resolvedElsewhere: { animeId: string; fieldPath: string }[]
}

interface LegOutcome {
  status: SyncLegStatus
  reason?: SyncLegReason
  waitingMalIds: number[]
  rewatchesSuperseded: number
  counts: { applied: number; conflicts: number }
  details?: SyncLogDetail[]
  conflicts: { animeId: string; fieldPath: string; reason: string }[]
  resolvedElsewhere: { animeId: string; fieldPath: string }[]
}

/** A pending file's, a conflict record's and a leg's owner (#715). */
type Owner = PendingOwner

/**
 * The owner tracker as the runner reads and writes it (#715). Shikimori's
 * keeps its own reads (`shikimoriUserRates` rows, `getUserAnimeRates`); another
 * tracker's go through its sync instance's codec and its provider.
 */
interface Side {
  id: TrackerId
  label: string
  keys: TrackerStoreKeys
  /** Its sync instance and provider; absent for Shikimori, and for a tracker not wired here. */
  leg?: RunnerLegTracker
  /** The projection's reader; absent for Shikimori (the projection's default). */
  rate?: RateTracker
  /** The reason a held rejection carries, and the held-rejection filter's key. */
  rejectedReason: string
  user(): number | null
}

/** A cached rate as the runner reads it, whatever the tracker. */
interface CachedRate {
  remoteId: number | null
  field(f: SyncRateField): number | string | undefined
  serverUpdatedAt: string | null
  smotretId?: number
}

/** A tracker leg's list row, normalized. */
interface LegRow {
  malId: number
  remoteId: number | null
  values: RateValues
  updatedAt: string | null
}

const emptyCounts = (): SyncLibraryResult['counts'] => ({ applied: 0, conflicts: 0, clamped: 0 })

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

const WATCHED_PATH = /^titles\.([^.]+)\.watch\.(.+)\.watched$/

/**
 * The projection's reader for a tracker not wired here (#715): no row is ever
 * its, so a claim PC's projection has no rate, as with no session.
 */
const noRates = (side: Pick<Side, 'id' | 'keys'>): RateTracker => ({
  id: side.id,
  keys: side.keys,
  entryOf: () => ({
    malId: Number.NaN,
    remoteId: null,
    values: { episodes: 0, status: '', score: 0, rewatches: 0 },
    updatedAt: null,
    smotretAnime: null
  })
})

const isTrackerId = (p: string | null | undefined): p is TrackerId =>
  p === 'shikimori' || p === 'anilist' || p === 'mal'

/** A conflict record's or a pending body's owner id: Shikimori's a number (#715). */
const scopeOf = (o: Owner): number | string =>
  o.provider === 'shikimori' ? Number(o.userId) : o.userId

/** What a tracker's error class means to a leg (#715): `config` is "Needs setup". */
function legReasonOf(c: TrackerErrorClass): SyncLegReason {
  if (c === 'auth' || c === 'network' || c === 'config') return c
  return 'api'
}

export function rejectedReasonOf(tracker: TrackerId): string {
  return tracker === 'shikimori'
    ? REJECTED_REASON
    : `${TRACKER_LABELS[tracker]} rejected this change`
}

/**
 * The derived leg the renderer reads (#715): Shikimori's from `shikimori*`,
 * another tracker's from `tracker`. Never written to the log.
 */
export function withLeg(r: SyncLibraryResult): SyncLibraryResult {
  const leg: SyncLeg = r.tracker
    ? {
        tracker: r.tracker.id,
        status: r.tracker.status,
        ...(r.tracker.reason ? { reason: r.tracker.reason } : {})
      }
    : {
        tracker: 'shikimori',
        status: r.shikimori,
        ...(r.shikimoriReason ? { reason: r.shikimoriReason } : {})
      }
  return { ...r, leg }
}

const withLegs = (result: SyncRunResult): SyncRunResult => ({
  ...result,
  libraries: result.libraries.map(withLeg)
})

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  const { store, attached } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const api = deps.api ?? shikimoriApi
  const writeState = deps.writeState ?? defaultWriteState
  const makeId = deps.makeId ?? randomUUID
  const bases = createSyncBaseStore(path.join(deps.userDataDir, 'sync-bases'), fs.promises)
  const pending = createPendingStore(path.join(deps.userDataDir, 'sync-pending'))
  const conflictStore = createConflictStore(path.join(deps.userDataDir, 'sync-state'))
  const syncLog = createSyncLog(path.join(deps.userDataDir, 'sync-log'))
  const work = createMutex()
  const inflight = new Map<string, Promise<SyncLibraryResult>>()
  const lastResults = new Map<string, SyncLibraryResult>()
  const unsubscribe: (() => void)[] = []
  const trackers: RunnerTracker[] = deps.trackers ?? [
    {
      trackerId: 'shikimori',
      keys: SHIKIMORI_KEYS,
      withQueueLock: (fn) => deps.sync.withQueueLock(fn),
      broadcastQueueChanged: () =>
        deps.broadcast(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, {
          length: (store.get<unknown[] | undefined>('shikimoriUpdateQueue') ?? []).length
        })
    }
  ]

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = await work.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  // --- the owner trackers (#715) ---------------------------------------------------------------

  const sides = new Map<TrackerId, Side>()
  const userOf = (keys: TrackerStoreKeys) => (): number | null =>
    store.get<{ id?: number } | null>(keys.user)?.id ?? null
  sides.set('shikimori', {
    id: 'shikimori',
    label: TRACKER_LABELS.shikimori,
    keys: SHIKIMORI_KEYS,
    rejectedReason: REJECTED_REASON,
    user: userOf(SHIKIMORI_KEYS)
  })
  for (const id of ['anilist', 'mal'] as const) {
    const leg = deps.legs?.find((l) => l.sync.trackerId === id)
    const keys = leg?.sync.keys ?? TRACKER_KEYS[id]
    sides.set(id, {
      id,
      label: TRACKER_LABELS[id],
      keys,
      ...(leg
        ? {
            leg,
            rate: {
              id,
              keys,
              entryOf: (row) => leg.sync.rateCache.entryOf(row as never)
            } satisfies RateTracker
          }
        : {}),
      rejectedReason: rejectedReasonOf(id),
      user: userOf(keys)
    })
  }
  const shikiSide = sides.get('shikimori')!
  /** The side of a provider string from a drive or a record; null for one the app doesn't know. */
  const sideOf = (provider: string | null | undefined): Side | null =>
    isTrackerId(provider) ? sides.get(provider)! : null
  /** Every wired tracker's projection reader: the `defaultMalIdOf` union (§6). */
  const rateTrackers = (): RateTracker[] =>
    [...sides.values()].flatMap((s) => (s.rate ? [s.rate] : []))
  const malIdOfUnion = () => defaultMalIdOf(store, rateTrackers())
  /** Whether this PC is signed in to the owner's tracker as the owner, by owner key. */
  const signedInAs = (side: Side, owner: Owner): boolean => {
    const u = side.user()
    return u !== null && sameOwnerKey({ provider: side.id, userId: String(u) }, owner)
  }

  function cachedRate(side: Side, ownerId: number, malId: number): CachedRate | null | undefined {
    if (side.id === 'shikimori') {
      const c = cacheEntry(store, ownerId, malId)
      if (!c) return null
      if (c.idx === -1) return undefined
      const rate = c.entries[c.idx].rate
      return {
        remoteId: rate.id ?? null,
        field: (f) => rate[f] as number | string | undefined,
        serverUpdatedAt: rate.serverUpdatedAt ?? null,
        smotretId: (c.entries[c.idx].smotretAnime as { id?: number } | null)?.id
      }
    }
    if (side.user() !== ownerId || !side.leg) return null
    const codec = side.leg.sync.rateCache
    const row = (store.get<unknown[] | undefined>(side.keys.userRates) ?? []).find(
      (r) => codec.malIdOf(r as never) === malId
    )
    if (row === undefined) return undefined
    const e = codec.entryOf(row as never)
    return {
      remoteId: e.remoteId,
      field: (f) => e.values[f],
      serverUpdatedAt: e.updatedAt !== null ? new Date(e.updatedAt).toISOString() : null,
      smotretId: e.smotretAnime?.id
    }
  }

  /**
   * Whether the cache moved past a pending field's patch: Shikimori's
   * `serverUpdatedAt` is newer than the patch's. Another tracker's patch moves
   * the row's only time, so a cache showing a value other than the pending one
   * is what a refresh (or a newer edit) left there (#715).
   */
  function newerThanPatch(
    side: Side,
    c: CachedRate,
    p: PendingField,
    field: SyncRateField
  ): boolean {
    if (side.id === 'shikimori') {
      return parseAt(c.serverUpdatedAt) > parseAt(p.prePatch.serverUpdatedAt)
    }
    return !sameValue(c.field(field), p.value)
  }

  function broadcastQueue(side: Side, length: number): void {
    if (side.id === 'shikimori') {
      deps.broadcast(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, { length })
    } else side.leg?.sync.broadcastQueueChanged()
  }

  /** The tracker's timer and one drain, as after any queue write. */
  function kick(side: Side): void {
    if (side.id === 'shikimori') {
      deps.sync.startSyncTimer()
      void deps.sync.syncShikimoriQueue()
      return
    }
    side.leg?.sync.startSyncTimer()
    void side.leg?.sync.syncQueue()
  }

  function refreshRates(side: Side): void {
    if (side.id === 'shikimori') deps.refreshRates?.()
    else
      void side.leg?.sync
        .refreshRates({ keepQueued: false })
        .catch((err) => log.warn(`[sync] the ${side.label} rate refresh failed:`, err))
  }

  // --- the rate cache, the pending store's display side --------------------------------

  function patchCache(
    side: Side,
    ownerId: number,
    malId: number,
    values: Partial<Record<SyncRateField, number | string>>,
    serverUpdatedAt?: string
  ): void {
    if (side.id === 'shikimori') {
      const c = cacheEntry(store, ownerId, malId)
      if (!c || c.idx === -1 || Object.keys(values).length === 0) return
      const e = c.entries[c.idx]
      const rate = {
        ...e.rate,
        ...values,
        updated_at: new Date(now()).toISOString(),
        ...(serverUpdatedAt ? { serverUpdatedAt } : {})
      } as CachedRateEntry['rate']
      c.entries[c.idx] = { ...e, rate }
      store.set('shikimoriUserRates', c.entries)
      deps.broadcast(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED, c.entries[c.idx])
      return
    }
    // Through the instance's own patch: its cache write and `tracker:rate-updated`.
    const c = cachedRate(side, ownerId, malId)
    if (!c || Object.keys(values).length === 0) return
    const full = rateValues({
      episodes: (values.episodes ?? c.field('episodes') ?? 0) as number,
      status: (values.status ?? c.field('status') ?? 'planned') as RateValues['status'],
      score: (values.score ?? c.field('score') ?? 0) as number,
      rewatches: (values.rewatches ?? c.field('rewatches') ?? 0) as number
    })
    side.leg?.sync.patchCachedRate(ownerId, malId, full)
  }

  /**
   * One rule for dropping a pending field (Forget, and every other drop but
   * path F): a wholesale refresh newer than the patch is kept; otherwise the
   * newer of `prePatch` and the owner tracker's base; with neither, a refresh.
   * In Forget's revert a field a later surviving `via` entry carries is kept
   * too (#692 § 6): that entry's enqueue patch is the cache's newer value.
   */
  function revertTarget(
    side: Side,
    ownerId: number,
    malId: number,
    field: SyncRateField,
    p: PendingField,
    trackerBase: SyncBase | null,
    keep?: ReadonlySet<string>
  ): { value: number | string } | 'keep' | 'refresh' {
    if (keep?.has(`${malId}:${field}`)) return 'keep'
    const cached = cachedRate(side, ownerId, malId)
    if (cached && newerThanPatch(side, cached, p, field)) return 'keep'
    const baseField = Object.values(trackerBase?.doc.titles ?? {}).find(
      (t) => t.rate?.malId === malId
    )?.rate?.[field] as SyncField<number | string> | undefined
    const pre =
      p.prePatch.value !== null
        ? { value: p.prePatch.value, at: parseAt(p.prePatch.serverUpdatedAt) }
        : null
    if (pre && baseField)
      return baseField.at > pre.at ? { value: baseField.value } : { value: pre.value }
    if (pre) return { value: pre.value }
    if (baseField) return { value: baseField.value }
    return 'refresh'
  }

  /** Reverts dropped pending fields of `owner` from its own tracker's base and cache (#715). */
  async function revertFields(
    owner: Owner,
    dropped: { malId: number; field: SyncRateField; p: PendingField }[],
    opts: { keep?: ReadonlySet<string> } = {}
  ): Promise<void> {
    if (dropped.length === 0) return
    const side = sideOf(owner.provider)
    if (!side) return
    const ownerId = Number(owner.userId)
    const trackerBase = await bases.read(`${side.id}-${owner.userId}`).catch(() => null)
    const byMal = new Map<number, Partial<Record<SyncRateField, number | string>>>()
    let refresh = false
    for (const d of dropped) {
      const t = revertTarget(side, ownerId, d.malId, d.field, d.p, trackerBase, opts.keep)
      if (t === 'keep') continue
      if (t === 'refresh') {
        refresh = true
        continue
      }
      byMal.set(d.malId, { ...byMal.get(d.malId), [d.field]: t.value })
    }
    for (const [malId, values] of byMal) patchCache(side, ownerId, malId, values)
    if (refresh && !deps.isOffline()) refreshRates(side)
  }

  /**
   * A merge value into the pending store, with the first `prePatch` carried
   * forward when the field is already pending (refreshed only when a wholesale
   * refresh replaced the cache since). In memory; the caller saves, then patches.
   */
  function putPending(
    side: Side,
    rates: PendingRates,
    ownerId: number,
    malId: number,
    field: SyncRateField,
    f: SyncField<number | string>,
    provenance: SyncProvenance,
    unconfirmedRewatch: boolean
  ): void {
    const fields = (rates[String(malId)] ??= {})
    const existing = fields[field]
    const cached = cachedRate(side, ownerId, malId)
    const fresh = {
      value: cached?.field(field) ?? null,
      serverUpdatedAt: cached?.serverUpdatedAt ?? null
    }
    const prePatch =
      existing && !(cached && newerThanPatch(side, cached, existing, field))
        ? existing.prePatch
        : fresh
    fields[field] = {
      value: f.value,
      clock: { at: f.at, origin: f.origin },
      provenance,
      prePatch,
      ...(unconfirmedRewatch ? { unconfirmedRewatch: true as const } : {})
    }
  }

  function deletePending(
    rates: PendingRates,
    malId: number,
    field: SyncRateField
  ): PendingField | null {
    const fields = rates[String(malId)]
    const p = fields?.[field]
    if (!p) return null
    delete fields![field]
    if (Object.keys(fields!).length === 0) delete rates[String(malId)]
    return p
  }

  // --- conflicts -----------------------------------------------------------------------------

  /** One leg's conflicts into the library owner's file (#715): picked by the owner, not the leg. */
  async function reconcileConflicts(
    owner: Owner,
    party: string,
    scope: Set<string>,
    list: LegConflict[],
    runId: string
  ): Promise<{ resolvedElsewhere: { animeId: string; fieldPath: string }[] }> {
    const records = await conflictStore.read(owner.provider)
    const r = reconcileLeg(
      records,
      { ownerScope: scopeOf(owner), party, inScope: (id) => scope.has(id), conflicts: list, runId },
      makeId
    )
    if (!sameValue(r.records, records)) await conflictStore.write(owner.provider, r.records)
    return {
      resolvedElsewhere: r.removed.map((x) => ({ animeId: x.animeId, fieldPath: x.fieldPath }))
    }
  }

  // --- the library leg ------------------------------------------------------------------------

  function librarySkip(lib: AttachedLibraryInfo): Outcome | null {
    const skipped = (driveReason: SyncLibraryResult['driveReason']): Outcome => ({
      drive: 'skipped',
      driveReason,
      counts: emptyCounts(),
      changes: [],
      conflicts: [],
      clamps: [],
      raises: [],
      resolvedElsewhere: []
    })
    if (lib.mode === 'videos') return skipped('videos-only')
    if (lib.role !== 'owner' && lib.role !== 'claim') return skipped('foreign')
    if (!lib.available) return skipped('unavailable')
    if (lib.access === 'read-only') return skipped('read-only')
    return null
  }

  async function libraryLeg(
    lib: AttachedLibraryInfo,
    runId: string,
    animeId: string | null,
    force = false
  ): Promise<Outcome> {
    const skip = librarySkip(lib)
    if (skip) return skip
    const out: Outcome = {
      drive: 'ok',
      counts: emptyCounts(),
      changes: [],
      conflicts: [],
      clamps: [],
      raises: [],
      resolvedElsewhere: []
    }
    const fail = (driveReason: SyncLibraryResult['driveReason']): Outcome => ({
      ...out,
      drive: 'error',
      driveReason
    })
    const libraryId = lib.libraryId
    const insp = await inspectLibrary(lib.root)
    const read = insp.result
    if (read.status === 'none') return fail('unreadable')
    if (read.status === 'read-only') {
      return read.reason === 'interrupted'
        ? fail('unreadable')
        : { ...out, drive: 'skipped', driveReason: 'read-only' }
    }
    const manifest = read.manifest
    if (manifest.libraryId !== libraryId || manifest.mode !== 'metadata' || !manifest.owner) {
      return fail('unreadable')
    }
    // The owner's tracker (#715): any tracker the app knows, with an owner key
    // (a non-canonical v2 Shikimori owner has none). An owner PC needs that
    // tracker wired here to read its rates; a claim PC reads none.
    const normalized = ownerOf(manifest.owner)
    const side = ownerKey(manifest.owner) !== null ? sideOf(normalized?.provider) : null
    if (!normalized || !side || (side.id !== 'shikimori' && !side.leg && lib.role === 'owner')) {
      return { ...out, drive: 'skipped', driveReason: 'foreign' }
    }
    const rateTracker = side.rate ?? (side.id === 'shikimori' ? undefined : noRates(side))
    const owner: Owner = { provider: side.id, userId: normalized.userId }
    const ownerId = Number(owner.userId)
    // The export's leg is the owner's only: an account switched meanwhile is foreign.
    if (force && !signedInAs(side, owner)) {
      return { ...out, drive: 'skipped', driveReason: 'foreign' }
    }
    const role = lib.role
    const scopeAll = manifest.titles.map((t) => String(t.animeId))
    const scope = animeId === null ? scopeAll : scopeAll.filter((id) => id === animeId)
    const inScope = new Set(scope)
    const base = await bases.read(`library-${libraryId}`)
    const t = now()

    const isOwner = role === 'owner' && signedInAs(side, owner)
    const rates: PendingRates = role === 'owner' ? await pending.load(owner) : {}
    const superseded: { malId: number; field: SyncRateField }[] = []
    const pendingRates = (o: number, malId: number) =>
      o === ownerId
        ? overlay(store, o, malId, rates, { skipUnconfirmed: true }, superseded, side.id)
        : undefined
    const malIdOf = malIdOfUnion()
    const local = projectSyncDoc(store, scope, {
      resolveEpisodeFile: (id, ep, fp) => deps.resolveEpisodeFile?.(id, ep, fp) ?? null,
      pendingRates,
      malIdOf,
      ...(rateTracker ? { tracker: rateTracker } : {})
    })
    // A claim PC has no session, so its projection has no rate: an absent side
    // never changed, and the library's rates pass through to the base (§4).

    let libDoc = normalizeDoc(read.state?.doc)
    if (base && isRollback(read.state?.generation ?? null, base.stateGeneration)) {
      const r = rollbackAdjust(libDoc, normalizeDoc(base.doc))
      libDoc = r.doc
      log.log(
        `[sync] ${lib.name}: the drive's state generation ${read.state?.generation} is below the base's ${base.stateGeneration}: an older replica (${r.replaced.length} fields predate the base)`
      )
    }

    const skipContext = (id: string): SkipContext => ({
      algorithm: deps.skipAlgorithm ?? DEFAULT_SKIP_ALGORITHM,
      localFile: (ep) => {
        const f = deps.localEpisodeFile?.(id, ep)
        return f ? { translationId: f.translationId, fileSize: f.fileSize } : null
      }
    })
    const m = merge3(base?.doc ?? null, local, libDoc, FIELD_TABLE, {
      now: t,
      scope,
      skip: skipContext,
      order: animeId === null
    })

    // The owner-decision-5 raise, on the owner's logged-in PC only.
    const unconfirmed = new Map<string, Set<SyncRateField>>()
    if (isOwner) {
      for (const id of scope) {
        const flips: WatchFlip[] = []
        for (const p of m.changesA) {
          const w = WATCHED_PATH.exec(p)
          if (!w || w[1] !== id) continue
          const after = m.result.titles[id]?.watch?.[w[2]]?.watched
          const before = local.titles[id]?.watch?.[w[2]]?.watched
          if (after?.value === true && before?.value !== true) {
            flips.push({ episodeInt: w[2], at: after.at, origin: after.origin })
          }
        }
        if (flips.length === 0) continue
        const merged = m.result.titles[id]?.rate
        const malId = merged?.malId ?? malIdOf(id)
        if (malId === null || malId === undefined) continue
        const cached = cachedRate(side, ownerId, malId)
        const cachedAt = cached ? parseAt(cached.serverUpdatedAt) : -Infinity
        // The owner tracker's own clocks only (#715): its cached time and its origin.
        const trackerClocks = merged
          ? RATE_FIELDS.map((f) => merged[f])
              .filter((f) => f.origin === side.id)
              .map((f) => f.at)
          : []
        const trackerAt = Math.max(cachedAt, ...trackerClocks)
        const raise = computeRaise({
          noBase: !base,
          flips,
          mergedRate: merged ? (rateValuesOf(merged) as RateValues) : null,
          shikimoriAt: Number.isFinite(trackerAt) ? trackerAt : null
        })
        if (!raise) continue
        const prev = merged ? rateValuesOf(merged) : NO_RATE_BEFORE
        const changed = RATE_FIELDS.filter((f) => !merged || prev[f] !== raise.rate[f])
        // Only the raised fields move: a conflicted field stays as each side has it.
        const raiseOnto = (rate: SyncRateState | undefined): SyncRateState => {
          const out = { ...(rate ?? merged ?? { malId }) } as SyncRateState
          out.malId = malId
          for (const f of RATE_FIELDS) {
            if (changed.includes(f) || !out[f]) {
              ;(out as unknown as Record<string, unknown>)[f] = {
                value: raise.rate[f],
                ...raise.clock
              }
            }
          }
          return out
        }
        ;(m.result.titles[id] ??= {}).rate = raiseOnto(merged)
        if (raise.kind === 'forward') {
          const t = (m.remote.titles[id] ??= {})
          t.rate = raiseOnto(t.rate)
          const nb = (m.nextBase.titles[id] ??= {})
          nb.rate = raiseOnto(nb.rate)
          for (const f of changed) m.changesB.push(`titles.${id}.rate.${f}`)
        } else {
          unconfirmed.set(id, new Set(changed))
        }
        out.raises.push({
          libraryId,
          animeId: id,
          malId,
          kind: raise.kind,
          episodes: raise.rate.episodes,
          from: prev.episodes,
          ...(side.id !== 'shikimori' ? { tracker: side.id } : {})
        })
      }
    }

    // Apply locally. `starred` needs the drive's metadata snapshot when this PC has no row.
    const library = store.get<Record<string, unknown> | undefined>('library') ?? {}
    const downloaded = store.get<Record<string, unknown> | undefined>('downloadedAnime') ?? {}
    const searchResults = new Map<string, AnimeSearchResult>()
    for (const id of scope) {
      if (!m.result.titles[id]?.starred || library[id] || downloaded[id]) continue
      const meta = await readMeta(lib.root, Number(id)).catch(() => null)
      if (meta?.status === 'ok' && meta.meta.searchResult) {
        searchResults.set(id, toAnimeSearchResult(meta.meta.searchResult))
      }
    }
    const patches: { malId: number; values: Partial<Record<SyncRateField, number | string>> }[] = []
    const report = applySyncDoc(store, m.result, scope, {
      now,
      sharedSearchResult: (id) => searchResults.get(id) ?? null,
      localEpisodeFile: (id, ep) => deps.localEpisodeFile?.(id, ep) ?? null,
      skipAlgorithm: deps.skipAlgorithm ?? DEFAULT_SKIP_ALGORITHM,
      pendingRates,
      ...(rateTracker ? { tracker: rateTracker } : {}),
      applyRate: (id, rate) => {
        if (role !== 'owner') return true
        const current = projectRate(store, rate.malId, {
          pendingRates,
          ...(rateTracker ? { tracker: rateTracker } : {})
        })
        const values: Partial<Record<SyncRateField, number | string>> = {}
        for (const f of RATE_FIELDS) {
          if (current && sameValue(current[f].value, rate[f].value)) continue
          putPending(
            side,
            rates,
            ownerId,
            rate.malId,
            f,
            rate[f],
            { libraryId },
            !!unconfirmed.get(id)?.has(f)
          )
          values[f] = rate[f].value
        }
        patches.push({ malId: rate.malId, values })
        return true
      }
    })
    for (const s of superseded) deletePending(rates, s.malId, s.field)
    if (role === 'owner') {
      await pending.save(owner, rates)
      for (const p of patches) patchCache(side, ownerId, p.malId, p.values)
    }
    // A field left unapplied (no metadata to star it with) keeps its base, so it is retried.
    for (const u of report.unapplied) {
      const mm = /^titles\.([^.]+)\.(starred|priority|rate)$/.exec(u.path)
      if (!mm) continue
      const [, id, field] = mm
      const title = (m.nextBase.titles[id] ??= {})
      const old = base?.doc.titles[id]?.[field as 'starred']
      if (old !== undefined) (title as Record<string, unknown>)[field] = old
      else delete (title as Record<string, unknown>)[field]
      if (field !== 'rate') {
        const stone = base?.doc.tombstones[id]?.[field as 'starred']
        const stones = (m.nextBase.tombstones[id] ??= {})
        if (stone) stones[field as 'starred'] = stone
        else delete stones[field as 'starred']
      }
    }

    // The drive: the merged in-scope titles, every other title as the drive has it.
    const driveTitles = read.state?.doc.titles ?? {}
    const driveStones = read.state?.doc.tombstones ?? {}
    const doc: SyncDoc = {
      ...m.remote,
      titles: { ...m.remote.titles },
      tombstones: { ...m.remote.tombstones }
    }
    for (const [id, title] of Object.entries(driveTitles))
      if (!inScope.has(id)) doc.titles[id] = title
    for (const [id, s] of Object.entries(driveStones)) if (!inScope.has(id)) doc.tombstones[id] = s
    doc.tombstones = pruneDocTombstones(doc.tombstones, t, scopeAll)
    if (animeId !== null && read.state?.doc.priorityOrder)
      doc.priorityOrder = read.state.doc.priorityOrder
    const prunedStones = !sameValue(doc.tombstones, { ...driveStones })
    let stateGeneration = manifest.stateGeneration
    if (m.changesB.length > 0 || prunedStones || force) {
      try {
        const actor = buildActor(store, libraryId, deps.appVersion)
        const w = await writeState(lib.root, doc as SharedSyncDoc, actor, manifest.stateGeneration)
        stateGeneration = w.stateGeneration
        void attached.refresh(libraryId, lib.root).catch(() => {})
      } catch (err) {
        if (READ_ONLY_CODES.has(errCode(err) ?? '')) {
          attached.reportWriteFailure(libraryId, err)
          log.warn(`[sync] ${lib.name}: the drive write failed (${errCode(err)}); read-only now`)
          return {
            ...fail('write-failed-read-only'),
            counts: { ...out.counts, applied: m.changesA.length }
          }
        }
        log.warn(`[sync] ${lib.name}: the drive write failed; retried on the next trigger`, err)
        return { ...fail('io'), counts: { ...out.counts, applied: m.changesA.length } }
      }
    }

    // The base, only after the write succeeded.
    const nextBase = normalizeDoc(base?.doc ?? m.nextBase)
    for (const id of scope) {
      if (m.nextBase.titles[id] && Object.keys(m.nextBase.titles[id]).length > 0) {
        nextBase.titles[id] = m.nextBase.titles[id]
      } else delete nextBase.titles[id]
      const s = m.nextBase.tombstones[id]
      if (s && (s.starred || s.priority)) nextBase.tombstones[id] = s
      else delete nextBase.tombstones[id]
    }
    if (animeId === null || !base) nextBase.priorityOrder = m.nextBase.priorityOrder
    await bases.write(`library-${libraryId}`, { stateGeneration, doc: nextBase })

    const legConflicts: LegConflict[] = m.conflicts.map((c) => ({
      animeId: c.animeId,
      fieldPath: c.fieldPath,
      reason: c.reason,
      local: c.a,
      party: c.b,
      base: c.base,
      ...(c.atA ? { atLocal: c.atA } : {}),
      ...(c.atB ? { atParty: c.atB } : {}),
      ...(c.noSuggestion ? { noSuggestion: true } : {})
    }))
    // The owner's file, on a claim PC too (§4).
    const conv = await reconcileConflicts(
      owner,
      `library:${libraryId}`,
      inScope,
      legConflicts,
      runId
    )
    attached.markSynced(libraryId, now())
    return {
      ...out,
      counts: {
        applied: m.changesA.length + m.changesB.length,
        conflicts: m.conflicts.length,
        clamped: m.clamped.length
      },
      changes: [...m.changesA.map((p) => `local:${p}`), ...m.changesB.map((p) => `library:${p}`)],
      details: [
        ...m.changesA.map(
          (p): SyncLogDetail => ({
            path: p,
            to: 'local',
            from: 'library',
            libraryId,
            before: valueAt(local, p),
            after: valueAt(m.result, p)
          })
        ),
        ...m.changesB.map(
          (p): SyncLogDetail => ({
            path: p,
            to: 'library',
            from: 'local',
            libraryId,
            before: valueAt(libDoc, p),
            after: valueAt(m.remote, p)
          })
        )
      ],
      conflicts: m.conflicts.map((c) => ({
        animeId: c.animeId,
        fieldPath: c.fieldPath,
        reason: c.reason
      })),
      clamps: m.clamped.map((c) => ({ path: c.path, at: c.at, clampedTo: c.clampedTo })),
      resolvedElsewhere: conv.resolvedElsewhere
    }
  }

  // --- the owner tracker's leg -----------------------------------------------------------------

  /** The owner's list, normalized: Shikimori's `getUserAnimeRates`, another tracker's `listEntries`. */
  async function readRows(side: Side, ownerId: number): Promise<LegRow[]> {
    if (side.id === 'shikimori') {
      const token = await api.ensureFreshToken(store)
      return (await api.getUserAnimeRates(token, ownerId)).map((r) => ({
        malId: r.target_id ?? r.anime.id,
        remoteId: r.id ?? null,
        values: rateValues(r),
        updatedAt: r.updated_at
      }))
    }
    const provider = side.leg!.provider
    const session = await provider.auth()
    return (await provider.listEntries(session)).map((e) => ({
      malId: e.malId,
      remoteId: e.remoteId,
      values: rateValues(e.values),
      updatedAt: e.updatedAt !== null ? new Date(e.updatedAt).toISOString() : null
    }))
  }

  /** A leg's read failure: Shikimori's three-way split, another tracker's `classifyError` (§1). */
  function readFailure(side: Side, err: unknown): SyncLegReason {
    if (side.id === 'shikimori') {
      if (err instanceof shikimoriApi.ShikiAuthError) return 'auth'
      if (isNetworkError(err)) return 'network'
      return 'api'
    }
    return legReasonOf(side.leg!.provider.classifyError(err))
  }

  /**
   * One owner's leg on their tracker (#715): the Shikimori leg generalized
   * over the owner tracker's keys, read, base, pending file, origin and queue.
   */
  async function trackerLeg(
    side: Side,
    ownerId: number,
    ids: string[],
    runId: string
  ): Promise<LegOutcome> {
    const owner: Owner = { provider: side.id, userId: String(ownerId) }
    const party = side.id
    const origin = side.id === 'shikimori' ? SHIKIMORI_ORIGIN : side.id
    const out: LegOutcome = {
      status: 'ok',
      waitingMalIds: [],
      rewatchesSuperseded: 0,
      counts: { applied: 0, conflicts: 0 },
      conflicts: [],
      resolvedElsewhere: []
    }
    const fail = (status: SyncLegStatus, reason: SyncLegReason): LegOutcome => ({
      ...out,
      status,
      reason
    })
    if (side.user() !== ownerId)
      return fail('skipped', side.user() === null ? 'logged-out' : 'foreign')
    if (deps.isOffline()) return fail('skipped', 'offline')
    if (!store.get(side.keys.credentials)) return fail('error', 'auth')

    const malIdOf = malIdOfUnion()
    const live = new Set(
      (store.get<QueuedShikimoriUpdate[] | undefined>(side.keys.updateQueue) ?? []).map(
        (q) => q.malId
      )
    )
    let rows: LegRow[]
    try {
      rows = await readRows(side, ownerId)
    } catch (err) {
      const reason = readFailure(side, err)
      if (reason !== 'auth' && reason !== 'network') {
        log.warn(`[sync] the ${side.label} read failed:`, err)
      }
      return fail('error', reason)
    }
    if (side.user() !== ownerId)
      return fail('skipped', side.user() === null ? 'logged-out' : 'foreign')
    const rowOf = new Map(rows.map((r) => [r.malId, r]))

    const t = now()
    const rates = await pending.load(owner)
    const trackerBase = await bases.read(`${party}-${ownerId}`)

    const titleIds: string[] = []
    const malOf = new Map<string, number>()
    for (const id of ids) {
      const malId = malIdOf(id)
      if (malId === null) continue
      // Not on this tracker (AniList's id map has no `idMal` for it): nothing queued (§1).
      if (side.leg && !side.leg.sync.hasTitle(malId)) continue
      if (live.has(malId)) {
        if (!out.waitingMalIds.includes(malId)) out.waitingMalIds.push(malId)
        continue
      }
      titleIds.push(id)
      malOf.set(id, malId)
    }
    if (out.waitingMalIds.length > 0) {
      log.log(`[sync] waiting for queued edits: MAL ${out.waitingMalIds.join(', ')}`)
    }

    // Path F: an unconfirmed rewatch raise older than the fresh row is cancelled.
    for (const [id, malId] of malOf) {
      const fields = rates[String(malId)]
      const raised = (Object.entries(fields ?? {}) as [SyncRateField, PendingField][]).filter(
        ([, p]) => p.unconfirmedRewatch
      )
      if (raised.length === 0) continue
      const row = rowOf.get(malId)
      const flipAt = Math.max(...raised.map(([, p]) => p.clock.at))
      if (!row || parseAt(row.updatedAt) <= flipAt) continue
      for (const [f] of raised) deletePending(rates, malId, f)
      const episodes = raised.find(([f]) => f === 'episodes')?.[1].value
      const provenance = raised[0][1].provenance
      patchCache(side, ownerId, malId, row.values, row.updatedAt ?? undefined)
      await syncLog.append({
        kind: 'rewatch-superseded',
        runId,
        at: t,
        animeId: id,
        malId,
        episodes: typeof episodes === 'number' ? episodes : row.values.episodes,
        flipAt,
        shikimoriUpdatedAt: row.updatedAt ?? '',
        libraryId: 'libraryId' in provenance ? provenance.libraryId : null,
        reason: rewatchSupersededReason(side),
        ...(side.id !== 'shikimori' ? { tracker: side.id } : {})
      })
      out.rewatchesSuperseded++
    }

    const superseded: { malId: number; field: SyncRateField }[] = []
    const local: SyncDoc = normalizeDoc(null)
    const remote: SyncDoc = normalizeDoc(null)
    for (const [id, malId] of malOf) {
      const rate = projectRate(store, malId, {
        pendingRates: (o, mal) =>
          overlay(store, o, mal, rates, { skipUnconfirmed: false }, superseded, side.id),
        ...(side.rate ? { tracker: side.rate } : {})
      })
      if (rate) local.titles[id] = { rate }
      const row = rowOf.get(malId)
      if (row) {
        const clock = { at: parseAt(row.updatedAt), origin }
        const at = Number.isFinite(clock.at) ? clock.at : 0
        const v = row.values
        remote.titles[id] = {
          rate: {
            malId,
            episodes: { value: v.episodes, at, origin },
            status: { value: v.status, at, origin },
            score: { value: v.score, at, origin },
            rewatches: { value: v.rewatches, at, origin }
          }
        }
      }
    }
    for (const s of superseded) deletePending(rates, s.malId, s.field)
    const baseDoc = trackerBase
      ? ratesOnly(normalizeDoc(trackerBase.doc), titleIds)
      : trackerNoBase(remote)
    const m = merge3(baseDoc, local, remote, FIELD_TABLE, { now: t, scope: titleIds, order: false })

    const conflicted = new Set(m.conflicts.map((c) => `${c.animeId}:${c.fieldPath}`))
    // A field the tracker rejected 3 times is a held conflict until it converges.
    const records = await conflictStore.read(owner.provider)
    const rejected = new Set(
      records
        .filter(
          (r) =>
            sameScope(r.ownerScope, scopeOf(owner)) &&
            r.reason === side.rejectedReason &&
            party in r.parties
        )
        .map((r) => `${r.animeId}:${r.fieldPath}`)
    )
    const nextBase = normalizeDoc(trackerBase?.doc ?? remote)
    // Only this leg's own entries; the queue is re-read right before the write.
    const additions: QueuedShikimoriUpdate[] = []
    let queuedAt = t
    const legConflicts: LegConflict[] = m.conflicts.map((c) => ({
      animeId: c.animeId,
      fieldPath: c.fieldPath,
      reason: c.reason,
      local: c.a,
      party: c.b,
      base: c.base,
      ...(c.atA ? { atLocal: c.atA } : {}),
      ...(c.atB ? { atParty: c.atB } : {}),
      ...(c.noSuggestion ? { noSuggestion: true } : {})
    }))
    for (const id of titleIds) {
      const malId = malOf.get(id)!
      const row = rowOf.get(malId)
      const merged = m.remote.titles[id]?.rate
      const fromTracker: Partial<Record<SyncRateField, number | string>> = {}
      const push: SyncRateField[] = []
      for (const f of RATE_FIELDS) {
        const key = `${id}:rate.${f}`
        const path = `titles.${id}.rate.${f}`
        if (conflicted.has(key)) continue
        if (rejected.has(key)) {
          legConflicts.push({
            animeId: id,
            fieldPath: `rate.${f}`,
            reason: side.rejectedReason,
            local: local.titles[id]?.rate?.[f].value,
            party: row ? row.values[f] : undefined,
            base: baseDoc.titles[id]?.rate?.[f].value
          })
          continue
        }
        const tookTracker = m.changesA.includes(path) && !!row
        if (tookTracker) {
          // Path B: the tracker's value applied here; a pending value would hide it.
          fromTracker[f] = row!.values[f]
          deletePending(rates, malId, f)
        }
        if (m.changesB.includes(path)) push.push(f)
        else if (!tookTracker && row && merged && sameValue(merged[f].value, row.values[f])) {
          // Path A: this PC's value, which the server already has.
          deletePending(rates, malId, f)
        }
        // The base: now for every field that needs no push; a pushed one waits for its settle.
        if (!m.changesB.includes(path)) {
          const nb = m.nextBase.titles[id]?.rate
          if (nb) {
            const title = (nextBase.titles[id] ??= {})
            title.rate = { ...(title.rate ?? nb), malId, [f]: nb[f] } as SyncRateState
          }
        }
      }
      if (Object.keys(fromTracker).length > 0 && row) {
        patchCache(side, ownerId, malId, fromTracker, row.updatedAt ?? undefined)
        out.counts.applied += Object.keys(fromTracker).length
        for (const [f, v] of Object.entries(fromTracker) as [SyncRateField, number | string][]) {
          ;(out.details ??= []).push({
            path: `titles.${id}.rate.${f}`,
            to: 'local',
            from: side.id,
            before: local.titles[id]?.rate?.[f].value,
            after: v
          })
        }
      }
      if (push.length > 0 && merged) {
        const after = rateValuesOf(merged) as RateValues
        const provenance: Partial<Record<SyncRateField, SyncProvenance>> = {}
        for (const f of push) {
          const p = rates[String(malId)]?.[f]
          if (p) provenance[f] = p.provenance
          ;(out.details ??= []).push({
            path: `titles.${id}.rate.${f}`,
            to: side.id,
            from: 'local',
            ...(p && 'libraryId' in p.provenance ? { libraryId: p.provenance.libraryId } : {}),
            before: row ? row.values[f] : undefined,
            after: after[f]
          })
        }
        additions.push({
          malId,
          rateId: row?.remoteId ?? null,
          before: row ? row.values : NO_RATE_BEFORE,
          after,
          queuedAt: queuedAt++,
          fields: push,
          ...(Object.keys(provenance).length > 0
            ? { origin: { kind: 'sync-merge' as const, provenance } }
            : {})
        })
        out.counts.applied += push.length
      }
    }
    out.counts.conflicts = legConflicts.length
    out.conflicts = legConflicts.map((c) => ({
      animeId: c.animeId,
      fieldPath: c.fieldPath,
      reason: c.reason
    }))
    await pending.save(owner, rates)
    await bases.write(`${party}-${ownerId}`, { stateGeneration: null, doc: nextBase })
    const conv = await reconcileConflicts(owner, party, new Set(titleIds), legConflicts, runId)
    out.resolvedElsewhere = conv.resolvedElsewhere
    if (additions.length > 0) {
      // Re-read: a user edit or a drain may have written the queue during the awaits above.
      // In `queuedAt` order: a user edit made during the leg is newer than the
      // leg's entries, and `consolidateQueue` takes the last entry's `after`.
      // Merge results never fan out (#692): they reach mirrors only through #716.
      const queue = mergeQueues(
        store.get<QueuedShikimoriUpdate[] | undefined>(side.keys.updateQueue) ?? [],
        additions
      )
      store.set(side.keys.updateQueue, queue)
      broadcastQueue(side, queue.length)
      kick(side)
    }
    return out
  }

  // --- the settle listener (path C, drops) ---------------------------------------------------

  /**
   * What the tracker has for a pending field, as this PC last saw it: the
   * cache, when a refresh replaced the patch since; otherwise the value the
   * patch covered (`prePatch`). The cache itself shows the pending value.
   */
  function serverValueOf(
    side: Side,
    ownerId: number,
    malId: number,
    field: SyncRateField,
    p: PendingField
  ): number | string | null {
    const cached = cachedRate(side, ownerId, malId)
    if (cached && newerThanPatch(side, cached, p, field)) {
      return cached.field(field) as number | string
    }
    return p.prePatch.value ?? cached?.field(field) ?? null
  }

  function animeIdOfMal(side: Side, ownerId: number, malId: number): string | null {
    const fromCache = cachedRate(side, ownerId, malId)?.smotretId
    if (fromCache !== undefined) return String(fromCache)
    const mapped = store.get<Record<string, { id?: number }> | undefined>('malIdMap')?.[
      String(malId)
    ]?.id
    return mapped !== undefined ? String(mapped) : null
  }

  async function onSettled(side: Side, e: TrackerItemSettled<unknown>): Promise<void> {
    // The event's numeric user id, as an owner key (#715).
    const owner: Owner = { provider: side.id, userId: String(e.ownerId) }
    const rates = await pending.load(owner)
    const fields = rates[String(e.malId)]
    let changed = false
    if (e.outcome === 'dropped') {
      const scope = (Object.keys(e.provenance ?? {}) as SyncRateField[]).filter((f) => fields?.[f])
      const held: SyncRateField[] = []
      for (const f of scope) {
        const p = fields![f]!
        p.drops = (p.drops ?? 0) + 1
        changed = true
        if (p.drops >= DROPS_TO_CONFLICT) held.push(f)
      }
      if (held.length > 0) {
        const id = animeIdOfMal(side, e.ownerId, e.malId)
        const records = await conflictStore.read(owner.provider)
        const r = reconcileLeg(
          records,
          {
            ownerScope: scopeOf(owner),
            party: side.id,
            inScope: () => false,
            conflicts: held.map((f) => ({
              animeId: id ?? `mal:${e.malId}`,
              fieldPath: `rate.${f}` as SyncConflictFieldPath,
              reason: side.rejectedReason,
              local: fields![f]!.value,
              party: serverValueOf(side, e.ownerId, e.malId, f, fields![f]!),
              base: null
            })),
            runId: `settle-${e.malId}`
          },
          makeId
        )
        await conflictStore.write(owner.provider, r.records)
        await syncLog.append(
          side.id === 'shikimori'
            ? {
                kind: 'shikimori-rejected',
                at: now(),
                malId: e.malId,
                fields: held,
                error: e.error ?? ''
              }
            : {
                kind: 'tracker-rejected',
                tracker: side.id,
                at: now(),
                malId: e.malId,
                fields: held,
                error: e.error ?? ''
              }
        )
      }
    } else if (side.id === 'shikimori' ? e.rate : true) {
      // Shikimori's settled rate; another tracker's `after` on the fields it applied.
      const values =
        side.id === 'shikimori'
          ? rateValues(e.rate as shikimoriApi.ShikiUserRate)
          : rateValues(e.after)
      for (const f of e.fieldsApplied) {
        const p = fields?.[f]
        if (p && sameValue(p.value, values[f])) {
          deletePending(rates, e.malId, f)
          changed = true
        }
      }
      const party = `${side.id}-${e.ownerId}`
      const base = await bases.read(party)
      if (base && e.fieldsApplied.length > 0) {
        const doc = normalizeDoc(base.doc)
        const entry = Object.entries(doc.titles).find(([, ti]) => ti.rate?.malId === e.malId)
        if (entry?.[1].rate) {
          const rate = { ...entry[1].rate }
          for (const f of e.fieldsApplied) {
            ;(rate as unknown as Record<string, unknown>)[f] = {
              value: values[f],
              at: now(),
              origin: side.id === 'shikimori' ? SHIKIMORI_ORIGIN : side.id
            }
          }
          doc.titles[entry[0]] = { ...entry[1], rate }
          await bases.write(party, { stateGeneration: null, doc })
        }
      }
    }
    if (changed) await pending.save(owner, rates)
  }

  // --- the review sheet and the history (#585) -------------------------------------------------

  /** Every other tracker's cache, normalized (§6's union read, #715). */
  function otherCaches(): ReturnType<RateTracker['entryOf']>[] {
    return rateTrackers().flatMap((t) =>
      (store.get<unknown[] | undefined>(t.keys.userRates) ?? []).map((row) => t.entryOf(row))
    )
  }

  function titleInfo(animeId: string): SyncConflictItem['title'] {
    if (animeId.startsWith('mal:')) return { ...titleOfMalInfo(Number(animeId.slice(4))) }
    const library = store.get<Record<string, AnimeSearchResult> | undefined>('library') ?? {}
    const downloaded =
      store.get<Record<string, AnimeSearchResult> | undefined>('downloadedAnime') ?? {}
    let a: AnimeSearchResult | undefined = library[animeId] ?? downloaded[animeId]
    for (const lib of a ? [] : attached.list()) {
      a = lib.titles.find((t) => String(t.animeId) === animeId)?.anime
      if (a) break
    }
    if (!a) {
      const cached = (store.get<CachedRateEntry[] | undefined>('shikimoriUserRates') ?? []).find(
        (e) => String((e.smotretAnime as { id?: number } | null)?.id) === animeId
      )
      a = (cached?.smotretAnime as AnimeSearchResult | null) ?? undefined
    }
    if (!a) {
      a =
        (otherCaches().find((e) => String(e.smotretAnime?.id) === animeId)?.smotretAnime as
          | AnimeSearchResult
          | null
          | undefined) ?? undefined
    }
    return a
      ? { name: a.title, poster: a.posterUrlSmall ?? null, episodes: a.numberOfEpisodes ?? null }
      : { name: `#${animeId}`, poster: null, episodes: null }
  }

  function titleOfMalInfo(malId: number): SyncConflictItem['title'] {
    const cached = (store.get<CachedRateEntry[] | undefined>('shikimoriUserRates') ?? []).find(
      (e) => e.rate.target_id === malId
    )
    const other = cached ? undefined : otherCaches().find((e) => e.malId === malId)
    const id =
      (cached?.smotretAnime as { id?: number } | null)?.id ??
      store.get<Record<string, { id?: number }> | undefined>('malIdMap')?.[String(malId)]?.id ??
      other?.smotretAnime?.id
    if (id !== undefined) return titleInfo(String(id))
    const name = (cached?.shikiAnime as { name?: string } | null)?.name ?? other?.anime?.title
    return { name: name ?? `MAL ${malId}`, poster: null, episodes: null }
  }

  const historyNames: HistoryNames = {
    title: (animeId) => titleInfo(animeId).name,
    titleOfMal: (malId) => titleOfMalInfo(malId).name,
    library: (libraryId) => attached.get(libraryId)?.name ?? 'a forgotten library'
  }

  const titlesOf = (lib: AttachedLibraryInfo): AttachedLibraryTitle[] =>
    attached.get(lib.libraryId)?.titles ?? lib.titles

  /** A library's owner, from its attached record (`owner` or `trackerOwner`). */
  function libraryOwner(l: AttachedLibraryInfo): ReturnType<typeof ownerOf> {
    const rec = store.get<Record<string, AttachedLibraryRecord> | undefined>('attachedLibraries')?.[
      l.libraryId
    ]
    return ownerOf(rec?.trackerOwner ?? rec?.owner)
  }

  /**
   * Owned or claimed metadata libraries a conflict touches (#715): a party to
   * it, kept whatever its owner now is (a record held from before a takeover
   * still reaches its library), or a library of the record's owner holding
   * its title. `provider` is the record's file's.
   */
  function conflictLibraries(rec: SyncConflictRecord, provider: TrackerId): AttachedLibraryInfo[] {
    const recordOwner = { provider, userId: String(rec.ownerScope) }
    return attached.list().filter((l) => {
      if (l.mode !== 'metadata' || (l.role !== 'owner' && l.role !== 'claim')) return false
      if (`library:${l.libraryId}` in rec.parties) return true
      const owner = libraryOwner(l)
      return (
        owner !== null &&
        sameOwnerKey(owner, recordOwner) &&
        titlesOf(l).some((t) => String(t.animeId) === rec.animeId)
      )
    })
  }

  async function listConflicts(opts: { strict?: boolean } = {}): Promise<SyncConflictItem[]> {
    const files = await conflictStore.readAll({ lenient: !opts.strict })
    return files.flatMap(({ provider, records }) =>
      records.map((rec) => ({
        ...rec,
        ...(provider !== 'shikimori' ? { tracker: provider } : {}),
        title: titleInfo(rec.animeId),
        libraries: conflictLibraries(rec, provider).map((l) => ({
          libraryId: l.libraryId,
          name: l.name,
          involved: `library:${l.libraryId}` in rec.parties,
          available: l.available
        })),
        options: conflictOptions(rec),
        rewatchQuestion: rewatchQuestionBase(rec) !== null
      }))
    )
  }

  /** The owner tracker's base `field` of `malId`, set to a value the tracker has now (#715). */
  async function advanceTrackerBase(
    side: Side,
    ownerId: number,
    malId: number,
    field: SyncRateField,
    value: number | string,
    at: number
  ): Promise<void> {
    const party = `${side.id}-${ownerId}`
    const base = await bases.read(party)
    if (!base) return
    const doc = normalizeDoc(base.doc)
    const entry = Object.entries(doc.titles).find(([, ti]) => ti.rate?.malId === malId)
    if (!entry?.[1].rate) return
    const origin = side.id === 'shikimori' ? SHIKIMORI_ORIGIN : side.id
    const rate = { ...entry[1].rate, [field]: { value, at, origin } }
    doc.titles[entry[0]] = { ...entry[1], rate: rate as SyncRateState }
    await bases.write(party, { stateGeneration: null, doc })
  }

  /**
   * Strips `field` of `malId` from the merge entries of the owner tracker's
   * live queue and parked buckets, under its queue lock (#715): another
   * tracker's queue belongs to another owner.
   */
  async function stripQueued(side: Side, malId: number, field: SyncRateField): Promise<void> {
    for (const t of trackers) {
      if (t.trackerId !== side.id) continue
      await t.withQueueLock(() => {
        // Rebase only (#692 review): a later `via` survivor built on the
        // stripped value would otherwise drain as drift on `field`.
        const live = store.get<QueuedShikimoriUpdate[] | undefined>(t.keys.updateQueue) ?? []
        const nextLive = revertAndRebase(stripFieldSlots(live, malId, field)).queue
        if (!sameValue(nextLive, live)) {
          store.set(t.keys.updateQueue, nextLive)
          t.broadcastQueueChanged()
        }
        const parked = store.get<ParkedQueues | undefined>(t.keys.parkedQueues) ?? {}
        const nextParked: ParkedQueues = {}
        for (const [owner, bucket] of Object.entries(parked)) {
          const entries = revertAndRebase(stripFieldSlots(bucket.entries, malId, field)).queue
          if (entries.length > 0) nextParked[owner] = { ...bucket, entries }
        }
        if (!sameValue(nextParked, parked)) store.set(t.keys.parkedQueues, nextParked)
      })
    }
  }

  /** `value` into one title's field of `doc`, with `clock`; false when there is nothing to put it on. */
  function putField(
    doc: SyncDoc,
    animeId: string,
    rec: SyncConflictRecord,
    value: unknown,
    clock: SyncClock,
    fallback: SyncTitleState | undefined
  ): boolean {
    const title = (doc.titles[animeId] ??= {})
    const field = fieldOf(rec.fieldPath)
    if (field === 'watched') {
      const ep = episodeOf(rec.fieldPath)!
      const watch = (title.watch ??= {})
      const entry = watch[ep] ?? structuredClone(fallback?.watch?.[ep])
      if (!entry) return false
      entry.watched = { value: value === true, ...clock }
      entry.watchedAt = value === true ? (entry.watchedAt ?? clock.at) : null
      watch[ep] = entry
      return true
    }
    const rate = title.rate ?? structuredClone(fallback?.rate)
    if (!rate) return false
    ;(rate as unknown as Record<string, unknown>)[field] = { value, ...clock }
    title.rate = rate
    return true
  }

  async function resolveOne(
    rec: SyncConflictRecord,
    provider: TrackerId,
    choice: SyncConflictChoice,
    value: unknown
  ): Promise<{ failed?: string; notes: string[]; queued: TrackerId | null }> {
    const t = now()
    const clock: SyncClock = { at: t, origin: store.get<string | undefined>('installId') ?? '' }
    const notes: string[] = []
    const field = fieldOf(rec.fieldPath)
    // The record's owner, from its file's provider (#715).
    const side = sides.get(provider)!
    const owner: Owner = { provider, userId: String(rec.ownerScope) }
    const ownerId = Number(rec.ownerScope)
    const party = side.id
    const isOwnerPc = signedInAs(side, owner)
    const fromMal = rec.animeId.startsWith('mal:') ? Number(rec.animeId.slice(4)) : null
    const animeId = fromMal === null ? rec.animeId : null
    const libs = animeId === null ? [] : conflictLibraries(rec, provider)
    const isRate = field !== 'watched'
    // `conflictLibraries` holds only the record's owner's libraries (and its parties).
    if (isRate && !isOwnerPc && !libs.some((l) => l.role === 'claim')) {
      return { failed: "Sign in as the library's owner to resolve this.", notes, queued: null }
    }
    if (!isRate && animeId === null) return { failed: 'Unknown title.', notes, queued: null }
    const malId = fromMal ?? (isRate && animeId !== null ? malIdOfUnion()(animeId) : null)
    if (isRate && isOwnerPc && malId === null) {
      return {
        failed: `This title has no ${side.label} id on this PC.`,
        notes,
        queued: null
      }
    }
    const rates: PendingRates = isOwnerPc ? await pending.load(owner) : {}
    const pendingRates = (o: number, mal: number) =>
      o === ownerId
        ? overlay(store, o, mal, rates, { skipUnconfirmed: true }, [], side.id)
        : undefined
    const projectLocal = (): SyncDoc =>
      projectSyncDoc(store, animeId === null ? [] : [animeId], {
        resolveEpisodeFile: (id, ep, fp) => deps.resolveEpisodeFile?.(id, ep, fp) ?? null,
        pendingRates,
        malIdOf: malIdOfUnion(),
        ...(side.rate ? { tracker: side.rate } : {})
      })
    const partyLibraryIds = Object.keys(rec.parties)
      .filter((p) => p.startsWith('library:'))
      .map((p) => p.slice(8))
    let trackerWrote: 'queued' | 'already' | 'none' = 'none'
    let queued: TrackerId | null = null
    let wroteLocal = false

    // This PC: a watch row through `applySyncDoc`; a rate field through the pending store.
    if (!isRate) {
      const doc = projectLocal()
      const fallback: SyncTitleState = {
        watch: {
          [episodeOf(rec.fieldPath)!]: {
            position: { value: { position: 0, duration: 0 }, ...clock },
            watched: { value: false, ...clock },
            watchedAt: null
          }
        }
      }
      putField(doc, animeId!, rec, value, clock, fallback)
      applySyncDoc(store, doc, [animeId!], {
        now,
        localEpisodeFile: (id, ep) => deps.localEpisodeFile?.(id, ep) ?? null,
        skipAlgorithm: deps.skipAlgorithm ?? DEFAULT_SKIP_ALGORITHM,
        pendingRates,
        ...(side.rate ? { tracker: side.rate } : {}),
        applyRate: () => true
      })
      wroteLocal = true
    } else if (isOwnerPc && malId !== null) {
      const f = field as SyncRateField
      const v = value as number | string
      const existing = rates[String(malId)]?.[f]
      const cached = cachedRate(side, ownerId, malId)
      // What this PC last saw on the server (S9's `serverValueOf` for a pending field).
      const serverOf = (g: SyncRateField): number | string | null => {
        const p = rates[String(malId)]?.[g]
        if (p) return serverValueOf(side, ownerId, malId, g, p)
        return cached?.field(g) ?? null
      }
      const serverValue =
        party in rec.parties ? (rec.parties[party] as number | string) : serverOf(f)
      if (serverValue !== null && sameValue(serverValue, v)) {
        // The tracker has it already (Keep theirs): S9's clear path B.
        deletePending(rates, malId, f)
        await pending.save(owner, rates)
        patchCache(side, ownerId, malId, { [f]: v })
        await stripQueued(side, malId, f)
        await advanceTrackerBase(side, ownerId, malId, f, v, rec.at[party]?.at ?? t)
        trackerWrote = 'already'
      } else {
        const libraryIds = new Set(partyLibraryIds)
        if (existing) {
          const p = existing.provenance
          for (const id of 'libraryId' in p ? [p.libraryId] : p.libraryIds) libraryIds.add(id)
        }
        const provenance: SyncProvenance = { resolution: rec.id, libraryIds: [...libraryIds] }
        putPending(side, rates, ownerId, malId, f, { value: v, ...clock }, provenance, false)
        // The tracker leg read the conflict's server value no earlier than the
        // patch it covers, so a Forget reverts to it (unless a refresh is newer).
        const trackerAt = rec.at[party]?.at
        const p = rates[String(malId)]![f]!
        if (
          party in rec.parties &&
          trackerAt !== undefined &&
          trackerAt >= parseAt(p.prePatch.serverUpdatedAt)
        ) {
          p.prePatch = {
            value: rec.parties[party] as number | string,
            serverUpdatedAt: new Date(trackerAt).toISOString()
          }
        }
        await pending.save(owner, rates)
        patchCache(side, ownerId, malId, { [f]: v })
        const queue = store.get<QueuedShikimoriUpdate[] | undefined>(side.keys.updateQueue) ?? []
        const before = { ...NO_RATE_BEFORE }
        for (const g of RATE_FIELDS) {
          const s = serverOf(g)
          if (s !== null) (before as Record<string, unknown>)[g] = s
        }
        const lastAfter = queue.filter((q) => q.malId === malId).at(-1)?.after
        const entry: QueuedShikimoriUpdate = {
          malId,
          rateId: cached?.remoteId ?? null,
          before: rateValues(before as RateValues),
          after: { ...rateValues((lastAfter ?? before) as RateValues), [f]: v },
          queuedAt: Math.max(t, ...queue.map((q) => q.queuedAt + 1)),
          fields: [f],
          resolvedFields: [f],
          origin: { kind: 'sync-merge', provenance: { [f]: provenance } }
        }
        const next = mergeQueues(queue, [entry])
        store.set(side.keys.updateQueue, next)
        broadcastQueue(side, next.length)
        trackerWrote = 'queued'
        queued = side.id
      }
      wroteLocal = true
    }
    const wrote: Extract<import('./log').SyncLogRecord, { kind: 'resolution' }>['wrote'] = {
      local: wroteLocal,
      libraries: [],
      shikimori: side.id === 'shikimori' ? trackerWrote : 'none',
      ...(side.id !== 'shikimori' ? { tracker: { id: side.id, status: trackerWrote } } : {})
    }

    // The drives: every connected, writable library of the record's owner holding the title.
    const local = animeId === null ? null : projectLocal()
    /**
     * A party library that can't be written now: its base for this field moves
     * to the value the conflict showed for it (never to the choice), so the next
     * run sees only this PC's change and writes the choice silently. If the
     * library changed again meanwhile (another PC's choice), that run holds a
     * new conflict. A library that wasn't a party already agrees with its base.
     */
    async function holdForNextRun(lib: AttachedLibraryInfo): Promise<void> {
      const party = `library:${lib.libraryId}`
      if (!(party in rec.parties)) return
      const base = await bases.read(`library-${lib.libraryId}`)
      if (!base) return
      const doc = normalizeDoc(base.doc)
      if (putField(doc, animeId!, rec, rec.parties[party], rec.at[party] ?? clock, undefined)) {
        await bases.write(`library-${lib.libraryId}`, {
          stateGeneration: base.stateGeneration,
          doc
        })
      }
    }
    for (const lib of libs) {
      const party = `library:${lib.libraryId}` in rec.parties
      if (!titlesOf(lib).some((ti) => String(ti.animeId) === animeId)) {
        if (party)
          notes.push(
            `${lib.name} no longer has this title, so the choice was applied on this PC and for ${side.label} only.`
          )
        continue
      }
      const skip = librarySkip(lib)
      if (skip) {
        await holdForNextRun(lib)
        notes.push(
          skip.driveReason === 'read-only'
            ? `${lib.name} is read-only on this PC. It gets this choice once this PC can write to it.`
            : `${lib.name} isn't connected. It gets this choice on its next sync.`
        )
        continue
      }
      const read = (await inspectLibrary(lib.root)).result
      if (
        read.status === 'none' ||
        read.status === 'read-only' ||
        read.manifest.libraryId !== lib.libraryId ||
        read.manifest.mode !== 'metadata' ||
        !sameOwnerKey(read.manifest.owner, owner)
      ) {
        await holdForNextRun(lib)
        notes.push(`${lib.name} couldn't be read. It gets this choice on its next sync.`)
        continue
      }
      const doc = normalizeDoc(structuredClone(read.state?.doc ?? null))
      const base = await bases.read(`library-${lib.libraryId}`)
      const fallback = local?.titles[animeId!] ?? base?.doc.titles[animeId!]
      if (!putField(doc, animeId!, rec, value, clock, fallback)) {
        await holdForNextRun(lib)
        notes.push(
          `${lib.name} has no entry for this field yet, so the choice wasn't written there.`
        )
        continue
      }
      let stateGeneration: number
      try {
        const actor = buildActor(store, lib.libraryId, deps.appVersion)
        const w = await writeState(
          lib.root,
          doc as SharedSyncDoc,
          actor,
          read.manifest.stateGeneration
        )
        stateGeneration = w.stateGeneration
        void attached.refresh(lib.libraryId, lib.root).catch(() => {})
      } catch (err) {
        if (READ_ONLY_CODES.has(errCode(err) ?? '')) attached.reportWriteFailure(lib.libraryId, err)
        log.warn(`[sync] ${lib.name}: the resolution's drive write failed`, err)
        await holdForNextRun(lib)
        notes.push(`${lib.name} couldn't be written. It gets this choice on its next sync.`)
        continue
      }
      wrote.libraries.push(lib.libraryId)
      if (base) {
        const nextBase = normalizeDoc(base.doc)
        putField(nextBase, animeId!, rec, value, clock, doc.titles[animeId!])
        await bases.write(`library-${lib.libraryId}`, { stateGeneration, doc: nextBase })
      }
    }

    await syncLog.append({
      kind: 'resolution',
      at: t,
      conflictId: rec.id,
      animeId: rec.animeId,
      fieldPath: rec.fieldPath,
      choice: choiceName(choice),
      value,
      libraryIds: partyLibraryIds,
      wrote,
      notes
    })
    return { notes, queued }
  }

  async function resolve(
    conflictIds: string[],
    choices: Record<string, SyncConflictChoice>
  ): Promise<SyncResolveResult> {
    const out: SyncResolveResult = { resolved: [], failed: [], notes: [] }
    // The trackers a resolution queued to: each one's drain is kicked (#715).
    const kicks = new Set<TrackerId>()
    await locked(async () => {
      const files = await conflictStore.readAll()
      const done = new Map<TrackerId, Set<string>>()
      for (const id of new Set(Array.isArray(conflictIds) ? conflictIds : [])) {
        const file = files.find((f) => f.records.some((r) => r.id === id))
        const rec = file?.records.find((r) => r.id === id)
        if (!file || !rec) {
          out.failed.push({ id, reason: 'This conflict is no longer held.' })
          continue
        }
        const choice = choices?.[id]
        const value = choice ? choiceValue(rec, choice) : undefined
        if (value === undefined) {
          out.failed.push({ id, reason: 'Pick a value for this row.' })
          continue
        }
        try {
          const r = await resolveOne(rec, file.provider, choice!, value)
          if (r.failed) {
            out.failed.push({ id, reason: r.failed })
            continue
          }
          if (!done.has(file.provider)) done.set(file.provider, new Set())
          done.get(file.provider)!.add(id)
          out.resolved.push(id)
          for (const text of r.notes) out.notes.push({ id, text })
          if (r.queued) kicks.add(r.queued)
        } catch (err) {
          log.error('[sync] a resolution failed:', err)
          out.failed.push({ id, reason: "This choice couldn't be applied." })
        }
      }
      // One filtered write per file: each record back to the file it came from.
      for (const [provider, ids] of done) {
        await conflictStore.write(
          provider,
          (await conflictStore.read(provider)).filter((r) => !ids.has(r.id))
        )
      }
    })
    for (const id of kicks) kick(sides.get(id)!)
    return out
  }

  // --- runs ------------------------------------------------------------------------------------

  /**
   * The leg an owned library's results come from (#715): its owner tracker's
   * signed-in account. A hand-written v2 `provider: 'shikimori'` library is
   * Shikimori's, grouped with that user's v1 libraries; a non-canonical one
   * is foreign and never `owner`.
   */
  function legOwnerOf(lib: AttachedLibraryInfo): { side: Side; ownerId: number } | null {
    if (lib.mode !== 'metadata' || lib.role !== 'owner') return null
    const side = sideOf(lib.ownerProvider)
    if (!side || (side.id !== 'shikimori' && !side.leg)) return null
    const ownerId = side.user()
    return ownerId === null ? null : { side, ownerId }
  }

  /** Why a library got no tracker leg, on its owner's tracker (#715). */
  function skipReason(lib: AttachedLibraryInfo, side: Side): SyncLegReason {
    if (lib.role === 'claim') return 'claim'
    if (side.user() === null) return 'logged-out'
    if (deps.isOffline()) return 'offline'
    return 'foreign'
  }

  /**
   * A library's tracker side with no leg: Shikimori's fields as before, or
   * `tracker` for a library a non-Shikimori account owns. `reason: false` is
   * the export's form, which never carried one.
   */
  function skippedPart(
    lib: AttachedLibraryInfo,
    opts: { reason?: boolean } = {}
  ): Pick<SyncLibraryResult, 'shikimori' | 'shikimoriReason' | 'tracker'> {
    const withReason = opts.reason !== false
    const side = sideOf(lib.ownerProvider)
    if (!side || side.id === 'shikimori') {
      return {
        shikimori: 'skipped',
        ...(withReason ? { shikimoriReason: skipReason(lib, shikiSide) as never } : {})
      }
    }
    return {
      shikimori: 'skipped',
      tracker: {
        id: side.id,
        status: 'skipped',
        ...(withReason ? { reason: skipReason(lib, side) } : {})
      }
    }
  }

  /** A leg's outcome as the result's tracker side. */
  function legPart(
    side: Side,
    o: LegOutcome
  ): Pick<SyncLibraryResult, 'shikimori' | 'shikimoriReason' | 'tracker'> {
    if (side.id === 'shikimori') {
      return {
        shikimori: o.status,
        ...(o.reason
          ? { shikimoriReason: o.reason as NonNullable<SyncLibraryResult['shikimoriReason']> }
          : {})
      }
    }
    return {
      shikimori: 'skipped',
      tracker: { id: side.id, status: o.status, ...(o.reason ? { reason: o.reason } : {}) }
    }
  }

  /** A run's fallback when a library's result never came: the drive's `io` error (§9). */
  function skippedResult(
    lib: AttachedLibraryInfo,
    opts: { reason?: boolean } = {}
  ): SyncLibraryResult {
    return {
      libraryId: lib.libraryId,
      drive: 'error',
      driveReason: 'io',
      ...skippedPart(lib, opts),
      counts: emptyCounts(),
      waitingMalIds: [],
      rewatchesSuperseded: 0
    }
  }

  async function run(
    trigger: SyncTrigger,
    pick: (lib: AttachedLibraryInfo) => boolean,
    animeId: string | null
  ): Promise<SyncRunResult> {
    const runId = makeId()
    const libs = attached.list().filter(pick)
    const joined = new Map<string, Promise<SyncLibraryResult>>()
    const fresh: AttachedLibraryInfo[] = []
    const settle = new Map<string, (r: SyncLibraryResult) => void>()
    for (const lib of libs) {
      const running = inflight.get(lib.libraryId)
      if (running) {
        joined.set(lib.libraryId, running)
        continue
      }
      fresh.push(lib)
      const p = new Promise<SyncLibraryResult>((resolve) => settle.set(lib.libraryId, resolve))
      inflight.set(lib.libraryId, p)
      joined.set(lib.libraryId, p)
    }
    const record: Extract<import('./log').SyncLogRecord, { kind: 'run' }> = {
      kind: 'run',
      runId,
      trigger,
      at: now(),
      libraries: fresh.map((l) => l.libraryId),
      counts: emptyCounts(),
      changes: [],
      details: [],
      conflicts: [],
      clamps: [],
      skippedMalIds: [],
      raises: [],
      resolvedElsewhere: [],
      result: { runId, trigger, libraries: [] }
    }
    const results = new Map<string, SyncLibraryResult>()
    try {
      const outcomes = await locked(async () => {
        const o = new Map<string, Outcome>()
        for (const lib of fresh) {
          try {
            o.set(lib.libraryId, await libraryLeg(lib, runId, animeId))
          } catch (err) {
            log.error(`[sync] the library leg failed for ${lib.name}:`, err)
            o.set(lib.libraryId, {
              drive: 'error',
              driveReason: 'io',
              counts: emptyCounts(),
              changes: [],
              conflicts: [],
              clamps: [],
              raises: [],
              resolvedElsewhere: []
            })
          }
        }
        return o
      })
      // One leg per owner on the owner's tracker (#715), over the union of that
      // owner's in-scope titles.
      const owners = new Map<string, { side: Side; ownerId: number; ids: string[] }>()
      for (const lib of fresh) {
        const g = legOwnerOf(lib)
        if (!g) continue
        const key = `${g.side.id}:${g.ownerId}`
        const id = lib.libraryId
        const titles = (attached.get(id)?.titles ?? lib.titles).map((ti) => String(ti.animeId))
        const scoped = animeId === null ? titles : titles.filter((x) => x === animeId)
        const prev = owners.get(key)
        owners.set(key, { ...g, ids: [...new Set([...(prev?.ids ?? []), ...scoped])] })
      }
      const legs = new Map<string, LegOutcome>()
      for (const [key, { side, ownerId, ids }] of owners) {
        if (side.user() === ownerId && !deps.isOffline()) {
          await (side.id === 'shikimori' ? deps.sync.drainNow() : side.leg!.sync.drainNow())
        }
        try {
          legs.set(key, await locked(() => trackerLeg(side, ownerId, ids, runId)))
        } catch (err) {
          log.error(`[sync] the ${side.label} leg failed:`, err)
          legs.set(key, {
            status: 'error',
            // Through the owner's provider (#715); Shikimori's split as before.
            reason:
              side.id === 'shikimori'
                ? isNetworkError(err)
                  ? 'network'
                  : 'api'
                : legReasonOf(side.leg!.provider.classifyError(err)),
            waitingMalIds: [],
            rewatchesSuperseded: 0,
            counts: { applied: 0, conflicts: 0 },
            conflicts: [],
            resolvedElsewhere: []
          })
        }
      }
      for (const lib of fresh) {
        const o = outcomes.get(lib.libraryId)!
        const g = legOwnerOf(lib)
        const s = g ? legs.get(`${g.side.id}:${g.ownerId}`) : undefined
        const part = g && s ? legPart(g.side, s) : skippedPart(lib)
        const r: SyncLibraryResult = {
          libraryId: lib.libraryId,
          drive: o.drive,
          ...(o.driveReason ? { driveReason: o.driveReason } : {}),
          ...part,
          counts: {
            applied: o.counts.applied + (s?.counts.applied ?? 0),
            conflicts: o.counts.conflicts + (s?.counts.conflicts ?? 0),
            clamped: o.counts.clamped
          },
          waitingMalIds: s ? [...s.waitingMalIds] : [],
          rewatchesSuperseded: s?.rewatchesSuperseded ?? 0
        }
        results.set(lib.libraryId, r)
        record.counts.applied += r.counts.applied
        record.counts.conflicts += r.counts.conflicts
        record.counts.clamped += r.counts.clamped
        record.changes.push(...o.changes)
        record.details!.push(...(o.details ?? []))
        record.conflicts.push(...o.conflicts)
        record.clamps.push(...o.clamps)
        record.raises.push(...o.raises)
        record.resolvedElsewhere.push(...o.resolvedElsewhere)
      }
      for (const s of legs.values()) {
        record.details!.push(...(s.details ?? []))
        record.skippedMalIds.push(...s.waitingMalIds)
        record.conflicts.push(...s.conflicts)
        record.resolvedElsewhere.push(...s.resolvedElsewhere)
      }
    } finally {
      for (const lib of fresh) {
        const r = results.get(lib.libraryId) ?? skippedResult(lib)
        lastResults.set(lib.libraryId, withLeg(r))
        settle.get(lib.libraryId)!(r)
        inflight.delete(lib.libraryId)
      }
    }
    const libraries: SyncLibraryResult[] = []
    for (const lib of libs) libraries.push(await joined.get(lib.libraryId)!)
    const result: SyncRunResult = { runId, trigger, libraries }
    record.result = result
    if (record.details!.length > LOG_MAX_DETAILS) record.details!.length = LOG_MAX_DETAILS
    if (fresh.length > 0) {
      // Under the mutex, as every other append: the size bound rewrites the file.
      await locked(() => syncLog.append(record)).catch((err) =>
        log.warn('[sync] could not write the sync log', err)
      )
    }
    // The derived leg goes on what the runner hands out, after the log record (§9).
    const handed = withLegs(result)
    deps.broadcast(deps.runFinishedChannel ?? EVENT_CHANNELS.SYNC_RUN_FINISHED, handed)
    return handed
  }

  /** The export target's owner provider, read before the leg: its results name that tracker. */
  async function exportOwner(root: string): Promise<SharedLibraryManifest['owner'] | null> {
    try {
      const r = (await inspectLibrary(root)).result
      return r.status === 'none' ? null : (r.manifest?.owner ?? null)
    } catch {
      return null
    }
  }

  async function runExport(target: {
    libraryId: string
    root: string
    name: string
  }): Promise<SyncLibraryResult> {
    const { libraryId } = target
    // After any run of this library in flight; `idle` (Forget) waits for this one.
    for (let r = inflight.get(libraryId); r; r = inflight.get(libraryId)) await r
    let settle!: (r: SyncLibraryResult) => void
    inflight.set(libraryId, new Promise<SyncLibraryResult>((resolve) => (settle = resolve)))
    const runId = makeId()
    const manifestOwner = await exportOwner(target.root)
    const lib: AttachedLibraryInfo = {
      ...target,
      mode: 'metadata',
      ownerNickname: null,
      // The leg reads the owner from the manifest; this names its tracker in the result.
      ownerProvider: ownerOf(manifestOwner)?.provider ?? 'shikimori',
      layoutVersion: isTrackerOwner(manifestOwner) ? 2 : 1,
      role: 'owner',
      access: 'read-write',
      available: true,
      lastSeenAt: now(),
      lastSyncAt: null,
      pathOverflow: 0,
      mkvCount: 0,
      titles: []
    }
    let o: Outcome
    let r: SyncLibraryResult | undefined
    try {
      try {
        o = await locked(() => libraryLeg(lib, runId, null, true))
      } catch (err) {
        log.error(`[sync] the export's library leg failed for ${target.name}:`, err)
        o = {
          drive: 'error',
          driveReason: 'io',
          counts: emptyCounts(),
          changes: [],
          conflicts: [],
          clamps: [],
          raises: [],
          resolvedElsewhere: []
        }
      }
      r = {
        libraryId,
        drive: o.drive,
        ...(o.driveReason ? { driveReason: o.driveReason } : {}),
        ...skippedPart(lib, { reason: false }),
        counts: o.counts,
        waitingMalIds: [],
        rewatchesSuperseded: 0
      }
      const result: SyncRunResult = { runId, trigger: 'export', libraries: [r] }
      await locked(() =>
        syncLog.append({
          kind: 'run',
          runId,
          trigger: 'export',
          at: now(),
          libraries: [libraryId],
          counts: o.counts,
          changes: o.changes,
          details: (o.details ?? []).slice(0, LOG_MAX_DETAILS),
          conflicts: o.conflicts,
          clamps: o.clamps,
          skippedMalIds: [],
          raises: o.raises,
          resolvedElsewhere: o.resolvedElsewhere,
          result
        })
      ).catch((err) => log.warn('[sync] could not write the sync log', err))
      deps.broadcast(deps.runFinishedChannel ?? EVENT_CHANNELS.SYNC_RUN_FINISHED, withLegs(result))
      return withLeg(r)
    } finally {
      const done: SyncLibraryResult = r ?? skippedResult(lib, { reason: false })
      lastResults.set(libraryId, withLeg(done))
      settle(done)
      inflight.delete(libraryId)
    }
  }

  const safe = (fn: () => Promise<unknown>) => (): void => {
    void fn().catch((err) => log.error('[sync] a triggered run failed:', err))
  }

  /**
   * What Forget's pending count compares with the library base (#715): this
   * PC's projection through the library owner's tracker, with its pending
   * overlay while this PC is signed in as that owner.
   */
  async function projectForLibrary(libraryId: string, scope: string[]): Promise<SyncDoc> {
    const rec = store.get<Record<string, AttachedLibraryRecord> | undefined>('attachedLibraries')?.[
      libraryId
    ]
    const normalized = ownerOf(rec?.trackerOwner ?? rec?.owner)
    const side = (normalized && sideOf(normalized.provider)) || shikiSide
    const userId = side.user()
    const owner: Owner = { provider: side.id, userId: String(userId) }
    const rates = userId !== null ? await pending.load(owner) : {}
    return projectSyncDoc(store, scope, {
      resolveEpisodeFile: (id, ep, fp) => deps.resolveEpisodeFile?.(id, ep, fp) ?? null,
      pendingRates:
        userId !== null
          ? (o, malId) =>
              o === userId
                ? overlay(store, o, malId, rates, { skipUnconfirmed: true }, [], side.id)
                : undefined
          : undefined,
      malIdOf: malIdOfUnion(),
      ...(side.rate ? { tracker: side.rate } : {})
    })
  }

  const runner: SyncRunner = {
    runAll: (trigger) => run(trigger, () => true, null),
    runLibrary: (libraryId, trigger) => run(trigger, (l) => l.libraryId === libraryId, null),
    runTitle: (animeId, trigger) =>
      run(
        trigger,
        (l) =>
          l.mode === 'metadata' &&
          (l.role === 'owner' || l.role === 'claim') &&
          l.titles.some((t) => t.animeId === animeId),
        String(animeId)
      ),
    runExport,
    async idle(libraryId) {
      await inflight.get(libraryId)?.catch(() => {})
    },
    async status() {
      const records = (await conflictStore.readAll({ lenient: true })).flatMap((f) => f.records)
      const libraries: SyncStatus['libraries'] = {}
      for (const lib of attached.list()) {
        const party = `library:${lib.libraryId}`
        libraries[lib.libraryId] = {
          last: lastResults.get(lib.libraryId) ?? null,
          needReview: records.filter((r) => party in r.parties).length
        }
      }
      return { running: [...inflight.keys()], libraries }
    },
    quiesce: () => locked(async () => {}),
    start(opts = {}) {
      if (opts.triggers !== false) {
        unsubscribe.push(
          attached.onAvailabilityChanged((t) => {
            if (t.available && t.access === 'read-write') {
              safe(() => runner.runLibrary(t.libraryId, 'plug'))()
            }
          })
        )
        if (deps.onOnline) unsubscribe.push(deps.onOnline(safe(() => runner.runAll('online'))))
      }
      unsubscribe.push(
        deps.sync.onItemSettled((e) => {
          void locked(() => onSettled(shikiSide, e as TrackerItemSettled<unknown>)).catch((err) =>
            log.error('[sync] settle failed:', err)
          )
        })
      )
      // Each owner tracker's settles too (#715): path C and the drop counter per owner key.
      for (const side of sides.values()) {
        if (!side.leg) continue
        unsubscribe.push(
          side.leg.sync.onItemSettled((e) => {
            void locked(() => onSettled(side, e)).catch((err) =>
              log.error(`[sync] the ${side.label} settle failed:`, err)
            )
          })
        )
      }
      unsubscribe.push(
        attached.registerForgetHook(
          createForgetHook({
            store,
            locked,
            trackers,
            bases,
            pending,
            conflicts: conflictStore,
            attached,
            revertFields,
            projectLibrary: projectForLibrary
          })
        )
      )
    },
    stop() {
      for (const u of unsubscribe.splice(0)) u()
    },
    listConflicts,
    resolve,
    listHistory: (req) => listHistory(syncLog, req ?? {}, historyNames),
    syncLog
  }
  return runner
}

export const REJECTED_REASON = 'Shikimori rejected this change'

function rewatchSupersededReason(side: { id: TrackerId; label: string }): string {
  return side.id === 'shikimori'
    ? REWATCH_SUPERSEDED_REASON
    : `your rewatch didn't count because ${side.label} changed after it`
}

function rateValuesOf(rate: SyncRateState): RateValues {
  return rateValues({
    episodes: rate.episodes.value,
    status: rate.status.value as RateValues['status'],
    score: rate.score.value,
    rewatches: rate.rewatches.value
  })
}
