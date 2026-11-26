// Shikimori's primary branch of #692's fan-out writer: `sendRate` / `queueRate`
// and the bodies of `SHIKIMORI_UPDATE_RATE` / `SHIKIMORI_MARK_EPISODE_WATCHED`,
// moved here verbatim from `ipc/shikimori.ipc.ts`. A Shikimori-only user's
// writes are exactly 6.x's: the live read for mark-watched, the live send, the
// queue on a queueable error, the park on an owner change, the cache patch,
// the broadcasts, the clocks and the cleanup prompt. The router injects the
// channels and its refresh / recommendations helpers.

import * as shikimori from '../../shikimori'
import { isNetworkError } from '../../lib/errors'
import {
  parkEntries,
  type ParkedQueues,
  type QueuedShikimoriUpdate
} from '../../lib/shikimori-queue'
import {
  NO_RATE_BEFORE,
  nextWatchedRate,
  rateValues,
  type RateValues
} from '../../lib/shikimori-rate'
import { rateClockKey, stampRateClocks } from '../../store/sync-meta'
import type { StorageService } from '../../store/types'
import type { ShikimoriSyncService } from '../shikimori-sync'
import type { PrimaryWrite, RateChange } from './fan-out'

type CachedRateEntry = {
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
}

function cachedBasis(entry: CachedRateEntry): { rateId: number | null; before: RateValues } {
  return {
    rateId: typeof entry.rate.id === 'number' ? entry.rate.id : null,
    before: rateValues(entry.rate)
  }
}

// An expired session joins the offline path rather than bypassing it: the edit
// that discovered the dead token is exactly the one we must not lose, and it
// replays on reconnect like any queued update (#244). Deliberately
// `ShikiAuthError`, not `ShikiApiError` — a genuine 400/422 from `user_rates`
// must keep dropping, or one malformed entry would jam the drain forever.
export function isQueueableRateError(err: unknown): boolean {
  return isNetworkError(err) || err instanceof shikimori.ShikiAuthError
}

export interface ShikimoriPrimaryDeps {
  store: StorageService
  sync: Pick<
    ShikimoriSyncService,
    'invalidateCalendarCache' | 'syncShikimoriQueue' | 'broadcastSyncStatus' | 'startSyncTimer'
  >
  broadcast: (channel: string, ...args: unknown[]) => void
  /** `EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED`. */
  rateUpdatedChannel: string
  /** `EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED`. */
  offlineQueueChangedChannel: string
  maybeBroadcastCleanupPrompt: (
    smotretAnime: unknown,
    malId: number,
    status: shikimori.ShikiUserRateStatus,
    prevStatus?: shikimori.ShikiUserRateStatus
  ) => Promise<void>
  invalidateRecommendations(): void
  /** The router's background rate refresh, for a write to a title with no cached row. */
  refreshRatesInBackground(): void
}

export interface ShikimoriPrimary {
  /** The primary branch for `applyChange`: a write, or null (mark-watched with nothing to do). */
  write(malId: number, change: RateChange): Promise<PrimaryWrite<shikimori.ShikiUserRate> | null>
  sendRate(
    accessToken: string,
    userId: number,
    malId: number,
    existing: shikimori.ShikiUserRate | null,
    after: RateValues,
    stamp: boolean
  ): Promise<shikimori.ShikiUserRate>
  queueRate(
    owner: shikimori.ShikiUser,
    malId: number,
    basis: { rateId: number | null; before: RateValues },
    after: RateValues,
    err: unknown,
    stamp: boolean
  ): shikimori.ShikiUserRate
}

