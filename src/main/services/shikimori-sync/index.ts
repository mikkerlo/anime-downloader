import * as shikimori from '../../shikimori'
import { isNetworkError } from '../../lib/errors'
import {
  consolidateQueue,
  dropFromParked,
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

interface CachedCalendar {
  data: CalendarEntry[]
  fetchedAt: number
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
  setCachedCalendar(data: CalendarEntry[]): void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shouldApplyOnDrift(
  current: shikimori.ShikiUserRate,
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

  async function syncShikimoriQueue(): Promise<void> {
    if (syncInProgress) return
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
        } else {
          const driftMatches =
            current.episodes === item.before.episodes &&
            current.status === item.before.status &&
            current.score === item.before.score

          if (driftMatches) {
            const updated = await shikimori.updateUserRate(
              accessToken,
              current.id,
              item.after.episodes,
              item.after.status,
              item.after.score,
              item.after.rewatches
            )
            reconcileCacheFromRate(user.id, item.malId, updated)
          } else if (shouldApplyOnDrift(current, item.after)) {
            const updated = await shikimori.updateUserRate(
              accessToken,
              current.id,
              item.after.episodes,
              item.after.status,
              item.after.score,
              item.after.rewatches
            )
            reconcileCacheFromRate(user.id, item.malId, updated)
          } else {
            reconcileCacheFromRate(user.id, item.malId, current)
          }
        }

        dropConsumedEntries(user.id, item.malId, item.consumedQueuedAts)
      } catch (err) {
        if (isNetworkError(err)) {
          aborted = true
          break
        }
        if (err instanceof shikimori.ShikiApiError && (err.status === 401 || err.status === 403)) {
          aborted = true
          lastSyncError = err.message
          console.warn('[shikimori sync] auth error, stopping drain:', err)
          break
        }
        if (err instanceof shikimori.ShikiApiError && err.status === 429) {
          aborted = true
          lastSyncError = 'Shikimori rate limit — will retry'
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
          } else {
            hadServerError = true
            lastSyncError = 'Shikimori server error — will retry'
            console.warn('[shikimori sync] server error, keeping item', item.malId, err.status)
          }
        } else {
          console.warn('[shikimori sync] dropping item', item.malId, err)
          dropConsumedEntries(user.id, item.malId, item.consumedQueuedAts)
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
    if (prefetchInProgress) return
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

  function invalidateCalendarCache(): void {
    calendarCache = null
  }

  function getCachedCalendar(): CachedCalendar | null {
    return calendarCache
  }

  function setCachedCalendar(data: CalendarEntry[]): void {
    calendarCache = { data, fetchedAt: Date.now() }
  }

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
    setCachedCalendar
  }
}
