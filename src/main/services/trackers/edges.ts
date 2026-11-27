// Which trackers take part at boot and on the online edge (#693, epic #688).
// `index.ts` reads the list when each edge fires, so a tracker connected later
// joins the next one. Shikimori takes part signed in or not, as in 6.0.21 (its
// drain returns at its own guard); every other tracker only while connected.
// `docs/trackers.md` § Boot, the online edge and Prepare describes it.

import type { KickoffTracker } from '../offline/kickoff'
import { TRACKER_LABELS } from '../../trackers/types'
import type { TrackerSyncService } from './sync'

type Store = { get(key: string): unknown }
type Svc = Pick<TrackerSyncService<unknown, unknown>, 'trackerId' | 'keys'>

/** Connected: the tracker's `<provider>User` key is set. */
export function isTrackerConnected(store: Store, sync: Svc): boolean {
  return store.get(sync.keys.user) != null
}

/** Shikimori always, then every other tracker that is connected now, in the given order. */
export function edgeTrackers<T extends Svc>(store: Store, syncs: T[]): T[] {
  return syncs.filter((s) => s.trackerId === 'shikimori' || isTrackerConnected(store, s))
}

/**
 * The boot drain: each tracker with a non-empty queue starts its timer and
 * kicks one drain. Each iteration is guarded on its own, so a synchronous
 * throw from one tracker's `getQueueLength()` or `startSyncTimer()` logs and
 * moves on to the next.
 */
export function bootDrain(
  syncs: Pick<
    TrackerSyncService<unknown, unknown>,
    'trackerId' | 'getQueueLength' | 'startSyncTimer' | 'syncQueue'
  >[],
  log: Pick<Console, 'warn'> = console
): void {
  for (const sync of syncs) {
    try {
      if (sync.getQueueLength() > 0) {
        sync.startSyncTimer()
        void sync.syncQueue()
      }
    } catch (err) {
      log.warn(`[trackers] ${TRACKER_LABELS[sync.trackerId]} boot drain failed:`, err)
    }
  }
}

/**
 * One tracker's online-edge entry. Shikimori keeps 6.0.21's labels; every
 * other tracker is `'<Name> queue drain'` / `'<Name> details prefetch'`. Only
 * the `prefetch` passed here is called: the generic instance has none (T7
 * passes AniList's).
 */
export function kickoffEntry(
  sync: Pick<TrackerSyncService<unknown, unknown>, 'trackerId' | 'syncQueue'>,
  prefetch?: () => Promise<unknown> | unknown
): KickoffTracker {
  const name = TRACKER_LABELS[sync.trackerId]
  return {
    drainLabel: `${name} queue drain`,
    drain: () => sync.syncQueue(),
    prefetchLabel: sync.trackerId === 'shikimori' ? 'details prefetch' : `${name} details prefetch`,
    ...(prefetch ? { prefetch } : {})
  }
}

/**
 * The kick-off's list at one online edge: `edgeTrackers`, with Shikimori's
 * details prefetch and any other tracker's from `prefetches` (AniList's, #703).
 */
export function kickoffTrackers(
  store: Store,
  syncs: Pick<TrackerSyncService<unknown, unknown>, 'trackerId' | 'keys' | 'syncQueue'>[],
  prefetchShikimoriDetails: () => Promise<unknown> | unknown,
  prefetches: Partial<
    Record<Exclude<TrackerId, 'shikimori'>, () => Promise<unknown> | unknown>
  > = {}
): KickoffTracker[] {
  return edgeTrackers(store, syncs).map((sync) =>
    kickoffEntry(
      sync,
      sync.trackerId === 'shikimori' ? prefetchShikimoriDetails : prefetches[sync.trackerId]
    )
  )
}