export function createShikimoriPrimary(deps: ShikimoriPrimaryDeps): ShikimoriPrimary {
  const { store, sync, broadcast, maybeBroadcastCleanupPrompt } = deps

  function currentUserId(): number | undefined {
    return (store.get('shikimoriUser') as shikimori.ShikiUser | null)?.id
  }

  function getParkedQueues(): ParkedQueues {
    return (store.get('shikimoriParkedQueues') as ParkedQueues | undefined) ?? {}
  }

  function ownerKey(user: shikimori.ShikiUser): { id: string; nickname: string } {
    return { id: String(user.id), nickname: user.nickname }
  }

  function findCachedRate(malId: number): CachedRateEntry | undefined {
    const cached = store.get('shikimoriUserRates') as CachedRateEntry[]
    return cached.find((e) => e.rate.target_id === malId)
  }

  // The rate cache belongs to whoever is signed in now. After a switch during a
  // handler's network await it is someone else's, so the owner's basis is the
  // entry the handler read before that await.
  function ownersCachedRate(
    owner: shikimori.ShikiUser,
    malId: number,
    cachedAtStart: CachedRateEntry | undefined
  ): CachedRateEntry | undefined {
    return currentUserId() === owner.id ? findCachedRate(malId) : cachedAtStart
  }

  // Writes `after` to Shikimori (creating the rate when `existing` is null),
  // then patches the cached entry and fans out the change.
  async function sendRate(
    accessToken: string,
    userId: number,
    malId: number,
    existing: shikimori.ShikiUserRate | null,
    after: RateValues,
    stamp: boolean
  ): Promise<shikimori.ShikiUserRate> {
    const { episodes, status, score, rewatches } = after
    const cached = store.get('shikimoriUserRates') as CachedRateEntry[]
    const idx = cached.findIndex((e) => e.rate.target_id === malId)
    const prevStatus = idx !== -1 ? cached[idx].rate.status : undefined

    const updatedRate = existing
      ? await shikimori.updateUserRate(accessToken, existing.id, episodes, status, score, rewatches)
      : await shikimori.createUserRate(
          accessToken,
          userId,
          malId,
          episodes,
          status,
          score,
          rewatches
        )
    if (stamp)
      stampRateClocks(
        store,
        rateClockKey('shikimori', userId, malId),
        existing ? rateValues(existing) : NO_RATE_BEFORE,
        after
      )

    // The write landed on the previous account; the cache is the new one's.
    if (currentUserId() !== userId) return updatedRate

    if (idx !== -1) {
      cached[idx] = {
        ...cached[idx],
        rate: {
          ...cached[idx].rate,
          id: updatedRate.id,
          score: updatedRate.score,
          status: updatedRate.status,
          episodes: updatedRate.episodes,
          rewatches: updatedRate.rewatches ?? 0,
          updated_at: new Date().toISOString(),
          target_id: updatedRate.target_id
        }
      }
      store.set('shikimoriUserRates', cached)
      sync.invalidateCalendarCache()
      deps.invalidateRecommendations()
      broadcast(deps.rateUpdatedChannel, cached[idx])
      void maybeBroadcastCleanupPrompt(
        cached[idx].smotretAnime,
        malId,
        updatedRate.status,
        prevStatus
      )
    } else {
      deps.invalidateRecommendations()
      deps.refreshRatesInBackground()
      void maybeBroadcastCleanupPrompt(null, malId, updatedRate.status, undefined)
    }

    void sync.syncShikimoriQueue()
    return updatedRate
  }

  // Queues `after` for the drain and patches the cached entry optimistically
  // when there is one. `basis` is what the drain's drift check compares the
  // server against. Returns a synthetic rate so callers need no offline branch.
  // `owner` is the user the handler started for: when a logout or account
  // switch landed during its network await, the entry is kept for that owner
  // instead of joining the new user's live queue (#588).
  function queueRate(
    owner: shikimori.ShikiUser,
    malId: number,
    basis: { rateId: number | null; before: RateValues },
    after: RateValues,
    err: unknown,
    stamp: boolean
  ): shikimori.ShikiUserRate {
    const { episodes, status, score, rewatches } = after
    const synthetic = {
      id: basis.rateId ?? -1,
      score,
      status,
      episodes,
      rewatches,
      target_id: malId,
      target_type: 'Anime'
    } satisfies shikimori.ShikiUserRate
    const entry = { malId, rateId: basis.rateId, before: basis.before, after, queuedAt: Date.now() }
    // Keyed by the owner the edit was made for, parked or live.
    if (stamp)
      stampRateClocks(store, rateClockKey('shikimori', owner.id, malId), basis.before, after)

    if (currentUserId() !== owner.id) {
      store.set(
        'shikimoriParkedQueues',
        parkEntries(getParkedQueues(), ownerKey(owner), [entry], Date.now())
      )
      // The live length is unchanged; the broadcast tells Connectors to reload
      // its kept-changes rows.
      broadcast(deps.offlineQueueChangedChannel, {
        length: (store.get('shikimoriUpdateQueue') as unknown[]).length
      })
      return synthetic
    }

    const isExpiredSession = err instanceof shikimori.ShikiAuthError
    const queue = store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]
    queue.push(entry)
    store.set('shikimoriUpdateQueue', queue)

    const cached = store.get('shikimoriUserRates') as CachedRateEntry[]
    const idx = cached.findIndex((e) => e.rate.target_id === malId)
    const prevStatus = idx !== -1 ? cached[idx].rate.status : undefined
    if (idx !== -1) {
      cached[idx] = {
        ...cached[idx],
        rate: {
          ...cached[idx].rate,
          episodes,
          status,
          score,
          rewatches,
          updated_at: new Date().toISOString()
        }
      }
      store.set('shikimoriUserRates', cached)
      sync.invalidateCalendarCache()
      deps.invalidateRecommendations()
      broadcast(deps.rateUpdatedChannel, cached[idx])
    }
    broadcast(deps.offlineQueueChangedChannel, { length: queue.length })
    // Without this the expiry banner never appears on the path that
    // discovers expiry most often: this branch broadcasts the queue change
    // but nothing else here reports sync status, and the renderer polls it
    // from exactly one view (#244).
    sync.broadcastSyncStatus()
    if (!isExpiredSession) sync.startSyncTimer()
    if (idx !== -1) {
      void maybeBroadcastCleanupPrompt(cached[idx].smotretAnime, malId, status, prevStatus)
    }

    return synthetic
  }

  // `SHIKIMORI_UPDATE_RATE`'s body. The basis is what the fan-out diffs
  // `values` against: the live rate when sent, the cached entry when queued.
  async function updateRate(
    malId: number,
    values: RateValues
  ): Promise<PrimaryWrite<shikimori.ShikiUserRate>> {
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    const { episodes, status, score, rewatches } = values
    const after = { episodes, status, score, rewatches }
    const cachedAtStart = findCachedRate(malId)

    try {
      const accessToken = await shikimori.ensureFreshToken(store)
      const existing = await shikimori.getUserRate(accessToken, user.id, malId)
      const result = await sendRate(accessToken, user.id, malId, existing, after, true)
      return { result, basis: existing ? rateValues(existing) : NO_RATE_BEFORE, after }
    } catch (err) {
      const entry = ownersCachedRate(user, malId, cachedAtStart)
      if (!isQueueableRateError(err) || !entry) throw err
      const basis = cachedBasis(entry)
      return { result: queueRate(user, malId, basis, after, err, true), basis: basis.before, after }
    }
  }

  // The player's auto-mark (#565). It used to be a renderer-side get-rate then
  // update-rate, and the get threw first on every failure update-rate queues:
  // offline, and an expired session from `ensureFreshToken`. Online it still
  // decides from the live rate, so a count raised on shikimori.one since the
  // last cache refresh is never lowered. Offline it decides from the cache, and
  // queues even for a title with no cache entry, which update-rate refuses.
  async function markEpisodeWatched(
    malId: number,
    epNum: number
  ): Promise<PrimaryWrite<shikimori.ShikiUserRate> | null> {
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user || !Number.isInteger(epNum) || epNum <= 0) return null
    const cachedAtStart = findCachedRate(malId)

    let accessToken: string
    let existing: shikimori.ShikiUserRate | null
    try {
      accessToken = await shikimori.ensureFreshToken(store)
      existing = await shikimori.getUserRate(accessToken, user.id, malId)
    } catch (err) {
      if (!isQueueableRateError(err)) throw err
      const entry = ownersCachedRate(user, malId, cachedAtStart)
      const basis = entry ? cachedBasis(entry) : { rateId: null, before: NO_RATE_BEFORE }
      const next = nextWatchedRate(basis.before, epNum)
      return next
        ? {
            result: queueRate(user, malId, basis, next, err, true),
            basis: basis.before,
            after: next
          }
        : null
    }

    const before = existing ? rateValues(existing) : NO_RATE_BEFORE
    const next = nextWatchedRate(before, epNum)
    if (!next) return null
    try {
      const result = await sendRate(accessToken, user.id, malId, existing, next, true)
      return { result, basis: before, after: next }
    } catch (err) {
      if (!isQueueableRateError(err)) throw err
      const result = queueRate(
        user,
        malId,
        { rateId: existing?.id ?? null, before },
        next,
        err,
        true
      )
      return { result, basis: before, after: next }
    }
  }

  return {
    write: (malId, change) =>
      change.kind === 'set'
        ? updateRate(malId, change.values)
        : markEpisodeWatched(malId, change.episode),
    sendRate,
    queueRate
  }
}
