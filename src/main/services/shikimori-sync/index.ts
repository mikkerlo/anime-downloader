import * as shikimori from '../../shikimori'
import { isNetworkError } from '../../lib/errors'
import { consolidateQueue, type QueuedShikimoriUpdate } from '../../lib/shikimori-queue'
import type { StorageService } from '../../store/types'

export type ShikiSyncState = 'idle' | 'syncing'

export interface ShikiSyncStatus {
  state: ShikiSyncState
  queueLength: number
  lastSyncAt: number
  lastSyncError: string | null
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
const PREFETCH_STATUSES = new Set<shikimori.ShikiUserRateStatus>(['watching', 'planned'])

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

  let calendarCache: CachedCalendar | null = null

  function getQueueLength(): number {
    return (store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]).length
  }

  function getSyncStatus(): ShikiSyncStatus {
    return {
      state: syncInProgress ? 'syncing' : 'idle',
      queueLength: getQueueLength(),
      lastSyncAt,
      lastSyncError
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

  function dropConsumedEntries(malId: number, consumedQueuedAts: number[]): number {
    const consumed = new Set(consumedQueuedAts)
    const queue = (store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]).filter(
      (q) => !(q.malId === malId && consumed.has(q.queuedAt))
    )
    store.set('shikimoriUpdateQueue', queue)
    broadcast(deps.offlineQueueChangedChannel, { length: queue.length })
    return queue.length
  }

  function reconcileCacheFromRate(malId: number, rate: shikimori.ShikiUserRate): void {
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
      if (!isNetworkError(err)) {
        lastSyncError = err instanceof Error ? err.message : String(err)
        console.warn('[shikimori sync] auth refresh failed:', err)
      }
      broadcastSyncStatus()
      return
    }

    const work = consolidateQueue(queue)
    let aborted = false

    for (const item of work) {
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
          reconcileCacheFromRate(item.malId, created)
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
            reconcileCacheFromRate(item.malId, updated)
          } else if (shouldApplyOnDrift(current, item.after)) {
            const updated = await shikimori.updateUserRate(
              accessToken,
              current.id,
              item.after.episodes,
              item.after.status,
              item.after.score,
              item.after.rewatches
            )
            reconcileCacheFromRate(item.malId, updated)
          } else {
            reconcileCacheFromRate(item.malId, current)
          }
        }

        dropConsumedEntries(item.malId, item.consumedQueuedAts)
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
        console.warn('[shikimori sync] dropping item', item.malId, err)
        dropConsumedEntries(item.malId, item.consumedQueuedAts)
      }

      if (work.indexOf(item) < work.length - 1) await sleep(SYNC_ITEM_DELAY_MS)
    }

    syncInProgress = false
    if (!aborted) {
      lastSyncAt = Date.now()
      lastSyncError = null
    }
    adjustSyncTimer()
    broadcastSyncStatus()
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
    const result: number[] = []
    for (const entry of rates) {
      if (!PREFETCH_STATUSES.has(entry.rate.status)) continue
      const malId = entry.rate.target_id ?? entry.shikiAnime?.id
      if (typeof malId !== 'number' || !Number.isFinite(malId) || malId <= 0) continue
      const cached = cache[String(malId)]
      if (!cached || now - cached.fetchedAt > PREFETCH_STALENESS_MS) {
        result.push(malId)
      }
    }
    return result
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
      if (!isNetworkError(err)) {
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
          if (err instanceof shikimori.ShikiApiError && err.status === 404) {
            console.warn('[shikimori prefetch] anime', malId, 'not found, skipping')
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
    abortPrefetch,
    invalidateCalendarCache,
    getCachedCalendar,
    setCachedCalendar
  }
}
