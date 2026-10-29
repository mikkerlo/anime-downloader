import * as fs from 'fs'
import * as path from 'path'
import * as shikimori from '../../shikimori'
import { isNetworkError } from '../../lib/errors'
import { createListenerSet } from '../../lib/listener-set'
import {
  consolidateQueue,
  dropFromParked,
  type ConsolidatedWorkItem,
  recordServerError,
  recordServerErrorInParked,
  type ParkedQueues,
  type QueuedShikimoriUpdate
} from '../../lib/shikimori-queue'
import type { StorageService } from '../../store/types'

export type ShikiSyncState = 'idle' | 'syncing'

export interface ShikiSyncStatus {
  state: ShikiSyncState
  queueLength: number
  lastSyncAt: number
  lastSyncError: string | null
  /** The stored refresh token was rejected; the user must sign in again. */
  sessionExpired: boolean
}

export interface CalendarEntry {
  malId: number
  animeId: number | null
  name: string
  posterUrl: string
  kind: string
  episodeInt: string
  nextEpisodeAt: string
  userStatus: shikimori.ShikiUserRateStatus
}

// Display snapshots (#568), each kept for the Shikimori user it was fetched
// for: a mismatch reads as no snapshot. Offline they are served whatever their
// age. They persist to `snapshotsPath` (#570), never to `config.json`.
export interface CachedCalendar {
  data: CalendarEntry[]
  fetchedAt: number
  userId: number | null
  /** Set by `invalidateCalendarCache()`: online a miss, offline still served. */
  invalidated: boolean
}

export interface CachedFriendsActivity {
  data: ShikiFriendActivityEntry[]
  fetchedAt: number
  userId: number | null
}

/** `userData/shikimori-snapshots.json`: one signed-in user's snapshots. */
interface SnapshotsFile {
  version: 1
  userId: number
  calendar?: { data: CalendarEntry[]; fetchedAt: number }
  friendsActivity?: { data: ShikiFriendActivityEntry[]; fetchedAt: number }
}

const SYNC_TIMER_MS = 60_000
const SYNC_ITEM_DELAY_MS = 250

const PREFETCH_INTER_REQUEST_MS = 2000
const PREFETCH_STALENESS_MS = 30 * 24 * 60 * 60 * 1000
// The worklist covers every rated anime so favorite-genres aggregation (#183) is
// complete, but these statuses are fetched first — they back the AnimeDetailView
// Shikimori panel, the worker's original purpose, so they must not wait behind a
// large completed/dropped backlog.
const PREFETCH_PRIORITY_STATUSES = new Set<shikimori.ShikiUserRateStatus>([
  'watching',
  'rewatching',
  'planned'
])

export const CALENDAR_CACHE_TTL_MS = 5 * 60 * 1000

const STATUS_ORDER: Record<shikimori.ShikiUserRateStatus, number> = {
  planned: 0,
  watching: 1,
  rewatching: 1,
  on_hold: 2,
  dropped: 2,
  completed: 3
}

export interface ShikimoriSyncServiceDeps {
  store: StorageService
  /**
   * Cross-channel broadcaster — the service emits sync-status / offline-queue /
   * rate-updated / anime-details-updated events that the renderer subscribes to.
   */
  broadcast: (channel: string, ...args: unknown[]) => void
  syncStatusChannel: string
  offlineQueueChangedChannel: string
  rateUpdatedChannel: string
  animeDetailsUpdatedChannel: string
  /**
   * While offline (#567) the drain and the prefetch return before touching the
   * network; writes keep queueing, and the online edge drains them.
   */
  isOffline?: () => boolean
  /**
   * Where the calendar and friends-activity snapshots persist (#570), loaded at
   * creation for the signed-in user only. Unset keeps them in memory.
   */
  snapshotsPath?: string
}

