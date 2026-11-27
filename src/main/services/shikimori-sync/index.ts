import * as shikimori from '../../shikimori'
import { isNetworkError } from '../../lib/errors'
import type { StorageService } from '../../store/types'
import type { CachedRateEntry } from '../../lib/shikimori-rate-cache'
import type { AnimeSearchResult } from '../../smotret-api'
import { SHIKIMORI_KEYS } from '../../trackers/keys'
import { createShikimoriProvider } from '../../trackers/shikimori.provider'
import {
  createDisplaySnapshots,
  type CalendarSnapshot,
  type SnapshotRecord
} from '../../trackers/display-snapshots'
import {
  createTrackerSyncService,
  type TrackerDrainStatus,
  type TrackerItemSettled,
  type TrackerRatesResult,
  type TrackerSyncService
} from '../trackers/sync'
import { EVENT_CHANNELS } from '@shared/ipc/channels'

export { driftPayload } from '../trackers/sync'

export type ShikiSyncState = TrackerDrainStatus['state']

export type ShikiSyncStatus = TrackerDrainStatus

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
// age. They persist to `snapshotsPath` (#570), never to `config.json`, through
// the shared helper (`trackers/display-snapshots.ts`, #709).
/** `invalidated` is set by `invalidateCalendarCache()`: online a miss, offline still served. */
export type CachedCalendar = CalendarSnapshot<CalendarEntry>

export type CachedFriendsActivity = SnapshotRecord<ShikiFriendActivityEntry[]>

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
  /** Smotret entries for the cached rates' `smotretAnime` (`index.ts`'s `lookupByMalIds`). */
  lookupByMalIds?: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  /** `EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED`, broadcast by `refreshRates`. */
  ratesRefreshedChannel?: string
}

export type RefreshRatesResult = TrackerRatesResult<CachedRateEntry>

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
  /**
   * Fetches the signed-in user's rates (#592). Without `status` it replaces
   * `shikimoriUserRates`; with `keepQueued`, every MAL id with a live queue
   * entry at the moment of that write keeps its cached entry. Null when the
   * account changed while the list was in flight (#588).
   */
  fetchAndCacheRates(opts?: {
    status?: shikimori.ShikiUserRateStatus
    keepQueued?: boolean
  }): Promise<RefreshRatesResult | null>
  /**
   * The wholesale refresh with its side effects (#592): the calendar and the
   * recommendations are invalidated and `SHIKIMORI_RATES_REFRESHED` carries
   * the new entries.
   */
  refreshRates(opts: { keepQueued: boolean }): Promise<RefreshRatesResult | null>
  /** Clears the cached recommendations feed; it rebuilds on the next open. */
  invalidateRecommendations(): void
  /** The generic instance underneath (#691), for #692's fan-out writer. */
  readonly tracker: TrackerSyncService<shikimori.ShikiUserRate, CachedRateEntry>
}

/** One consumed drain item (#584): the generic service's, with Shikimori's rate. */
export type ShikiItemSettled = TrackerItemSettled<shikimori.ShikiUserRate>

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shikimori's sync service. The queue, its drain, the timer, the lock and the
 * rate cache are the generic tracker sync service's (#691,
 * `services/trackers/sync.ts`), built here with Shikimori's provider and keys.
 * This wrapper adds the Shikimori-only extras: the anime-details prefetcher,
 * the calendar and friends-activity snapshots, and the recommendations cache,
 * and it wires the generic instance's rate hooks to their invalidations.
 */
export function createShikimoriSyncService(deps: ShikimoriSyncServiceDeps): ShikimoriSyncService {
  const { store, broadcast } = deps

  const sync = createTrackerSyncService(
    createShikimoriProvider({ store, lookupByMalIds: deps.lookupByMalIds }),
    SHIKIMORI_KEYS,
    {
      store,
      broadcast,
      syncStatusChannel: deps.syncStatusChannel,
      offlineQueueChangedChannel: deps.offlineQueueChangedChannel,
      rateUpdatedChannel: deps.rateUpdatedChannel,
      ratesRefreshedChannel: deps.ratesRefreshedChannel ?? EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED,
      isOffline: () => deps.isOffline?.() ?? false,
      // A drained edit marks the calendar stale, as a queued one does.
      onRateUpdated: () => invalidateCalendarCache(),
      // A full rate refresh can carry completions made outside the app (e.g.
      // on shikimori.one); clear the recs cache so it rebuilds from the
      // updated list rather than surfacing a now-rated title (#193 follow-up).
      onRatesRefreshed: () => {
        invalidateCalendarCache()
        invalidateRecommendations()
      }
    }
  )

  let prefetchInProgress = false
  let prefetchAbort = false
  // Set by the IPC layer (#183) to recompute the profile's favorite-genres panel
  // once a prefetch run has widened the cached-details coverage.
  let onDetailsPrefetched: (() => void) | undefined

  function currentUserId(): number | undefined {
    return (store.get('shikimoriUser') as shikimori.ShikiUser | null)?.id
  }

  // A loaded calendar starts invalidated: online the first open refetches,
  // offline it is served stale.
  const snapshots = createDisplaySnapshots<{
    calendar: CachedCalendar
    friendsActivity: CachedFriendsActivity
  }>({
    path: deps.snapshotsPath,
    sections: ['calendar', 'friendsActivity'],
    currentUserId,
    label: '[shikimori]',
    revive: {
      calendar: (stored, userId) => ({ ...stored, userId, invalidated: true }),
      friendsActivity: (stored, userId) => ({ ...stored, userId })
    }
  })

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

  function invalidateCalendarCache(): void {
    snapshots.update('calendar', (c) => ({ ...c, invalidated: true }))
  }

  // A rate change shifts the taste signal, so the cached feed is stale. Clear it
  // (rather than recompute eagerly — that costs N `/similar` calls) so the next
  // tab open rebuilds from fresh taste.
  function invalidateRecommendations(): void {
    store.set('shikimoriRecommendations', [])
  }

  function getCachedCalendar(): CachedCalendar | null {
    return snapshots.get('calendar')
  }

  function setCachedCalendar(
    data: CalendarEntry[],
    userId: number | null = currentUserId() ?? null
  ): CachedCalendar {
    const snapshot: CachedCalendar = { data, fetchedAt: Date.now(), userId, invalidated: false }
    // A fetch that outlived an account switch must not evict the new user's snapshot.
    snapshots.put('calendar', snapshot)
    return snapshot
  }

  function getCachedFriendsActivity(): CachedFriendsActivity | null {
    return snapshots.get('friendsActivity')
  }

  function setCachedFriendsActivity(
    userId: number,
    data: ShikiFriendActivityEntry[]
  ): CachedFriendsActivity {
    const snapshot: CachedFriendsActivity = { data, fetchedAt: Date.now(), userId }
    snapshots.put('friendsActivity', snapshot)
    return snapshot
  }

  function clearOfflineSnapshots(): void {
    snapshots.clear()
  }

  return {
    getQueueLength: sync.getQueueLength,
    getSyncStatus: sync.getSyncStatus,
    broadcastSyncStatus: sync.broadcastSyncStatus,
    startSyncTimer: sync.startSyncTimer,
    stopSyncTimer: sync.stopSyncTimer,
    adjustSyncTimer: sync.adjustSyncTimer,
    syncShikimoriQueue: sync.syncQueue,
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
    drainNow: sync.drainNow,
    withQueueLock: sync.withQueueLock,
    onItemSettled: sync.onItemSettled,
    fetchAndCacheRates: sync.fetchAndCacheRates,
    refreshRates: sync.refreshRates,
    invalidateRecommendations,
    tracker: sync
  }
}
