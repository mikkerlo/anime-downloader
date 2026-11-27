// The setters behind `tracker:set-primary`, `tracker:set-mirror` and
// `tracker:set-feature-source` (#696, epic #688): the only writers of
// `trackerPrimary`, `trackerMirror` and `trackerFeatureSource`, which the
// settings guard refuses to the renderer so these side effects always run.
// Each rejects a tracker that isn't connected (`<provider>User` unset), and
// each applied change broadcasts `tracker:accounts-changed` through the
// lifecycle's one seam. A call that matches what is stored is a no-op: no
// write and no broadcast. `docs/trackers.md` § Primary, mirrors and feature
// sources describes the rules.

import { isCapable, isFeatureKey } from '@shared/trackers/feature-source'
import type { StorageService } from '../../store/types'
import type { TrackerLifecycle } from '../../trackers/lifecycle'
import { isConnected } from '../../trackers/primary'
import { TRACKER_LABELS } from '../../trackers/types'
import type { TrackerFanOut } from './fan-out'

export interface TrackerChoicesDeps {
  store: StorageService
  trackers: Pick<TrackerFanOut, 'discardQueue' | 'mirrorQueueCount'>
  lifecycle: Pick<TrackerLifecycle, 'accountsState' | 'primary' | 'notifyAccountsChanged'>
  log?: Pick<Console, 'error'>
}

export interface TrackerChoices {
  /** Writes `trackerPrimary`. The current primary again is a no-op. */
  setPrimary(trackerId: TrackerId): TrackerAccountsState
  /**
   * The mirror toggle. Rejects the current primary in both directions. Off
   * without `confirm` only counts; off with `confirm` writes the flag, then
   * runs `discardQueue`, which takes the tracker's queue lock itself. A
   * discard that rejects is logged and reported as `discarded: 0`: the
   * toggle is off either way.
   */
  setMirror(
    trackerId: TrackerId,
    enabled: boolean,
    opts?: TrackerSetMirrorOptions
  ): Promise<TrackerSetMirrorResult>
  /**
   * Stores (or with null clears) an override. Rejects a tracker the capability
   * matrix says can't back the feature. `resolveFeatureSource` resolves it.
   */
  setFeatureSource(feature: TrackerFeature, trackerId: TrackerId | null): TrackerAccountsState
}

type Toggles = Partial<Record<TrackerId, boolean>>
type Sources = Partial<Record<TrackerFeature, TrackerId>>

export function createTrackerChoices(deps: TrackerChoicesDeps): TrackerChoices {
  const { store, trackers, lifecycle } = deps
  const log = deps.log ?? console

  function assertConnected(id: TrackerId): void {
    if (!isConnected(store, id)) throw new Error(`${TRACKER_LABELS[id]} isn't connected`)
  }

  const toggles = (): Toggles => (store.get('trackerMirror') as Toggles | undefined) ?? {}
  const sources = (): Sources => (store.get('trackerFeatureSource') as Sources | undefined) ?? {}

  function applied(): TrackerAccountsState {
    lifecycle.notifyAccountsChanged()
    return lifecycle.accountsState()
  }

  function setPrimary(id: TrackerId): TrackerAccountsState {
    // Connected means the user is set: an expired session or "Needs setup"
    // is accepted, and writes to it queue until it can drain.
    assertConnected(id)
    if (lifecycle.primary() === id) return lifecycle.accountsState()
    // No queue moves: every reader takes the primary at call or tick time,
    // and the old primary mirrors under its stored toggle.
    store.set('trackerPrimary', id)
    return applied()
  }

  async function setMirror(
    id: TrackerId,
    enabled: boolean,
    opts: TrackerSetMirrorOptions = {}
  ): Promise<TrackerSetMirrorResult> {
    assertConnected(id)
    if (lifecycle.primary() === id) {
      // Its stored toggle is kept for when it stops being primary.
      throw new Error(`${TRACKER_LABELS[id]} is the primary: its mirror toggle can't change`)
    }
    // A missing entry means on.
    const on = toggles()[id] !== false
    if (on === enabled) return { applied: false }
    if (enabled) {
      store.set('trackerMirror', { ...toggles(), [id]: true })
      lifecycle.notifyAccountsChanged()
      return { applied: true, offerReconcile: true }
    }
    if (!opts.confirm)
      return { applied: false, pendingMirrorChanges: trackers.mirrorQueueCount(id) }
    // The flag first: the fan-out reads it in the step that appends a mirror
    // entry, after the primary's await, so nothing is appended after this
    // line. `discardQueue` then waits for a drain in flight under the lock.
    store.set('trackerMirror', { ...toggles(), [id]: false })
    lifecycle.notifyAccountsChanged()
    try {
      return { applied: true, discarded: await trackers.discardQueue(id) }
    } catch (err) {
      // The toggle is already off and broadcast, so the call reports the
      // change that landed: a rejection would read as a revert that never
      // happened. Whatever it didn't remove stays queued and drains as usual.
      log.error(`[trackers] discarding the ${TRACKER_LABELS[id]} mirror queue failed:`, err)
      return { applied: true, discarded: 0 }
    }
  }

  function setFeatureSource(feature: TrackerFeature, id: TrackerId | null): TrackerAccountsState {
    if (!isFeatureKey(feature)) throw new Error(`Unknown feature: ${String(feature)}`)
    const current = sources()
    if (id === null) {
      if (current[feature] === undefined) return lifecycle.accountsState()
      const next = { ...current }
      delete next[feature]
      store.set('trackerFeatureSource', next)
      return applied()
    }
    assertConnected(id)
    // The static matrix (#706), which the renderer's dropdowns read too.
    if (!isCapable(feature, id)) {
      throw new Error(`${TRACKER_LABELS[id]} can't be the ${feature} source`)
    }
    if (current[feature] === id) return lifecycle.accountsState()
    store.set('trackerFeatureSource', { ...current, [feature]: id })
    return applied()
  }

  return { setPrimary, setMirror, setFeatureSource }
}