export interface ShikimoriSyncService {
  getQueueLength(): number
  getSyncStatus(): ShikiSyncStatus
  broadcastSyncStatus(): void
  startSyncTimer(): void
  stopSyncTimer(): void
  adjustSyncTimer(): void
  syncShikimoriQueue(): Promise<void>
  prefetchShikimoriDetails(): Promise<void>
  refreshShikimoriDetailsForMalId(malId: number): Promise<shikimori.ShikiAnimeDetails | null>
  setOnDetailsPrefetched(cb: () => void): void
  abortPrefetch(): void
  invalidateCalendarCache(): void
  getCachedCalendar(): CachedCalendar | null
  /** `userId` defaults to the signed-in user; stored only while that user is signed in. */
  setCachedCalendar(data: CalendarEntry[], userId?: number | null): CachedCalendar
  getCachedFriendsActivity(): CachedFriendsActivity | null
  setCachedFriendsActivity(userId: number, data: ShikiFriendActivityEntry[]): CachedFriendsActivity
  /** Drops both snapshots and their file: logout and account switch. */
  clearOfflineSnapshots(): void
  /** Waits for a drain in flight, then drains once (#584). Never rejects. */
  drainNow(): Promise<void>
  /**
   * Runs `fn` with no drain in flight: waits for one already running, and keeps
   * any new drain from starting until `fn` settles (#584's Forget).
   */
  withQueueLock<T>(fn: () => T | Promise<T>): Promise<T>
  /** Every consumed work item's outcome (#584). Multi-listener; returns an unsubscribe. */
  onItemSettled(listener: (e: ShikiItemSettled) => void): () => void
}

/**
 * One consumed drain item (#584). `fieldsApplied` hold the entry's value on
 * the server now; `fieldsKeptByServer` kept the server's. `dropped` is a 4xx
 * (or a 5xx past its window): nothing applied.
 */
export interface ShikiItemSettled {
  ownerId: number
  malId: number
  consumedQueuedAts: number[]
  outcome: 'applied' | 'created' | 'partial' | 'server-won' | 'dropped'
  rate: shikimori.ShikiUserRate | null
  fieldsApplied: SyncRateField[]
  fieldsKeptByServer: SyncRateField[]
  after: QueuedShikimoriUpdate['after']
  provenance?: Partial<Record<SyncRateField, SyncProvenance>>
  error?: string
}

const RATE_FIELDS: readonly SyncRateField[] = ['episodes', 'status', 'score', 'rewatches']

type RateFieldValues = QueuedShikimoriUpdate['after']

function valuesOf(rate: shikimori.ShikiUserRate): RateFieldValues {
  return {
    episodes: rate.episodes,
    status: rate.status,
    score: rate.score,
    rewatches: rate.rewatches ?? 0
  }
}

// An entry queued before `rewatches` was recorded has none: it means 0.
function beforeOf(item: Pick<ConsolidatedWorkItem, 'before'>, f: SyncRateField): number | string {
  return f === 'rewatches' ? (item.before.rewatches ?? 0) : item.before[f]
}

/** The fields an item means to change: a scoped entry's own, otherwise every rate field. */
function intendedFields(item: ConsolidatedWorkItem): SyncRateField[] {
  if (!item.fields) return [...RATE_FIELDS]
  return RATE_FIELDS.filter((f) => item.fields!.includes(f) || item.resolvedFields?.includes(f))
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
  current: { episodes: number; status: shikimori.ShikiUserRateStatus },
  after: { episodes: number; status: shikimori.ShikiUserRateStatus; score: number }
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

/**
 * Owns the Shikimori sync timer, offline-queue drain worker, anime-details
 * prefetcher, and calendar cache (refactor epic #84, Phase 3 slice 3d).
 *
 * All module-level state that previously lived in `src/main/index.ts`
 * (syncInProgress, syncTimer, lastSyncAt/Error, prefetchInProgress/Abort,
 * calendarCache) now lives in this closure.
 */
export function createShikimoriSyncService(deps: ShikimoriSyncServiceDeps): ShikimoriSyncService {
  const { store, broadcast } = deps

  let syncInProgress = false
  let syncTimer: NodeJS.Timeout | null = null
  let lastSyncAt = 0
  let lastSyncError: string | null = null

  let prefetchInProgress = false
  let prefetchAbort = false
  // Set by the IPC layer (#183) to recompute the profile's favorite-genres panel
  // once a prefetch run has widened the cached-details coverage.
  let onDetailsPrefetched: (() => void) | undefined

  let calendarCache: CachedCalendar | null = null
  let friendsActivityCache: CachedFriendsActivity | null = null

  function getQueueLength(): number {
    return (store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]).length
  }

  function getSyncStatus(): ShikiSyncStatus {
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
      sessionExpired: Boolean(store.get('shikimoriSessionExpired'))
    }
  }

  function broadcastSyncStatus(): void {
    broadcast(deps.syncStatusChannel, getSyncStatus())
  }

  function startSyncTimer(): void {
    if (syncTimer) return
    syncTimer = setInterval(() => {
      void syncShikimoriQueue()
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
    return (store.get('shikimoriUser') as shikimori.ShikiUser | null)?.id
  }

  // The drain's owner may have logged out or been switched away mid-item: its
  // entries are then parked, or gone after Discard, and never in the live queue
  // (#588). A missing bucket stays missing.
  function dropConsumedEntries(ownerId: number, malId: number, consumedQueuedAts: number[]): void {
    let queue = store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]
    if (currentUserId() === ownerId) {
      const consumed = new Set(consumedQueuedAts)
      queue = queue.filter((q) => !(q.malId === malId && consumed.has(q.queuedAt)))
      store.set('shikimoriUpdateQueue', queue)
    } else {
      const parked = (store.get('shikimoriParkedQueues') as ParkedQueues | undefined) ?? {}
      const next = dropFromParked(parked, String(ownerId), malId, consumedQueuedAts)
      if (next !== parked) store.set('shikimoriParkedQueues', next)
    }
    broadcast(deps.offlineQueueChangedChannel, { length: queue.length })
  }

  // Routed like dropConsumedEntries, so a stamp never lands in the next owner's
  // queue. Returns whether the item's 5xx window has expired.
  function recordConsumedServerError(
    ownerId: number,
    malId: number,
    consumedQueuedAts: number[]
  ): boolean {
    const now = Date.now()
    if (currentUserId() === ownerId) {
      const queue = store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]
      const result = recordServerError(queue, malId, consumedQueuedAts, now)
      if (result.entries !== queue) store.set('shikimoriUpdateQueue', result.entries)
      return result.expired
    }
    const parked = (store.get('shikimoriParkedQueues') as ParkedQueues | undefined) ?? {}
    const result = recordServerErrorInParked(parked, String(ownerId), malId, consumedQueuedAts, now)
    if (result.parked !== parked) store.set('shikimoriParkedQueues', result.parked)
    return result.expired
  }

  // An item in flight across a switch lands on the old account; the cache is
  // the new one's by then (#588).
  function reconcileCacheFromRate(
    ownerId: number,
    malId: number,
    rate: shikimori.ShikiUserRate
  ): void {
    if (currentUserId() !== ownerId) return
    const cached = store.get('shikimoriUserRates') as {
      rate: Record<string, unknown> & {
        id?: number
        target_id: number
        episodes: number
        status: shikimori.ShikiUserRateStatus
        score: number
        rewatches?: number
      }
      shikiAnime: unknown
      smotretAnime: unknown
    }[]
    const idx = cached.findIndex((e) => e.rate.target_id === malId)
    if (idx === -1) return
    cached[idx] = {
      ...cached[idx],
      rate: {
        ...cached[idx].rate,
        id: rate.id,
        episodes: rate.episodes,
        status: rate.status,
        score: rate.score,
        rewatches: rate.rewatches ?? 0,
        updated_at: new Date().toISOString()
      }
    }
    store.set('shikimoriUserRates', cached)
    invalidateCalendarCache()
    broadcast(deps.rateUpdatedChannel, cached[idx])
  }

  const settled = createListenerSet<[ShikiItemSettled]>('shikimori-item-settled')
  // The drain in flight, and Forget's queue lock (#584).
  let inFlight: Promise<void> | null = null
  let queueLock: Promise<void> | null = null
  let drainAfterLock = false

  function syncShikimoriQueue(): Promise<void> {
    if (syncInProgress || deps.isOffline?.()) return Promise.resolve()
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
      await syncShikimoriQueue()
      // Another caller's drain started meanwhile: it covers every entry queued so far.
      await inFlight?.catch(() => {})
    } catch (err) {
      console.warn('[shikimori sync] drainNow failed:', err)
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
        void syncShikimoriQueue()
      }
    }
  }

  async function drainOnce(): Promise<void> {
    if (syncInProgress || deps.isOffline?.()) return
    const queue = store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]
    if (queue.length === 0) {
      stopSyncTimer()
      return
    }
    const creds = store.get('shikimoriCredentials') as shikimori.ShikiCredentials | null
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!creds || !user) return

    syncInProgress = true
    broadcastSyncStatus()

    let accessToken: string
    try {
      accessToken = await shikimori.ensureFreshToken(store)
    } catch (err) {
      syncInProgress = false
      // The previous account's refresh failed after a switch: not this
      // session's error, and its timer is not this drain's to stop.
      if (currentUserId() !== user.id) {
        broadcastSyncStatus()
        void syncShikimoriQueue()
        return
      }
      if (!isNetworkError(err)) {
        lastSyncError = err instanceof Error ? err.message : String(err)
        console.warn('[shikimori sync] auth refresh failed:', err)
      }
      // `ensureFreshToken` has already cleared the credentials, so every later
      // tick would return at the `!creds` guard above without ever reaching
      // `adjustSyncTimer()` — a timer that can only spin. The queue is kept: it
      // replays once the user signs in again (#244).
      if (err instanceof shikimori.ShikiAuthError) stopSyncTimer()
      broadcastSyncStatus()
      return
    }

    const work = consolidateQueue(queue)
    let aborted = false
    let ownerChanged = false
    let hadServerError = false

    for (const item of work) {
      // A logout or account switch since the drain started: the rest of this
      // work list is someone else's now, and this token is the old owner's.
      if (currentUserId() !== user.id) {
        ownerChanged = true
        break
      }
      const intended = intendedFields(item)
      const settle = (
        outcome: ShikiItemSettled['outcome'],
        rate: shikimori.ShikiUserRate | null,
        sent: RateFieldValues | null,
        error?: string
      ): void => {
        const applied = sent ? intended.filter((f) => sent[f] === item.after[f]) : []
        settled.emit({
          ownerId: user.id,
          malId: item.malId,
          consumedQueuedAts: [...item.consumedQueuedAts],
          outcome,
          rate,
          fieldsApplied: applied,
          fieldsKeptByServer: sent ? intended.filter((f) => !applied.includes(f)) : [],
          after: { ...item.after },
          ...(item.origin ? { provenance: { ...item.origin.provenance } } : {}),
          ...(error !== undefined ? { error } : {})
        })
      }
      try {
        const current = await shikimori.getUserRate(accessToken, user.id, item.malId)

        if (!current) {
          const created = await shikimori.createUserRate(
            accessToken,
            user.id,
            item.malId,
            item.after.episodes,
            item.after.status,
            item.after.score,
            item.after.rewatches
          )
          reconcileCacheFromRate(user.id, item.malId, created)
          dropConsumedEntries(user.id, item.malId, item.consumedQueuedAts)
          settle('created', created, item.after)
        } else {
          const now = valuesOf(current)
          // `rewatches` is part of the drift check (#584): a rewatches-only drift is drift.
          const driftMatches = RATE_FIELDS.every((f) => now[f] === beforeOf(item, f))
          const sent = driftMatches ? item.after : driftPayload(item, now)
          let rate = current
          if (RATE_FIELDS.some((f) => sent[f] !== now[f]) || driftMatches) {
            rate = await shikimori.updateUserRate(
              accessToken,
              current.id,
              sent.episodes,
              sent.status,
              sent.score,
              sent.rewatches
            )
          }
          reconcileCacheFromRate(user.id, item.malId, rate)
          dropConsumedEntries(user.id, item.malId, item.consumedQueuedAts)
          const applied = intended.filter((f) => sent[f] === item.after[f])
          settle(
            applied.length === intended.length
              ? 'applied'
              : applied.length === 0
                ? 'server-won'
                : 'partial',
            rate,
            sent
          )
        }
      } catch (err) {
        if (isNetworkError(err)) {
          aborted = true
          break
        }
        // After a switch mid-item the error is the previous account's, so it
        // must not reach the session that signed in meanwhile.
        const ownerCurrent = currentUserId() === user.id
        if (err instanceof shikimori.ShikiApiError && (err.status === 401 || err.status === 403)) {
          aborted = true
          if (ownerCurrent) lastSyncError = err.message
          console.warn('[shikimori sync] auth error, stopping drain:', err)
          break
        }
        if (err instanceof shikimori.ShikiApiError && err.status === 429) {
          aborted = true
          if (ownerCurrent) lastSyncError = 'Shikimori rate limit — will retry'
          console.warn('[shikimori sync] rate limited, stopping drain:', err)
          break
        }
        // Often specific to one item, so the drain moves on instead of stopping.
        if (err instanceof shikimori.ShikiApiError && err.status >= 500 && err.status < 600) {
          if (recordConsumedServerError(user.id, item.malId, item.consumedQueuedAts)) {
            console.warn(
              '[shikimori sync] dropping item',
              item.malId,
              'after 24 h of server errors:',
              err.message
            )
            dropConsumedEntries(user.id, item.malId, item.consumedQueuedAts)
            settle('dropped', null, null, err.message)
          } else {
            hadServerError = true
            if (ownerCurrent) lastSyncError = 'Shikimori server error — will retry'
            console.warn('[shikimori sync] server error, keeping item', item.malId, err.status)
          }
        } else {
          console.warn('[shikimori sync] dropping item', item.malId, err)
          dropConsumedEntries(user.id, item.malId, item.consumedQueuedAts)
          settle('dropped', null, null, err instanceof Error ? err.message : String(err))
        }
      }

      if (work.indexOf(item) < work.length - 1) await sleep(SYNC_ITEM_DELAY_MS)
    }

    // The owner may have changed while the last item was awaiting the network.
    if (currentUserId() !== user.id) ownerChanged = true
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
    if (ownerChanged) void syncShikimoriQueue()
  }

  function getStaleOrMissingMalIds(): number[] {
    const rates = store.get('shikimoriUserRates') as {
      rate: { target_id?: number; status: shikimori.ShikiUserRateStatus }
      shikiAnime?: { id?: number }
    }[]
    const cache = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >
    const now = Date.now()
    const priority: number[] = []
    const rest: number[] = []
    for (const entry of rates) {
      const malId = entry.rate.target_id ?? entry.shikiAnime?.id
      if (typeof malId !== 'number' || !Number.isFinite(malId) || malId <= 0) continue
      const cached = cache[String(malId)]
      if (!cached || now - cached.fetchedAt > PREFETCH_STALENESS_MS) {
        ;(PREFETCH_PRIORITY_STATUSES.has(entry.rate.status) ? priority : rest).push(malId)
      }
    }
    return [...priority, ...rest]
  }

  async function refreshShikimoriDetailsForMalId(
    malId: number
  ): Promise<shikimori.ShikiAnimeDetails | null> {
    const creds = store.get('shikimoriCredentials') as shikimori.ShikiCredentials | null
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!creds || !user) return null
    let accessToken: string
    try {
      accessToken = await shikimori.ensureFreshToken(store)
    } catch (err) {
      if (!isNetworkError(err)) {
        console.warn('[shikimori] single-show refresh auth failed:', err)
      }
      return null
    }
    try {
      const details = await shikimori.getAnimeDetails(accessToken, malId)
      const cache = store.get('shikimoriAnimeDetails') as Record<
        string,
        { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
      >
      cache[String(malId)] = { details, fetchedAt: Date.now() }
      store.set('shikimoriAnimeDetails', cache)
      broadcast(deps.animeDetailsUpdatedChannel, { malId, details })
      return details
    } catch (err) {
      if (err instanceof shikimori.ShikiApiError && err.status >= 500 && err.status < 600) {
        console.warn('[shikimori] single-show refresh: server error', err.status, 'for', malId)
      } else if (!isNetworkError(err)) {
        console.warn('[shikimori] single-show refresh failed for', malId, err)
      }
      return null
    }
  }

  async function prefetchShikimoriDetails(): Promise<void> {
    if (prefetchInProgress || deps.isOffline?.()) return
    const creds = store.get('shikimoriCredentials') as shikimori.ShikiCredentials | null
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!creds || !user) return

    const work = getStaleOrMissingMalIds()
    if (work.length === 0) return

    prefetchInProgress = true
    prefetchAbort = false
    let fetched = 0

    try {
      let accessToken: string
      try {
        accessToken = await shikimori.ensureFreshToken(store)
      } catch (err) {
        if (!isNetworkError(err)) {
          console.warn('[shikimori prefetch] auth refresh failed:', err)
        }
        return
      }

      for (let i = 0; i < work.length; i++) {
        if (prefetchAbort) break
        const malId = work[i]
        try {
          const details = await shikimori.getAnimeDetails(accessToken, malId)
          const cache = store.get('shikimoriAnimeDetails') as Record<
            string,
            { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
          >
          cache[String(malId)] = { details, fetchedAt: Date.now() }
          store.set('shikimoriAnimeDetails', cache)
          fetched++
          broadcast(deps.animeDetailsUpdatedChannel, { malId, details })
        } catch (err) {
          if (isNetworkError(err)) {
            console.warn('[shikimori prefetch] network error, aborting loop:', err)
            break
          }
          if (
            err instanceof shikimori.ShikiApiError &&
            (err.status === 401 || err.status === 403)
          ) {
            console.warn('[shikimori prefetch] auth error, aborting loop:', err)
            break
          }
          if (err instanceof shikimori.ShikiApiError && err.status === 429) {
            console.warn('[shikimori prefetch] rate limited, aborting loop:', err)
            break
          }
          if (err instanceof shikimori.ShikiApiError && err.status === 404) {
            console.warn('[shikimori prefetch] anime', malId, 'not found, skipping')
          } else if (
            err instanceof shikimori.ShikiApiError &&
            err.status >= 500 &&
            err.status < 600
          ) {
            console.warn('[shikimori prefetch] server error', err.status, 'for', malId, 'skipping')
          } else {
            console.warn('[shikimori prefetch] error fetching', malId, err)
          }
        }
        if (i < work.length - 1) {
          await sleep(PREFETCH_INTER_REQUEST_MS)
        }
      }
    } finally {
      prefetchInProgress = false
    }

    // A fuller details cache means the profile's favorite-genres panel can be
    // recomputed with broader coverage (#183) — let the caller rebroadcast it.
    if (fetched > 0) onDetailsPrefetched?.()
  }

  function setOnDetailsPrefetched(cb: () => void): void {
    onDetailsPrefetched = cb
  }

  function abortPrefetch(): void {
    prefetchAbort = true
  }

  function isCurrentUser(userId: number | null): boolean {
    return userId === (currentUserId() ?? null)
  }

  function ownSnapshot<T extends { userId: number | null }>(snapshot: T | null): T | null {
    return snapshot && isCurrentUser(snapshot.userId) ? snapshot : null
  }

  function invalidateCalendarCache(): void {
    if (calendarCache) calendarCache = { ...calendarCache, invalidated: true }
  }

  function getCachedCalendar(): CachedCalendar | null {
    return ownSnapshot(calendarCache)
  }

  function setCachedCalendar(
    data: CalendarEntry[],
    userId: number | null = currentUserId() ?? null
  ): CachedCalendar {
    const snapshot: CachedCalendar = { data, fetchedAt: Date.now(), userId, invalidated: false }
    // A fetch that outlived an account switch must not evict the new user's snapshot.
    if (isCurrentUser(userId)) {
      calendarCache = snapshot
      persistSnapshots(userId)
    }
    return snapshot
  }

  function getCachedFriendsActivity(): CachedFriendsActivity | null {
    return ownSnapshot(friendsActivityCache)
  }

  function setCachedFriendsActivity(
    userId: number,
    data: ShikiFriendActivityEntry[]
  ): CachedFriendsActivity {
    const snapshot: CachedFriendsActivity = { data, fetchedAt: Date.now(), userId }
    if (isCurrentUser(userId)) {
      friendsActivityCache = snapshot
      persistSnapshots(userId)
    }
    return snapshot
  }

  function clearOfflineSnapshots(): void {
    calendarCache = null
    friendsActivityCache = null
    deleteSnapshotsFile()
  }

  function deleteSnapshotsFile(): void {
    if (!deps.snapshotsPath) return
    try {
      fs.rmSync(deps.snapshotsPath, { force: true })
    } catch (err) {
      console.warn('[shikimori] could not delete the offline snapshots:', err)
    }
  }

  // Tmp + rename, so a crash mid-write leaves the previous file whole.
  function persistSnapshots(userId: number | null): void {
    const file = deps.snapshotsPath
    if (!file || userId === null) return
    const body: SnapshotsFile = { version: 1, userId }
    if (calendarCache?.userId === userId) {
      body.calendar = { data: calendarCache.data, fetchedAt: calendarCache.fetchedAt }
    }
    if (friendsActivityCache?.userId === userId) {
      body.friendsActivity = {
        data: friendsActivityCache.data,
        fetchedAt: friendsActivityCache.fetchedAt
      }
    }
    const tmp = `${file}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(body))
      fs.renameSync(tmp, file)
    } catch (err) {
      console.warn('[shikimori] could not persist the offline snapshots:', err)
    }
  }

  // Kept only for the signed-in user; anything else is deleted. A loaded
  // calendar starts invalidated: online the first open refetches, offline it
  // is served stale.
  function loadSnapshots(): void {
    const file = deps.snapshotsPath
    if (!file) return
    let parsed: Partial<SnapshotsFile> | null = null
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SnapshotsFile>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    }
    const userId = currentUserId()
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.userId !== 'number' ||
      parsed.userId !== userId
    ) {
      deleteSnapshotsFile()
      return
    }
    const { calendar, friendsActivity } = parsed
    if (calendar && Array.isArray(calendar.data) && typeof calendar.fetchedAt === 'number') {
      calendarCache = {
        data: calendar.data,
        fetchedAt: calendar.fetchedAt,
        userId,
        invalidated: true
      }
    }
    if (
      friendsActivity &&
      Array.isArray(friendsActivity.data) &&
      typeof friendsActivity.fetchedAt === 'number'
    ) {
      friendsActivityCache = {
        data: friendsActivity.data,
        fetchedAt: friendsActivity.fetchedAt,
        userId
      }
    }
  }

  loadSnapshots()

  return {
    getQueueLength,
    getSyncStatus,
    broadcastSyncStatus,
    startSyncTimer,
    stopSyncTimer,
    adjustSyncTimer,
    syncShikimoriQueue,
    prefetchShikimoriDetails,
    refreshShikimoriDetailsForMalId,
    setOnDetailsPrefetched,
    abortPrefetch,
    invalidateCalendarCache,
    getCachedCalendar,
    setCachedCalendar,
    getCachedFriendsActivity,
    setCachedFriendsActivity,
    clearOfflineSnapshots,
    drainNow,
    withQueueLock,
    onItemSettled: (listener) => settled.add(listener)
  }
}
